/**
 * Agents HTTP API Routes
 * REST endpoints for the Agent Composer (dashboard)
 */

import type { ServerResponse } from "node:http";
import { normalizeModelChainInput, normalizeExecutorType } from "./chain-input.js";
import type { KernelHttpServer } from "../../core/http-server.js";
import type { AgentService } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import { resolveGoal } from "./executor.js";
import type { EventBus } from "../../core/event-bus.js";
import type { KernelLanguage } from "../../core/config.js";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../../core/logger.js";
import { promptAgentDesigner, promptAgentDesignerFlowHint } from "../../core/i18n/prompts.js";
import type {
  WorkspaceServiceLike,
  ReflectionOptimizerLike,
  WorkspaceEvolverLike,
} from "./advanced-types.js";
import { rankSkillsForAgent, skillRowText, agentRowText } from "./skill-scoring.js";

/**
 * Conservative prompt-injection red-flag patterns scanned in cloned marketplace
 * skill/plugin manifests and markdown before they are surfaced to agents.
 */
const INJECTION_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "ignore-previous-instructions", re: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i },
  { label: "disregard-instructions", re: /disregard\s+(?:all\s+)?(?:previous|prior|the\s+above)\s+(?:instructions|prompt)/i },
  { label: "override-system-prompt", re: /(?:override|replace|forget)\s+(?:your\s+)?(?:system\s+)?prompt/i },
  { label: "reveal-system-prompt", re: /(?:reveal|print|show|leak)\s+(?:your\s+)?system\s+prompt/i },
  { label: "embedded-tool-call", re: /<\/?(?:tool_call|function_call|antml:invoke)\b/i },
  { label: "embedded-kernel-tool-directive", re: /\b(?:call|invoke|run|execute)\s+(?:the\s+)?(?:tool\s+)?kernel_[a-z_]+/i },
  { label: "exfiltrate-secrets", re: /(?:exfiltrate|leak|send|upload)\b.{0,40}\b(?:api[\s_-]?key|secret|token|password|credential|\.env)/i },
];

/** Bounded recursive walk collecting manifest/markdown text and matching red flags. */
async function scanForPromptInjection(
  rootDir: string,
): Promise<Array<{ file: string; pattern: string; match: string }>> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { resolve: resolvePath, relative } = await import("node:path");
  const flags: Array<{ file: string; pattern: string; match: string }> = [];
  let filesScanned = 0;
  const MAX_FILES = 200;
  const MAX_BYTES = 256 * 1024;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8 || filesScanned >= MAX_FILES) return;
    let ents: import("node:fs").Dirent[];
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const ent of ents) {
      if (filesScanned >= MAX_FILES) return;
      if (ent.name === ".git" || ent.name === "node_modules") continue;
      const full = resolvePath(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!/\.(md|mdx|markdown|json|txt|ya?ml)$/i.test(ent.name)) continue;
      filesScanned++;
      let content: string;
      try {
        content = await readFile(full, { encoding: "utf-8" });
      } catch { continue; }
      if (content.length > MAX_BYTES) content = content.slice(0, MAX_BYTES);
      const rel = relative(rootDir, full);
      for (const { label, re } of INJECTION_PATTERNS) {
        const m = re.exec(content);
        if (m) {
          flags.push({ file: rel, pattern: label, match: m[0].slice(0, 120) });
        }
      }
    }
  }

  await walk(rootDir, 0);
  return flags;
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

  // ── Prompt versions (Autogenesis RSPL lineage) ────

  // GET /api/agents/:id/prompt-versions
  server.get("/api/agents/:id/prompt-versions", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const versions = service.listPromptVersions(id, 100);
      const active = service.getActivePromptVersion(id);
      server.json(res, 200, { versions, active_version: active?.version ?? null });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/:id/prompt-versions/:version
  server.get("/api/agents/:id/prompt-versions/:version", (req, res) => {
    try {
      const p = (req as unknown as { params: Record<string, string> }).params ?? {};
      const agentId = p.id;
      const version = Number(p.version);
      if (!agentId || !Number.isFinite(version)) { server.json(res, 400, { error: "id and version required" }); return; }
      const row = service.getPromptVersion(agentId, version);
      if (!row) { server.json(res, 404, { error: "version not found" }); return; }
      server.json(res, 200, row);
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/:id/prompt-versions/:from/diff/:to
  server.get("/api/agents/:id/prompt-versions/:from/diff/:to", (req, res) => {
    try {
      const p = (req as unknown as { params: Record<string, string> }).params ?? {};
      const agentId = p.id;
      const from = Number(p.from);
      const to = Number(p.to);
      if (!agentId || !Number.isFinite(from) || !Number.isFinite(to)) {
        server.json(res, 400, { error: "id, from, to required" });
        return;
      }
      const diff = service.diffPromptVersions(agentId, from, to);
      if (!diff) { server.json(res, 404, { error: "version(s) not found" }); return; }
      server.json(res, 200, diff);
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/:id/prompt-versions/:version/restore — roll back to this version
  server.post("/api/agents/:id/prompt-versions/:version/restore", async (req, res) => {
    try {
      const p = (req as unknown as { params: Record<string, string> }).params ?? {};
      const agentId = p.id;
      const version = Number(p.version);
      if (!agentId || !Number.isFinite(version)) { server.json(res, 400, { error: "id and version required" }); return; }
      const body = await server.parseBody<{ note?: string }>(req).catch(() => ({} as { note?: string }));
      const snap = service.restorePromptVersion(agentId, version, body?.note ?? "");
      if (!snap) { server.json(res, 404, { error: "agent or version not found" }); return; }
      server.json(res, 200, { success: true, version: snap });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/:id/prompt-versions/:version/activate — flip active to existing version
  server.post("/api/agents/:id/prompt-versions/:version/activate", (req, res) => {
    try {
      const p = (req as unknown as { params: Record<string, string> }).params ?? {};
      const agentId = p.id;
      const version = Number(p.version);
      if (!agentId || !Number.isFinite(version)) { server.json(res, 400, { error: "id and version required" }); return; }
      const row = service.activatePromptVersion(agentId, version);
      if (!row) { server.json(res, 404, { error: "agent or version not found" }); return; }
      server.json(res, 200, { success: true, version: row });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Evolution runs (Autogenesis SEPL) ─────────────

  // GET /api/agents/:id/evolution — list recent evolution cycles
  server.get("/api/agents/:id/evolution", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const runs = service.listEvolutionRuns(id, 50);
      server.json(res, 200, { evolution_runs: runs });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/:id/evolution/run — trigger one reflection cycle synchronously
  server.post("/api/agents/:id/evolution/run", async (req, res) => {
    try {
      if (!optimizer) { server.json(res, 503, { error: "optimizer not configured" }); return; }
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{
        lookbackRuns?: number;
        minFailures?: number;
        commitMargin?: number;
        dryRun?: boolean;
        model?: string;
      }>(req).catch(() => ({} as Record<string, unknown>));
      const run = await optimizer.runCycle(id, body ?? {});
      if (!run) {
        server.json(res, 200, { triggered: false, reason: "not enough failures in lookback window" });
        return;
      }
      server.json(res, 200, { triggered: true, evolution: run });
    } catch (err) {
      log.error("Evolution cycle failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/evolution/:runId/accept — manual commit of a proposed/rejected candidate
  server.post("/api/agents/evolution/:runId/accept", (req, res) => {
    try {
      const runId = (req as unknown as { params: Record<string, string> }).params?.runId;
      if (!runId) { server.json(res, 400, { error: "runId required" }); return; }
      const evo = service.getEvolutionRun(runId);
      if (!evo) { server.json(res, 404, { error: "evolution run not found" }); return; }
      if (!evo.candidate_version) { server.json(res, 400, { error: "no candidate written yet" }); return; }
      service.activatePromptVersion(evo.agent_id, evo.candidate_version);
      const updated = service.updateEvolutionRun(runId, {
        status: "accepted",
        committed_at: new Date().toISOString(),
      });
      server.json(res, 200, { success: true, evolution: updated });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/evolution/:runId/reject — explicitly reject a proposed candidate
  server.post("/api/agents/evolution/:runId/reject", (req, res) => {
    try {
      const runId = (req as unknown as { params: Record<string, string> }).params?.runId;
      if (!runId) { server.json(res, 400, { error: "runId required" }); return; }
      const updated = service.updateEvolutionRun(runId, { status: "rejected" });
      if (!updated) { server.json(res, 404, { error: "evolution run not found" }); return; }
      server.json(res, 200, { success: true, evolution: updated });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Workspace evolution (target='workspace') ─────────────────────────

  function ensureEvolver(res: ServerResponse): WorkspaceEvolverLike | null {
    if (!workspaceEvolver) {
      server.json(res, 503, { error: "workspace evolver not configured" });
      return null;
    }
    return workspaceEvolver;
  }

  // GET /api/workspaces/:id/evolution — describe workspace evolver state
  server.get("/api/workspaces/:id/evolution", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const state = await evolver.describe(id);
      const history = service.listEvolutionRunsByWorkspace(id, 50);
      server.json(res, 200, { ...state, history });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/workspaces/:id/evolution/init — scaffold .evolve/ + git
  server.post("/api/workspaces/:id/evolution/init", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const result = await evolver.init(id);
      server.json(res, 200, result);
    } catch (err) {
      log.error("workspace evolution init failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/workspaces/:id/evolution/snapshot — commit current state
  server.post("/api/workspaces/:id/evolution/snapshot", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{ label?: string; agent_id?: string }>(req)
        .catch(() => ({} as Record<string, unknown>));
      const snap = await evolver.snapshotBaseline({
        workspace_id: id,
        agent_id: typeof body?.agent_id === "string" ? body.agent_id : undefined,
        label: typeof body?.label === "string" ? body.label : undefined,
      });
      server.json(res, 200, snap);
    } catch (err) {
      log.error("workspace snapshot failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/workspaces/:id/evolution/evaluate — run policy.evaluation.command
  server.post("/api/workspaces/:id/evolution/evaluate", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const result = await evolver.evaluate({ workspace_id: id });
      if (!result) { server.json(res, 412, { error: "no policy.json — call /init first" }); return; }
      server.json(res, 200, result);
    } catch (err) {
      log.error("workspace evaluate failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/workspaces/:id/evolution/accept — promote dirty state to candidate
  server.post("/api/workspaces/:id/evolution/accept", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{
        baseline_ref: string;
        evaluation: {
          passed: boolean;
          exit_code: number;
          stdout?: string;
          stderr?: string;
          duration_ms: number;
          timed_out?: boolean;
        };
        agent_id?: string;
        trigger_run_ids?: string[];
        hypothesis?: string;
        notes?: string;
      }>(req);
      if (!body?.baseline_ref || !body?.evaluation || !body?.agent_id) {
        server.json(res, 400, { error: "baseline_ref, evaluation and agent_id required" });
        return;
      }
      const summary = await evolver.acceptCandidate({
        workspace_id: id,
        agent_id: body.agent_id,
        baseline_ref: body.baseline_ref,
        evaluation: {
          passed: !!body.evaluation.passed,
          exit_code: body.evaluation.exit_code,
          stdout: body.evaluation.stdout ?? "",
          stderr: body.evaluation.stderr ?? "",
          duration_ms: body.evaluation.duration_ms,
          timed_out: !!body.evaluation.timed_out,
        },
        trigger_run_ids: body.trigger_run_ids,
        hypothesis: body.hypothesis,
        notes: body.notes,
      });
      server.json(res, 200, summary);
    } catch (err) {
      log.error("workspace accept failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/workspaces/:id/evolution/reject — record rejection, optionally revert
  server.post("/api/workspaces/:id/evolution/reject", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{
        baseline_ref: string;
        evaluation: {
          passed: boolean;
          exit_code: number;
          stdout?: string;
          stderr?: string;
          duration_ms: number;
          timed_out?: boolean;
        };
        agent_id?: string;
        trigger_run_ids?: string[];
        hypothesis?: string;
        notes?: string;
        revert?: boolean;
      }>(req);
      if (!body?.baseline_ref || !body?.evaluation || !body?.agent_id) {
        server.json(res, 400, { error: "baseline_ref, evaluation and agent_id required" });
        return;
      }
      const summary = await evolver.rejectCandidate({
        workspace_id: id,
        agent_id: body.agent_id,
        baseline_ref: body.baseline_ref,
        evaluation: {
          passed: !!body.evaluation.passed,
          exit_code: body.evaluation.exit_code,
          stdout: body.evaluation.stdout ?? "",
          stderr: body.evaluation.stderr ?? "",
          duration_ms: body.evaluation.duration_ms,
          timed_out: !!body.evaluation.timed_out,
        },
        trigger_run_ids: body.trigger_run_ids,
        hypothesis: body.hypothesis,
        notes: body.notes,
        revert: body.revert,
      });
      server.json(res, 200, summary);
    } catch (err) {
      log.error("workspace reject failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/workspaces/:id/evolution/cycle — full SEPL: baseline → run agent → evaluate → accept|reject
  server.post("/api/workspaces/:id/evolution/cycle", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{
        agent_id: string;
        goal: string;
        revert_on_fail?: boolean;
        notes?: string;
      }>(req);
      if (!body?.agent_id || !body?.goal) {
        server.json(res, 400, { error: "agent_id and goal required" });
        return;
      }
      const out = await evolver.runCycle({
        workspace_id: id,
        agent_id: body.agent_id,
        goal: body.goal,
        executor,
        events,
        revertOnFail: body.revert_on_fail,
        notes: body.notes,
      });
      server.json(res, 200, out);
    } catch (err) {
      log.error("workspace cycle failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/workspaces/:id/evolution/revert — hard revert to a known ref
  server.post("/api/workspaces/:id/evolution/revert", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{ ref: string }>(req);
      if (!body?.ref) { server.json(res, 400, { error: "ref required" }); return; }
      const result = await evolver.revertTo(id, body.ref);
      server.json(res, 200, result);
    } catch (err) {
      log.error("workspace revert failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Workspace API ─────────────────────────────
  const workspaceRoot = resolve(process.cwd(), "data", "workspaces");

  async function computeWsStats(wsId: string): Promise<{ files: number; bytes: number; mtime: number }> {
    const { readdir, stat } = await import("node:fs/promises");
    let files = 0, bytes = 0, mtime = 0;
    const base = resolve(workspaceRoot, wsId);
    async function walk(d: string): Promise<void> {
      let ents;
      try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        if (ent.name === "node_modules" || ent.name === ".git") continue;
        const sub = resolve(d, ent.name);
        if (ent.isDirectory()) await walk(sub);
        else {
          const s = await stat(sub).catch(() => null);
          if (s) { files++; bytes += s.size; if (s.mtimeMs > mtime) mtime = s.mtimeMs; }
        }
      }
    }
    await walk(base);
    return { files, bytes, mtime };
  }

  // ── Marketplaces (Claude Code plugin repos cloned on the host) ───────

  // GET /api/agents/marketplaces — lista marketplaces instalados
  server.get("/api/agents/marketplaces", async (_req, res) => {
    try {
      const { readdir, readFile } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const { execFileSync } = await import("node:child_process");

      const hostHome = process.env.HOST_HOME ?? homedir();
      const marketplacesDir = resolvePath(hostHome, ".claude/plugins/marketplaces");

      if (!existsSync(marketplacesDir)) {
        server.json(res, 200, { marketplaces: [], root: marketplacesDir });
        return;
      }

      const entries = await readdir(marketplacesDir, { withFileTypes: true });
      const items: Array<Record<string, unknown>> = [];

      for (const d of entries) {
        if (!d.isDirectory() || d.name.startsWith(".")) continue;
        const mpPath = resolvePath(marketplacesDir, d.name);
        let gitUrl = "";
        let lastCommit = "";
        try {
          gitUrl = execFileSync("git", ["-C", mpPath, "remote", "get-url", "origin"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        } catch { /* not a git repo */ }
        try {
          lastCommit = execFileSync("git", ["-C", mpPath, "log", "-1", "--format=%ci %h %s"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        } catch { /* no commits */ }

        let pluginCount = 0;
        const pluginsDir = resolvePath(mpPath, "plugins");
        if (existsSync(pluginsDir)) {
          try {
            pluginCount = (await readdir(pluginsDir, { withFileTypes: true }))
              .filter(e => e.isDirectory() && !e.name.startsWith(".")).length;
          } catch { /* ignore */ }
        }

        // Read optional .claude-plugin/marketplace.json for metadata
        let title = d.name;
        let description = "";
        try {
          const mf = JSON.parse(await readFile(resolvePath(mpPath, ".claude-plugin", "marketplace.json"), "utf-8"));
          title = mf.name ?? mf.title ?? d.name;
          description = mf.description ?? "";
        } catch { /* no manifest or invalid */ }

        items.push({
          id: d.name,
          name: d.name,
          title,
          description,
          git_url: gitUrl,
          last_commit: lastCommit,
          plugin_count: pluginCount,
          path: mpPath,
        });
      }

      items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      server.json(res, 200, { marketplaces: items, root: marketplacesDir });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/marketplaces — clone a marketplace from a git URL
  server.post("/api/agents/marketplaces", async (req, res) => {
    try {
      const body = await server.parseBody<{ url: string; name?: string; confirm?: boolean; acknowledged?: boolean }>(req);
      if (!body.url || typeof body.url !== "string") {
        server.json(res, 400, { error: "url required" });
        return;
      }
      // Allowlist: solo https GitHub/GitLab público (sin creds)
      const validProtocol = /^https:\/\/(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\//.test(body.url);
      if (!validProtocol) {
        server.json(res, 400, { error: "Only https URLs from github.com, gitlab.com, codeberg.org, or bitbucket.org are accepted" });
        return;
      }

      // Explicit confirmation gate: cloned skills/plugins are later surfaced into
      // agent contexts (prompt-injection vector), so the caller must acknowledge
      // what is being pulled before we run the clone.
      const confirmed = body.confirm === true || body.acknowledged === true;
      if (!confirmed) {
        server.json(res, 428, {
          error: "confirmation_required",
          message: `Cloning a marketplace downloads third-party skills/plugins that are later exposed to agents. Re-send with \"confirm\": true to confirm cloning: ${body.url}`,
          requires_confirmation: true,
          url: body.url,
        });
        return;
      }

      const { existsSync, mkdirSync } = await import("node:fs");
      const { resolve: resolvePath, basename } = await import("node:path");
      const { execFileSync } = await import("node:child_process");

      const hostHome = process.env.HOST_HOME ?? homedir();
      const marketplacesDir = resolvePath(hostHome, ".claude/plugins/marketplaces");
      mkdirSync(marketplacesDir, { recursive: true });

      // Derive the dir name from the URL when it isn't supplied
      let dirName = body.name?.trim() || "";
      if (!dirName) {
        dirName = basename(body.url).replace(/\.git$/, "");
      }
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(dirName)) {
        server.json(res, 400, { error: "invalid marketplace name" });
        return;
      }

      const targetPath = resolvePath(marketplacesDir, dirName);
      if (existsSync(targetPath)) {
        server.json(res, 409, { error: `A marketplace with that name already exists: ${dirName}` });
        return;
      }

      // Clone (depth=1 for speed, re-fetch if tags turn out to be needed)
      try {
        execFileSync("git", ["clone", "--depth", "1", "--single-branch", body.url, targetPath], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        server.json(res, 500, { error: `git clone failed: ${msg.slice(0, 300)}` });
        return;
      }

      // Validate the minimum structure: must contain `plugins/` or `.claude-plugin/`
      const hasPlugins = existsSync(resolvePath(targetPath, "plugins"));
      const hasManifest = existsSync(resolvePath(targetPath, ".claude-plugin", "marketplace.json"));
      if (!hasPlugins && !hasManifest) {
        try { execFileSync("rm", ["-rf", targetPath]); } catch { /* ignore */ }
        server.json(res, 400, { error: "The repo doesn't look like a Claude Code marketplace (missing plugins/ or .claude-plugin/marketplace.json)" });
        return;
      }

      // Lightweight content scan of cloned manifests/markdown for obvious
      // prompt-injection red flags before this content is surfaced to agents.
      // Conservative: we log + flag, we do NOT block the clone.
      const injectionFlags = await scanForPromptInjection(targetPath);
      if (injectionFlags.length > 0) {
        log.warn(
          `[marketplace] prompt-injection red flags in cloned repo ${dirName} (${body.url}): ` +
            injectionFlags.map(f => `${f.file}: "${f.match}"`).join("; "),
        );
      }

      // Audit event — persisted to agent_event_log (queryable via kernel_audit_logs).
      try {
        service.logEvent({
          event_type: "marketplace",
          event_subtype: injectionFlags.length > 0 ? "clone_flagged" : "clone",
          detail: `Cloned marketplace ${dirName} from ${body.url}` +
            (injectionFlags.length > 0 ? ` — ${injectionFlags.length} injection flag(s)` : ""),
          raw_data: {
            url: body.url,
            name: dirName,
            path: targetPath,
            initiated_via: "POST /api/agents/marketplaces",
            confirmed: true,
            injection_flags: injectionFlags,
            timestamp: new Date().toISOString(),
          },
        });
      } catch (e) {
        log.warn(`[marketplace] failed to write audit event: ${e instanceof Error ? e.message : String(e)}`);
      }
      void events?.emit("data.changed", { module: "agents", action: "marketplace_cloned" });

      server.json(res, 200, {
        success: true,
        name: dirName,
        path: targetPath,
        injection_flags: injectionFlags,
        flagged: injectionFlags.length > 0,
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/marketplaces/:name/refresh — git pull
  server.post("/api/agents/marketplaces/:name/refresh", async (req, res) => {
    try {
      const name = (req as unknown as { params: Record<string, string> }).params?.name;
      if (!name || !/^[A-Za-z0-9_.-]{1,80}$/.test(name)) {
        server.json(res, 400, { error: "invalid name" });
        return;
      }
      const { existsSync } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const { execFileSync } = await import("node:child_process");
      const hostHome = process.env.HOST_HOME ?? homedir();
      const mpPath = resolvePath(hostHome, ".claude/plugins/marketplaces", name);
      if (!existsSync(mpPath)) {
        server.json(res, 404, { error: "marketplace not found" });
        return;
      }
      try {
        const output = execFileSync("git", ["-C", mpPath, "pull", "--ff-only"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
        });
        server.json(res, 200, { success: true, output: output.slice(0, 500) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        server.json(res, 500, { error: `git pull failed: ${msg.slice(0, 300)}` });
      }
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // DELETE /api/agents/marketplaces/:name — remove a marketplace
  server.delete("/api/agents/marketplaces/:name", async (req, res) => {
    try {
      const name = (req as unknown as { params: Record<string, string> }).params?.name;
      if (!name || !/^[A-Za-z0-9_.-]{1,80}$/.test(name)) {
        server.json(res, 400, { error: "invalid name" });
        return;
      }
      const { existsSync } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const { execFileSync } = await import("node:child_process");
      const hostHome = process.env.HOST_HOME ?? homedir();
      const mpPath = resolvePath(hostHome, ".claude/plugins/marketplaces", name);
      if (!existsSync(mpPath)) {
        server.json(res, 404, { error: "marketplace not found" });
        return;
      }
      try {
        execFileSync("rm", ["-rf", mpPath]);
        server.json(res, 200, { success: true });
      } catch (err) {
        server.json(res, 500, { error: `rm failed: ${String(err)}` });
      }
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/extensions — inventario de skills/plugins/MCPs del host
  // available to mount inside the claude_code agent sandbox.
  server.get("/api/agents/extensions", async (_req, res) => {
    try {
      const { readdir, readFile, stat } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      const { resolve: resolvePath, basename } = await import("node:path");

      const hostHome = process.env.HOST_HOME ?? homedir();
      const skillsDir = resolvePath(hostHome, ".claude/skills");
      const marketplacesDir = resolvePath(hostHome, ".claude/plugins/marketplaces");

      type SkillEntry = { name: string; source: "user" | "plugin"; plugin?: string; marketplace?: string; description: string; path: string };
      type PluginEntry = { name: string; marketplace: string; path: string; description: string; provides: { skills: string[]; agents: string[]; commands: string[] } };
      type McpEntry = { name: string; source: string; type: string; description: string };

      const skills: SkillEntry[] = [];
      const plugins: PluginEntry[] = [];
      const mcps: McpEntry[] = [];

      // Frontmatter parsing delegates to the LRU-cached sanitizer in core.
      // Files that fail the prompt-injection check return null and are
      // silently skipped — the dashboard already treats null as "skip".
      const { parseSkillMdFrontmatter } = await import("../../core/prompt-sanitizer.js");
      async function parseSkillMd(filePath: string): Promise<{ name?: string; description?: string } | null> {
        return parseSkillMdFrontmatter(filePath);
      }

      // 1) User-level skills: ~/.claude/skills/<name>/SKILL.md
      if (existsSync(skillsDir)) {
        try {
          const dirs = await readdir(skillsDir, { withFileTypes: true });
          for (const d of dirs) {
            if (!d.isDirectory()) continue;
            const skillPath = resolvePath(skillsDir, d.name);
            const mdPath = resolvePath(skillPath, "SKILL.md");
            if (!existsSync(mdPath)) continue;
            const meta = await parseSkillMd(mdPath);
            skills.push({
              name: meta?.name ?? d.name,
              source: "user",
              description: meta?.description ?? "",
              path: skillPath,
            });
          }
        } catch { /* ignore */ }
      }

      // 2) Marketplaces: ~/.claude/plugins/marketplaces/<mp>/plugins/<plugin>/
      if (existsSync(marketplacesDir)) {
        let mpDirs: string[] = [];
        try {
          mpDirs = (await readdir(marketplacesDir, { withFileTypes: true }))
            .filter(d => d.isDirectory() && !d.name.startsWith("."))
            .map(d => d.name);
        } catch { /* ignore */ }

        for (const mpName of mpDirs) {
          const pluginsRoot = resolvePath(marketplacesDir, mpName, "plugins");
          if (!existsSync(pluginsRoot)) continue;
          let pluginDirs: string[] = [];
          try {
            pluginDirs = (await readdir(pluginsRoot, { withFileTypes: true }))
              .filter(d => d.isDirectory() && !d.name.startsWith("."))
              .map(d => d.name);
          } catch { continue; }

          for (const plName of pluginDirs) {
            const pluginPath = resolvePath(pluginsRoot, plName);
            const provides = { skills: [] as string[], agents: [] as string[], commands: [] as string[] };
            let pluginDescription = "";

            // Plugin manifest (opcional): .claude-plugin/plugin.json
            const manifestPath = resolvePath(pluginPath, ".claude-plugin", "plugin.json");
            if (existsSync(manifestPath)) {
              try {
                const mf = JSON.parse(await readFile(manifestPath, "utf-8"));
                pluginDescription = String(mf.description ?? "");
              } catch { /* ignore */ }
            }

            // Skills del plugin
            const pluginSkillsDir = resolvePath(pluginPath, "skills");
            if (existsSync(pluginSkillsDir)) {
              try {
                const ss = await readdir(pluginSkillsDir, { withFileTypes: true });
                for (const s of ss) {
                  if (!s.isDirectory()) continue;
                  const mdPath = resolvePath(pluginSkillsDir, s.name, "SKILL.md");
                  if (!existsSync(mdPath)) continue;
                  const meta = await parseSkillMd(mdPath);
                  const skillName = meta?.name ?? s.name;
                  provides.skills.push(skillName);
                  skills.push({
                    name: skillName,
                    source: "plugin",
                    plugin: plName,
                    marketplace: mpName,
                    description: meta?.description ?? "",
                    path: resolvePath(pluginSkillsDir, s.name),
                  });
                }
              } catch { /* ignore */ }
            }

            // Plugin agents (names only, for now)
            const pluginAgentsDir = resolvePath(pluginPath, "agents");
            if (existsSync(pluginAgentsDir)) {
              try {
                const as = await readdir(pluginAgentsDir, { withFileTypes: true });
                for (const a of as) if (a.isFile() && a.name.endsWith(".md")) {
                  provides.agents.push(a.name.replace(/\.md$/, ""));
                }
              } catch { /* ignore */ }
            }

            // Commands
            const pluginCmdsDir = resolvePath(pluginPath, "commands");
            if (existsSync(pluginCmdsDir)) {
              try {
                const cs = await readdir(pluginCmdsDir, { withFileTypes: true });
                for (const c of cs) if (c.isFile() && c.name.endsWith(".md")) {
                  provides.commands.push(c.name.replace(/\.md$/, ""));
                }
              } catch { /* ignore */ }
            }

            plugins.push({
              name: plName,
              marketplace: mpName,
              path: pluginPath,
              description: pluginDescription,
              provides,
            });
          }
        }
      }

      // 3) MCPs — manual inventory + minimal discovery
      // Kernel-internal: el propio kernl en 3086/mcp
      mcps.push({
        name: "kernl",
        source: "kernel-internal",
        type: "http",
        description: "Local kernel MCP server (every Kernl tool available over HTTP).",
      });

      // MCPs from the user's ~/.claude.json (when present)
      const userClaudeJson = resolvePath(hostHome, ".claude.json");
      if (existsSync(userClaudeJson)) {
        try {
          const cfg = JSON.parse(await readFile(userClaudeJson, "utf-8")) as { mcpServers?: Record<string, { type?: string; command?: string; url?: string; description?: string }> };
          if (cfg.mcpServers && typeof cfg.mcpServers === "object") {
            for (const [name, srv] of Object.entries(cfg.mcpServers)) {
              mcps.push({
                name,
                source: "user-config",
                type: srv.type ?? "stdio",
                description: srv.description ?? `${srv.type ?? "stdio"} MCP from ~/.claude.json`,
              });
            }
          }
        } catch { /* ignore */ }
      }

      // Ordenar
      skills.sort((a, b) => a.name.localeCompare(b.name));
      plugins.sort((a, b) => `${a.marketplace}/${a.name}`.localeCompare(`${b.marketplace}/${b.name}`));
      mcps.sort((a, b) => a.name.localeCompare(b.name));

      // Stats por conveniencia
      void stat; void basename;
      server.json(res, 200, {
        skills, plugins, mcps,
        counts: { skills: skills.length, plugins: plugins.length, mcps: mcps.length },
        home: hostHome,
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/workspaces — offices with their workspaces nested
  server.get("/api/agents/workspaces", async (_req, res) => {
    try {
      if (!wsService) { server.json(res, 200, { offices: [] }); return; }
      const all = wsService.listAll();
      const flows = service.listFlows?.() ?? [];
      const flowById = new Map(flows.map((f: { id: string; name: string; color: string }) => [f.id, f]));

      const officeMap = new Map<string, { flow_id: string; name: string; color: string; workspaces: Array<Record<string, unknown>> }>();
      for (const w of all) {
        const stats = await computeWsStats(w.id);
        const meta = flowById.get(w.owner_flow_id);
        if (!officeMap.has(w.owner_flow_id)) {
          officeMap.set(w.owner_flow_id, {
            flow_id: w.owner_flow_id,
            name: meta?.name ?? w.owner_flow_id,
            color: meta?.color ?? "#6366f1",
            workspaces: [],
          });
        }
        officeMap.get(w.owner_flow_id)!.workspaces.push({
          id: w.id,
          name: w.name,
          description: w.description,
          shared: w.shared === 1,
          files: stats.files,
          bytes: stats.bytes,
          mtime: stats.mtime,
        });
      }

      const offices = [...officeMap.values()].sort((a, b) => a.name.localeCompare(b.name));
      for (const o of offices) o.workspaces.sort((a, b) => (b.mtime as number) - (a.mtime as number));
      server.json(res, 200, { offices });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/workspace/:wsId — list files recursively
  server.get("/api/agents/workspace/:wsId", async (req, res) => {
    try {
      const wsId = (req as unknown as { params: Record<string, string> }).params?.wsId;
      if (!wsId) { server.json(res, 400, { error: "wsId required" }); return; }
      // Validate workspace exists (if service available) — otherwise fall back to raw dir
      if (wsService && !wsService.get(wsId)) { server.json(res, 404, { error: "workspace not found" }); return; }
      const dir = resolve(workspaceRoot, wsId);
      if (!dir.startsWith(workspaceRoot)) { server.json(res, 403, { error: "forbidden" }); return; }

      const files: Array<{ path: string; type: string; size: number }> = [];
      async function walk(d: string, prefix: string): Promise<void> {
        const { readdir, stat } = await import("node:fs/promises");
        let entries;
        try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.name === "node_modules" || e.name === ".git") continue;
          if (e.isDirectory()) {
            files.push({ path: rel, type: "dir", size: 0 });
            await walk(resolve(d, e.name), rel);
          } else {
            const s = await stat(resolve(d, e.name)).catch(() => ({ size: 0 }));
            files.push({ path: rel, type: "file", size: s.size });
          }
        }
      }
      await walk(dir, "");
      const ws = wsService?.get(wsId);
      server.json(res, 200, {
        workspace_id: wsId,
        workspace: ws ? { id: ws.id, name: ws.name, description: ws.description, shared: ws.shared === 1, owner_flow_id: ws.owner_flow_id } : null,
        files,
        total: files.length,
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/workspace/:wsId/file?path=... — read a file
  server.get("/api/agents/workspace/:wsId/file", async (req, res) => {
    try {
      const wsId = (req as unknown as { params: Record<string, string> }).params?.wsId;
      const url = new URL(req.url ?? "/", "http://localhost");
      const filePath = url.searchParams.get("path") ?? "";
      if (!wsId || !filePath) { server.json(res, 400, { error: "wsId and path required" }); return; }
      if (wsService && !wsService.get(wsId)) { server.json(res, 404, { error: "workspace not found" }); return; }
      const target = resolve(workspaceRoot, wsId, filePath);
      if (!target.startsWith(resolve(workspaceRoot, wsId))) { server.json(res, 403, { error: "forbidden" }); return; }

      const { readFile } = await import("node:fs/promises");
      const content = await readFile(target, "utf-8");
      server.json(res, 200, { path: filePath, content, size: content.length });
    } catch {
      server.json(res, 404, { error: "file not found" });
    }
  });

  // GET /api/agents/:id/cwd-files — list files under an agent's __cwd_path__
  // (an absolute repo path OUTSIDE data/workspaces). Jailed to that path.
  server.get("/api/agents/:id/cwd-files", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const agent = service.getAgent(id);
      if (!agent) { server.json(res, 404, { error: "Agent not found" }); return; }
      let vars: Record<string, unknown> = {};
      try { vars = JSON.parse((agent as { variables?: string }).variables || "{}"); } catch { /* defaults */ }
      const cwd = typeof vars.__cwd_path__ === "string" ? vars.__cwd_path__ : "";
      if (!cwd || !cwd.startsWith("/")) { server.json(res, 400, { error: "agent has no absolute __cwd_path__" }); return; }
      const root = resolve(cwd);
      const { readdir, stat } = await import("node:fs/promises");
      const files: Array<{ path: string; type: string; size: number }> = [];
      async function walk(d: string, prefix: string, depth: number): Promise<void> {
        if (depth > 8) return;
        let entries;
        try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name === "node_modules" || e.name === ".git" || e.name === ".wrangler") continue;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) {
            files.push({ path: rel, type: "dir", size: 0 });
            await walk(resolve(d, e.name), rel, depth + 1);
          } else {
            const s = await stat(resolve(d, e.name)).catch(() => ({ size: 0 }));
            files.push({ path: rel, type: "file", size: (s as { size: number }).size });
          }
        }
      }
      await walk(root, "", 0);
      const previewUrl = typeof vars.__preview_url__ === "string" ? vars.__preview_url__ : null;
      server.json(res, 200, { cwd: root, preview_url: previewUrl, files, total: files.length });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/:id/cwd-file?path=... — read a file jailed under __cwd_path__
  server.get("/api/agents/:id/cwd-file", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      const url = new URL(req.url ?? "/", "http://localhost");
      const filePath = url.searchParams.get("path") ?? "";
      if (!id || !filePath) { server.json(res, 400, { error: "id and path required" }); return; }
      const agent = service.getAgent(id);
      if (!agent) { server.json(res, 404, { error: "Agent not found" }); return; }
      let vars: Record<string, unknown> = {};
      try { vars = JSON.parse((agent as { variables?: string }).variables || "{}"); } catch { /* defaults */ }
      const cwd = typeof vars.__cwd_path__ === "string" ? vars.__cwd_path__ : "";
      if (!cwd || !cwd.startsWith("/")) { server.json(res, 400, { error: "agent has no absolute __cwd_path__" }); return; }
      const root = resolve(cwd);
      const target = resolve(root, filePath);
      if (target !== root && !target.startsWith(root + "/")) { server.json(res, 403, { error: "forbidden" }); return; }
      const { readFile, stat } = await import("node:fs/promises");
      const s = await stat(target).catch(() => null);
      if (!s || !s.isFile()) { server.json(res, 404, { error: "file not found" }); return; }
      if (s.size > 512 * 1024) { server.json(res, 200, { path: filePath, content: `(file too large to preview: ${s.size} bytes)`, size: s.size }); return; }
      const content = await readFile(target, "utf-8");
      server.json(res, 200, { path: filePath, content, size: content.length });
    } catch {
      server.json(res, 404, { error: "file not found" });
    }
  });

  // ── Claude Code host config ────────────────────────────────────
  // Wraps ~/.claude.json + ~/.claude/settings.json so the dashboard can manage
  // user-scope MCPs + plugin enablement exactly as `claude mcp add` / `claude
  // plugin` would. Files are the source of truth; the CLI and the SDK read
  // from the same locations.

  server.get("/api/claude-config", async (_req, res) => {
    try {
      const cfg = await import("./claude-host-config.js");
      server.json(res, 200, {
        hostHome: cfg.hostHome(),
        mcpServers: cfg.readUserScopeMcps(),
        enabledPlugins: cfg.readEnabledPlugins(),
        extraKnownMarketplaces: cfg.readClaudeSettings().extraKnownMarketplaces ?? {},
      });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.post("/api/claude-config/mcp", async (req, res) => {
    try {
      const body = await server.parseBody<{
        name: string;
        type?: "stdio" | "http" | "sse";
        command?: string;
        args?: string[];
        url?: string;
        env?: Record<string, string>;
      }>(req);
      if (!body.name || !/^[a-z0-9][a-z0-9_-]*$/i.test(body.name)) {
        server.json(res, 400, { error: "Invalid name (alphanumeric, dashes, underscores)" });
        return;
      }
      const type = body.type ?? (body.url ? "http" : "stdio");
      if (type === "stdio" && !body.command) { server.json(res, 400, { error: "stdio MCP requires 'command'" }); return; }
      if ((type === "http" || type === "sse") && !body.url) { server.json(res, 400, { error: `${type} MCP requires 'url'` }); return; }

      const cfg = await import("./claude-host-config.js");
      const mcp: import("./claude-host-config.js").ClaudeMcpServer =
        type === "stdio"
          ? { type: "stdio", command: body.command!, args: body.args, env: body.env }
          : { type, url: body.url!, env: body.env };
      cfg.upsertUserScopeMcp(body.name, mcp);
      server.json(res, 200, { ok: true, name: body.name, scope: "user" });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.delete("/api/claude-config/mcp/:name", async (req, res) => {
    try {
      const name = (req as unknown as { params: Record<string, string> }).params?.name;
      if (!name) { server.json(res, 400, { error: "name required" }); return; }
      const cfg = await import("./claude-host-config.js");
      const result = cfg.removeUserScopeMcp(name);
      if (!result.removedFromJson && !result.removedFromSettings) {
        server.json(res, 404, { error: `MCP "${name}" not found in user scope` });
        return;
      }
      server.json(res, 200, { ok: true, ...result });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.post("/api/claude-config/plugin/:ref/enable", async (req, res) => {
    await togglePluginEndpoint(req, res, true);
  });
  server.post("/api/claude-config/plugin/:ref/disable", async (req, res) => {
    await togglePluginEndpoint(req, res, false);
  });

  async function togglePluginEndpoint(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    enabled: boolean,
  ): Promise<void> {
    try {
      const ref = (req as unknown as { params: Record<string, string> }).params?.ref;
      if (!ref) { server.json(res, 400, { error: "plugin ref required" }); return; }
      const decoded = decodeURIComponent(ref);
      const cfg = await import("./claude-host-config.js");
      cfg.setPluginEnabled(decoded, enabled);
      server.json(res, 200, { ok: true, ref: decoded, enabled });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Per-agent private workspace (plugins + skills) ────────────
  // Each claude_code agent can own physical plugin/skill copies under
  // `data/agents/<agentId>/plugins/<name>/` and `data/agents/<agentId>/skills/<name>/`.
  // The executor's resolvers check these paths before the user-scope ones, so
  // an agent can use a plugin/skill that is NOT installed in ~/.claude/.

  server.get("/api/agents/:id/private-plugins", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "agent id required" }); return; }
      const { readdirSync, statSync, existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const dir = resolve(process.cwd(), `data/agents/${id}/plugins`);
      if (!existsSync(dir)) { server.json(res, 200, { items: [] }); return; }
      const items = readdirSync(dir)
        .filter((name) => {
          try { return statSync(resolve(dir, name)).isDirectory(); } catch { return false; }
        })
        .map((name) => ({ name, path: resolve(dir, name) }));
      server.json(res, 200, { items });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.post("/api/agents/:id/private-plugins/copy-from-marketplace", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "agent id required" }); return; }
      const body = await server.parseBody<{ source: string }>(req);
      if (!body.source) { server.json(res, 400, { error: "source (marketplace/plugin) required" }); return; }
      if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(body.source)) {
        server.json(res, 400, { error: "source must be 'marketplace/plugin' slug" });
        return;
      }
      const [mk, pluginName] = body.source.split("/", 2);
      const home = process.env.HOST_HOME ?? process.env.HOME ?? "";
      const { cpSync, existsSync, mkdirSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const srcPath = `${home}/.claude/plugins/marketplaces/${mk}/plugins/${pluginName}`;
      if (!existsSync(srcPath)) { server.json(res, 404, { error: `Plugin "${body.source}" not found at ${srcPath}` }); return; }
      const destDir = resolve(process.cwd(), `data/agents/${id}/plugins`);
      mkdirSync(destDir, { recursive: true });
      const destPath = resolve(destDir, pluginName);
      if (existsSync(destPath)) { server.json(res, 409, { error: `Agent already has private plugin "${pluginName}" — remove it first` }); return; }
      cpSync(srcPath, destPath, { recursive: true, dereference: true });
      server.json(res, 200, { ok: true, name: pluginName, path: destPath });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.delete("/api/agents/:id/private-plugins/:name", async (req, res) => {
    try {
      const params = (req as unknown as { params: Record<string, string> }).params ?? {};
      const { id, name } = params;
      if (!id || !name) { server.json(res, 400, { error: "agent id + plugin name required" }); return; }
      const { rmSync, existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const target = resolve(process.cwd(), `data/agents/${id}/plugins/${name}`);
      if (!existsSync(target)) { server.json(res, 404, { error: "not found" }); return; }
      rmSync(target, { recursive: true, force: true });
      server.json(res, 200, { ok: true, removed: name });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Mirror: skills
  server.get("/api/agents/:id/private-skills", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "agent id required" }); return; }
      const { readdirSync, statSync, existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const dir = resolve(process.cwd(), `data/agents/${id}/skills`);
      if (!existsSync(dir)) { server.json(res, 200, { items: [] }); return; }
      const items = readdirSync(dir)
        .filter((name) => {
          try { return statSync(resolve(dir, name)).isDirectory(); } catch { return false; }
        })
        .map((name) => ({ name, path: resolve(dir, name) }));
      server.json(res, 200, { items });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.post("/api/agents/:id/private-skills/copy-from-user", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "agent id required" }); return; }
      const body = await server.parseBody<{ name: string }>(req);
      if (!body.name || !/^[a-z0-9][a-z0-9_-]*$/i.test(body.name)) {
        server.json(res, 400, { error: "name (skill slug) required" }); return;
      }
      const home = process.env.HOST_HOME ?? process.env.HOME ?? "";
      const { cpSync, existsSync, mkdirSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const srcPath = `${home}/.claude/skills/${body.name}`;
      if (!existsSync(srcPath)) { server.json(res, 404, { error: `Skill "${body.name}" not found at ${srcPath}` }); return; }
      const destDir = resolve(process.cwd(), `data/agents/${id}/skills`);
      mkdirSync(destDir, { recursive: true });
      const destPath = resolve(destDir, body.name);
      if (existsSync(destPath)) { server.json(res, 409, { error: `Agent already has private skill "${body.name}"` }); return; }
      cpSync(srcPath, destPath, { recursive: true, dereference: true });
      server.json(res, 200, { ok: true, name: body.name, path: destPath });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.delete("/api/agents/:id/private-skills/:name", async (req, res) => {
    try {
      const params = (req as unknown as { params: Record<string, string> }).params ?? {};
      const { id, name } = params;
      if (!id || !name) { server.json(res, 400, { error: "agent id + skill name required" }); return; }
      const { rmSync, existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const target = resolve(process.cwd(), `data/agents/${id}/skills/${name}`);
      if (!existsSync(target)) { server.json(res, 404, { error: "not found" }); return; }
      rmSync(target, { recursive: true, force: true });
      server.json(res, 200, { ok: true, removed: name });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  log.info("Agent routes registered (/api/agents/*) + Claude host config (/api/claude-config) + private workspace");
}
