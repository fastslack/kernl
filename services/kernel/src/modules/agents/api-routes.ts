/**
 * Agents HTTP API Routes
 * REST endpoints for the Agent Composer (dashboard)
 */

import { normalizeModelChainInput, normalizeExecutorType, normalizeSkillsInput } from "./chain-input.js";
import { HttpError, isHttpError, type KernelHttpServer } from "../../core/http-server.js";
import type { AgentService } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import { resolveGoal } from "./executor.js";
import type { EventBus } from "../../core/event-bus.js";
import type { KernelLanguage } from "../../core/config.js";
import { log } from "../../core/logger.js";
import { promptAgentDesigner, promptAgentDesignerFlowHint } from "../../core/i18n/prompts.js";
import type {
  WorkspaceServiceLike,
  ReflectionOptimizerLike,
  WorkspaceEvolverLike,
} from "./advanced-types.js";
import { rankSkillsForAgent, skillRowText, agentRowText } from "./skill-scoring.js";
import { registerClaudeConfigRoutes } from "./routes/claude-config-routes.js";
import { registerPrivateAssetRoutes } from "./routes/private-assets-routes.js";
import { registerWorkspaceFileRoutes } from "./routes/workspace-file-routes.js";
import { registerPromptVersionRoutes } from "./routes/prompt-version-routes.js";
import { registerWorkspaceEvolutionRoutes } from "./routes/workspace-evolution-routes.js";
import { registerMarketplaceRoutes } from "./routes/marketplace-routes.js";
import { registerOfficeRoutes } from "./routes/office-routes.js";
import type { ExtensionOfficeSource } from "./office-templates.js";
import { parseSchedulePatch } from "./services/schedules-service.js";
import { setOfficeRepo } from "./office-repo.js";

type ConversationKind = "chat" | "meeting" | "debate";
type ConversationStatus = "open" | "closed";

/** `?limit=` clamped to [1, 500], 50 when absent or not a number. */
function clampLimit(raw: string | null): number {
  return raw ? Math.max(1, Math.min(parseInt(raw, 10) || 50, 500)) : 50;
}

export function registerAgentRoutes(
  server: KernelHttpServer,
  service: AgentService,
  executor: AgentExecutor,
  events?: EventBus,
  wsService?: WorkspaceServiceLike,
  optimizer?: ReflectionOptimizerLike,
  workspaceEvolver?: WorkspaceEvolverLike,
  /** Kernel-wide default language for the agent designer + i18n proposals. */
  defaultLanguage?: KernelLanguage,
  /**
   * Skill candidates from subscribed catalogue repos, for the per-agent
   * suggestions route. Injected rather than imported so the agents module
   * keeps not depending on marketplace: absent → suggestions fall back to
   * installed skills only, which is a degraded answer, not an error.
   */
  catalogSkills?: () => Promise<Array<{ slug: string; name: string; text: string }>>,
  /** Offices shipped by extensions, for the wizard gallery. Absent → built-in templates only. */
  officeSources?: () => Promise<ExtensionOfficeSource[]>,
): void {
  const designerLang: KernelLanguage = defaultLanguage ?? "es";

  const requireAgent = (id: string, message = "Agent not found") => {
    const agent = service.getAgent(id);
    if (!agent) throw new HttpError(404, message);
    return agent;
  };

  // POST /api/agents — create a new agent
  server.route<{
    name: string;
    description?: string;
    system_prompt?: string;
    goal_template?: string;
    allowed_tools?: string[];
    denied_tools?: string[];
    provider?: string;
    model?: string;
    max_iterations?: number;
    timeout_ms?: number;
    show_on_dashboard?: boolean;
    flow_id?: string;
    variables?: Record<string, string>;
    schedule?: { cron_expression: string; goal_override?: string };
  }>("POST", "/api/agents", ({ body }) => {
    if (!body.name?.trim()) throw new HttpError(400, "name is required");

    const agent = service.createAgent({
      name: body.name.trim(),
      description: body.description,
      system_prompt: body.system_prompt,
      goal_template: body.goal_template,
      allowed_tools: body.allowed_tools,
      denied_tools: body.denied_tools,
      provider: body.provider,
      model: body.model,
      max_iterations: body.max_iterations,
      timeout_ms: body.timeout_ms,
      show_on_dashboard: body.show_on_dashboard,
      flow_id: body.flow_id,
      variables: body.variables,
    });

    // Optional inline schedule (agent-create with cron). Non-fatal on error.
    if (body.schedule?.cron_expression) {
      try {
        service.addSchedule({
          agent_id: agent.id,
          cron_expression: body.schedule.cron_expression,
          goal_override: body.schedule.goal_override,
        });
      } catch (schedErr) {
        log.warn(`Could not add schedule for ${agent.id}: ${String(schedErr)}`);
      }
    }

    return { success: true, agent_id: agent.id, agent };
  });

  // POST /api/offices/create — Office Kit HTTP fallback of the `offices.create`
  // WS RPC. One call creates/refreshes a whole office (flow + agents + chains
  // + cron + repo) via the shared materializeOffice engine. Idempotent.
  // An existing office is a 409 (OfficeExistsError); any other failure is the
  // manifest's fault, so a 400.
  server.route<Record<string, unknown>>("POST", "/api/offices/create", async ({ body }) => {
    try {
      const { officeDefinitionFromJson, materializeOffice, loadRepoServiceBestEffort } =
        await import("./office-kit.js");
      const def = officeDefinitionFromJson(body);
      const db = service.getDb();
      const repoService = def.repo ? await loadRepoServiceBestEffort(db) : null;
      const mode = body.mode === "create" ? "create" : "upsert";
      const report = materializeOffice(db, service, def, { repoService, mode });
      return { success: true, report };
    } catch (err) {
      if (isHttpError(err)) throw err;
      log.error("Failed to create office", err);
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  });

  // POST /api/agents/generate-from-prompt — draft an agent from a natural-language
  // description using the global LLM singleton. Does NOT create the agent;
  // returns a proposed spec the UI can preview and confirm.
  server.route<{ prompt: string; flow_id?: string; flow_name?: string; language?: string }>(
    "POST", "/api/agents/generate-from-prompt", async ({ body }) => {
      if (!body.prompt?.trim()) throw new HttpError(400, "prompt is required");

      // Build a trimmed tool catalog — names + description snippets only.
      // Full schemas would blow the context budget; names + 1-line hints
      // are enough for the LLM to pick appropriate tools.
      const catalog = executor.getToolCatalog()
        .map((t) => ({
          name: t.name,
          description: (t.description ?? "").slice(0, 120),
        }))
        .filter((t) => t.name.startsWith("kernel_") || t.name.startsWith("mcp_"));

      // Per-request language override (operator setting on the form) — falls
      // back to the kernel-wide default the route was registered with.
      const reqLang: KernelLanguage = body.language === "es" || body.language === "en" ? body.language : designerLang;

      const flowHint = body.flow_name
        ? promptAgentDesignerFlowHint(reqLang, body.flow_name)
        : "";

      const systemPrompt = promptAgentDesigner(reqLang, { flowHint, catalog });

      const { llm } = await import("../../core/llm/client.js");
      const spec = await llm().chatJson<{
        name: string;
        description?: string;
        system_prompt?: string;
        goal_template?: string;
        allowed_tools?: string[];
        suggested_cron?: string;
        provider_preference?: string;
        rationale?: string;
      }>({
        system: systemPrompt,
        user: body.prompt.trim(),
        json: true,
        maxTokens: 2048,
        caller: "agents:propose-spec",
      });

      // Validate shape minimally; LLM drift happens.
      if (!spec || typeof spec !== "object" || !spec.name) {
        throw new HttpError(502, "LLM returned malformed spec", { error: "LLM returned malformed spec", spec });
      }

      // Filter allowed_tools against the real catalog — defensive against
      // hallucinations (LLM invents tool names that don't exist).
      const validNames = new Set(executor.getToolCatalog().map((t) => t.name));
      const allowed = (spec.allowed_tools ?? []).filter((n) => validNames.has(n));

      // Seed `*_i18n` with the language the spec was generated in. The other
      // language stays empty until the user (or translate-bundles.ts) fills
      // it — the resolver falls back to the plain field meanwhile.
      const desc = spec.description ?? "";
      const sp = spec.system_prompt ?? "";
      const gt = spec.goal_template ?? "";

      return {
        success: true,
        proposal: {
          name: String(spec.name).trim(),
          description: desc,
          system_prompt: sp,
          goal_template: gt,
          system_prompt_i18n: sp ? { [reqLang]: sp } : undefined,
          description_i18n: desc ? { [reqLang]: desc } : undefined,
          goal_template_i18n: gt ? { [reqLang]: gt } : undefined,
          language_used: reqLang,
          allowed_tools: allowed,
          suggested_cron: spec.suggested_cron?.trim() ?? "",
          provider_preference: spec.provider_preference ?? "",
          rationale: spec.rationale ?? "",
          flow_id: body.flow_id ?? "",
          // Surface if any hallucinated tools were filtered out so the UI
          // can warn the user.
          dropped_tools: (spec.allowed_tools ?? []).filter((n) => !validNames.has(n)),
        },
      };
    },
  );

  // GET /api/agents — list agents
  server.route("GET", "/api/agents", () => {
    const agents = service.listAgents({ active: true });
    return { agents, total: agents.length };
  });

  // ── Event Log endpoints ────────────────────────────

  // GET /api/agents/event-log — query persistent event log
  server.route("GET", "/api/agents/event-log", ({ query }) => {
    const filter = {
      run_id: query.get("run_id") || undefined,
      agent_id: query.get("agent_id") || undefined,
      event_type: query.get("event_type") || undefined,
      since: query.get("since") || undefined,
    };
    const limit = parseInt(query.get("limit") ?? "200", 10);
    const offset = parseInt(query.get("offset") ?? "0", 10);
    return {
      events: service.getEventLog({ ...filter, limit, offset }),
      total: service.getEventLogCount(filter),
    };
  });

  // DELETE /api/agents/event-log — cleanup old event log entries
  server.route("DELETE", "/api/agents/event-log", ({ query }) => {
    const deleted = service.clearEventLog({
      before: query.get("before") || undefined,
      agent_id: query.get("agent_id") || undefined,
    });
    return { success: true, deleted };
  });

  // ── Escalated questions (human-in-the-loop) ─────────────
  server.route("GET", "/api/agents/questions", ({ query }) => {
    const status = (query.get("status") as "pending" | "answered" | "dismissed" | null) ?? "pending";
    const limit = parseInt(query.get("limit") ?? "50", 10);
    const questions = service.listQuestions({ status, limit });
    return { questions, total: questions.length };
  });

  server.route<{ selected_index: number; selected_option: string; note?: string }>(
    "POST", "/api/agents/questions/:id/answer", ({ params: { id }, body }) => {
      if (typeof body.selected_index !== "number" || typeof body.selected_option !== "string") {
        throw new HttpError(400, "selected_index and selected_option required");
      }
      const result = service.answerQuestion(id, body);
      if (!result) throw new HttpError(404, "Question not found or already answered");
      events?.emit("agent:flow:question_answered" as any, {
        question_id: id,
        from_agent_id: result.from_agent_id,
        question: result.question,
        selected_option: body.selected_option,
        selected_index: body.selected_index,
        ts: new Date().toISOString(),
      });

      // Auto-resume — the agent that asked the question goes back to work
      // with the answer in its inbox + goal. Without this, the answer just
      // sits in agent_office_inbox waiting for someone to re-run the agent
      // manually, and the user thinks the kernel ignored the approval.
      let resumeRunId: string | undefined;
      try {
        const asker = service.getAgent(result.from_agent_id);
        if (asker && asker.active) {
          const noteSuffix = body.note ? `\n\nAdditional note: ${body.note}` : "";
          const resumeGoal =
            `Your supervisor answered your earlier question.\n\n` +
            `**Question:** ${result.question}\n\n` +
            `**Answer:** ${body.selected_option}${noteSuffix}\n\n` +
            `Resume from where you stopped: act on the answer using your tools. ` +
            `Do not re-ask the same question.`;
          const run = service.createRun({
            agent_id: asker.id,
            trigger_type: "manual",
            goal: resumeGoal,
            trigger_payload: { resume_question_id: id },
          });
          resumeRunId = run.id;
          service.updateRun(run.id, { status: "running", started_at: new Date().toISOString() });
          executor
            .execute({ agent: asker, goal: resumeGoal, run, service, events })
            .then((r) => {
              service.updateRun(run.id, {
                status: r.status,
                result: r.result,
                error: r.error,
                steps_count: r.steps_count,
                tokens_used: r.tokens_used,
                completed_at: new Date().toISOString(),
              });
            })
            .catch((err) => {
              service.updateRun(run.id, {
                status: "failed",
                error: String(err),
                completed_at: new Date().toISOString(),
              });
            });
        }
      } catch (resumeErr) {
        // Auto-resume is best-effort. The answer is already saved + queued
        // in the agent's inbox, so a manual re-run still works.
        events?.emit("data.changed", { module: "agents", action: "auto_resume_failed" });
        // eslint-disable-next-line no-console
        console.warn("auto-resume after answer failed", resumeErr);
      }

      return { success: true, resume_run_id: resumeRunId ?? null };
    },
  );

  server.route("POST", "/api/agents/questions/:id/dismiss", ({ params: { id } }) => {
    if (!service.dismissQuestion(id)) throw new HttpError(404, "Question not found or already handled");
    return { success: true };
  });

  // POST /api/agents/flow-diag — receive diagnostic breadcrumbs from the 3D
  // dashboard so walker/meeting events are traceable in kernel logs without
  // asking the user to read browser devtools.
  server.route("POST", "/api/agents/flow-diag", ({ body }) => {
    log.info(`[flow-diag] ${JSON.stringify(body)}`);
    return { success: true };
  });

  // GET /api/agents/graph — full graph data for visualization
  server.route("GET", "/api/agents/graph", ({ query }) =>
    service.getAgentGraph(query.get("flow_id") || undefined));

  // ── Conversations (chats, meetings, debates) ─────────────────

  // GET /api/agents/conversations — list recent conversations
  //   query params: agent_id, kind (chat|meeting|debate), status (open|closed), limit
  server.route("GET", "/api/agents/conversations", ({ query }) => {
    const conversations = service.listConversations({
      agent_id: query.get("agent_id") || undefined,
      kind: (query.get("kind") as ConversationKind | null) || undefined,
      status: (query.get("status") as ConversationStatus | null) || undefined,
      limit: clampLimit(query.get("limit")),
    });
    return { conversations, total: conversations.length };
  });

  // GET /api/agents/conversations/:id — full transcript
  server.route("GET", "/api/agents/conversations/:id", ({ params: { id } }) => {
    const conversation = service.getConversation(id);
    if (!conversation) throw new HttpError(404, "Conversation not found");
    const messages = service.listMessages(id, { limit: 500 });
    const participants = service.parseParticipants(conversation)
      .map(pid => {
        const a = service.getAgent(pid);
        return a ? { id: a.id, name: a.name, flow_id: a.flow_id } : { id: pid, name: pid, flow_id: "" };
      });
    return { conversation, messages, participants };
  });

  // POST /api/agents/conversations/:id/archive — soft-hide a single
  // conversation. Used by the meeting history "✕" button to dismiss read
  // meetings so they stop reappearing on hydrate.
  server.route("POST", "/api/agents/conversations/:id/archive", ({ params: { id } }) => {
    if (!service.archiveConversation(id)) throw new HttpError(404, "Conversation not found");
    return { archived: true, id };
  });

  // POST /api/agents/conversations/archive-all-closed — bulk dismiss every
  // closed (and not-yet-archived) conversation. Optional ?kind= filter.
  server.route("POST", "/api/agents/conversations/archive-all-closed", ({ query }) => ({
    archived: service.archiveClosedConversations({
      kind: (query.get("kind") as ConversationKind | null) || undefined,
    }),
  }));

  // GET /api/agents/debates — debates only (convenience over /conversations?kind=debate)
  server.route("GET", "/api/agents/debates", ({ query }) => {
    const debates = service.listConversations({
      kind: "debate",
      status: (query.get("status") as ConversationStatus | null) || undefined,
      limit: clampLimit(query.get("limit")),
    });
    return { debates, total: debates.length };
  });

  // ── Flow endpoints ──────────────────────────────

  // GET /api/agents/flows — list all flows
  server.route("GET", "/api/agents/flows", () => ({ flows: service.listFlows() }));

  // POST /api/agents/flows — create a flow
  server.route<{ name: string; description?: string; color?: string; agent_ids?: string[] }>(
    "POST", "/api/agents/flows", ({ body }) => {
      if (!body.name?.trim()) throw new HttpError(400, "name is required");
      const flow = service.createFlow({ name: body.name.trim(), description: body.description, color: body.color });
      // Optionally assign agents
      for (const aid of body.agent_ids ?? []) service.assignAgentToFlow(aid, flow.id);
      return { success: true, flow };
    },
  );

  // PUT /api/agents/flows/:id — update a flow. The service rejects bad input
  // with an "Invalid …" error, which is the caller's fault, so a 400.
  server.route<Parameters<AgentService["updateFlow"]>[1]>(
    "PUT", "/api/agents/flows/:id", ({ params: { id }, body }) => {
      let flow;
      try {
        flow = service.updateFlow(id, body);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new HttpError(message.startsWith("Invalid") ? 400 : 500, message);
      }
      if (!flow) throw new HttpError(404, "Flow not found");
      return { success: true, flow };
    },
  );

  // DELETE /api/agents/flows/:id — delete a flow
  server.route("DELETE", "/api/agents/flows/:id", ({ params: { id } }) => {
    const result = service.deleteFlow(id);
    if (!result) throw new HttpError(404, "Flow not found");
    return { success: true, unassigned: result.unassigned };
  });

  // POST /api/agents/flows/:id/assign — assign agents to a flow
  server.route<{ agent_ids: string[] }>("POST", "/api/agents/flows/:id/assign", ({ params: { id }, body }) => {
    if (!body.agent_ids?.length) throw new HttpError(400, "agent_ids required");
    for (const aid of body.agent_ids) service.assignAgentToFlow(aid, id);
    return { success: true, assigned: body.agent_ids.length };
  });

  // PUT /api/agents/flows/:id/repo — point the office at a host repo, or back to its workspace (path null)
  server.route<{ path?: unknown; git_init?: unknown }>("PUT", "/api/agents/flows/:id/repo", ({ params: { id }, body }) => {
    if (body.path !== null && typeof body.path !== "string") throw new HttpError(400, "path must be a string or null");
    if (body.git_init !== undefined && typeof body.git_init !== "boolean") throw new HttpError(400, "git_init must be a boolean");
    const result = setOfficeRepo(service, {
      flow_id: id,
      path: body.path as string | null,
      git_init: body.git_init as boolean | undefined,
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
  });

  // POST /api/agents/flows/:id/lead — make an agent the office's one lead
  server.route<{ agent_id?: unknown }>("POST", "/api/agents/flows/:id/lead", ({ params: { id }, body }) => {
    if (typeof body.agent_id !== "string" || !body.agent_id) throw new HttpError(400, "agent_id required");
    return { success: true, ...service.setOfficeLead(id, body.agent_id) };
  });

  // PUT /api/agents/flows/:id/distribute — "the lead hands work to the team" on/off
  server.route<{ enabled?: unknown }>("PUT", "/api/agents/flows/:id/distribute", ({ params: { id }, body }) => {
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
    return { success: true, ...service.setLeadDistributes(id, body.enabled) };
  });

  // ── Rank endpoints ──────────────────────────────

  // GET /api/agents/ranks — list ranks (ordered by level asc)
  server.route("GET", "/api/agents/ranks", () => ({ ranks: service.listRanks() }));

  // POST /api/agents/ranks — create a rank
  server.route<{ name: string; level: number; insignia?: string; color?: string; description?: string }>(
    "POST", "/api/agents/ranks", ({ body }) => {
      if (!body.name?.trim()) throw new HttpError(400, "name is required");
      if (typeof body.level !== "number") throw new HttpError(400, "level (number) is required");
      const rank = service.createRank({
        name: body.name.trim(),
        level: body.level,
        insignia: body.insignia,
        color: body.color,
        description: body.description,
      });
      return { success: true, rank };
    },
  );

  // PUT /api/agents/ranks/:id — update a rank
  server.route<{ name?: string; level?: number; insignia?: string; color?: string; description?: string }>(
    "PUT", "/api/agents/ranks/:id", ({ params: { id }, body }) => {
      const rank = service.updateRank(id, body);
      if (!rank) throw new HttpError(404, "Rank not found");
      return { success: true, rank };
    },
  );

  // DELETE /api/agents/ranks/:id — soft-delete + unassign agents
  server.route("DELETE", "/api/agents/ranks/:id", ({ params: { id } }) => {
    if (!service.deleteRank(id)) throw new HttpError(404, "Rank not found");
    return { success: true };
  });

  // POST /api/agents/:id/model-chain — set the agent's fallback model chain
  //
  // Special case: when the primary slot is `claude_code`, the agent switches to
  // executor del SDK (Anthropic-only, sin fallback). El model chain se borra
  // and store the chosen model in `agents.model`. To go back to the native
  // engine, just pick any other provider as the primary.
  server.route<{ chain: Array<{ provider: string; model: string }> }>(
    "POST", "/api/agents/:id/model-chain", ({ params: { id }, body }) => {
      if (!Array.isArray(body.chain)) throw new HttpError(400, "chain must be an array");
      const clean = body.chain
        .filter(e => e && typeof e === "object")
        .map(e => ({ provider: String(e.provider ?? ""), model: String(e.model ?? "") }))
        .filter(e => e.provider || e.model);

      if (clean.length > 0 && clean[0].provider === "claude_code") {
        // SDK engine: persist the model + clear the chain + mark the executor.
        const model = clean[0].model || "claude-opus-4-6";
        if (!service.setExecutorType(id, "claude_code")) throw new HttpError(404, "Agent not found");
        service.updateAgent(id, { model, provider: "claude" });
        service.setModelChain(id, []);
        return { success: true, executor_type: "claude_code", model, chain: [] };
      }

      // Native engine — revert it if the agent was on claude_code.
      service.setExecutorType(id, "native");
      if (!service.setModelChain(id, clean)) throw new HttpError(404, "Agent not found");
      return { success: true, executor_type: "native", chain: clean };
    },
  );

  // POST /api/agents/:id/executor-type — switch engine: 'native' or 'claude_code'
  server.route<{ executor_type: "native" | "claude_code" }>(
    "POST", "/api/agents/:id/executor-type", ({ params: { id }, body }) => {
      if (body.executor_type !== "native" && body.executor_type !== "claude_code") {
        throw new HttpError(400, "executor_type must be 'native' or 'claude_code'");
      }
      if (!service.setExecutorType(id, body.executor_type)) throw new HttpError(404, "Agent not found");
      return { success: true, executor_type: body.executor_type };
    },
  );

  // POST /api/agents/:id/rank — assign (or clear) an agent's rank
  // A missing rank_id clears the rank, so an empty body must not reach it:
  // only an explicit `{}` / `{ "rank_id": "" }` clears it.
  server.route<{ rank_id: string }>("POST", "/api/agents/:id/rank", ({ params: { id }, body }) => {
    if (!service.assignRankToAgent(id, body.rank_id ?? "")) throw new HttpError(404, "Agent not found or rank_id invalid");
    return { success: true };
  }, { requireBody: true });

  // POST /api/agents/chain — create a chain between agents
  server.route<{
    source_agent_id: string;
    target_agent_id: string;
    label?: string;
    condition?: Record<string, unknown>;
    pass_result?: boolean;
    delay_ms?: number;
  }>("POST", "/api/agents/chain", ({ body }) => {
    if (!body.source_agent_id || !body.target_agent_id) {
      throw new HttpError(400, "source_agent_id and target_agent_id required");
    }
    const chain = service.addChain(body);
    return { success: true, chain_id: chain.id, chain };
  });

  // DELETE /api/agents/chain/:id — remove a chain
  server.route("DELETE", "/api/agents/chain/:id", ({ params: { id } }) => {
    if (!service.removeChain(id)) throw new HttpError(404, "Chain not found");
    return { success: true };
  });

  // PUT /api/agents/schedules/:id — change a schedule's cadence or pause it.
  // A cadence under the floor throws ScheduleValidationError, a 400.
  server.route<unknown>("PUT", "/api/agents/schedules/:id", ({ params: { id }, body }) => {
    const result = parseSchedulePatch(body);
    if (!result.ok) throw new HttpError(400, result.error);
    const schedule = service.updateSchedule(id, result.patch);
    if (!schedule) throw new HttpError(404, "Schedule not found");
    return { success: true, schedule };
  });

  // DELETE /api/agents/schedules/:id — remove a schedule
  server.route("DELETE", "/api/agents/schedules/:id", ({ params: { id } }) => {
    if (!service.removeSchedule(id)) throw new HttpError(404, "Schedule not found");
    return { success: true };
  });

  // POST /api/agents/trigger — add a trigger or schedule to an agent
  server.route<{
    agent_id: string;
    type: "event" | "schedule";
    event_name?: string;
    filter?: Record<string, unknown>;
    cooldown_ms?: number;
    interval_ms?: number;
    cron?: string;
    goal_override?: string;
  }>("POST", "/api/agents/trigger", ({ body }) => {
    if (!body.agent_id) throw new HttpError(400, "agent_id required");
    if (!body.type) throw new HttpError(400, "type required (event|schedule)");

    if (body.type === "event") {
      if (!body.event_name) throw new HttpError(400, "event_name required for event trigger");
      const trigger = service.addEventTrigger({
        agent_id: body.agent_id,
        event_name: body.event_name,
        filter: body.filter,
        cooldown_ms: body.cooldown_ms,
      });
      return { success: true, trigger_id: trigger.id };
    }
    if (body.type === "schedule") {
      if (!body.cron && (!body.interval_ms || body.interval_ms < 60000)) {
        throw new HttpError(400, "cron expression or interval_ms (>= 60000) required");
      }
      const schedule = service.addSchedule({
        agent_id: body.agent_id,
        interval_ms: body.interval_ms,
        cron_expression: body.cron,
        goal_override: body.goal_override,
      });
      return { success: true, schedule_id: schedule.id, schedule };
    }
    throw new HttpError(400, "type must be event or schedule");
  });

  // POST /api/agents/stop — cancel a running agent (by agent_id or run_id)
  server.route<{ agent_id?: string; run_id?: string }>("POST", "/api/agents/stop", ({ body }) => {
    const cancel = (runId: string) => {
      if (!executor.cancelRun(runId)) return false;
      service.updateRun(runId, { status: "cancelled", completed_at: new Date().toISOString() });
      return true;
    };

    // Cancel a specific run
    if (body.run_id) return { success: true, cancelled: cancel(body.run_id) ? 1 : 0 };

    // Cancel all running runs for this agent
    if (body.agent_id) {
      const runs = service.listRuns({ agent_id: body.agent_id, status: "running" });
      return { success: true, cancelled: runs.filter(run => cancel(run.id)).length };
    }

    throw new HttpError(400, "agent_id or run_id required");
  });

  // GET /api/agents/:id — get a single agent
  server.route("GET", "/api/agents/:id", ({ params: { id } }) => ({
    agent: requireAgent(id),
    runs: service.listRuns({ agent_id: id, limit: 5 }),
    triggers: service.listEventTriggers(id),
    schedules: service.listSchedules(id),
    adhocConnections: service.getAdHocConnections(id),
  }));

  // PUT /api/agents/:id — update an agent
  server.route<{
    name?: string; description?: string; system_prompt?: string;
    goal_template?: string; provider?: string; model?: string;
    max_iterations?: number; timeout_ms?: number; active?: boolean;
    max_tokens?: number; max_errors?: number;
    allowed_tools?: string[]; denied_tools?: string[];
    variables?: Record<string, string>;
    builtin_handler?: string;
    under_revision?: boolean;
    skills?: string[];
    /** JSON array, or the array itself. See chain-input.ts. */
    model_chain?: string | Array<{ provider?: string; model?: string }>;
    executor_type?: string;
  }>("PUT", "/api/agents/:id", ({ params: { id }, body }) => {
    // The chain, the engine and the loose pair are one edit for the person
    // making it, so they have to be one write here — otherwise `provider`
    // and the chain head can end up disagreeing between two requests.
    const updated = service.updateAgent(id, {
      ...body,
      model_chain: normalizeModelChainInput(body.model_chain),
      executor_type: normalizeExecutorType(body.executor_type),
      // Was reaching the column through the spread, unchecked. The two
      // writers have to accept the same thing or the fallback path becomes
      // a way around the validation the primary one does.
      skills: normalizeSkillsInput(body.skills),
    });
    if (!updated) throw new HttpError(404, "Agent not found");
    return { success: true, agent: updated };
  });

  // DELETE /api/agents/:id — delete (deactivate) an agent
  server.route("DELETE", "/api/agents/:id", ({ params: { id } }) => {
    if (!service.deleteAgent(id)) throw new HttpError(404, "Agent not found");
    return { success: true };
  });

  // POST /api/agents/run — manually run an agent
  server.route<{ agent_id: string; goal?: string; workspace?: string }>("POST", "/api/agents/run", ({ body }) => {
    if (!body.agent_id) throw new HttpError(400, "agent_id required");
    const agent = requireAgent(body.agent_id);

    // Workspace override — lets each run use its own isolated cwd (handy
    // for agents that test several OSS projects in parallel).
    // We sanitise the name to prevent path traversal.
    let workspaceOverride: string | undefined;
    if (typeof body.workspace === "string" && body.workspace.length > 0) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(body.workspace)) {
        throw new HttpError(400, "workspace must be alphanumeric/-/_ (max 64 chars)");
      }
      workspaceOverride = body.workspace;
    }

    // Manual runs have no event payload, so any {{event.*}} placeholders in
    // the goal_template resolve to empty strings (not left as literals).
    const resolvedTemplate = agent.goal_template
      ? resolveGoal(agent.goal_template, {}).trim()
      : "";
    const goal = body.goal || resolvedTemplate || `Execute the agent: ${agent.name}`;
    const run = service.createRun({
      agent_id: agent.id,
      trigger_type: "manual",
      goal,
      trigger_payload: workspaceOverride ? { workspace: workspaceOverride } : undefined,
    });
    service.updateRun(run.id, { status: "running", started_at: new Date().toISOString() });

    // Run async — don't await.
    //
    // Both branches feed the circuit breaker. A manual run counts exactly
    // like a scheduled one: recordRunOutcome() is the single entry point by
    // design, and the LLM path here was the one place that skipped it, so a
    // "Run now" that kept failing never advanced the counter — and a "Run
    // now" that finally worked never cleared it either.
    executor.execute({ agent, goal, run, service, events }).then(result => {
      service.updateRun(run.id, {
        status: result.status,
        result: result.result,
        error: result.error,
        steps_count: result.steps_count,
        tokens_used: result.tokens_used,
        completed_at: new Date().toISOString(),
      });
      service.recordRunOutcome(agent.id, {
        ok: result.status === "completed",
        error: result.error,
        run_id: run.id,
      });
    }).catch(err => {
      service.updateRun(run.id, { status: "failed", error: String(err), completed_at: new Date().toISOString() });
      service.recordRunOutcome(agent.id, { ok: false, error: String(err), run_id: run.id });
    });

    return { success: true, run_id: run.id, status: "running" };
  });

  // POST /api/agents/:id/preview-prompt — dry-run of the prompt build. Assembles
  // the blocks the executor would inject for a hypothetical goal (directory,
  // learnings, memory, similar past runs) SIN invocar al LLM. Soporta force_mode
  // so you can A/B lexical vs semantic from the dashboard without spending tokens.
  // Side effects: none. Creates NO run, marks NO inbox as read, emits NO events.
  server.route<{
    goal?: string;
    force_mode?: "auto" | "semantic" | "lexical";
    memory_pool?: number;
    memory_limit?: number;
    learnings_limit?: number;
    similar_runs_limit?: number;
  }>("POST", "/api/agents/:id/preview-prompt", async ({ params: { id }, body }) => {
    const agent = requireAgent(id);

    const resolvedTemplate = agent.goal_template
      ? resolveGoal(agent.goal_template, {}).trim()
      : "";
    const goal = (body.goal || resolvedTemplate || `Execute the agent: ${agent.name}`).trim();
    if (!goal) throw new HttpError(400, "goal required (and goal_template empty)");

    const memPool = Math.min(500, Math.max(10, body.memory_pool ?? 100));
    const memLimit = Math.min(memPool, Math.max(1, body.memory_limit ?? 50));
    const learnLimit = Math.min(50, Math.max(1, body.learnings_limit ?? 15));
    const similarLimit = Math.min(20, Math.max(1, body.similar_runs_limit ?? 3));

    const mode: "auto" | "semantic" | "lexical" = body.force_mode ?? "auto";
    const embedClient = service.getEmbeddingsClient();
    const wantSemantic = mode === "semantic" || (mode === "auto" && !!embedClient);

    // Embed the goal once (semantic mode); on failure transparently fall back.
    let goalVector: number[] | null = null;
    let embedMs = 0;
    let embedError: string | null = null;
    if (wantSemantic) {
      if (!embedClient) {
        embedError = "embeddings client not wired";
      } else {
        const t0 = Date.now();
        try {
          const [vec] = await embedClient.embed([goal]);
          goalVector = vec ?? null;
          embedMs = Date.now() - t0;
        } catch (err) {
          embedError = err instanceof Error ? err.message : String(err);
        }
      }
    }
    const effectiveMode: "semantic" | "lexical" = goalVector ? "semantic" : "lexical";

    const directory = service.buildDirectoryBlock(agent.id);
    const hierarchy = service.buildHierarchyBlock(agent.id);

    const learnings = goalVector
      ? service.getRelevantLearningsByEmbedding(agent.id, goal, goalVector, learnLimit)
      : service.getRelevantLearnings(agent.id, goal, learnLimit);
    const memory = goalVector
      ? service.getRelevantMemoryByEmbedding(agent.id, goal, goalVector, memLimit, memPool)
      : service.getRelevantMemory(agent.id, goal, memLimit, memPool);
    const similar = goalVector
      ? service.findSimilarPastRunsByEmbedding(agent.id, goal, goalVector, similarLimit)
      : service.findSimilarPastRuns(agent.id, goal, similarLimit);

    const inbox = service.getUnreadInbox(agent.id).map(m => ({
      from_agent_name: service.getAgent(m.from_agent_id)?.name ?? m.from_agent_id,
      subject: m.subject,
      body: m.body,
      created_at: m.created_at,
    }));

    return {
      agent: { id: agent.id, name: agent.name, role: agent.role, flow_id: agent.flow_id },
      goal,
      mode: effectiveMode,
      requested_mode: mode,
      embeddings: embedClient
        ? { provider: embedClient.provider, model: embedClient.model, dim: embedClient.dim, embed_ms: embedMs, error: embedError }
        : { provider: null, model: null, dim: null, embed_ms: 0, error: embedError ?? "no embeddings client" },
      blocks: {
        directory,
        hierarchy,
        learnings: learnings.map(l => ({
          id: l.id, type: l.type, content: l.content, confidence: l.confidence,
        })),
        memory: memory.map(m => ({
          role: m.role, content: m.content, created_at: m.created_at,
        })),
        similar_runs: similar.map(r => ({
          id: r.id, status: r.status, goal: r.goal,
          result_preview: (r.result || r.error || "").slice(0, 300),
        })),
        inbox,
      },
      counts: {
        learnings: learnings.length,
        memory: memory.length,
        similar_runs: similar.length,
        inbox: inbox.length,
      },
    };
  });

  // GET /api/agents/runs/active — runs currently in flight (to re-hydrate
  // la vista 3D al F5). Devuelve lista mínima: id, agent_id, agent_name,
  // started_at. Returns no steps and no results — just who is working.
  server.route("GET", "/api/agents/runs/active", () => ({
    runs: service.listRuns({ status: "running", limit: 100 }).map((r) => ({
      id: r.id,
      agent_id: r.agent_id,
      agent_name: service.getAgent(r.agent_id)?.name ?? "Unknown",
      goal: r.goal,
      started_at: r.started_at,
      trigger_type: r.trigger_type,
    })),
  }));

  // GET /api/agents/runs/:id — get a run with its steps
  server.route("GET", "/api/agents/runs/:id", ({ params: { id } }) => {
    // Direct PK lookup. The previous listRuns({limit:500}).find() approach
    // returned 404 for any run older than the 500 most recent system-wide,
    // which silently broke the HISTORY tab on agents with long histories.
    const run = service.getRun(id);
    if (!run) throw new HttpError(404, "Run not found");
    return {
      run,
      steps: service.getSteps(id),
      events: service.getRunEvents(id),
      agent_name: service.getAgent(run.agent_id)?.name ?? "Unknown",
    };
  });

  // GET /api/agents/:id/runs — list runs for an agent with steps
  server.route("GET", "/api/agents/:id/runs", ({ params: { id } }) => ({
    runs: service.listRuns({ agent_id: id, limit: 20 }).map(r => ({ ...r, steps: service.getSteps(r.id) })),
  }));

  // GET /api/agents/:id/memory — get conversation memory for an agent
  server.route("GET", "/api/agents/:id/memory", ({ params: { id }, query }) => ({
    memory: service.getMemory(id, Math.min(parseInt(query.get("limit") ?? "50", 10), 200)),
  }));

  // POST /api/agents/:id/memory — add a manual memory entry (for chat persistence)
  server.route<{ role: string; content: string }>("POST", "/api/agents/:id/memory", ({ params: { id }, body }) => {
    if (!body.content) throw new HttpError(400, "content required");
    service.addMemory(id, (body.role as "user" | "assistant") ?? "user", body.content);
    return { ok: true };
  });

  // GET /api/agents/:id/skill-suggestions — which skills would suit this
  // agent, scored live, across installed extensions AND subscribed catalogue
  // repos. Same maths as the daily suggester cron; this is the path the
  // drawer's SKILLS tab calls, so the ranking reaches the agent it is about
  // instead of a note nobody reads. A skill not yet installed is included
  // flagged `installed: false` — that is what turns a recommendation into an
  // installer.
  server.route("GET", "/api/agents/:id/skill-suggestions", async ({ params: { id }, query }) => {
    const agent = requireAgent(id, "agent not found");

    const minScore = Number(query.get("min_score") ?? "1") || 0;
    // Clamp into [0, 50]; fall back to 8 only when the param is absent or
    // genuinely not a number. `top_n=0` must return zero results, not the
    // default — and a negative value must not reach Array.slice(0, -n),
    // which truncates from the end instead of erroring.
    const topNRaw = query.get("top_n");
    const topNParsed = topNRaw === null ? NaN : Number(topNRaw);
    const topN = Number.isFinite(topNParsed) ? Math.min(Math.max(topNParsed, 0), 50) : 8;

    const rows = service.listInstalledSkillRows();
    const installedSlugs = new Set(rows.map((r) => r.slug));

    const candidates: Array<{ slug: string; name: string; text: string; installed: boolean }> =
      rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        text: skillRowText(r),
        installed: true,
      }));

    // The catalogue can never take down the tab: a dead repo, no network,
    // or a slow provider degrades to "installed skills only", logged as a
    // warning — never a 500.
    if (catalogSkills) {
      try {
        for (const c of await catalogSkills()) {
          if (installedSlugs.has(c.slug)) continue; // the installed row wins
          candidates.push({ slug: c.slug, name: c.name, text: c.text, installed: false });
        }
      } catch (e) {
        log.warn(`skill-suggestions: catalogue source failed — ${String(e)}`);
      }
    }

    if (candidates.length === 0) return { suggestions: [] };

    let attached: string[] = [];
    try { attached = JSON.parse(agent.skills_json ?? "[]") as string[]; } catch { attached = []; }

    const ranked = rankSkillsForAgent(
      {
        text: agentRowText({
          name: agent.name,
          description: agent.description ?? "",
          system_prompt: agent.system_prompt ?? "",
          flow_name: null,
        }),
        attached: new Set(attached.map(String)),
      },
      candidates.map((c) => ({ slug: c.slug, text: c.text })),
      { minScore, topN },
    );

    const byslug = new Map(candidates.map((c) => [c.slug, c]));
    return {
      suggestions: ranked.map((m) => {
        const c = byslug.get(m.slug);
        return {
          slug: m.slug,
          name: c?.name ?? m.slug,
          score: Number(m.score.toFixed(2)),
          matches: m.matches,
          installed: c?.installed ?? false,
        };
      }),
    };
  });

  // ── Export endpoints (for marketplace) ─────────────

  const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const exportAgentDef = (agent: ReturnType<typeof requireAgent>) => ({
    system_prompt: agent.system_prompt,
    goal_template: agent.goal_template,
    allowed_tools: JSON.parse(agent.allowed_tools),
    denied_tools: JSON.parse(agent.denied_tools),
    provider: agent.provider,
    model: agent.model,
    max_iterations: agent.max_iterations,
    timeout_ms: agent.timeout_ms,
    variables: JSON.parse(agent.variables),
  });

  // GET /api/agents/:id/export — export agent as marketplace package JSON
  server.route("GET", "/api/agents/:id/export", ({ params: { id } }) => {
    const agent = requireAgent(id);
    return {
      $schema: "kernl://marketplace/agent/v1",
      slug: slugOf(agent.name),
      name: agent.name,
      version: "1.0.0",
      description: agent.description,
      author: "Kernl",
      icon: "🤖",
      category: "agent",
      tags: ["agent"],
      agent: exportAgentDef(agent),
      learnings: service.getLearnings(id).map(l => ({
        type: l.type,
        content: l.content,
        confidence: l.confidence,
      })),
      triggers: service.listEventTriggers(id).map(t => ({
        event_name: t.event_name,
        filter: JSON.parse(t.filter),
        cooldown_ms: t.cooldown_ms,
      })),
    };
  });

  // GET /api/agents/flows/:id/export — export flow as marketplace package JSON
  server.route("GET", "/api/agents/flows/:id/export", ({ params: { id } }) => {
    const flow = service.getFlow(id);
    if (!flow) throw new HttpError(404, "Flow not found");

    const agents = service.listAgents({ active: true }).filter(a => a.flow_id === id);
    const chains = service.listChains().filter(
      c => agents.some(a => a.id === c.source_agent_id) && agents.some(a => a.id === c.target_agent_id),
    );

    // Build id → refId mapping
    const idToRef = new Map<string, string>();
    const agentDefs: Record<string, unknown> = {};
    agents.forEach((agent, i) => {
      const refId = `agent_${i}`;
      idToRef.set(agent.id, refId);
      agentDefs[refId] = { name: agent.name, description: agent.description, ...exportAgentDef(agent) };
    });

    return {
      $schema: "kernl://marketplace/flow/v1",
      slug: slugOf(flow.name),
      name: flow.name,
      version: "1.0.0",
      description: flow.description,
      author: "Kernl",
      icon: "⬡",
      category: "flow",
      tags: ["flow"],
      flow: {
        name: flow.name,
        description: flow.description,
        color: flow.color,
      },
      agents: agentDefs,
      chains: chains.map(c => ({
        source_ref: idToRef.get(c.source_agent_id) ?? c.source_agent_id,
        target_ref: idToRef.get(c.target_agent_id) ?? c.target_agent_id,
        label: c.label,
        condition: JSON.parse(c.condition),
        pass_result: c.pass_result === 1,
        delay_ms: c.delay_ms,
      })),
    };
  });

  registerPromptVersionRoutes(server, service, optimizer);
  registerWorkspaceEvolutionRoutes(server, service, executor, events, workspaceEvolver);
  registerMarketplaceRoutes(server, service, events);
  registerOfficeRoutes(server, { defaultLanguage: designerLang, officeSources });
  registerWorkspaceFileRoutes(server, service, wsService);
  registerClaudeConfigRoutes(server);
  registerPrivateAssetRoutes(server);

  log.info("Agent routes registered (/api/agents/*) + Claude host config (/api/claude-config) + private workspace");
}
