import { z } from "zod";
import { mkdirSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { textResult, errorResult, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import { seedOfficeHome } from "./office-home.js";
import type { ToolDefinition } from "../../core/types.js";
import type { AgentService } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import type { MeetingExecutorLike } from "./advanced-types.js";
import type { EventBus } from "../../core/event-bus.js";
import { resolveGoal, extractRoleFromReply, stripRoleWrapper } from "./executor.js";
import { getRequestContext } from "../../core/request-context.js";
import { defineTool, defineToolNoInput } from "../../core/tool-builder.js";

// ─────────────────────────────────────────────────────────────────────────
// Agent-management policy
//
// An agent is allowed to create/update/delete other agents ONLY when it has
// the tool in its allowed_tools list AND passes three runtime checks:
//
//   1. **Role gate** — the caller must be `role='manager'`. Workers can be
//      trusted with lots of things, but self-propagation is not one of them.
//      A named allowlist (`PRIVILEGED_AGENT_NAMES`) covers the few infra
//      agents that legitimately spawn children (Tool Architect, Reflection
//      Optimizer). Human calls (no `__caller_agent_id`) bypass the gate —
//      the dashboard and direct API callers are trusted.
//
//   2. **Inheritance cap** — a child cannot hold a tool its parent doesn't
//      hold. If the caller has a restricted `allowed_tools`, the child must
//      be a subset; `[]` ("all tools") for the child requires the caller to
//      also have `[]`. Prevents trivial privilege escalation via
//      "spawn-and-grant-self-more".
//
//   3. **Approval pending** — agents created by another agent enter with
//      `active=0`. A human activates them from the dashboard. Update/delete
//      of existing agents is not blocked by this, only creation.
// ─────────────────────────────────────────────────────────────────────────

const PRIVILEGED_AGENT_NAMES = new Set<string>([
  "Tool Architect",
  "Reflection Optimizer",
]);

type PolicyOk = { ok: true; caller: ReturnType<AgentService["getAgent"]> | null };
type PolicyErr = { ok: false; error: string };

function resolveCaller(
  args: Record<string, unknown>,
  service: AgentService,
): ReturnType<AgentService["getAgent"]> | null {
  const id = typeof args.__caller_agent_id === "string" ? args.__caller_agent_id : null;
  if (!id) return null;
  return service.getAgent(id) ?? null;
}

function parseAllowedTools(raw: string | undefined): string[] | null {
  // Returns null to mean "all tools" (empty JSON array or blank).
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr.filter((t): t is string => typeof t === "string");
  } catch {
    return null;
  }
}

function enforceAgentMgmtPolicy(
  args: unknown,
  service: AgentService,
  action: "create" | "update" | "delete",
  childTools: string[] | undefined | null,
): PolicyOk | PolicyErr {
  const bag = (args ?? {}) as Record<string, unknown>;
  const caller = resolveCaller(bag, service);

  // Human call (no caller agent id) — trusted. Dashboards, direct API, CLI.
  if (!caller) return { ok: true, caller: null };

  // (1) Role gate.
  const isManager = caller.role === "manager";
  const isPrivilegedByName = PRIVILEGED_AGENT_NAMES.has(caller.name);
  if (!isManager && !isPrivilegedByName) {
    return {
      ok: false,
      error:
        `Agent "${caller.name}" (role=${caller.role || "worker"}) cannot ${action} agents. ` +
        `Only managers or explicitly privileged agents may invoke kernel_agents_${action}.`,
    };
  }

  if (action === "delete") {
    // Delete is manager-only; no inheritance check applies.
    return { ok: true, caller };
  }

  // (2) Inheritance cap (create + update).
  const parentTools = parseAllowedTools(caller.allowed_tools);
  // parentTools === null means caller holds "all tools". No cap needed.
  if (parentTools !== null) {
    if (childTools === null) {
      return {
        ok: false,
        error:
          `Inheritance cap: caller "${caller.name}" has a restricted tool list, ` +
          `so the child cannot be given "[]" (all tools). Supply an explicit allowed_tools list.`,
      };
    }
    if (Array.isArray(childTools) && childTools.length > 0) {
      const parentSet = new Set(parentTools);
      const offenders = childTools.filter((t) => !parentSet.has(t));
      if (offenders.length > 0) {
        return {
          ok: false,
          error:
            `Inheritance cap: child would receive ${offenders.length} tool(s) the caller does not hold: ` +
            `${offenders.slice(0, 5).join(", ")}${offenders.length > 5 ? ", …" : ""}. ` +
            `Agents cannot grant tools beyond their own allowed_tools.`,
        };
      }
    }
  }

  return { ok: true, caller };
}

// Internal field injected by AgentExecutor.executeTool() for every tool call
// an agent makes: `{ ...input, __caller_agent_id: agent.id }`. It never
// reaches this handler via the normal MCP dispatch (server.ts) because
// zod strips unknown keys there — this is a private in-process channel, not
// a documented tool parameter for external callers. A handful of tools below
// declare it explicitly (as an optional field) so it survives the
// defineTool() schema.parse() step; without that, agent-to-agent policy
// enforcement and messaging would silently stop working once wrapped.
const CALLER_AGENT_ID_FIELD = {
  __caller_agent_id: z.string().optional().describe(
    "[internal] injected by the agent executor when this tool is invoked from an agent run. Not meant to be set by external callers.",
  ),
};

export function agentsTools(
  service: AgentService,
  executor: AgentExecutor,
  events: EventBus,
  /**
   * Lazy accessor: meeting support is provided by the `agent-advanced`
   * extension, which registers itself AFTER `agents.initialize()` builds
   * this tool list. Reading it per-call lets the meeting tool flip from
   * "not initialized" to live once the extension wires in.
   */
  getMeetingExecutor: () => MeetingExecutorLike | null = () => null,
): ToolDefinition[] {
  return [
    // ── kernel_agents_create ─────────────────────────
    defineTool({
      name: "kernel_agents_create",
      description: "Create a new autonomous agent definition with system prompt, goal template, tool permissions, and LLM config",
      schema: z.object({
        name: z.string().describe("Agent name"),
        description: z.string().optional().describe("What this agent does"),
        system_prompt: z.string().optional().describe("Custom system prompt for the LLM"),
        goal_template: z.string().optional().describe("Goal template with {{variables}} for dynamic goals"),
        allowed_tools: z.array(z.string()).optional().describe("Whitelist of tool names (empty = all tools)"),
        denied_tools: z.array(z.string()).optional().describe("Blacklist of tool names to exclude"),
        provider: z.string().optional().describe("LLM provider: claude, openai, lmstudio (default: system default)"),
        model: z.string().optional().describe("Specific model name (default: provider default)"),
        max_iterations: z.number().optional().describe("Max tool-use loop iterations (default: 15)"),
        timeout_ms: z.number().optional().describe("Execution timeout in ms (default: 300000)"),
        show_on_dashboard: z.boolean().optional().describe("Show last flow result as a widget on dashboard home"),
        flow_id: z.string().optional().describe("Assign agent to a flow/department by ID"),
        role: z.enum(["manager", "worker"]).optional().describe("'manager' to allow this agent to spawn/update/delete other agents; 'worker' (default) cannot."),
        ...CALLER_AGENT_ID_FIELD,
      }),
      handler: async (input) => {
        if (!input.name?.trim()) return errorResult("Name is required");

        // Agent-management policy: role gate + inheritance cap + pending-approval.
        const childTools = input.allowed_tools === undefined
          ? null                              // undefined → "all tools"
          : input.allowed_tools.length === 0
            ? null                            // [] → also "all tools"
            : input.allowed_tools;
        const decision = enforceAgentMgmtPolicy(input, service, "create", childTools);
        if (!decision.ok) return errorResult(decision.error);

        const agent = service.createAgent(input);

        // (3) Approval pending — agent-to-agent creations land inactive.
        // Humans (no caller) keep the default `active=1` so the dashboard flow
        // isn't disrupted.
        if (decision.caller) {
          service.updateAgent(agent.id, { active: false });
          log.info(
            `Agent policy: "${decision.caller.name}" created "${agent.name}" (${agent.id}) — pending human approval (active=0)`,
          );
        }

        const pendingNote = decision.caller
          ? "\n- **Status: PENDING APPROVAL** (active=0). A human must activate this agent before it runs."
          : "";
        return textResult(
          `Agent created: **${agent.name}** (id: ${agent.id})\n` +
          `- Max iterations: ${agent.max_iterations}\n` +
          `- Timeout: ${agent.timeout_ms}ms\n` +
          `- Provider: ${agent.provider || "default"}\n` +
          `- Allowed tools: ${agent.allowed_tools === "[]" ? "all" : agent.allowed_tools}` +
          pendingNote,
        );
      },
    }),

    // ── kernel_agents_list ───────────────────────────
    defineTool({
      name: "kernel_agents_list",
      description: "List all agent definitions, optionally filtered by active status",
      schema: z.object({
        active: z.boolean().optional().describe("Filter by active status"),
      }),
      outputSchema: z.object({
        agents: z.array(z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          active: z.boolean(),
          flow_id: z.string(),
          executor_type: z.string(),
          progressive_discovery: z.boolean(),
        })),
        total: z.number().int(),
      }),
      tags: ["agents", "list", "discovery"],
      handler: async (input) => {
        const agents = service.listAgents(input.active !== undefined ? { active: input.active } : undefined);

        const structured = {
          agents: agents.map((a) => ({
            id: a.id,
            name: a.name,
            description: a.description ?? "",
            active: !!a.active,
            flow_id: a.flow_id ?? "",
            executor_type: a.executor_type ?? "native",
            progressive_discovery: !!a.progressive_discovery,
          })),
          total: agents.length,
        };

        if (agents.length === 0) {
          return { ...textResult("No agents found."), structuredContent: structured };
        }

        const lines = agents.map((a) =>
          `- **${a.name}** (${a.id}) — ${a.active ? "active" : "inactive"}` +
          (a.description ? ` — ${a.description}` : ""),
        );
        return {
          ...textResult(`**${agents.length} agent(s):**\n${lines.join("\n")}`),
          structuredContent: structured,
        };
      },
    }),

    // ── kernel_agents_update ─────────────────────────
    defineTool({
      name: "kernel_agents_update",
      description: "Update an agent definition (name, prompt, tools, config, active status)",
      schema: z.object({
        id: z.string().describe("Agent ID"),
        name: z.string().optional(),
        description: z.string().optional(),
        system_prompt: z.string().optional(),
        goal_template: z.string().optional(),
        allowed_tools: z.array(z.string()).optional(),
        denied_tools: z.array(z.string()).optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        max_iterations: z.number().optional(),
        timeout_ms: z.number().optional(),
        active: z.boolean().optional(),
        show_on_dashboard: z.boolean().optional().describe("Show last flow result as a widget on dashboard home"),
        ...CALLER_AGENT_ID_FIELD,
      }),
      handler: async (input) => {
        const { id } = input;
        // SECURITY: `input` is already zod-parsed and limited to this schema's
        // declared fields, but keep an explicit whitelist as defense-in-depth
        // — if a future edit ever widens the schema (or a field is added for
        // an unrelated reason), this still stops an agent holding this tool
        // from passing `role:"manager"`, `executor_type`, or
        // `builtin_handler` and escalating its own privileges.
        const UPDATABLE_FIELDS = [
          "name", "description", "system_prompt", "goal_template",
          "allowed_tools", "denied_tools", "provider", "model",
          "max_iterations", "timeout_ms", "active", "show_on_dashboard",
        ] as const;
        const bag = input as unknown as Record<string, unknown>;
        const rest: Record<string, unknown> = {};
        for (const k of UPDATABLE_FIELDS) if (k in bag) rest[k] = bag[k];

        // Apply the same inheritance cap on updates — otherwise an agent could
        // bypass the cap by creating a child with minimal tools and then
        // updating it to hold whatever it wants.
        const childTools = input.allowed_tools === undefined
          ? undefined                         // not changing tools → no cap check
          : input.allowed_tools.length === 0
            ? null                             // [] → "all tools"
            : input.allowed_tools;
        const decision = enforceAgentMgmtPolicy(input, service, "update", childTools);
        if (!decision.ok) return errorResult(decision.error);

        const before = service.getAgent(id);
        const updated = service.updateAgent(id, rest as Parameters<AgentService["updateAgent"]>[1]);
        if (!updated) return errorResult("Agent not found");
        if (decision.caller) {
          log.info(
            `Agent policy: "${decision.caller.name}" updated "${updated.name}" (${updated.id})`,
          );
        }
        // Emit a dedicated flow event so the 3D office can show an explicit
        // "manager edited colleague's prompt" beam + log. Only fire when a
        // prompt-level field actually changed (not just active/show flags) so
        // cosmetic updates don't clutter the flow log.
        const promptChanged =
          (rest.system_prompt !== undefined && before && rest.system_prompt !== before.system_prompt) ||
          (rest.goal_template !== undefined && before && rest.goal_template !== before.goal_template);
        const toolsChanged = Array.isArray(rest.allowed_tools) || Array.isArray(rest.denied_tools);
        if (decision.caller && (promptChanged || toolsChanged)) {
          events.emit("agent:flow:agent_edited" as any, {
            manager_id: decision.caller.id,
            manager_name: decision.caller.name,
            target_id: updated.id,
            target_name: updated.name,
            prompt_changed: promptChanged,
            tools_changed: toolsChanged,
            system_prompt_preview: rest.system_prompt
              ? String(rest.system_prompt).slice(0, 240)
              : "",
            ts: new Date().toISOString(),
          });
        }
        return textResult(`Agent **${updated.name}** updated.`);
      },
    }),

    // ── kernel_agents_delete ─────────────────────────
    defineTool({
      name: "kernel_agents_delete",
      description: "Soft-delete an agent (sets active=0, preserves history)",
      schema: z.object({
        id: z.string().describe("Agent ID"),
        ...CALLER_AGENT_ID_FIELD,
      }),
      handler: async (input) => {
        const { id } = input;
        const decision = enforceAgentMgmtPolicy(input, service, "delete", null);
        if (!decision.ok) return errorResult(decision.error);
        const ok = service.deleteAgent(id);
        if (!ok) return errorResult("Agent not found");
        if (decision.caller) {
          log.info(
            `Agent policy: "${decision.caller.name}" deleted agent ${id}`,
          );
        }
        return textResult("Agent deactivated.");
      },
    }),

    // ── kernel_agents_run ────────────────────────────
    defineTool({
      name: "kernel_agents_run",
      description: "Manually trigger an agent run with a specific goal. Returns the run result.",
      schema: z.object({
        agent_id: z.string().describe("Agent ID to run"),
        goal: z.string().optional().describe("Goal override (uses agent's goal_template if not provided)"),
        variables: z.string().optional().describe("JSON object of template variables for {{var}} substitution"),
      }),
      handler: async (input) => {
        const agent = service.getAgent(input.agent_id);
        if (!agent) return errorResult("Agent not found");
        if (!agent.active) return errorResult("Agent is inactive");

        // Caller context propagated by the MCP HTTP server. If the caller is
        // a subprocess agent (Claude Code SDK), these are populated from
        // X-Caller-Agent-Id / X-Caller-Run-Id / X-Caller-Depth headers.
        const callerCtx = getRequestContext();

        // Self-invocation guard at the handler boundary. Same check exists
        // in service.createRun, but failing here returns a tool-result error
        // (visible to the LLM) instead of throwing, so the agent gets clean
        // feedback that this is forbidden.
        if (callerCtx.callerAgentId && callerCtx.callerAgentId === agent.id) {
          return errorResult(
            `Refused: agent "${agent.name}" cannot invoke itself via kernel_agents_run. ` +
            `Self-recursion causes runaway loops. If you need to do more work, ` +
            `do it in this run instead of spawning a new one.`,
          );
        }

        // Resolve goal
        let vars: Record<string, unknown> = {};
        if (input.variables) {
          try { vars = JSON.parse(input.variables); } catch { /* ignore */ }
        }
        const goal = input.goal || resolveGoal(agent.goal_template, vars) || `Execute agent "${agent.name}"`;

        // Create run — propagate lineage so depth caps and self-recursion
        // checks at deeper layers (and observability) all work.
        const run = service.createRun({
          agent_id: agent.id,
          trigger_type: "manual",
          goal,
          parent_run_id: callerCtx.callerRunId,
          parent_agent_id: callerCtx.callerAgentId,
          depth: callerCtx.callerAgentId ? callerCtx.callerDepth + 1 : 0,
        });

        service.updateRun(run.id, { status: "running", started_at: isoNow() });

        events.emit("agent.run.started", {
          run_id: run.id,
          agent_id: agent.id,
          agent_name: agent.name,
          trigger_type: "manual",
        });

        // Execute
        const result = await executor.execute({
          agent,
          goal,
          run,
          service,
          events,
        });

        service.updateRun(run.id, {
          status: result.status,
          result: result.result,
          error: result.error,
          steps_count: result.steps_count,
          tokens_used: result.tokens_used,
          completed_at: isoNow(),
        });

        events.emit("agent.run.completed", {
          run_id: run.id,
          agent_id: agent.id,
          status: result.status,
          steps_count: result.steps_count,
          tokens_used: result.tokens_used,
        });

        events.emit("data.changed", { module: "agents", action: "run_completed" });

        if (result.status === "failed") {
          return errorResult(
            `Agent run failed: ${result.error}\n\nRun ID: ${run.id}`,
          );
        }

        return textResult(
          `**Agent "${agent.name}" completed** (run: ${run.id})\n` +
          `- Steps: ${result.steps_count}\n` +
          `- Tokens: ${result.tokens_used}\n\n` +
          `**Result:**\n${result.result}`,
        );
      },
    }),

    // ── kernel_agents_status ─────────────────────────
    defineTool({
      name: "kernel_agents_status",
      description: "Get the status and step-by-step log of an agent run",
      schema: z.object({
        run_id: z.string().describe("Run ID"),
      }),
      handler: async (input) => {
        const { run_id } = input;

        const run = service.getRun(run_id);
        if (!run) return errorResult("Run not found");

        const steps = service.getSteps(run_id);
        const agent = service.getAgent(run.agent_id);

        let md = `**Run ${run.id}** — ${run.status}\n`;
        md += `- Agent: ${agent?.name ?? run.agent_id}\n`;
        md += `- Trigger: ${run.trigger_type}\n`;
        md += `- Goal: ${run.goal}\n`;
        md += `- Steps: ${run.steps_count} | Tokens: ${run.tokens_used}\n`;
        if (run.started_at) md += `- Started: ${run.started_at}\n`;
        if (run.completed_at) md += `- Completed: ${run.completed_at}\n`;
        if (run.error) md += `- Error: ${run.error}\n`;
        if (run.result) md += `\n**Result:**\n${run.result}\n`;

        if (steps.length > 0) {
          md += `\n**Steps (${steps.length}):**\n`;
          for (const s of steps) {
            switch (s.type) {
              case "thought":
                md += `  ${s.step_number}. [thought] ${s.content.slice(0, 200)}\n`;
                break;
              case "tool_call":
                md += `  ${s.step_number}. [tool] ${s.tool_name}(${s.tool_input.slice(0, 100)})\n`;
                break;
              case "tool_result":
                md += `  ${s.step_number}. [result] ${s.tool_output.slice(0, 200)}\n`;
                break;
              case "error":
                md += `  ${s.step_number}. [error] ${s.content}\n`;
                break;
              case "final":
                md += `  ${s.step_number}. [final] ${s.content.slice(0, 200)}\n`;
                break;
            }
          }
        }

        return textResult(md);
      },
    }),

    // ── kernel_agents_history ────────────────────────
    defineTool({
      name: "kernel_agents_history",
      description: "List past runs for an agent",
      schema: z.object({
        agent_id: z.string().describe("Agent ID"),
        limit: z.number().optional().describe("Max results (default: 20)"),
        status: z.string().optional().describe("Filter by status: pending, running, completed, failed, cancelled"),
      }),
      handler: async (input) => {
        const runs = service.listRuns({
          agent_id: input.agent_id,
          status: input.status,
          limit: input.limit ?? 20,
        });

        if (runs.length === 0) return textResult("No runs found.");

        const lines = runs.map((r) =>
          `- **${r.id}** — ${r.status} (${r.trigger_type}) | ${r.steps_count} steps, ${r.tokens_used} tokens | ${r.created_at}`,
        );
        return textResult(`**${runs.length} run(s):**\n${lines.join("\n")}`);
      },
    }),

    // ── kernel_agents_add_trigger ────────────────────
    defineTool({
      name: "kernel_agents_add_trigger",
      description: "Add an event trigger or schedule to an agent. Event triggers fire when a matching event occurs. Schedules run periodically.",
      schema: z.object({
        agent_id: z.string().describe("Agent ID"),
        type: z.enum(["event", "schedule"]).describe("Trigger type"),
        event_name: z.string().optional().describe("Event name to listen for (required for event type, e.g. 'reminder.fired', 'data.changed')"),
        filter: z.string().optional().describe("JSON filter to match event payload (e.g. '{\"module\":\"crm\"}')"),
        cooldown_ms: z.number().optional().describe("Min time between event triggers in ms (default: 60000)"),
        interval_ms: z.number().optional().describe("Interval in ms for schedule type (e.g. 3600000 = 1h). Use cron instead for time-based scheduling."),
        cron: z.string().optional().describe("Cron expression for schedule type (e.g. '0 7 * * *' = daily at 7am, '0 */6 * * *' = every 6h, '0 9 * * 1' = Monday 9am). Takes precedence over interval_ms."),
        goal_override: z.string().optional().describe("Optional goal override for scheduled runs"),
      }),
      handler: async (input) => {
        const agent = service.getAgent(input.agent_id);
        if (!agent) return errorResult("Agent not found");

        if (input.type === "event") {
          if (!input.event_name) return errorResult("event_name is required for event triggers");

          let filterObj: Record<string, unknown> = {};
          if (input.filter) {
            try { filterObj = JSON.parse(input.filter); } catch { return errorResult("Invalid filter JSON"); }
          }

          const trigger = service.addEventTrigger({
            agent_id: input.agent_id,
            event_name: input.event_name,
            filter: filterObj,
            cooldown_ms: input.cooldown_ms,
          });

          return textResult(
            `Event trigger added (${trigger.id})\n` +
            `- Event: ${trigger.event_name}\n` +
            `- Cooldown: ${trigger.cooldown_ms}ms`,
          );
        }

        // Schedule — require either cron or interval_ms
        if (!input.cron && (!input.interval_ms || input.interval_ms < 60_000)) {
          return errorResult("Either cron expression or interval_ms (>= 60000) is required for schedules");
        }

        const schedule = service.addSchedule({
          agent_id: input.agent_id,
          interval_ms: input.interval_ms,
          cron_expression: input.cron,
          goal_override: input.goal_override,
        });

        const scheduleInfo = input.cron
          ? `- Cron: \`${input.cron}\``
          : `- Interval: ${input.interval_ms}ms`;

        return textResult(
          `Schedule added (${schedule.id})\n` +
          `${scheduleInfo}\n` +
          `- Next run: ${schedule.next_run_at}`,
        );
      },
    }),

    // ── kernel_agents_remove_trigger ─────────────────
    defineTool({
      name: "kernel_agents_remove_trigger",
      description: "Remove an event trigger or schedule from an agent",
      schema: z.object({
        trigger_id: z.string().describe("Trigger or schedule ID"),
        type: z.enum(["event", "schedule"]).describe("Type of trigger to remove"),
      }),
      handler: async (input) => {
        const { trigger_id, type } = input;

        const ok = type === "event"
          ? service.removeEventTrigger(trigger_id)
          : service.removeSchedule(trigger_id);

        if (!ok) return errorResult(`${type} trigger not found`);
        return textResult(`${type} trigger removed.`);
      },
    }),

    // ── kernel_agents_feedback ──────────────────────
    defineTool({
      name: "kernel_agents_feedback",
      description: "Rate an agent run and provide feedback. The agent learns from feedback to improve future runs.",
      schema: z.object({
        run_id: z.string().describe("Run ID to provide feedback on"),
        rating: z.number().min(1).max(5).describe("Rating 1-5 (1=terrible, 5=perfect)"),
        outcome: z.enum(["success", "partial", "failure", "neutral"]).optional().describe("Outcome classification"),
        lesson: z.string().optional().describe("What the agent should learn from this run"),
      }),
      handler: async (input) => {
        const run = service.getRun(input.run_id);
        if (!run) return errorResult("Run not found");

        const feedback = service.addFeedback({
          agent_id: run.agent_id,
          run_id: input.run_id,
          rating: input.rating,
          outcome: input.outcome,
          lesson: input.lesson,
        });

        // Auto-generate learning if lesson provided
        if (input.lesson?.trim()) {
          const type = input.outcome === "failure" ? "avoid" : input.outcome === "success" ? "prefer" : "insight";
          service.addLearning({
            agent_id: run.agent_id,
            type,
            content: input.lesson.trim(),
            confidence: input.rating >= 4 ? 0.8 : input.rating >= 3 ? 0.5 : 0.3,
            source_runs: [input.run_id],
          });
        }

        return textResult(
          `Feedback recorded (${feedback.id})\n` +
          `- Rating: ${"★".repeat(input.rating)}${"☆".repeat(5 - input.rating)}\n` +
          `- Outcome: ${feedback.outcome}\n` +
          (input.lesson ? `- Learning saved: "${input.lesson.slice(0, 100)}"` : ""),
        );
      },
    }),

    // ── kernel_agents_stats ──────────────────────
    defineTool({
      name: "kernel_agents_stats",
      description: "Get performance stats for an agent: success rate, avg tokens, top tools, common errors, learnings",
      schema: z.object({
        agent_id: z.string().describe("Agent ID"),
      }),
      handler: async (input) => {
        const { agent_id } = input;
        const agent = service.getAgent(agent_id);
        if (!agent) return errorResult("Agent not found");

        const stats = service.getAgentStats(agent_id);
        const learnings = service.getLearnings(agent_id);

        let md = `# ${agent.name} — Performance\n\n`;
        md += `| Metric | Value |\n|--------|-------|\n`;
        md += `| Total runs | ${stats.total_runs} |\n`;
        md += `| Success rate | ${stats.success_rate}% |\n`;
        md += `| Avg tokens | ${stats.avg_tokens} |\n`;
        md += `| Avg steps | ${stats.avg_steps} |\n`;
        if (stats.avg_rating !== null) md += `| Avg rating | ${stats.avg_rating.toFixed(1)}/5 |\n`;

        if (stats.top_tools.length > 0) {
          md += `\n**Top tools:**\n`;
          stats.top_tools.forEach(t => {
            md += `- \`${t.tool}\` × ${t.count}\n`;
          });
        }

        if (stats.common_errors.length > 0) {
          md += `\n**Common errors:**\n`;
          stats.common_errors.forEach(e => md += `- ${e}\n`);
        }

        if (learnings.length > 0) {
          md += `\n**Learnings (${learnings.length}):**\n`;
          learnings.forEach(l => {
            const icon = l.type === "avoid" ? "🚫" : l.type === "prefer" ? "✅" : l.type === "pattern" ? "🔄" : "💡";
            md += `${icon} (${(l.confidence * 100).toFixed(0)}%) ${l.content}\n`;
          });
        }

        return textResult(md);
      },
    }),

    // ── kernel_agents_add_learning ────────────────
    defineTool({
      name: "kernel_agents_add_learning",
      description: "Manually add a learning/insight to an agent. High-confidence learnings are injected into the agent's system prompt.",
      schema: z.object({
        agent_id: z.string().describe("Agent ID"),
        type: z.enum(["pattern", "avoid", "prefer", "insight"]).describe("Learning type: pattern (observed), avoid (don't do), prefer (do this), insight (general)"),
        content: z.string().describe("The learning content"),
        confidence: z.number().min(0).max(1).optional().describe("Confidence 0-1 (default: 0.7)"),
      }),
      handler: async (input) => {
        const agent = service.getAgent(input.agent_id);
        if (!agent) return errorResult("Agent not found");

        const learning = service.addLearning({
          agent_id: input.agent_id,
          type: input.type,
          content: input.content,
          confidence: input.confidence ?? 0.7,
        });

        return textResult(`Learning added (${learning.id}): [${input.type}] ${input.content.slice(0, 100)}`);
      },
    }),

    // ── kernel_agents_list_triggers ──────────────────
    defineTool({
      name: "kernel_agents_list_triggers",
      description: "List event triggers, schedules, and chains for an agent",
      schema: z.object({
        agent_id: z.string().describe("Agent ID"),
      }),
      handler: async (input) => {
        const { agent_id } = input;

        const triggers = service.listEventTriggers(agent_id);
        const schedules = service.listSchedules(agent_id);
        const chains = service.listChains(agent_id);

        let md = "";

        if (triggers.length > 0) {
          md += `**Event Triggers (${triggers.length}):**\n`;
          for (const t of triggers) {
            md += `- ${t.id} — event: \`${t.event_name}\` | cooldown: ${t.cooldown_ms}ms | ${t.active ? "active" : "inactive"}\n`;
          }
        }

        if (schedules.length > 0) {
          md += `\n**Schedules (${schedules.length}):**\n`;
          for (const s of schedules) {
            const timing = s.cron_expression ? `cron: \`${s.cron_expression}\`` : `every ${s.interval_ms}ms`;
            md += `- ${s.id} — ${timing} | next: ${s.next_run_at} | ${s.active ? "active" : "inactive"}\n`;
          }
        }

        if (chains.length > 0) {
          md += `\n**Chains (${chains.length}):**\n`;
          for (const c of chains) {
            const dir = c.source_agent_id === agent_id ? "→ out" : "← in";
            const other = c.source_agent_id === agent_id ? c.target_agent_id : c.source_agent_id;
            md += `- ${c.id} [${dir}] agent: ${other} | label: "${c.label}" | pass_result: ${c.pass_result ? "yes" : "no"} | delay: ${c.delay_ms}ms\n`;
          }
        }

        if (!md) return textResult("No triggers, schedules, or chains found.");
        return textResult(md);
      },
    }),

    // ── kernel_agents_chain ──────────────────────────
    defineTool({
      name: "kernel_agents_chain",
      description: "Create a declarative chain between two agents. When the source agent completes, the target agent is automatically triggered.",
      schema: z.object({
        source_agent_id: z.string().describe("Source agent ID (triggers the chain on completion)"),
        target_agent_id: z.string().describe("Target agent ID (receives the chain)"),
        label: z.string().optional().describe("Label for this chain connection"),
        condition: z.string().optional().describe("JSON condition: {\"status\":\"completed\"}, {\"result_contains\":\"keyword\"}, {} = always"),
        pass_result: z.boolean().optional().describe("Pass source result as context to target (default: true)"),
        delay_ms: z.number().optional().describe("Delay in ms before triggering target (default: 0)"),
      }),
      handler: async (input) => {
        const source = service.getAgent(input.source_agent_id);
        if (!source) return errorResult("Source agent not found");
        const target = service.getAgent(input.target_agent_id);
        if (!target) return errorResult("Target agent not found");

        let condObj: Record<string, unknown> = {};
        if (input.condition) {
          try { condObj = JSON.parse(input.condition); } catch { return errorResult("Invalid condition JSON"); }
        }

        const chain = service.addChain({
          source_agent_id: input.source_agent_id,
          target_agent_id: input.target_agent_id,
          label: input.label,
          condition: condObj,
          pass_result: input.pass_result,
          delay_ms: input.delay_ms,
        });

        return textResult(
          `Chain created (${chain.id})\n` +
          `**${source.name}** → **${target.name}**\n` +
          `- Label: ${chain.label || "(none)"}\n` +
          `- Pass result: ${chain.pass_result ? "yes" : "no"}\n` +
          `- Delay: ${chain.delay_ms}ms\n` +
          `- Condition: ${chain.condition}`,
        );
      },
    }),

    // ── kernel_agents_unchain ────────────────────────
    defineTool({
      name: "kernel_agents_unchain",
      description: "Remove a chain between two agents",
      schema: z.object({
        chain_id: z.string().describe("Chain ID to remove"),
      }),
      handler: async (input) => {
        const { chain_id } = input;
        const ok = service.removeChain(chain_id);
        if (!ok) return errorResult("Chain not found");
        return textResult("Chain removed.");
      },
    }),

    // ── kernel_office_create ────────────────────────
    // Office Kit: one declarative call creates/refreshes a whole office —
    // flow + agents (+ chains + cron + repo registration). Same engine as the
    // dashboard "New Office" wizard and `scripts/seed-office.ts`. Idempotent:
    // flows match on name, agents on slug; operator pauses and hand-edited
    // variables survive re-runs.
    defineTool({
      name: "kernel_office_create",
      description:
        "Create or refresh a whole office (department) in one declarative call: flow + agents + optional chains, cron and home repo. " +
        "Agents get smart defaults — with `repo` set they become claude_code executors with native FS tools jailed to that cwd. " +
        "Idempotent (flow matches by name, agents by slug). The office appears in the 3D agents-flow view immediately.",
      schema: z.object({
        name: z.string().describe("Office name, e.g. 'Marketing'. Idempotency key."),
        description: z.string().optional(),
        color: z.string().optional().describe("Hex color of the 3D room, e.g. '#16a34a'. Default: palette pick."),
        repo: z.string().optional().describe("Host repo path ('~' expands). Implies claude_code agents with cwd there."),
        previewUrl: z.string().optional().describe("URL shown as a clickable preview link in the dashboard."),
        discipline: z.union([z.string(), z.literal(false)]).optional()
          .describe("Shared preamble prepended to every agent prompt. false = none. Default: generic office discipline."),
        agents: z.array(z.object({
          slug: z.string().optional().describe("Stable unique id, e.g. 'marketing-lead'. Auto-derived from name when omitted."),
          name: z.string(),
          role: z.enum(["manager", "worker"]).optional().describe("Default worker."),
          description: z.string().optional(),
          prompt: z.string().describe("System prompt (office discipline is auto-prepended)."),
          goal: z.string().optional().describe("goal_template — supports {{event.message}}."),
          tools: z.array(z.string()).optional().describe("allowed_tools. Omit = all tools."),
          deniedTools: z.array(z.string()).optional(),
          plugins: z.array(z.string()).optional(),
          chainTo: z.array(z.string()).optional().describe("Slugs this agent dispatches to (creates chains)."),
          maxIterations: z.number().optional(),
          timeoutMs: z.number().optional(),
        })).min(1),
        cron: z.object({
          agent: z.string().describe("Slug or name of the agent to schedule (usually the manager)."),
          every: z.union([z.string(), z.number()]).describe("'45m', '6h', '90s' or raw ms. Clamped to the 5-min floor."),
          goal: z.string().optional().describe("goal_override for scheduled runs. Default 'resume'."),
        }).optional(),
      }),
      handler: async (input) => {
        const { officeDefinitionFromJson, materializeOffice, loadRepoServiceBestEffort } =
          await import("./office-kit.js");
        const def = officeDefinitionFromJson(input);
        const db = service.getDb();
        const repoService = def.repo ? await loadRepoServiceBestEffort(db) : null;
        const report = materializeOffice(db, service, def, { repoService });
        const lines = [
          `Office **${report.flowName}** ready (flow ${report.flowId}).`,
          report.created.length ? `- Created agents: ${report.created.join(", ")}` : "",
          report.updated.length ? `- Refreshed agents: ${report.updated.join(", ")}` : "",
          report.chained.length ? `- Chains: ${report.chained.map(([s, t]) => `${s}→${t}`).join(", ")}` : "",
          report.scheduled ? `- Cron: ${report.scheduled.agent} every ${Math.round(report.scheduled.intervalMs / 60000)} min` : "",
          report.repo ? `- Repo: ${report.repo.path} (${report.repo.registered ? "registered" : "NOT registered"})` : "",
          ...report.warnings.map((w) => `- ⚠ ${w}`),
          "",
          "The office is live — open the 3D agents-flow view to see it.",
        ].filter(Boolean);
        return textResult(lines.join("\n"));
      },
    }),

    // ── kernel_agents_flows_create ──────────────────
    // Mint a new flow (department / office). Counterpart of the dashboard
    // POST /api/agents/flows route — without this, LLM-driven office
    // creation can't make a real flow and ends up writing orphan agents.
    defineTool({
      name: "kernel_agents_flows_create",
      description: "Create a new flow (department / office). Returns the new flow id, which you must pass to subsequent kernel_agents_create calls so the agents show up under this office in the 3D view.",
      schema: z.object({
        name: z.string().describe("Short office name, e.g. 'Ventas' or 'Content Factory'"),
        description: z.string().optional().describe("One-line summary of what this office does"),
        color: z.string().optional().describe("Hex color for the 3D room marker, e.g. '#10b981'"),
      }),
      handler: async (input) => {
        if (!input.name?.trim()) return errorResult("Name is required");
        const flow = service.createFlow({
          name: input.name.trim(),
          description: input.description?.trim(),
          color: input.color?.trim(),
        });
        return textResult(
          `Flow created: **${flow.name}** (id: ${flow.id})\n` +
          `- Color: ${flow.color}\n` +
          `- Description: ${flow.description || "(none)"}\n\n` +
          `Pass \`flow_id: "${flow.id}"\` to \`kernel_agents_create\` so new agents land inside this office.`,
        );
      },
    }),

    // ── kernel_agents_flows_list ────────────────────
    defineToolNoInput({
      name: "kernel_agents_flows_list",
      description: "List active flows (offices / departments). Use this before creating a new one to avoid duplicates.",
      handler: async () => {
        const flows = service.listFlows();
        if (flows.length === 0) return textResult("No flows yet.");
        const lines = flows.map(f => {
          const home = service.resolveFlowHome(f.id);
          const homeStr = home
            ? ` — home: ${home.kind === "git" ? `git \`${home.path}\`` : `workspace \`${home.path}\``}`
            : "";
          return `- **${f.name}** (\`${f.id}\`) — ${f.description || "(no description)"}${homeStr}`;
        });
        return textResult(`Active flows (${flows.length}):\n\n${lines.join("\n")}`);
      },
    }),

    // ── kernel_agents_flows_set_repo ────────────────
    // Promote an office to a host git repo so all its agents work there, or
    // revert it (empty path) back to its kernel workspace home. Seeds the
    // office folder convention (CHARTER / MEMORY / decisions / docs) and, by
    // default, runs `git init` on a fresh directory.
    defineTool({
      name: "kernel_agents_flows_set_repo",
      description: "Promote an office (flow) to a host git repo all its agents work in, or revert it. Pass an absolute path to promote; omit/empty path to revert to the kernel workspace home. Agents without their own __cwd_path__ override will use this directory as cwd.",
      schema: z.object({
        flow_id: z.string().describe("Office/flow id (from kernel_agents_flows_list)"),
        path: z.string().optional().describe("Absolute host path, e.g. /home/you/projects/my-office. Omit or empty to revert to the kernel workspace."),
        git_init: z.boolean().optional().describe("Run `git init` if the directory is not already a git repo. Default true."),
      }),
      handler: async (input) => {
        const flowId = input.flow_id?.trim();
        if (!flowId) return errorResult("flow_id is required");
        const flow = service.getFlow(flowId);
        if (!flow) return errorResult(`Flow not found: ${flowId}`);

        const raw = input.path?.trim() ?? "";
        if (!raw) {
          service.setFlowRepo(flowId, "");
          const home = service.resolveFlowHome(flowId);
          return textResult(
            `Office **${flow.name}** reverted to its kernel workspace home` +
            (home ? ` (\`${home.path}\`).` : "."),
          );
        }
        if (!isAbsolute(raw)) {
          return errorResult("path must be absolute (e.g. /home/you/office or C:\\Users\\you\\office)");
        }

        mkdirSync(raw, { recursive: true });

        let gitNote = "";
        if (input.git_init !== false && !existsSync(join(raw, ".git"))) {
          const r = spawnSync("git", ["init"], { cwd: raw, encoding: "utf8" });
          const gitMissing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
          gitNote = r.status === 0
            ? "\n- `git init` ✓"
            : gitMissing
              ? "\n- git init skipped (git is not installed — install Git from https://git-scm.com to version this office)"
              : `\n- git init skipped (${(r.stderr || r.error?.message || "git unavailable").toString().trim().slice(0, 120)})`;
        }

        try {
          seedOfficeHome(raw, flow);
        } catch (err) {
          log.warn(`set_repo: seedOfficeHome failed for ${raw}: ${err instanceof Error ? err.message : String(err)}`);
        }

        service.setFlowRepo(flowId, raw);
        return textResult(
          `Office **${flow.name}** promoted to git repo:\n` +
          `- Path: \`${raw}\`${gitNote}\n` +
          `- Seeded CHARTER.md / MEMORY.md / decisions/ / docs/ (existing files untouched)\n\n` +
          `Agents in this office without a \`__cwd_path__\` override will now work here.`,
        );
      },
    }),

    // ── kernel_agents_directory ─────────────────────
    defineTool({
      name: "kernel_agents_directory",
      description: "View the full office directory — all departments (flows) with their agents, roles, capabilities, and connections. Use this to find agents you can request help from or delegate work to.",
      schema: z.object({
        flow_id: z.string().optional().describe("Filter to a specific department/flow ID. Omit to see all."),
      }),
      outputSchema: z.object({
        flows: z.array(z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          agents: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            kind: z.enum(["LLM", "CLI", "Function"]),
            provider: z.string(),
            chains_in: z.array(z.string()),
            chains_out: z.array(z.string()),
          })),
        })),
        unassigned: z.array(z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          kind: z.enum(["LLM", "CLI", "Function"]),
        })),
      }),
      tags: ["agents", "directory", "discovery"],
      handler: async (input) => {
        const flows = service.listFlows();
        const allAgents = service.listAgents({ active: true });
        const allChains = service.listChains();

        const targetFlows = input.flow_id
          ? flows.filter(f => f.id === input.flow_id)
          : flows;

        const kindOf = (a: typeof allAgents[number]): "LLM" | "CLI" | "Function" =>
          !a.builtin_handler ? "LLM" : a.builtin_handler.startsWith("script:") ? "CLI" : "Function";

        // ── Structured projection (used by code_run and structured-aware clients) ──
        const structuredFlows = targetFlows
          .map((flow) => {
            const flowAgents = allAgents.filter(a => a.flow_id === flow.id);
            return {
              id: flow.id,
              name: flow.name,
              description: flow.description ?? "",
              agents: flowAgents.map((a) => ({
                id: a.id,
                name: a.name,
                description: a.description ?? "",
                kind: kindOf(a),
                provider: a.provider ?? "",
                chains_in: allChains
                  .filter(c => c.target_agent_id === a.id)
                  .map(c => allAgents.find(x => x.id === c.source_agent_id)?.name ?? c.source_agent_id),
                chains_out: allChains
                  .filter(c => c.source_agent_id === a.id)
                  .map(c => allAgents.find(x => x.id === c.target_agent_id)?.name ?? c.target_agent_id),
              })),
            };
          })
          .filter((f) => f.agents.length > 0);

        const unassigned = allAgents.filter(a => !a.flow_id || !flows.some(f => f.id === a.flow_id));
        const structuredUnassigned = !input.flow_id
          ? unassigned.map((a) => ({
              id: a.id,
              name: a.name,
              description: a.description ?? "",
              kind: kindOf(a),
            }))
          : [];

        // ── Markdown rendering (legacy text path) ──
        const sections: string[] = ["# Office Directory\n"];
        for (const f of structuredFlows) {
          sections.push(`## ${f.name} (${f.agents.length} staff)`);
          if (f.description) sections.push(`_${f.description}_`);
          for (const a of f.agents) {
            let line = `- **${a.name}** (id: ${a.id}) [${a.kind}]`;
            if (a.description) line += ` — ${a.description}`;
            if (a.provider) line += ` | provider: ${a.provider}`;
            if (a.chains_in.length > 0) line += ` | receives from: ${a.chains_in.join(", ")}`;
            if (a.chains_out.length > 0) line += ` | sends to: ${a.chains_out.join(", ")}`;
            sections.push(line);
          }
          sections.push("");
        }
        if (structuredUnassigned.length > 0) {
          sections.push(`## General (${structuredUnassigned.length} unassigned)`);
          for (const a of structuredUnassigned) {
            sections.push(`- **${a.name}** (id: ${a.id}) [${a.kind}]${a.description ? ` — ${a.description}` : ""}`);
          }
        }

        return {
          ...textResult(sections.join("\n")),
          structuredContent: { flows: structuredFlows, unassigned: structuredUnassigned },
        };
      },
    }),

    // ── kernel_agents_memory ────────────────────────
    defineTool({
      name: "kernel_agents_memory",
      description: "Read an agent's conversational memory — recent interactions with humans and other agents. Use this to check what another agent has been working on or said recently.",
      schema: z.object({
        agent_id: z.string().describe("Agent ID to read memory from"),
        limit: z.number().optional().describe("Max messages to return (default: 10)"),
      }),
      handler: async (input) => {
        const memory = service.getMemory(input.agent_id, input.limit ?? 10);
        if (memory.length === 0) return textResult("No conversation history for this agent.");

        const agent = service.getAgent(input.agent_id);
        const name = agent?.name || input.agent_id;
        const lines = [`**${name}'s recent memory** (${memory.length} messages):\n`];
        for (const m of memory.reverse()) {
          const ts = m.created_at.slice(0, 16).replace("T", " ");
          lines.push(`[${ts}] ${m.role === "user" ? "Received" : "Said"}: ${m.content.slice(0, 300)}`);
        }
        return textResult(lines.join("\n"));
      },
    }),

    // ── kernel_agents_ask_supervisor ──────────────────────
    // Human-in-the-loop. When an agent (especially a manager after a meeting)
    // has an open question it cannot resolve itself, it sends the question
    // here with a small set of canned answers. The question shows up in the
    // user's My Office panel with clickable buttons. When the user picks one,
    // the answer gets posted back to the asking agent's inbox.
    ...(() => {
      const askSupervisorSchema = z.object({
        question: z.string().describe("The question, in one sentence."),
        context: z.string().optional().describe("Background the user needs to decide (meeting summary, trade-offs)."),
        options: z.array(z.object({
          label: z.string().describe("Short option label the user sees as a button."),
          value: z.string().optional().describe("Optional internal value; defaults to label."),
          url: z.string().optional().describe("If set, picking this option opens the URL in a new browser tab (e.g. 'Yes — open the link' style options). Must be http(s)://."),
        })).min(2).max(6).describe("2–6 multiple-choice options."),
        meeting_id: z.string().optional().describe("If the question came out of a meeting, reference its id."),
        ...CALLER_AGENT_ID_FIELD,
      });
      const askSupervisorHandler = async (input: z.infer<typeof askSupervisorSchema>) => {
        const callerId = input.__caller_agent_id ?? "";
        if (!callerId) return errorResult("Caller agent context missing — ask_supervisor is only usable from an agent run.");
        const caller = service.getAgent(callerId);
        if (!caller) return errorResult(`Caller agent not found: ${callerId}`);

        const question = input.question.trim();
        if (!question) return errorResult("`question` is required");
        const options = input.options
          .map((o) => {
            const label = o.label.trim();
            const value = o.value ?? label;
            // Only accept http(s) URLs — defense against agents trying to ship
            // `javascript:` or `file:` payloads that would XSS the dashboard.
            let url: string | undefined;
            if (typeof o.url === "string") {
              const u = o.url.trim();
              if (/^https?:\/\//i.test(u)) url = u;
            }
            return label ? { label, value, ...(url ? { url } : {}) } : null;
          })
          .filter((x): x is { label: string; value: string; url?: string } => x !== null);
        if (options.length < 2) return errorResult("Need at least 2 options");

        const res = service.createQuestion({
          from_agent_id: caller.id,
          flow_id: caller.flow_id ?? "",
          meeting_id: input.meeting_id ?? "",
          // `run_id` is never populated: no code path in src/ injects
          // `__caller_run_id` (AgentExecutor only injects `__caller_agent_id`).
          // Kept as a fixed "" rather than removing the column/field from
          // createQuestion() — changing it would touch AgentService's
          // question schema for a field that already never had any value.
          run_id: "",
          question,
          context: input.context ?? "",
          options,
        });
        events.emit("agent:flow:question_asked" as any, {
          question_id: res.id,
          from_agent_id: caller.id,
          from_agent_name: caller.name,
          flow_id: caller.flow_id ?? "",
          question,
          options: options.map(o => o.label),
          ts: new Date().toISOString(),
        });
        return textResult(
          `Question ${res.id} escalated to your supervisor. The answer will land in your inbox.`,
        );
      };

      return [
        defineTool({
          name: "kernel_agents_ask_supervisor",
          description:
            "Escalate an open question to your supervisor (the human user, at the top of the org) with multiple-choice answers. " +
            "Use this after a meeting or when a decision requires human input. Provide 2-5 concrete options. " +
            "The answer comes back as an inbox message on your next run.",
          schema: askSupervisorSchema,
          handler: askSupervisorHandler,
        }),
      ];
    })(),

    // ── kernel_agents_post_to_colleague ───────────────
    defineTool({
      name: "kernel_agents_post_to_colleague",
      description:
        "Leave an async message in another agent's inbox. Works ACROSS offices — every agent can reach every other agent. " +
        "The recipient does NOT run immediately — the message appears as a 'PENDING REQUESTS FROM COLLEAGUES' block " +
        "in their system prompt the next time they run, then is marked read. " +
        "Use this for blockers, clarifications, escalations, and hand-backs. For blocking one-shot questions use " +
        "kernel_agents_invoke; for group deliberation use kernel_agents_call_meeting. " +
        "To continue a thread, pass `in_reply_to_message_id` (the conversation-message id of the turn you are replying to) " +
        "or an explicit `conversation_id`. To signal disagreement with something the recipient (or a peer) said, set " +
        "`role: \"counter\"` — 2+ counters from different agents on the same conversation auto-opens a debate.",
      schema: z.object({
        to_agent_id: z.string().optional().describe("UUID of the recipient. Preferred."),
        to_agent_name: z.string().optional().describe("Exact agent name (within your own office for name-only lookups). Use UUID across offices."),
        subject: z.string().describe("One-line subject. Max 300 chars."),
        body: z.string().describe("Message body (markdown OK). Include context and what action you want."),
        role: z.enum(["stmt","question","answer","counter","vote","summary"]).optional().describe("Semantic role of this turn. Default 'stmt'. Use 'counter' to disagree."),
        in_reply_to_message_id: z.string().optional().describe("Conversation-message id you are replying to. Keeps the thread together."),
        conversation_id: z.string().optional().describe("Explicit conversation id to append to. Omit to find-or-create by topic+participants."),
        ...CALLER_AGENT_ID_FIELD,
      }),
      handler: async (input) => {
        const callerId = input.__caller_agent_id ?? "";
        if (!callerId) {
          return errorResult("Caller agent context missing — kernel_agents_post_to_colleague is only usable from an agent run.");
        }
        const caller = service.getAgent(callerId);
        if (!caller) return errorResult(`Caller agent not found: ${callerId}`);

        const subject = input.subject.trim();
        const rawBody = input.body.trim();
        if (!subject) return errorResult("`subject` is required");
        if (!rawBody) return errorResult("`body` is required");

        // Let the agent wrap its body in <msg role="..."> — we pull the role
        // and strip the wrapper for storage. Explicit `role` in args wins.
        const wrappedRole = extractRoleFromReply(rawBody);
        const body = stripRoleWrapper(rawBody);
        const explicitRole = input.role ?? "";
        const role = (explicitRole || wrappedRole || "stmt") as
          "stmt" | "question" | "answer" | "counter" | "vote" | "summary";

        let toId = input.to_agent_id?.trim() ?? "";
        const toName = input.to_agent_name?.trim() ?? "";
        if (!toId && toName) {
          // Name-only resolution is scoped to the caller's office to stay
          // unambiguous. Cross-office calls must supply the UUID.
          if (!caller.flow_id) {
            return errorResult(`Cannot resolve agent name "${toName}" without an office context — supply to_agent_id instead.`);
          }
          const resolved = service.findAgentByNameInFlow(caller.flow_id, toName);
          if (!resolved) {
            return errorResult(`No agent named "${toName}" found in your office. Use kernel_agents_directory or supply to_agent_id.`);
          }
          toId = resolved.id;
        }
        if (!toId) {
          return errorResult("Either `to_agent_id` or `to_agent_name` is required.");
        }

        const conversationId = input.conversation_id;
        const inReplyTo = input.in_reply_to_message_id;

        const result = service.postToColleague({
          from_agent_id: callerId,
          to_agent_id: toId,
          subject,
          body,
          role,
          in_reply_to_message_id: inReplyTo,
          conversation_id: conversationId,
        });
        if (!result.message) return errorResult(result.error ?? "Failed to post message");

        const recipient = service.getAgent(toId);
        // Escalation event for the 3D flow: fire when the sender is a manager
        // (top-down directive) OR the post crosses office boundaries (cross-team
        // coordination). The 3D uses this to draw a distinct beam + bubble so
        // the user can see who is pushing work onto whom in real time.
        const crossOffice = !!(caller.flow_id && recipient?.flow_id && caller.flow_id !== recipient.flow_id);
        const isManager = caller.role === "manager";
        if (isManager || crossOffice) {
          events.emit("agent:flow:escalation" as any, {
            from_agent_id: caller.id,
            from_agent_name: caller.name,
            from_role: caller.role || "worker",
            to_agent_id: toId,
            to_agent_name: recipient?.name ?? toId,
            subject,
            body_preview: body.slice(0, 200),
            role,
            cross_office: crossOffice,
            is_manager_directive: isManager,
            ts: new Date().toISOString(),
          });
        }
        const convoLine = result.conversation
          ? `\nConversation: ${result.conversation.id} (turn ${result.conversation_message?.id ?? "?"}, role=${role})`
          : "";
        return textResult(
          `Posted to **${recipient?.name ?? toId}**'s inbox (id: ${result.message.id}).\n` +
          `They will see it at the top of their next run.` +
          convoLine,
        );
      },
    }),

    // ── kernel_agents_inbox ───────────────────────────
    defineTool({
      name: "kernel_agents_inbox",
      description:
        "Read an agent's office inbox (messages from colleagues). Defaults to the caller's own inbox and " +
        "shows unread items only. Useful for the dashboard or to check what's pending before a run.",
      schema: z.object({
        agent_id: z.string().optional().describe("Agent whose inbox to read. Defaults to the caller."),
        status: z.enum(["unread", "read", "archived"]).optional().describe("Filter by status (default: unread)"),
        limit: z.number().optional().describe("Max messages (default: 20)"),
        ...CALLER_AGENT_ID_FIELD,
      }),
      handler: async (input) => {
        const callerId = input.__caller_agent_id ?? "";
        const targetId = input.agent_id || callerId;
        if (!targetId) return errorResult("No agent_id provided and no caller context available.");

        const status = input.status ?? "unread";
        const limit = input.limit ?? 20;
        const messages = service.listInbox(targetId, { status, limit });
        if (messages.length === 0) return textResult(`No ${status} messages.`);

        const target = service.getAgent(targetId);
        const lines: string[] = [`# ${target?.name ?? targetId} — ${status} inbox (${messages.length})`];
        for (const m of messages) {
          const sender = service.getAgent(m.from_agent_id)?.name ?? m.from_agent_id;
          const ts = m.created_at.slice(0, 16).replace("T", " ");
          lines.push(`\n## [${ts}] From ${sender} — ${m.subject}`);
          lines.push(`_(id: ${m.id})_`);
          lines.push(m.body);
        }
        return textResult(lines.join("\n"));
      },
    }),

    // ── kernel_agents_call_meeting ─────────────────────
    defineTool({
      name: "kernel_agents_call_meeting",
      description:
        "Call a group meeting with other agents. You (the caller) become the moderator. " +
        "The meeting runs N structured rounds (default 2, capped at 20) where each " +
        "attendee gives input, then you synthesize into decisions and action items. " +
        "Use this when you need collaborative input from multiple agents before proceeding.",
      schema: z.object({
        topic: z.string().describe("Meeting topic / agenda item"),
        attendee_ids: z.array(z.string()).describe("Agent IDs to invite (you are already the moderator)"),
        context: z.string().optional().describe("Background document or partial result to discuss"),
        rounds: z.number().optional().describe("Number of discussion rounds (default: 2, max: 20)"),
        urgency: z.enum(["normal", "urgent"]).optional().describe("Urgency level — 'urgent' triggers red alert in the office"),
        ...CALLER_AGENT_ID_FIELD,
      }),
      handler: async (input) => {
        const meetingExecutor = getMeetingExecutor();
        if (!meetingExecutor) {
          return errorResult("Meeting executor not initialized");
        }
        if (!input.attendee_ids || input.attendee_ids.length === 0) {
          return errorResult("Need at least one attendee");
        }
        // The calling agent's ID is injected by the executor via __caller_agent_id
        // (set in the tool args when invoked from the LLM loop).
        // If missing, the first attendee becomes moderator.
        const callerId = input.__caller_agent_id;
        const moderatorId = callerId ?? input.attendee_ids[0];
        const attendeeIds = input.attendee_ids.filter(id => id !== moderatorId);

        if (attendeeIds.length === 0) {
          return errorResult("Need at least one attendee besides the moderator");
        }

        const result = await meetingExecutor.run(
          {
            topic: input.topic,
            moderator_id: moderatorId,
            attendee_ids: attendeeIds,
            context: input.context,
            rounds: input.rounds,
            urgency: input.urgency,
          },
          service,
          events,
        );

        const lines = [
          `**Meeting completed:** ${result.meeting_id}`,
          `**Topic:** ${input.topic}`,
          `**Rounds:** ${result.rounds_completed} | **Tokens:** ${result.total_tokens}`,
          "",
          "## Summary",
          result.summary,
        ];
        if (result.decisions.length > 0) {
          lines.push("", "## Decisions");
          for (const d of result.decisions) lines.push(`- ${d}`);
        }
        if (result.action_items.length > 0) {
          lines.push("", "## Action Items");
          for (const a of result.action_items) lines.push(`- ${a}`);
        }
        return textResult(lines.join("\n"));
      },
    }),

    // ── kernel_agents_subscribe_conversation ────────────────────────────
    defineTool({
      name: "kernel_agents_subscribe_conversation",
      description:
        "Subscribe an agent to a conversation. Once subscribed, every new turn in that " +
        "conversation wakes the agent with a run (mode='responder') so it can read and reply " +
        "without being explicitly invoked. Use this to keep an agent engaged in a thread " +
        "after invoke/post/meeting hands the topic over. Idempotent — re-subscribing updates " +
        "the mode/filter. Defaults: subscribe yourself unless agent_id is set.",
      schema: z.object({
        conversation_id: z.string().describe("Conversation to follow"),
        agent_id: z.string().optional().describe("Agent that will follow (defaults to caller)"),
        mode: z.enum(["responder", "observer"]).optional().describe("'responder' (default) wakes the agent; 'observer' just records the link"),
        filter_role: z.enum(["stmt", "question", "answer", "counter", "vote", "summary"]).optional().describe("Only wake on this message role (omit = any)"),
        ...CALLER_AGENT_ID_FIELD,
      }),
      handler: async (input) => {
        const callerId = input.__caller_agent_id ?? "";
        const targetId = input.agent_id || callerId;
        if (!targetId) return errorResult("agent_id is required (no caller context).");
        const conversationId = input.conversation_id;
        if (!conversationId) return errorResult("conversation_id is required.");

        const sub = service.subscribeAgentToConversation({
          agent_id: targetId,
          conversation_id: conversationId,
          mode: input.mode,
          filter_role: input.filter_role,
        });
        if (!sub) return errorResult("Subscription failed — agent or conversation not found.");

        const agent = service.getAgent(targetId);
        return textResult(
          `Subscribed **${agent?.name ?? targetId}** to conversation ${conversationId}.\n` +
          `- Mode: ${sub.mode}\n` +
          `- Filter role: ${sub.filter_role || "(any)"}\n` +
          `- Subscription id: ${sub.id}`,
        );
      },
    }),

    // ── kernel_agents_unsubscribe_conversation ─────────────────────────
    defineTool({
      name: "kernel_agents_unsubscribe_conversation",
      description:
        "Cancel a conversation subscription so the agent stops being woken by new turns. " +
        "Defaults to the caller unless agent_id is supplied.",
      schema: z.object({
        conversation_id: z.string().describe("Conversation to leave"),
        agent_id: z.string().optional().describe("Agent to unsubscribe (defaults to caller)"),
        ...CALLER_AGENT_ID_FIELD,
      }),
      handler: async (input) => {
        const callerId = input.__caller_agent_id ?? "";
        const targetId = input.agent_id || callerId;
        if (!targetId) return errorResult("agent_id is required (no caller context).");
        const conversationId = input.conversation_id;
        if (!conversationId) return errorResult("conversation_id is required.");

        const ok = service.unsubscribeAgentFromConversation(targetId, conversationId);
        return ok
          ? textResult(`Unsubscribed from ${conversationId}.`)
          : errorResult("No active subscription found for that pair.");
      },
    }),

    // ── kernel_agents_list_subscriptions ───────────────────────────────
    defineTool({
      name: "kernel_agents_list_subscriptions",
      description:
        "List active conversation subscriptions for an agent. Useful before subscribing " +
        "(to avoid duplicates) or to audit what conversations an agent is watching.",
      schema: z.object({
        agent_id: z.string().optional().describe("Agent whose subscriptions to list (defaults to caller)"),
        ...CALLER_AGENT_ID_FIELD,
      }),
      handler: async (input) => {
        const callerId = input.__caller_agent_id ?? "";
        const targetId = input.agent_id || callerId;
        if (!targetId) return errorResult("agent_id is required (no caller context).");

        const subs = service.listSubscriptionsForAgent(targetId);
        if (subs.length === 0) return textResult("No active subscriptions.");

        const agent = service.getAgent(targetId);
        const lines: string[] = [`# ${agent?.name ?? targetId} — ${subs.length} subscription(s)`];
        for (const s of subs) {
          const convo = service.getConversation(s.conversation_id);
          const topic = convo?.topic ? ` "${convo.topic.slice(0, 80)}"` : "";
          lines.push(
            `- ${s.id} → conversation ${s.conversation_id}${topic} | mode: ${s.mode} | filter: ${s.filter_role || "(any)"}`,
          );
        }
        return textResult(lines.join("\n"));
      },
    }),

    // ── kernel_skill_load ────────────────────────────
    // On-demand loader for procedural skill bodies. The agent's system_prompt
    // already lists every attached skill (slug + description); the model calls
    // this tool when a user request matches a skill's trigger pattern, to read
    // the full step-by-step playbook before acting.
    //
    // Why this exists instead of dumping all bodies into the system_prompt:
    // typical skill body is 500-2000 tokens; loading 40 of them eats 30k+
    // tokens on every call. Lazy-loading keeps the base context cheap.
    defineTool({
      name: "kernel_skill_load",
      description:
        "Load the full body of a procedural skill the agent has attached. " +
        "Call this when a user request matches a skill listed in the system_prompt's " +
        "'Available skills' section, to read the step-by-step playbook before acting.",
      schema: z.object({
        slug: z.string().describe("Skill slug — must be one listed in the agent's Available skills index"),
      }),
      handler: async (input) => {
        const { slug } = input;
        const resolver = executor.getSkillResolver();
        if (!resolver) return errorResult("Skill resolver not initialized");
        const resolved = resolver.resolve(slug);
        if (!resolved) return errorResult(`Skill not installed: ${slug}`);
        return textResult(
          `# Skill: ${resolved.slug}\n\n${resolved.description}\n\n---\n\n${resolved.body}`,
        );
      },
    }),

    // ── kernel_agents_set_skills ─────────────────────
    defineTool({
      name: "kernel_agents_set_skills",
      description:
        "Attach (or replace) the procedural skills loaded by an agent. Each slug must reference " +
        "an installed extension with type='skill'. Pass an empty array to detach all.",
      schema: z.object({
        agent_id: z.string().describe("Target agent id"),
        skills: z.array(z.string()).describe("Array of skill slugs"),
      }),
      handler: async (input) => {
        const { agent_id, skills } = input;
        const updated = service.updateAgent(agent_id, { skills });
        if (!updated) return errorResult(`Agent not found: ${agent_id}`);
        const resolver = executor.getSkillResolver();
        if (resolver) resolver.invalidate();
        return textResult(`Agent ${updated.name} now has ${skills.length} skill(s) attached.`);
      },
    }),

    // ── kernel_agents_get_skills ─────────────────────
    defineTool({
      name: "kernel_agents_get_skills",
      description: "List the procedural skills attached to an agent, with descriptions and token estimates.",
      schema: z.object({
        agent_id: z.string().describe("Target agent id"),
      }),
      handler: async (input) => {
        const { agent_id } = input;
        const agent = service.getAgent(agent_id);
        if (!agent) return errorResult(`Agent not found: ${agent_id}`);
        let slugs: string[] = [];
        try { slugs = JSON.parse(agent.skills_json ?? "[]") as string[]; } catch { /* ignore */ }
        if (slugs.length === 0) return textResult(`Agent ${agent.name} has no skills attached.`);
        const resolver = executor.getSkillResolver();
        if (!resolver) return textResult(`Slugs (resolver offline): ${slugs.join(", ")}`);
        const resolved = resolver.resolveMany(slugs);
        const totalTokens = resolved.reduce((s, r) => s + r.tokens_estimate, 0);
        const lines = resolved.map((r) => `- **${r.slug}** (~${r.tokens_estimate} tok) — ${r.description.slice(0, 200)}`);
        return textResult(
          `**${agent.name}** has ${resolved.length} skill(s) attached (~${totalTokens} tok if all loaded):\n\n${lines.join("\n")}`,
        );
      },
    }),

    // ── kernel_agents_factory_finalize ───────────────
    // The deterministic barrier of the Agent Factory. The "Agent Factory"
    // meta-agent does the intelligence (deep research → synthesize a system
    // prompt → kernel_tool_search for a verified tool set) and then calls THIS
    // tool to materialize the result safely as an INACTIVE draft. Splitting
    // mechanics out of the LLM loop means the agent can't fumble the DB write,
    // invent tool names, or skip the active=0 review gate.
    defineTool({
      name: "kernel_agents_factory_finalize",
      description:
        "Finalize an Agent Factory draft: validate the proposed tools against the real catalog, resolve/create the target office, guard against duplicates, and create the agent INACTIVE (active=0) for human review. Returns the activation command. Use AFTER you've researched the domain, synthesized the system prompt, and picked tools via kernel_tool_search.",
      schema: z.object({
        name: z.string().describe("Short human agent name, 2-4 words"),
        system_prompt: z.string().describe("Full synthesized system prompt governing the agent"),
        description: z.string().optional().describe("One-line description of what the agent does"),
        goal_template: z.string().optional().describe("Default goal prompt for runs; may use {{variables}}"),
        tool_ids: z.array(z.string()).optional().describe("Candidate tool names from kernel_tool_search. Hallucinated/unknown names are dropped automatically."),
        flow_name: z.string().optional().describe("Target office (flow) name. Resolved case-insensitively; created if missing. Default: 'No office'."),
        brief: z.string().optional().describe("Original domain brief — stored on the agent for provenance."),
        provider: z.string().optional().describe("LLM provider override; default = system default"),
        rationale: z.string().optional().describe("One line: why these tools / this design"),
        ...CALLER_AGENT_ID_FIELD,
      }),
      handler: async (input) => {
        if (!input.name?.trim()) return errorResult("name is required");
        if (!input.system_prompt?.trim()) return errorResult("system_prompt is required");

        // Manager-only when called by an agent (humans bypass). The draft is
        // always active=0 below, so this is safe by construction. Pass the
        // validated tool list as childTools so the inheritance cap applies.
        const requested = input.tool_ids ?? [];
        const validNames = new Set(executor.getToolCatalog().map((t) => t.name));
        const granted = requested.filter((n) => validNames.has(n));
        const dropped = requested.filter((n) => !validNames.has(n));

        const decision = enforceAgentMgmtPolicy(
          input,
          service,
          "create",
          granted.length > 0 ? granted : [],
        );
        if (!decision.ok) return errorResult(decision.error);

        // ── Resolve (or create) the target office ──
        const flowName = (input.flow_name?.trim() || "No office");
        let flow = service.listFlows().find(
          (f) => f.name.toLowerCase() === flowName.toLowerCase(),
        );
        if (!flow) {
          flow = service.createFlow({ name: flowName });
        }

        // ── Anti-duplicate guard: same (normalized) name already in this office ──
        const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
        const dup = service
          .listAgents()
          .find((a) => a.flow_id === flow!.id && norm(a.name) === norm(input.name));
        if (dup) {
          return errorResult(
            `An agent named "${dup.name}" already exists in office "${flow.name}" (id: ${dup.id}). ` +
            `Pick a different name or update the existing agent instead of creating a duplicate.`,
          );
        }

        // ── Create the draft (always inactive, pending human activation) ──
        const brief = input.brief?.trim() ?? "";
        const agent = service.createAgent({
          name: input.name.trim(),
          description: input.description?.trim() ?? "",
          system_prompt: input.system_prompt,
          goal_template: input.goal_template?.trim() ?? "",
          allowed_tools: granted,
          provider: input.provider?.trim() || undefined,
          flow_id: flow.id,
          show_on_dashboard: true,
          role: "worker",
          variables: brief ? ({ __factory_brief: brief } as unknown as Record<string, string>) : undefined,
        });
        // Factory drafts are ALWAYS inactive — the operator reviews the prompt
        // and tools, then activates. This holds regardless of caller (human or
        // the meta-agent).
        service.updateAgent(agent.id, { active: false });

        const toolLine = granted.length > 0
          ? granted.map((t) => `\`${t}\``).join(", ")
          : "⚠️ none verified — review before activating";
        const droppedLine = dropped.length > 0
          ? `\n- **Dropped (not real tools):** ${dropped.map((t) => `\`${t}\``).join(", ")}`
          : "";
        const rationaleLine = input.rationale?.trim()
          ? `\n- **Rationale:** ${input.rationale.trim()}`
          : "";

        return textResult(
          `🏭 **Draft agent created (INACTIVE):** ${agent.name} (id: \`${agent.id}\`)\n` +
          `- **Office:** ${flow.name} (\`${flow.id}\`)\n` +
          `- **Provider:** ${agent.provider || "default"}\n` +
          `- **Tools granted (${granted.length}):** ${toolLine}` +
          droppedLine +
          rationaleLine +
          `\n\n**Review, then activate with:**\n` +
          `\`kernel_agents_update { id: "${agent.id}", active: true }\``,
        );
      },
    }),
  ];
}
