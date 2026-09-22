/**
 * Agent operations the dashboard reaches over both the WS RPC and HTTP.
 *
 * The dashboard calls each of these through `rpcOrCall`, so the RPC action
 * and the HTTP route are the same request by two roads, and they have to
 * answer alike. They used to be written twice and had drifted: `agents.run`
 * over RPC skipped goal-template resolution and the circuit breaker,
 * `agents.update` over RPC dropped every field outside its own list
 * (wake_on_inbox, rank_id, skin_id…), and create took max_tokens on one road
 * only. Now rpc-actions.ts exposes this map as is and api-routes.ts binds each
 * entry to its path; where the two disagreed, the fuller behaviour won.
 *
 * The MCP tools are deliberately NOT built on these. An agent calling
 * `kernel_agents_update` is held to a narrower field list, a role gate and
 * pending-approval rules; the dashboard is the operator.
 */

import type { Operation } from "../../sdk/args.js";
import { pickArgs } from "../../sdk/args.js";
import { HttpError, isHttpError } from "../../sdk/http-error.js";
import { log } from "../../core/logger.js";
import type { EventBus } from "../../core/event-bus.js";
import { normalizeModelChainInput, normalizeExecutorType, normalizeSkillsInput } from "./chain-input.js";
import type { AgentService } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import { resolveGoal } from "./executor.js";
import { parseSchedulePatch } from "./services/schedules-service.js";
import { setOfficeRepo } from "./office-repo.js";

export interface AgentOperationDeps {
  service: AgentService | null;
  executor?: AgentExecutor | null;
  events?: EventBus | null;
}

/** Everything an operator may set on an agent, create and update alike. */
const AGENT_FIELDS = {
  description: "string",
  system_prompt: "string",
  goal_template: "string",
  allowed_tools: "string[]",
  denied_tools: "string[]",
  provider: "string",
  model: "string",
  max_iterations: "number",
  timeout_ms: "number",
  max_tokens: "number",
  max_errors: "number",
  variables: "object",
  show_on_dashboard: "boolean",
  builtin_handler: "string",
  rank_id: "string",
  wake_on_inbox: "boolean",
  progressive_discovery: "boolean",
  skin_id: "string",
} as const;

const EVENT_LOG_FILTER = { run_id: "string", agent_id: "string", event_type: "string", since: "string" } as const;

const now = () => new Date().toISOString();

export function agentOperations(deps: AgentOperationDeps): Record<string, Operation> {
  const { executor, events } = deps;

  const svc = (): AgentService => {
    if (!deps.service) throw new Error("Agent service not available");
    return deps.service;
  };
  const requireExecutor = (): AgentExecutor => {
    if (!executor) throw new Error("Agent executor not available");
    return executor;
  };
  const str = (input: Record<string, unknown>, key: string): string =>
    typeof input[key] === "string" ? (input[key] as string) : "";
  const required = (input: Record<string, unknown>, key: string, message = `${key} required`): string => {
    const value = str(input, key);
    if (!value) throw new HttpError(400, message);
    return value;
  };

  return {
    "agents.create": (input) => {
      const name = str(input, "name").trim();
      if (!name) throw new HttpError(400, "name is required");
      const fields = pickArgs(input, { ...AGENT_FIELDS, flow_id: "string" });
      const agent = svc().createAgent({ ...fields, name, variables: fields.variables as Record<string, string> | undefined });

      // Optional inline schedule (agent-create with cron). Non-fatal on error.
      const schedule = pickArgs(input, { schedule: "object" }).schedule;
      const cron = typeof schedule?.cron_expression === "string" ? schedule.cron_expression : "";
      if (cron) {
        try {
          svc().addSchedule({
            agent_id: agent.id,
            cron_expression: cron,
            goal_override: typeof schedule?.goal_override === "string" ? schedule.goal_override : undefined,
          });
        } catch (err) {
          log.warn(`Could not add schedule for ${agent.id}: ${String(err)}`);
        }
      }
      return { success: true, agent_id: agent.id, agent };
    },

    "agents.update": (input) => {
      const id = required(input, "id");
      const fields = pickArgs(input, { ...AGENT_FIELDS, name: "string", active: "boolean", under_revision: "boolean" });
      // The chain, the engine and the loose pair are one edit for the person
      // making it, so they have to be one write — otherwise `provider` and the
      // chain head can end up disagreeing between two requests. Skills are
      // normalized rather than passed through: see normalizeSkillsInput.
      const updated = svc().updateAgent(id, {
        ...fields,
        variables: fields.variables as Record<string, string> | undefined,
        model_chain: normalizeModelChainInput(input.model_chain),
        executor_type: normalizeExecutorType(input.executor_type),
        skills: normalizeSkillsInput(input.skills),
      });
      if (!updated) throw new HttpError(404, "Agent not found");
      return { success: true, agent: updated };
    },

    "agents.delete": (input) => {
      if (!svc().deleteAgent(required(input, "id"))) throw new HttpError(404, "Agent not found");
      return { success: true };
    },

    "agents.detail": (input) => {
      const id = required(input, "id");
      const agent = svc().getAgent(id);
      if (!agent) throw new HttpError(404, "Agent not found");
      return {
        agent,
        runs: svc().listRuns({ agent_id: id, limit: 5 }),
        triggers: svc().listEventTriggers(id),
        schedules: svc().listSchedules(id),
        adhocConnections: svc().getAdHocConnections(id),
      };
    },

    "agents.run": (input) => {
      const service = svc();
      const executor = requireExecutor();
      const agent = service.getAgent(required(input, "agent_id"));
      if (!agent) throw new HttpError(404, "Agent not found");

      // Workspace override — lets each run use its own isolated cwd (handy
      // for agents that test several OSS projects in parallel). The name is
      // sanitised to prevent path traversal.
      const workspace = str(input, "workspace");
      if (workspace && !/^[A-Za-z0-9_-]{1,64}$/.test(workspace)) {
        throw new HttpError(400, "workspace must be alphanumeric/-/_ (max 64 chars)");
      }

      // Manual runs have no event payload, so any {{event.*}} placeholders in
      // the goal_template resolve to empty strings (not left as literals).
      const resolvedTemplate = agent.goal_template ? resolveGoal(agent.goal_template, {}).trim() : "";
      const goal = str(input, "goal") || resolvedTemplate || `Execute the agent: ${agent.name}`;
      const run = service.createRun({
        agent_id: agent.id,
        trigger_type: "manual",
        goal,
        trigger_payload: workspace ? { workspace } : undefined,
      });
      service.updateRun(run.id, { status: "running", started_at: now() });

      // Run async — don't await. Both branches feed the circuit breaker: a
      // manual run counts exactly like a scheduled one, so a "Run now" that
      // keeps failing advances the counter and one that works clears it.
      executor.execute({ agent, goal, run, service, events: events ?? undefined }).then((result) => {
        service.updateRun(run.id, {
          status: result.status,
          result: result.result,
          error: result.error,
          steps_count: result.steps_count,
          tokens_used: result.tokens_used,
          completed_at: now(),
        });
        service.recordRunOutcome(agent.id, { ok: result.status === "completed", error: result.error, run_id: run.id });
      }).catch((err) => {
        service.updateRun(run.id, { status: "failed", error: String(err), completed_at: now() });
        service.recordRunOutcome(agent.id, { ok: false, error: String(err), run_id: run.id });
      });

      return { success: true, run_id: run.id, status: "running" };
    },

    "agents.stop": (input) => {
      const service = svc();
      const executor = requireExecutor();
      const cancel = (runId: string) => {
        if (!executor.cancelRun(runId)) return false;
        service.updateRun(runId, { status: "cancelled", completed_at: now() });
        return true;
      };
      const runId = str(input, "run_id");
      if (runId) return { success: true, cancelled: cancel(runId) ? 1 : 0 };
      const agentId = str(input, "agent_id");
      if (agentId) {
        const runs = service.listRuns({ agent_id: agentId, status: "running" });
        return { success: true, cancelled: runs.filter((run) => cancel(run.id)).length };
      }
      throw new HttpError(400, "agent_id or run_id required");
    },

    "agents.trigger": (input) => {
      const agent_id = required(input, "agent_id");
      const type = required(input, "type", "type required (event|schedule)");
      const args = pickArgs(input, {
        event_name: "string", filter: "object", cooldown_ms: "number",
        interval_ms: "number", cron: "string", goal_override: "string",
      });
      if (type === "event") {
        if (!args.event_name) throw new HttpError(400, "event_name required for event trigger");
        const trigger = svc().addEventTrigger({
          agent_id, event_name: args.event_name, filter: args.filter, cooldown_ms: args.cooldown_ms,
        });
        return { success: true, trigger_id: trigger.id };
      }
      if (type === "schedule") {
        if (!args.cron && (!args.interval_ms || args.interval_ms < 60000)) {
          throw new HttpError(400, "cron expression or interval_ms (>= 60000) required");
        }
        const schedule = svc().addSchedule({
          agent_id, interval_ms: args.interval_ms, cron_expression: args.cron, goal_override: args.goal_override,
        });
        return { success: true, schedule_id: schedule.id, schedule };
      }
      throw new HttpError(400, "type must be event or schedule");
    },

    "agents.chain.create": (input) => {
      const args = pickArgs(input, {
        source_agent_id: "string", target_agent_id: "string", label: "string",
        condition: "object", pass_result: "boolean", delay_ms: "number",
      });
      if (!args.source_agent_id || !args.target_agent_id) {
        throw new HttpError(400, "source_agent_id and target_agent_id required");
      }
      const chain = svc().addChain({ ...args, source_agent_id: args.source_agent_id, target_agent_id: args.target_agent_id });
      return { success: true, chain_id: chain.id, chain };
    },

    "agents.chain.delete": (input) => {
      if (!svc().removeChain(required(input, "id"))) throw new HttpError(404, "Chain not found");
      return { success: true };
    },

    "agents.eventLog.list": (input) => {
      const filter = pickArgs(input, EVENT_LOG_FILTER);
      const { limit, offset } = pickArgs(input, { limit: "number", offset: "number" });
      return {
        events: svc().getEventLog({ ...filter, limit: Math.min(limit ?? 200, 500), offset: offset ?? 0 }),
        total: svc().getEventLogCount(filter),
      };
    },

    "agents.eventLog.clear": (input) => ({
      success: true,
      deleted: svc().clearEventLog(pickArgs(input, { before: "string", agent_id: "string" })),
    }),

    "agents.graph": (input) => svc().getAgentGraph(str(input, "flow_id") || undefined),

    "agents.flows.list": () => ({ flows: svc().listFlows() }),

    "agents.flows.create": (input) => {
      const name = str(input, "name").trim();
      if (!name) throw new HttpError(400, "name is required");
      const args = pickArgs(input, { description: "string", color: "string", agent_ids: "string[]" });
      const flow = svc().createFlow({ name, description: args.description, color: args.color });
      for (const aid of args.agent_ids ?? []) svc().assignAgentToFlow(aid, flow.id);
      return { success: true, flow };
    },

    // Office Kit — one call creates/refreshes a whole office: flow + agents
    // (+ chains + cron + repo). Consumed by the "New Office" wizard on
    // /agents-flow. Same engine as `kernel_office_create` and the CLI
    // (scripts/seed-office.ts). Idempotent. An existing office is a 409 whose
    // message carries the id (`office_exists:<id>`), which is what the wizard
    // parses; any other failure is the manifest's fault, so a 400.
    "offices.create": async (input) => {
      const service = svc();
      try {
        const { officeDefinitionFromJson, materializeOffice, loadRepoServiceBestEffort, OfficeExistsError } =
          await import("./office-kit.js");
        const def = officeDefinitionFromJson(input);
        const db = service.getDb();
        const repoService = def.repo ? await loadRepoServiceBestEffort(db) : null;
        try {
          const mode = input.mode === "create" ? "create" : "upsert";
          return { success: true, report: materializeOffice(db, service, def, { repoService, mode }) };
        } catch (err) {
          if (err instanceof OfficeExistsError) throw new HttpError(409, `office_exists:${err.officeId}`, err.body);
          throw err;
        }
      } catch (err) {
        if (isHttpError(err)) throw err;
        log.error("Failed to create office", err);
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    },

    "agents.flows.delete": (input) => {
      const result = svc().deleteFlow(required(input, "id"));
      if (!result) throw new HttpError(404, "Flow not found");
      return { success: true, unassigned: result.unassigned };
    },

    "agents.flows.assign": (input) => {
      const flow_id = required(input, "flow_id");
      const agent_ids = pickArgs(input, { agent_ids: "string[]" }).agent_ids ?? [];
      if (!agent_ids.length) throw new HttpError(400, "agent_ids required");
      for (const aid of agent_ids) svc().assignAgentToFlow(aid, flow_id);
      return { success: true, assigned: agent_ids.length };
    },

    // A wrong type is an error, never a silent no-op; a cadence under the
    // floor throws ScheduleValidationError, a 400.
    "agents.schedule.update": (input) => {
      const id = required(input, "id");
      const result = parseSchedulePatch(input);
      if (!result.ok) throw new HttpError(400, result.error);
      const schedule = svc().updateSchedule(id, result.patch);
      if (!schedule) throw new HttpError(404, "Schedule not found");
      return { success: true, schedule };
    },

    "agents.schedule.delete": (input) => {
      if (!svc().removeSchedule(required(input, "id"))) throw new HttpError(404, "Schedule not found");
      return { success: true };
    },

    // Point the office at a host repo, or back to its workspace. Only an
    // explicit null removes the repo.
    "agents.flows.set_repo": (input) => {
      if (input.path !== null && typeof input.path !== "string") throw new HttpError(400, "path must be a string or null");
      if (input.git_init !== undefined && typeof input.git_init !== "boolean") throw new HttpError(400, "git_init must be a boolean");
      const result = setOfficeRepo(svc(), {
        flow_id: required(input, "flow_id"),
        path: input.path as string | null,
        git_init: input.git_init as boolean | undefined,
        retarget_agents: true,
      });
      return {
        success: true,
        flow: result.flow,
        path: result.path,
        home_path: result.homePath,
        git: result.git,
        git_detail: result.gitDetail,
        retargeted: result.retargeted,
      };
    },

    "agents.flows.set_lead": (input) => {
      const flow_id = required(input, "flow_id");
      return { success: true, ...svc().setOfficeLead(flow_id, required(input, "agent_id")) };
    },

    "agents.flows.set_distribute": (input) => {
      const flow_id = required(input, "flow_id");
      if (typeof input.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
      return { success: true, ...svc().setLeadDistributes(flow_id, input.enabled) };
    },

    // Direct PK lookup: a listRuns().find() answered 404 for any run older
    // than the most recent 500, which broke the HISTORY tab on long histories.
    "agents.runs.detail": (input) => {
      const id = required(input, "id");
      const run = svc().getRun(id);
      if (!run) throw new HttpError(404, "Run not found");
      return {
        run,
        steps: svc().getSteps(id),
        events: svc().getRunEvents(id),
        agent_name: svc().getAgent(run.agent_id)?.name ?? "Unknown",
      };
    },
  };
}
