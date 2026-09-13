/**
 * Agents HTTP API Routes
 * REST endpoints for the Agent Composer (dashboard)
 */

import { normalizeModelChainInput, normalizeExecutorType, normalizeSkillsInput } from "./chain-input.js";
import type { KernelHttpServer } from "../../core/http-server.js";
import type { AgentService } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import { resolveGoal } from "./executor.js";
import type { EventBus } from "../../core/event-bus.js";
import type { KernelLanguage } from "../../core/config.js";
import { resolve } from "node:path";
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
): void {
  const designerLang: KernelLanguage = defaultLanguage ?? "es";

  // POST /api/agents — create a new agent
  server.post("/api/agents", async (req, res) => {
    try {
      const body = await server.parseBody<{
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
      }>(req);

      if (!body.name?.trim()) {
        server.json(res, 400, { error: "name is required" });
        return;
      }

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

      server.json(res, 200, { success: true, agent_id: agent.id, agent });
    } catch (err) {
      log.error("Failed to create agent", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/offices/create — Office Kit HTTP fallback of the `offices.create`
  // WS RPC. One call creates/refreshes a whole office (flow + agents + chains
  // + cron + repo) via the shared materializeOffice engine. Idempotent.
  server.post("/api/offices/create", async (req, res) => {
    try {
      const body = await server.parseBody<Record<string, unknown>>(req);
      const { officeDefinitionFromJson, materializeOffice, loadRepoServiceBestEffort } =
        await import("./office-kit.js");
      const def = officeDefinitionFromJson(body);
      const db = service.getDb();
      const repoService = def.repo ? await loadRepoServiceBestEffort(db) : null;
      const report = materializeOffice(db, service, def, { repoService });
      server.json(res, 200, { success: true, report });
    } catch (err) {
      log.error("Failed to create office", err);
      server.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/agents/generate-from-prompt — draft an agent from a natural-language
  // description using the global LLM singleton. Does NOT create the agent;
  // returns a proposed spec the UI can preview and confirm.
  server.post("/api/agents/generate-from-prompt", async (req, res) => {
    try {
      const body = await server.parseBody<{
        prompt: string;
        flow_id?: string;
        flow_name?: string;
      }>(req);
      if (!body.prompt?.trim()) {
        server.json(res, 400, { error: "prompt is required" });
        return;
      }

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
      const reqLang: KernelLanguage = ((): KernelLanguage => {
        const v = (body as { language?: string }).language;
        if (v === "es" || v === "en") return v;
        return designerLang;
      })();

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
        server.json(res, 502, { error: "LLM returned malformed spec", spec });
        return;
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

      server.json(res, 200, {
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
      });
    } catch (err) {
      log.error("generate-from-prompt failed", err);
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/agents — list agents
  server.get("/api/agents", (_req, res) => {
    try {
      const agents = service.listAgents({ active: true });
      server.json(res, 200, { agents, total: agents.length });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Event Log endpoints ────────────────────────────

  // GET /api/agents/event-log — query persistent event log
  server.get("/api/agents/event-log", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const run_id = url.searchParams.get("run_id") || undefined;
      const agent_id = url.searchParams.get("agent_id") || undefined;
      const event_type = url.searchParams.get("event_type") || undefined;
      const since = url.searchParams.get("since") || undefined;
      const limit = parseInt(url.searchParams.get("limit") ?? "200", 10);
      const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

      const opts = { run_id, agent_id, event_type, limit, offset, since };
      const events_list = service.getEventLog(opts);
      const total = service.getEventLogCount({ run_id, agent_id, event_type, since });
      server.json(res, 200, { events: events_list, total });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // DELETE /api/agents/event-log — cleanup old event log entries
  server.delete("/api/agents/event-log", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const before = url.searchParams.get("before") || undefined;
      const agent_id = url.searchParams.get("agent_id") || undefined;

      const deleted = service.clearEventLog({ before, agent_id });
      server.json(res, 200, { success: true, deleted });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Escalated questions (human-in-the-loop) ─────────────
  server.get("/api/agents/questions", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const statusParam = url.searchParams.get("status") as
        | "pending" | "answered" | "dismissed" | null;
      const status = statusParam ?? "pending";
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      const questions = service.listQuestions({ status, limit });
      server.json(res, 200, { questions, total: questions.length });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/agents/questions/:id/answer", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{ selected_index: number; selected_option: string; note?: string }>(req);
      if (typeof body.selected_index !== "number" || typeof body.selected_option !== "string") {
        server.json(res, 400, { error: "selected_index and selected_option required" });
        return;
      }
      const result = service.answerQuestion(id, body);
      if (!result) { server.json(res, 404, { error: "Question not found or already answered" }); return; }
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

      server.json(res, 200, { success: true, resume_run_id: resumeRunId ?? null });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/agents/questions/:id/dismiss", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const ok = service.dismissQuestion(id);
      if (!ok) { server.json(res, 404, { error: "Question not found or already handled" }); return; }
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/flow-diag — receive diagnostic breadcrumbs from the 3D
  // dashboard so walker/meeting events are traceable in kernel logs without
  // asking the user to read browser devtools.
  server.post("/api/agents/flow-diag", async (req, res) => {
    try {
      const body = await server.parseBody<Record<string, unknown>>(req);
      log.info(`[flow-diag] ${JSON.stringify(body)}`);
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/graph — full graph data for visualization
  server.get("/api/agents/graph", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const flowId = url.searchParams.get("flow_id") || undefined;
      const graph = service.getAgentGraph(flowId);
      server.json(res, 200, graph);
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Conversations (chats, meetings, debates) ─────────────────

  // GET /api/agents/conversations — list recent conversations
  //   query params: agent_id, kind (chat|meeting|debate), status (open|closed), limit
  server.get("/api/agents/conversations", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const agent_id = url.searchParams.get("agent_id") || undefined;
      const kind = (url.searchParams.get("kind") as "chat" | "meeting" | "debate" | null) || undefined;
      const status = (url.searchParams.get("status") as "open" | "closed" | null) || undefined;
      const limitStr = url.searchParams.get("limit");
      const limit = limitStr ? Math.max(1, Math.min(parseInt(limitStr, 10) || 50, 500)) : 50;
      const conversations = service.listConversations({ agent_id, kind, status, limit });
      server.json(res, 200, { conversations, total: conversations.length });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/conversations/:id — full transcript
  server.get("/api/agents/conversations/:id", (req, res) => {
    try {
      const id = (req as unknown as { params?: { id?: string } }).params?.id ?? "";
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const conversation = service.getConversation(id);
      if (!conversation) { server.json(res, 404, { error: "Conversation not found" }); return; }
      const messages = service.listMessages(id, { limit: 500 });
      const participants = service.parseParticipants(conversation)
        .map(pid => {
          const a = service.getAgent(pid);
          return a ? { id: a.id, name: a.name, flow_id: a.flow_id } : { id: pid, name: pid, flow_id: "" };
        });
      server.json(res, 200, { conversation, messages, participants });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/conversations/:id/archive — soft-hide a single
  // conversation. Used by the meeting history "✕" button to dismiss read
  // meetings so they stop reappearing on hydrate.
  server.post("/api/agents/conversations/:id/archive", (req, res) => {
    try {
      const id = (req as unknown as { params?: { id?: string } }).params?.id ?? "";
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const ok = service.archiveConversation(id);
      if (!ok) { server.json(res, 404, { error: "Conversation not found" }); return; }
      server.json(res, 200, { archived: true, id });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/conversations/archive-all-closed — bulk dismiss every
  // closed (and not-yet-archived) conversation. Optional ?kind= filter.
  server.post("/api/agents/conversations/archive-all-closed", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const kind = (url.searchParams.get("kind") as "chat" | "meeting" | "debate" | null) || undefined;
      const archived = service.archiveClosedConversations({ kind });
      server.json(res, 200, { archived });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/debates — debates only (convenience over /conversations?kind=debate)
  server.get("/api/agents/debates", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const status = (url.searchParams.get("status") as "open" | "closed" | null) || undefined;
      const limitStr = url.searchParams.get("limit");
      const limit = limitStr ? Math.max(1, Math.min(parseInt(limitStr, 10) || 50, 500)) : 50;
      const debates = service.listConversations({ kind: "debate", status, limit });
      server.json(res, 200, { debates, total: debates.length });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Flow endpoints ──────────────────────────────

  // GET /api/agents/flows — list all flows
  server.get("/api/agents/flows", (_req, res) => {
    try {
      const flows = service.listFlows();
      server.json(res, 200, { flows });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/flows — create a flow
  server.post("/api/agents/flows", async (req, res) => {
    try {
      const body = await server.parseBody<{
        name: string; description?: string; color?: string; agent_ids?: string[];
      }>(req);
      if (!body.name?.trim()) { server.json(res, 400, { error: "name is required" }); return; }
      const flow = service.createFlow({ name: body.name.trim(), description: body.description, color: body.color });
      // Optionally assign agents
      if (body.agent_ids) {
        for (const aid of body.agent_ids) {
          service.assignAgentToFlow(aid, flow.id);
        }
      }
      server.json(res, 200, { success: true, flow });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // PUT /api/agents/flows/:id — update a flow
  server.put("/api/agents/flows/:id", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{ name?: string; description?: string; color?: string }>(req);
      const flow = service.updateFlow(id, body);
      if (!flow) { server.json(res, 404, { error: "Flow not found" }); return; }
      server.json(res, 200, { success: true, flow });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // DELETE /api/agents/flows/:id — delete a flow
  server.delete("/api/agents/flows/:id", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const ok = service.deleteFlow(id);
      if (!ok) { server.json(res, 404, { error: "Flow not found" }); return; }
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/flows/:id/assign — assign agents to a flow
  server.post("/api/agents/flows/:id/assign", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{ agent_ids: string[] }>(req);
      if (!body.agent_ids?.length) { server.json(res, 400, { error: "agent_ids required" }); return; }
      for (const aid of body.agent_ids) {
        service.assignAgentToFlow(aid, id);
      }
      server.json(res, 200, { success: true, assigned: body.agent_ids.length });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Rank endpoints ──────────────────────────────

  // GET /api/agents/ranks — list ranks (ordered by level asc)
  server.get("/api/agents/ranks", (_req, res) => {
    try {
      const ranks = service.listRanks();
      server.json(res, 200, { ranks });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/ranks — create a rank
  server.post("/api/agents/ranks", async (req, res) => {
    try {
      const body = await server.parseBody<{
        name: string; level: number; insignia?: string; color?: string; description?: string;
      }>(req);
      if (!body.name?.trim()) { server.json(res, 400, { error: "name is required" }); return; }
      if (typeof body.level !== "number") { server.json(res, 400, { error: "level (number) is required" }); return; }
      const rank = service.createRank({
        name: body.name.trim(),
        level: body.level,
        insignia: body.insignia,
        color: body.color,
        description: body.description,
      });
      server.json(res, 200, { success: true, rank });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // PUT /api/agents/ranks/:id — update a rank
  server.put("/api/agents/ranks/:id", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{
        name?: string; level?: number; insignia?: string; color?: string; description?: string;
      }>(req);
      const rank = service.updateRank(id, body);
      if (!rank) { server.json(res, 404, { error: "Rank not found" }); return; }
      server.json(res, 200, { success: true, rank });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // DELETE /api/agents/ranks/:id — soft-delete + unassign agents
  server.delete("/api/agents/ranks/:id", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const ok = service.deleteRank(id);
      if (!ok) { server.json(res, 404, { error: "Rank not found" }); return; }
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/:id/model-chain — set the agent's fallback model chain
  //
  // Special case: when the primary slot is `claude_code`, the agent switches to
  // executor del SDK (Anthropic-only, sin fallback). El model chain se borra
  // and store the chosen model in `agents.model`. To go back to the native
  // engine, just pick any other provider as the primary.
  server.post("/api/agents/:id/model-chain", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{ chain: Array<{ provider: string; model: string }> }>(req);
      if (!Array.isArray(body.chain)) { server.json(res, 400, { error: "chain must be an array" }); return; }
      const clean = body.chain
        .filter(e => e && typeof e === "object")
        .map(e => ({ provider: String(e.provider ?? ""), model: String(e.model ?? "") }))
        .filter(e => e.provider || e.model);

      if (clean.length > 0 && clean[0].provider === "claude_code") {
        // SDK engine: persist the model + clear the chain + mark the executor.
        const model = clean[0].model || "claude-opus-4-6";
        const okType = service.setExecutorType(id, "claude_code");
        if (!okType) { server.json(res, 404, { error: "Agent not found" }); return; }
        service.updateAgent(id, { model, provider: "claude" });
        service.setModelChain(id, []);
        server.json(res, 200, { success: true, executor_type: "claude_code", model, chain: [] });
        return;
      }

      // Native engine — revert it if the agent was on claude_code.
      service.setExecutorType(id, "native");
      const ok = service.setModelChain(id, clean);
      if (!ok) { server.json(res, 404, { error: "Agent not found" }); return; }
      server.json(res, 200, { success: true, executor_type: "native", chain: clean });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/:id/executor-type — switch engine: 'native' or 'claude_code'
  server.post("/api/agents/:id/executor-type", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{ executor_type: "native" | "claude_code" }>(req);
      if (body.executor_type !== "native" && body.executor_type !== "claude_code") {
        server.json(res, 400, { error: "executor_type must be 'native' or 'claude_code'" }); return;
      }
      const ok = service.setExecutorType(id, body.executor_type);
      if (!ok) { server.json(res, 404, { error: "Agent not found" }); return; }
      server.json(res, 200, { success: true, executor_type: body.executor_type });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/:id/rank — assign (or clear) an agent's rank
  server.post("/api/agents/:id/rank", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{ rank_id: string }>(req);
      const ok = service.assignRankToAgent(id, body.rank_id ?? "");
      if (!ok) { server.json(res, 404, { error: "Agent not found or rank_id invalid" }); return; }
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/chain — create a chain between agents
  server.post("/api/agents/chain", async (req, res) => {
    try {
      const body = await server.parseBody<{
        source_agent_id: string;
        target_agent_id: string;
        label?: string;
        condition?: Record<string, unknown>;
        pass_result?: boolean;
        delay_ms?: number;
      }>(req);

      if (!body.source_agent_id || !body.target_agent_id) {
        server.json(res, 400, { error: "source_agent_id and target_agent_id required" });
        return;
      }

      const chain = service.addChain(body);
      server.json(res, 200, { success: true, chain_id: chain.id, chain });
    } catch (err) {
      log.error("Failed to create chain", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // DELETE /api/agents/chain/:id — remove a chain
  server.delete("/api/agents/chain/:id", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const ok = service.removeChain(id);
      if (!ok) { server.json(res, 404, { error: "Chain not found" }); return; }
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/trigger — add a trigger or schedule to an agent
  server.post("/api/agents/trigger", async (req, res) => {
    try {
      const body = await server.parseBody<{
        agent_id: string;
        type: "event" | "schedule";
        event_name?: string;
        filter?: Record<string, unknown>;
        cooldown_ms?: number;
        interval_ms?: number;
        cron?: string;
        goal_override?: string;
      }>(req);

      if (!body.agent_id) { server.json(res, 400, { error: "agent_id required" }); return; }
      if (!body.type) { server.json(res, 400, { error: "type required (event|schedule)" }); return; }

      if (body.type === "event") {
        if (!body.event_name) { server.json(res, 400, { error: "event_name required for event trigger" }); return; }
        const trigger = service.addEventTrigger({
          agent_id: body.agent_id,
          event_name: body.event_name,
          filter: body.filter,
          cooldown_ms: body.cooldown_ms,
        });
        server.json(res, 200, { success: true, trigger_id: trigger.id });
      } else if (body.type === "schedule") {
        if (!body.cron && (!body.interval_ms || body.interval_ms < 60000)) {
          server.json(res, 400, { error: "cron expression or interval_ms (>= 60000) required" }); return;
        }
        const schedule = service.addSchedule({
          agent_id: body.agent_id,
          interval_ms: body.interval_ms,
          cron_expression: body.cron,
          goal_override: body.goal_override,
        });
        server.json(res, 200, { success: true, schedule_id: schedule.id, schedule });
      } else {
        server.json(res, 400, { error: "type must be event or schedule" });
      }
    } catch (err) {
      log.error("Failed to add trigger", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/stop — cancel a running agent (by agent_id or run_id)
  server.post("/api/agents/stop", async (req, res) => {
    try {
      const body = await server.parseBody<{ agent_id?: string; run_id?: string }>(req);

      if (body.run_id) {
        // Cancel a specific run
        const cancelled = executor.cancelRun(body.run_id);
        if (cancelled) {
          service.updateRun(body.run_id, { status: "cancelled", completed_at: new Date().toISOString() });
        }
        server.json(res, 200, { success: true, cancelled: cancelled ? 1 : 0 });
        return;
      }

      if (body.agent_id) {
        // Cancel all running runs for this agent
        const runs = service.listRuns({ agent_id: body.agent_id, status: "running" });
        let cancelled = 0;
        for (const run of runs) {
          if (executor.cancelRun(run.id)) {
            service.updateRun(run.id, { status: "cancelled", completed_at: new Date().toISOString() });
            cancelled++;
          }
        }
        server.json(res, 200, { success: true, cancelled });
        return;
      }

      server.json(res, 400, { error: "agent_id or run_id required" });
    } catch (err) {
      log.error("Failed to stop agent", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/:id — get a single agent
  server.get("/api/agents/:id", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const agent = service.getAgent(id);
      if (!agent) { server.json(res, 404, { error: "Agent not found" }); return; }
      const runs = service.listRuns({ agent_id: id, limit: 5 });
      const triggers = service.listEventTriggers(id);
      const schedules = service.listSchedules(id);
      const adhocConnections = service.getAdHocConnections(id);
      server.json(res, 200, { agent, runs, triggers, schedules, adhocConnections });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // PUT /api/agents/:id — update an agent
  server.put("/api/agents/:id", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{
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
      }>(req);
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
      if (!updated) { server.json(res, 404, { error: "Agent not found" }); return; }
      server.json(res, 200, { success: true, agent: updated });
    } catch (err) {
      log.error("Failed to update agent", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // DELETE /api/agents/:id — delete (deactivate) an agent
  server.delete("/api/agents/:id", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const ok = service.deleteAgent(id);
      if (!ok) { server.json(res, 404, { error: "Agent not found" }); return; }
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/run — manually run an agent
  server.post("/api/agents/run", async (req, res) => {
    try {
      const body = await server.parseBody<{ agent_id: string; goal?: string; workspace?: string }>(req);
      if (!body.agent_id) { server.json(res, 400, { error: "agent_id required" }); return; }

      const agent = service.getAgent(body.agent_id);
      if (!agent) { server.json(res, 404, { error: "Agent not found" }); return; }

      // Workspace override — lets each run use its own isolated cwd (handy
      // for agents that test several OSS projects in parallel).
      // We sanitise the name to prevent path traversal.
      let workspaceOverride: string | undefined;
      if (typeof body.workspace === "string" && body.workspace.length > 0) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(body.workspace)) {
          server.json(res, 400, { error: "workspace must be alphanumeric/-/_ (max 64 chars)" });
          return;
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

      server.json(res, 200, { success: true, run_id: run.id, status: "running" });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/:id/preview-prompt — dry-run of the prompt build. Assembles
  // the blocks the executor would inject for a hypothetical goal (directory,
  // learnings, memory, similar past runs) SIN invocar al LLM. Soporta force_mode
  // so you can A/B lexical vs semantic from the dashboard without spending tokens.
  // Side effects: none. Creates NO run, marks NO inbox as read, emits NO events.
  server.post("/api/agents/:id/preview-prompt", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "agent id required" }); return; }
      const agent = service.getAgent(id);
      if (!agent) { server.json(res, 404, { error: "Agent not found" }); return; }

      const body = await server.parseBody<{
        goal?: string;
        force_mode?: "auto" | "semantic" | "lexical";
        memory_pool?: number;
        memory_limit?: number;
        learnings_limit?: number;
        similar_runs_limit?: number;
      }>(req);

      const resolvedTemplate = agent.goal_template
        ? resolveGoal(agent.goal_template, {}).trim()
        : "";
      const goal = (body?.goal || resolvedTemplate || `Execute the agent: ${agent.name}`).trim();
      if (!goal) { server.json(res, 400, { error: "goal required (and goal_template empty)" }); return; }

      const memPool = Math.min(500, Math.max(10, body?.memory_pool ?? 100));
      const memLimit = Math.min(memPool, Math.max(1, body?.memory_limit ?? 50));
      const learnLimit = Math.min(50, Math.max(1, body?.learnings_limit ?? 15));
      const similarLimit = Math.min(20, Math.max(1, body?.similar_runs_limit ?? 3));

      const mode: "auto" | "semantic" | "lexical" = body?.force_mode ?? "auto";
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

      const inboxRows = service.getUnreadInbox(agent.id);
      const inbox = inboxRows.map(m => ({
        from_agent_name: service.getAgent(m.from_agent_id)?.name ?? m.from_agent_id,
        subject: m.subject,
        body: m.body,
        created_at: m.created_at,
      }));

      server.json(res, 200, {
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
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/runs/active — runs currently in flight (to re-hydrate
  // la vista 3D al F5). Devuelve lista mínima: id, agent_id, agent_name,
  // started_at. Returns no steps and no results — just who is working.
  server.get("/api/agents/runs/active", (_req, res) => {
    try {
      const runs = service.listRuns({ status: "running", limit: 100 });
      const out = runs.map((r) => {
        const agent = service.getAgent(r.agent_id);
        return {
          id: r.id,
          agent_id: r.agent_id,
          agent_name: agent?.name ?? "Unknown",
          goal: r.goal,
          started_at: r.started_at,
          trigger_type: r.trigger_type,
        };
      });
      server.json(res, 200, { runs: out });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/runs/:id — get a run with its steps
  server.get("/api/agents/runs/:id", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      // Direct PK lookup. The previous listRuns({limit:500}).find() approach
      // returned 404 for any run older than the 500 most recent system-wide,
      // which silently broke the HISTORY tab on agents with long histories.
      const run = service.getRun(id);
      if (!run) { server.json(res, 404, { error: "Run not found" }); return; }
      const steps = service.getSteps(id);
      const events = service.getRunEvents(id);
      const agent = service.getAgent(run.agent_id);
      server.json(res, 200, { run, steps, events, agent_name: agent?.name ?? "Unknown" });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/:id/runs — list runs for an agent with steps
  server.get("/api/agents/:id/runs", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const runs = service.listRuns({ agent_id: id, limit: 20 });
      const runsWithSteps = runs.map(r => ({
        ...r,
        steps: service.getSteps(r.id),
      }));
      server.json(res, 200, { runs: runsWithSteps });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/:id/memory — get conversation memory for an agent
  server.get("/api/agents/:id/memory", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const limit = parseInt(String((req as any).query?.limit ?? "50"), 10);
      const memory = service.getMemory(id, Math.min(limit, 200));
      server.json(res, 200, { memory });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/:id/memory — add a manual memory entry (for chat persistence)
  server.post("/api/agents/:id/memory", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{ role: string; content: string }>(req);
      if (!body.content) { server.json(res, 400, { error: "content required" }); return; }
      service.addMemory(id, (body.role as "user" | "assistant") ?? "user", body.content);
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/:id/skill-suggestions — which skills would suit this
  // agent, scored live, across installed extensions AND subscribed catalogue
  // repos. Same maths as the daily suggester cron; this is the path the
  // drawer's SKILLS tab calls, so the ranking reaches the agent it is about
  // instead of a note nobody reads. A skill not yet installed is included
  // flagged `installed: false` — that is what turns a recommendation into an
  // installer.
  server.get("/api/agents/:id/skill-suggestions", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }

      const agent = service.getAgent(id);
      if (!agent) { server.json(res, 404, { error: "agent not found" }); return; }

      const url = new URL(req.url ?? "/", "http://localhost");
      const minScore = Number(url.searchParams.get("min_score") ?? "1") || 0;
      // Clamp into [0, 50]; fall back to 8 only when the param is absent or
      // genuinely not a number. `top_n=0` must return zero results, not the
      // default — and a negative value must not reach Array.slice(0, -n),
      // which truncates from the end instead of erroring.
      const topNRaw = url.searchParams.get("top_n");
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

      if (candidates.length === 0) { server.json(res, 200, { suggestions: [] }); return; }

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
      server.json(res, 200, {
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
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Export endpoints (for marketplace) ─────────────

  // GET /api/agents/:id/export — export agent as marketplace package JSON
  server.get("/api/agents/:id/export", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const agent = service.getAgent(id);
      if (!agent) { server.json(res, 404, { error: "Agent not found" }); return; }

      const learnings = service.getLearnings(id);
      const triggers = service.listEventTriggers(id);

      const slug = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const pkg = {
        $schema: "kernl://marketplace/agent/v1",
        slug,
        name: agent.name,
        version: "1.0.0",
        description: agent.description,
        author: "Kernl",
        icon: "🤖",
        category: "agent",
        tags: ["agent"],
        agent: {
          system_prompt: agent.system_prompt,
          goal_template: agent.goal_template,
          allowed_tools: JSON.parse(agent.allowed_tools),
          denied_tools: JSON.parse(agent.denied_tools),
          provider: agent.provider,
          model: agent.model,
          max_iterations: agent.max_iterations,
          timeout_ms: agent.timeout_ms,
          variables: JSON.parse(agent.variables),
        },
        learnings: learnings.map(l => ({
          type: l.type,
          content: l.content,
          confidence: l.confidence,
        })),
        triggers: triggers.map(t => ({
          event_name: t.event_name,
          filter: JSON.parse(t.filter),
          cooldown_ms: t.cooldown_ms,
        })),
      };

      server.json(res, 200, pkg);
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/flows/:id/export — export flow as marketplace package JSON
  server.get("/api/agents/flows/:id/export", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const flow = service.getFlow(id);
      if (!flow) { server.json(res, 404, { error: "Flow not found" }); return; }

      const agents = service.listAgents({ active: true }).filter(a => a.flow_id === id);
      const chains = service.listChains().filter(
        c => agents.some(a => a.id === c.source_agent_id) && agents.some(a => a.id === c.target_agent_id),
      );

      // Build id → refId mapping
      const idToRef = new Map<string, string>();
      const agentDefs: Record<string, unknown> = {};
      let refIdx = 0;
      for (const agent of agents) {
        const refId = `agent_${refIdx++}`;
        idToRef.set(agent.id, refId);
        agentDefs[refId] = {
          name: agent.name,
          description: agent.description,
          system_prompt: agent.system_prompt,
          goal_template: agent.goal_template,
          allowed_tools: JSON.parse(agent.allowed_tools),
          denied_tools: JSON.parse(agent.denied_tools),
          provider: agent.provider,
          model: agent.model,
          max_iterations: agent.max_iterations,
          timeout_ms: agent.timeout_ms,
          variables: JSON.parse(agent.variables),
        };
      }

      const chainDefs = chains.map(c => ({
        source_ref: idToRef.get(c.source_agent_id) ?? c.source_agent_id,
        target_ref: idToRef.get(c.target_agent_id) ?? c.target_agent_id,
        label: c.label,
        condition: JSON.parse(c.condition),
        pass_result: c.pass_result === 1,
        delay_ms: c.delay_ms,
      }));

      const slug = flow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const pkg = {
        $schema: "kernl://marketplace/flow/v1",
        slug,
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
        chains: chainDefs,
      };

      server.json(res, 200, pkg);
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });
  registerPromptVersionRoutes(server, service, optimizer);


  registerWorkspaceEvolutionRoutes(server, service, executor, events, workspaceEvolver);


  registerMarketplaceRoutes(server, service, events);

  registerWorkspaceFileRoutes(server, service, wsService);

  registerClaudeConfigRoutes(server);
  registerPrivateAssetRoutes(server);


  log.info("Agent routes registered (/api/agents/*) + Claude host config (/api/claude-config) + private workspace");
}
