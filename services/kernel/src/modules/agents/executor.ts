import { log } from "../../core/logger.js";
import { isoNow } from "../../core/helpers.js";
import { zodToJsonSchema } from "../../core/zod-to-json.js";
import type { ToolDefinition, ToolResult } from "../../core/types.js";
import type { KernelConfig } from "../../core/config.js";
import { isProviderExhausted, markProviderExhausted } from "../../core/llm/chat-adapters.js";
import * as providerHealth from "../../core/llm/provider-health.js";
import type { ChatLlmProvider } from "../../core/llm/chat-adapters.js";
import type { ChatMessage } from "../chat/types.js";
import { runToolLoop } from "../../core/llm/tool-loop.js";
import type { LlmLoopTool, LlmLoopResult } from "../../core/llm/tool-loop.js";
import { buildToolSearch, buildToolDescribe, buildCodeRun } from "../meta/index.js";
import { RankingService } from "../../core/ranking/service.js";
import type { EmbeddingsClient } from "../../core/embeddings/client.js";
import type { Agent, AgentRun, AgentStep } from "./types.js";
import type { AgentService } from "./service.js";
import { normalizeDriverResult, driverThrewOutcome } from "./driver-result.js";
import type { BuiltinHandler } from "./builtin-handlers.js";
import type { AltExecutorLike, EvalServiceLike } from "./advanced-types.js";
import type { EventBus } from "../../core/event-bus.js";
import { resolveAgentSystemPrompt, resolveAgentGoalTemplate, resolveAgentLanguage } from "./i18n.js";
import {
  promptTodayDate,
  promptInvokedBy,
  promptDefaultAgent,
  promptInboxBlock,
  promptLearningsBlock,
  promptPerformanceBlock,
  promptSimilarRunsBlock,
  promptMemorySummaryBlock,
  promptMemoryGoalSuffix,
  promptWorkspaceMandate,
  promptProgressiveDiscovery,
  promptStyleDirective,
} from "../../core/i18n/prompts.js";

type LlmToolDef = LlmLoopTool;

/**
 * Keep only the chain entries whose provider can actually run a tool loop.
 *
 * An agent run hands its whole tool catalogue to the provider. A provider that
 * declares `supportsToolLoop: false` — today only the claude_code CLI shim,
 * which runs a single turn with no tools — will not execute a single one of
 * them; it fails with a turn-limit error that names neither tools nor the
 * provider's limitation. Dropping it here turns a confusing runtime failure
 * into a chain that either works or reports precisely why it cannot.
 *
 * With no tools in play the provider is perfectly good, so the filter only
 * applies when the run is actually sending some.
 */
export function selectToolCapable<T extends { provider: ChatLlmProvider; configProvider: string }>(
  chain: T[],
  toolCount: number,
): { chain: T[]; dropped: string[] } {
  if (toolCount <= 0) return { chain, dropped: [] };
  const dropped: string[] = [];
  const kept = chain.filter((entry) => {
    if (entry.provider.supportsToolLoop === false) {
      dropped.push(entry.provider.name);
      return false;
    }
    return true;
  });
  return { chain: kept, dropped };
}

export interface ExecutionResult {
  status: "completed" | "failed";
  result: string;
  error: string;
  steps_count: number;
  tokens_used: number;
}

const DEFAULT_MAX_CHAIN_DEPTH = 5;
const DEFAULT_INVOKE_TIMEOUT_MS = 300_000;

/**
 * Tools every agent gets by default so every agent in the fleet knows about
 * — and can talk to — every other agent. An agent can still opt out of any
 * of these via `denied_tools`, but they never need to opt IN.
 *
 * kernel_agents_invoke is listed here, but its executor handler is wired
 * per-run below (it captures the calling agent + depth for recursion).
 */
const SOCIAL_TOOL_BASELINE = [
  "kernel_agents_directory",
  "kernel_agents_memory",
  "kernel_agents_inbox",
  "kernel_agents_post_to_colleague",
  "kernel_agents_call_meeting",
  "kernel_agents_invoke",
  "kernel_agents_subscribe_conversation",
  "kernel_agents_unsubscribe_conversation",
  "kernel_agents_list_subscriptions",
  // Every agent should be able to escalate to the human via multiple-choice
  // questions when stuck — same UX as personal-scrapers' watcher, but reusable.
  // Lands in `/api/agents/questions?status=pending`, rendered in My Office.
  "kernel_agents_ask_supervisor",
];

/** Does this error justify falling back to the next (provider, model) in the agent's chain? */
function isRetryableChainError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Quota / payment
  if (/insufficient_quota|exceeded your current quota|credit balance/i.test(msg)) return true;
  if (/API error 429|API error 402/.test(msg)) return true;
  // Model not found / unavailable
  if (/model_not_found|model.*not.*available|API error 404/i.test(msg)) return true;
  // Server-side hiccup
  if (/API error 5\d\d/.test(msg)) return true;
  // Network
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|network|fetch failed/i.test(msg)) return true;
  return false;
}

/** Subset of retryable errors that should also mark the provider as globally exhausted. */
function isProviderQuotaError(msg: string): boolean {
  return /insufficient_quota|exceeded your current quota|credit balance|API error 429|API error 402/i.test(msg);
}

export class AgentExecutor {
  private allTools: ToolDefinition[] = [];

  /** Read-only snapshot of the full kernel tool catalog — used by the
   *  /api/agents/generate-from-prompt endpoint to ground LLM suggestions. */
  getToolCatalog(): ReadonlyArray<ToolDefinition> {
    return this.allTools;
  }
  private providers: Map<string, ChatLlmProvider> = new Map();
  private defaultProvider = "";
  private evalService: EvalServiceLike | null = null;
  private claudeCodeExecutor: AltExecutorLike | null = null;
  /** Resolves agent.skills_json → SKILL.md bodies. Set by bootstrap. */
  private skillResolver: import("./skill-resolver.js").SkillBodyResolver | null = null;
  setSkillResolver(resolver: import("./skill-resolver.js").SkillBodyResolver): void {
    this.skillResolver = resolver;
  }
  getSkillResolver(): import("./skill-resolver.js").SkillBodyResolver | null {
    return this.skillResolver;
  }
  /** Reference to the live KernelConfig — `language` is read on every run so live changes apply. */
  private configRef: KernelConfig | null = null;
  /** Active runs — maps run ID to abort flag */
  private activeRuns = new Map<string, { cancelled: boolean }>();

  setConfig(config: KernelConfig): void {
    this.configRef = config;
  }

  setEvalService(evalService: EvalServiceLike): void {
    this.evalService = evalService;
  }

  setClaudeCodeExecutor(exec: AltExecutorLike): void {
    this.claudeCodeExecutor = exec;
  }

  /** Cancel a running agent by run ID */
  cancelRun(runId: string): boolean {
    const entry = this.activeRuns.get(runId);
    if (entry) {
      entry.cancelled = true;
      return true;
    }
    // Fall back to the claude_code executor — sus runs tienen AbortController propio.
    return this.claudeCodeExecutor?.cancelRun(runId) ?? false;
  }

  /** Cancel all running agents for a given agent ID */
  cancelByAgentId(agentId: string, service: AgentService): number {
    const runs = service.listRuns({ agent_id: agentId, status: "running" });
    let count = 0;
    for (const run of runs) {
      if (this.cancelRun(run.id)) count++;
    }
    return count;
  }

  /** Get IDs of all currently active runs */
  getActiveRunIds(): string[] {
    return [...this.activeRuns.keys()];
  }

  setProviders(
    providers: Map<string, ChatLlmProvider>,
    defaultProvider: string,
  ): void {
    this.providers = providers;
    this.defaultProvider = defaultProvider;
  }

  setKernelTools(tools: ToolDefinition[]): void {
    this.allTools = tools;
    log.info(`AgentExecutor: ${tools.length} kernel tools available`);
  }

  /** Builtin handlers — when set, agent.builtin_handler short-circuits LLM path. */
  private builtinHandlers: Map<string, BuiltinHandler> = new Map();
  setBuiltinHandlers(handlers: Map<string, BuiltinHandler>): void {
    this.builtinHandlers = handlers;
    log.info(`AgentExecutor: ${handlers.size} builtin handlers registered`);
  }

  async execute(params: {
    agent: Agent;
    goal: string;
    run: AgentRun;
    service: AgentService;
    events?: EventBus;
    depth?: number;
  }): Promise<ExecutionResult> {
    const { agent, goal, run, service, events } = params;
    const depth = params.depth ?? 0;
    let stepNumber = 0;
    let totalTokens = 0;

    // Chain depth guard
    const maxChainDepth = this.configRef?.agents?.maxInvokeDepth ?? DEFAULT_MAX_CHAIN_DEPTH;
    if (depth > maxChainDepth) {
      return {
        status: "failed",
        result: "",
        error: `Max chain depth exceeded (limit: ${maxChainDepth})`,
        steps_count: 0,
        tokens_used: 0,
      };
    }

    // Register active run for cancellation support
    const runState = { cancelled: false };
    this.activeRuns.set(run.id, runState);

    // Builtin handler short-circuit — skip the LLM path entirely when the agent
    // is backed by a native function. Lets manual runs, chains, and the API
    // invoke handlers (like email:triage) without hitting LLM tool limits.
    if (agent.builtin_handler && this.builtinHandlers.has(agent.builtin_handler)) {
      const handler = this.builtinHandlers.get(agent.builtin_handler)!;
      events?.emit("agent:flow:run_started", {
        agent_id: agent.id,
        agent_name: agent.name,
        run_id: run.id,
        goal,
      });
      // Same normalization as the scheduler's cron path: a handler that throws
      // or returns { ok: false } fails the run, and either way the outcome
      // feeds the persistent circuit breaker. Manual "Run now" must count
      // exactly like a scheduled run — otherwise a broken agent could be kept
      // alive (or paused) depending only on who triggered it.
      const outcome = await handler()
        .then((raw) => normalizeDriverResult(raw))
        .catch((err) => {
          log.error(`Builtin handler "${agent.builtin_handler}" threw:`, err);
          return driverThrewOutcome(err);
        });

      events?.emit("agent:flow:run_completed", {
        agent_id: agent.id, agent_name: agent.name, run_id: run.id,
        status: outcome.ok ? "completed" : "failed", steps_count: 1, tokens_used: 0,
        result_preview: outcome.text.slice(0, 200),
        error: outcome.error,
      });
      service.recordRunOutcome(agent.id, {
        ok: outcome.ok,
        error: outcome.error,
        run_id: run.id,
      });
      this.activeRuns.delete(run.id);
      if (!outcome.ok) {
        log.error(`Builtin handler "${agent.builtin_handler}" failed — ${outcome.error}`);
      }
      return {
        status: outcome.ok ? "completed" : "failed",
        result: outcome.text,
        error: outcome.error,
        steps_count: 1,
        tokens_used: 0,
      };
    }

    // Route a claude_code agents al SDK — keep declarative chains/auto-eval
    // out of the way; the SDK-backed executor emits the same flow events.
    if (agent.executor_type === "claude_code") {
      if (!this.claudeCodeExecutor) {
        this.activeRuns.delete(run.id);
        return {
          status: "failed",
          result: "",
          error: "claude_code executor not wired — check module initialization",
          steps_count: 0,
          tokens_used: 0,
        };
      }
      try {
        const result = await this.claudeCodeExecutor.execute({
          agent, goal, run, service, events, depth,
        });
        // We still want the declarative chains to run on completion.
        this.executeDeclarativeChains(agent, run, result, service, depth, events);
        return result;
      } finally {
        this.activeRuns.delete(run.id);
      }
    }

    // Emit flow event: run started
    events?.emit("agent:flow:run_started", {
      agent_id: agent.id,
      agent_name: agent.name,
      run_id: run.id,
      goal: goal.slice(0, 300),
      trigger_type: run.trigger_type,
    });
    service.logEvent({
      run_id: run.id,
      agent_id: agent.id,
      agent_name: agent.name,
      event_type: "run",
      event_subtype: "started",
      detail: `Goal: ${goal.slice(0, 200)}`,
      raw_data: { goal: goal.slice(0, 300), trigger_type: run.trigger_type },
    });

    // 1. Resolve allowed tools (baseline social tools auto-included unless denied).
    const { llmTools, toolExecutor } = this.resolveTools(agent, service.getEmbeddingsClient());

    // 2. kernel_agents_invoke: its schema is in the baseline, but the handler
    //    needs per-run context (caller id, depth) to recurse safely. Only wire
    //    the handler when the tool wasn't denied.
    const deniedSet = new Set(parseJsonArray(agent.denied_tools));
    const invokeAllowed = !deniedSet.has("kernel_agents_invoke");
    if (invokeAllowed && !llmTools.some(t => t.name === "kernel_agents_invoke")) {
      llmTools.push({
        name: "kernel_agents_invoke",
        description:
          "Invoke another AI agent by its UUID and wait for its result. " +
          "Use when you need a pointed, blocking answer from another agent. " +
          "For async back-and-forth prefer kernel_agents_post_to_colleague; " +
          "for group deliberation use kernel_agents_call_meeting.",
        input_schema: {
          type: "object",
          properties: {
            agent_id: { type: "string", description: "UUID of the target AI agent (not a tool name)" },
            goal: { type: "string", description: "Goal/instruction for the target agent" },
          },
          required: ["agent_id", "goal"],
        },
      });
    }

    toolExecutor.set("kernel_agents_invoke", async (args: unknown) => {
      const input = args as { agent_id: string; goal: string };
      const targetAgent = service.getAgent(input.agent_id);
      if (!targetAgent) {
        return { content: [{ type: "text" as const, text: `Agent not found: ${input.agent_id}` }], isError: true };
      }
      if (!targetAgent.active) {
        return { content: [{ type: "text" as const, text: `Agent is inactive: ${targetAgent.name}` }], isError: true };
      }

      // Pre-recursion depth gate. The post-execute guard at the top of execute()
      // also catches it but firing here avoids creating a doomed child run.
      const cap = this.configRef?.agents?.maxInvokeDepth ?? DEFAULT_MAX_CHAIN_DEPTH;
      if (depth + 1 > cap) {
        return {
          content: [{
            type: "text" as const,
            text: `Cannot invoke "${targetAgent.name}": invocation chain at max depth (${cap}). ` +
                  `Resolve the current task or break the recursion before calling another agent.`,
          }],
          isError: true,
        };
      }

      // Propagate root_run_id so nested invokes share a single budget root.
      // If the calling run was itself an invoke target, its trigger_payload
      // already carries root_run_id; otherwise this run IS the root.
      let rootRunId = run.id;
      try {
        const tp = JSON.parse(run.trigger_payload || "{}") as Record<string, unknown>;
        if (typeof tp.root_run_id === "string" && tp.root_run_id) {
          rootRunId = tp.root_run_id;
        }
      } catch { /* ignore */ }

      const targetRun = service.createRun({
        agent_id: targetAgent.id,
        trigger_type: "chain",
        trigger_payload: {
          source_agent_id: agent.id,
          source_run_id: run.id,
          root_run_id: rootRunId,
          invoke_depth: depth + 1,
        },
        goal: input.goal,
        parent_run_id: run.id,
        parent_agent_id: agent.id,
        depth: depth + 1,
      });

      service.updateRun(targetRun.id, { status: "running", started_at: isoNow() });
      log.info(`Agent "${agent.name}" invoking agent "${targetAgent.name}" (depth: ${depth + 1})`);

      // Save inter-agent conversation: source asks target
      service.addMemory(agent.id, "assistant", `[To ${targetAgent.name}] ${input.goal.slice(0, 1000)}`, run.id);
      service.addMemory(targetAgent.id, "user", `[From ${agent.name}] ${input.goal.slice(0, 1000)}`, run.id);

      // Mirror into a generic conversation so the debate orchestrator and
      // dashboard can observe the exchange as a unified thread. One convo per
      // (topic_hash, participants) pair — reused if the same pair talks about
      // the same topic within the same hash window.
      const invokeConvo = service.findOrCreateChatConversation({
        topic: input.goal.slice(0, 300),
        participants: [agent.id, targetAgent.id],
        initiator_agent_id: agent.id,
      });
      const questionMsg = service.postMessage({
        conversation_id: invokeConvo.id,
        from_agent_id: agent.id,
        to_agent_id: targetAgent.id,
        role: "question",
        body: input.goal,
        run_id: run.id,
        meta: { via: "kernel_agents_invoke", depth: depth + 1 },
      });

      events?.emit("agent:flow:chain_triggered", {
        source_agent_id: agent.id, source_agent_name: agent.name,
        target_agent_id: targetAgent.id, target_agent_name: targetAgent.name,
        chain_id: `invoke-${agent.id}-${targetAgent.id}`, chain_label: `${agent.name} → ${targetAgent.name}`,
        run_id: targetRun.id,
      });
      service.logEvent({
        run_id: targetRun.id, agent_id: targetAgent.id, agent_name: targetAgent.name,
        event_type: "chain", event_subtype: "triggered",
        detail: `${agent.name} -> ${targetAgent.name}`,
        raw_data: { source_agent_id: agent.id, source_agent_name: agent.name, chain_id: `invoke-${agent.id}-${targetAgent.id}` },
      });

      // Hard timeout on the recursive await — prevents an unresponsive child
      // (or a long sub-tree of invokes) from hanging the parent. We cancel
      // the target run on timeout so its state doesn't stay 'running' forever.
      const timeoutMs = this.configRef?.agents?.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
      const TIMEOUT_SENTINEL: ExecutionResult = {
        status: "failed",
        result: "",
        error: `Invoke timeout: ${targetAgent.name} did not return within ${timeoutMs}ms`,
        steps_count: 0,
        tokens_used: 0,
      };
      const result = await Promise.race<ExecutionResult>([
        this.execute({
          agent: targetAgent,
          goal: input.goal,
          run: targetRun,
          service,
          events,
          depth: depth + 1,
        }),
        new Promise<ExecutionResult>((resolve) =>
          setTimeout(() => {
            // Best-effort cancel of the child run so its branch unwinds.
            this.cancelRun(targetRun.id);
            resolve(TIMEOUT_SENTINEL);
          }, timeoutMs),
        ),
      ]);

      service.updateRun(targetRun.id, {
        status: result.status,
        result: result.result,
        error: result.error,
        steps_count: result.steps_count,
        tokens_used: result.tokens_used,
        completed_at: isoNow(),
      });

      // Save target's response back to source agent's memory
      const responseText = result.status === "failed" ? `[Error] ${result.error}` : result.result;
      service.addMemory(targetAgent.id, "assistant", `[To ${agent.name}] ${responseText.slice(0, 1000)}`, targetRun.id);
      service.addMemory(agent.id, "user", `[From ${targetAgent.name}] ${responseText.slice(0, 1000)}`, targetRun.id);

      // Mirror the reply into the conversation. Role defaults to 'answer';
      // the target's own LLM output may override this via self-marking
      // (parsed in step 7 below), but from invoke we know at least it's an
      // answer to the question — counter/stmt can still be applied by the
      // parser when the target wraps its reply with a role marker.
      const answerRole = extractRoleFromReply(result.result) ?? "answer";
      service.postMessage({
        conversation_id: invokeConvo.id,
        from_agent_id: targetAgent.id,
        to_agent_id: agent.id,
        role: answerRole,
        in_reply_to: questionMsg.id,
        body: result.status === "failed" ? `[Error] ${result.error}` : stripRoleWrapper(result.result),
        tokens: result.tokens_used,
        run_id: targetRun.id,
        meta: { via: "kernel_agents_invoke" },
      });

      return {
        content: [{
          type: "text" as const,
          text: result.status === "failed"
            ? `Agent "${targetAgent.name}" failed: ${result.error}`
            : result.result,
        }],
        isError: result.status === "failed",
      };
    });

    if (llmTools.length === 0) {
      const allowedParsed: string[] = parseJsonArray(agent.allowed_tools);
      log.error(
        `Agent "${agent.name}": no tools resolved. ` +
        `allowed_tools=${JSON.stringify(allowedParsed)}, ` +
        `denied_tools=${agent.denied_tools}, ` +
        `total kernel tools=${this.allTools.length}, ` +
        `matching=${this.allTools.filter(t => allowedParsed.includes(t.name)).map(t => t.name).join(",")}`,
      );
      return {
        status: "failed",
        result: "",
        error: `No tools available for this agent (allowed: ${allowedParsed.join(", ")}; ${this.allTools.length} kernel tools loaded)`,
        steps_count: 0,
        tokens_used: 0,
      };
    }

    // 3. Resolve the model fallback chain. Each entry is (provider, model).
    //    Agent-level chain wins; the global `agents.defaultModelChain` is
    //    appended as a common tail (deduped by provider+model) so any agent
    //    without a full custom 3-slot chain still benefits from global
    //    fallbacks — this is the UX "1 default + 2 fallbacks for everyone".
    //
    //    Empty entries ({provider:"", model:""}) are dropped — they represent
    //    an agent with no explicit preference. Without this drop they'd resolve
    //    to `this.defaultProvider` and race ahead of the curated global chain
    //    (regression: an agent with no chain + an exhausted default provider
    //    would fall back to *any* available LLM regardless of user preference).
    const agentChain = service.resolveModelChain(agent);
    const globalChain = this.configRef?.agents?.defaultModelChain ?? [];
    const seen = new Set<string>();
    const rawChain: Array<{ provider: string; model: string }> = [];
    for (const e of [...agentChain, ...globalChain]) {
      if (!e.provider && !e.model) continue;
      const key = `${e.provider}::${e.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rawChain.push(e);
    }
    // Last-resort safety net: if after the drop the chain is empty (no agent
    // chain, no global chain configured), keep one entry so at least one
    // attempt happens — using the configured default provider.
    if (rawChain.length === 0) {
      rawChain.push({ provider: this.defaultProvider, model: "" });
    }
    const effectiveChain: Array<{
      provider: ChatLlmProvider;
      model: string;
      configProvider: string;
    }> = [];
    for (const entry of rawChain) {
      const requestedName = entry.provider || this.defaultProvider;
      // STRICT resolve: only use exactly the provider this chain entry
      // requested. resolveProvider() used to fall back to *any* healthy
      // alternative here — but that paired the alternative provider with
      // the original (provider-specific) model name, producing nonsense
      // like `claude/grok-4-fast-reasoning` → 400. The chain itself is
      // the right place to express fallbacks; mid-resolve substitution
      // contaminates models across providers.
      const desired = this.providers.get(requestedName);
      if (!desired || !desired.available()) continue; // skip — next entry handles it
      effectiveChain.push({
        provider: desired,
        model: entry.model,
        configProvider: entry.provider,
      });
    }
    // Last-resort safety net: every chain entry pointed at an unavailable
    // provider (no key, never started, etc). Pick any provider that's
    // alive at all so the agent doesn't dead-end on config mistakes.
    // Tool-capable only — grabbing "anything alive" is how a single-turn
    // provider ended up being handed an agent's whole tool catalogue.
    if (effectiveChain.length === 0) {
      for (const [name, p] of this.providers) {
        if (!p.available()) continue;
        if (llmTools.length > 0 && p.supportsToolLoop === false) continue;
        effectiveChain.push({ provider: p, model: "", configProvider: name });
        log.warn(`Agent "${agent.name}": entire chain unavailable, last-resort fallback to ${name}/(default)`);
        break;
      }
    }

    // Drop providers that cannot execute the tools this run is about to send.
    // Done after availability and before the health re-ordering, so a
    // tool-incapable provider can never become effectiveChain[0].
    const capable = selectToolCapable(effectiveChain, llmTools.length);
    if (capable.dropped.length > 0) {
      log.warn(
        `Agent "${agent.name}": dropped ${capable.dropped.join(", ")} from the chain — ` +
          `${llmTools.length} tools to run and those providers cannot execute a tool loop.`,
      );
      effectiveChain.length = 0;
      effectiveChain.push(...capable.chain);
    }

    if (effectiveChain.length === 0) {
      const toolBlocked = capable.dropped.length > 0;
      // This run just proved the cached readiness verdict wrong, or confirmed
      // it. Either way the next gate check should re-probe rather than trust a
      // verdict from before whatever broke.
      void import("../../core/llm/readiness.js")
        .then((m) => m.markLlmReadinessStale("an agent run found no usable provider"))
        .catch(() => { /* readiness is optional wiring — never break a run over it */ });
      return {
        status: "failed",
        result: "",
        error: toolBlocked
          ? `No LLM provider in the chain can run tool calls. Dropped: ${capable.dropped.join(", ")}. ` +
            `Configure a provider that supports tools (Settings → AI), or set this agent's executor to "claude_code" to use the CLI's own tool loop.`
          : `No available LLM provider for chain: ${rawChain.map(e => `${e.provider || "(default)"}/${e.model || "(default)"}`).join(", ")}`,
        steps_count: 0,
        tokens_used: 0,
      };
    }
    // Re-order: push providers the health tracker has blocked (quota /
    // auth / repeated transient) to the tail of the chain. Without this
    // the executor would happily call effectiveChain[0] (e.g. Grok) on
    // every agent run even when provider-health knows it's been 403ing
    // for the last hour. Stable within each bucket so the user's chain
    // order still wins among healthy candidates.
    effectiveChain.sort((a, b) => {
      const ab = providerHealth.isBlocked(a.provider.name) ? 1 : 0;
      const bb = providerHealth.isBlocked(b.provider.name) ? 1 : 0;
      return ab - bb;
    });
    // `provider` is kept for backward compat with downstream code — it tracks
    // whichever entry in the chain is currently active.
    let provider = effectiveChain[0].provider;

    // 4. Interpolate variables in prompts
    let vars: Record<string, string> = {};
    try { vars = JSON.parse(agent.variables || "{}"); } catch { /* ignore */ }
    const interpolate = (text: string): string =>
      text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);

    const lang = resolveAgentLanguage(agent, this.configRef);
    const effectiveGoal = interpolate(goal);
    const rawSystemPrompt = resolveAgentSystemPrompt(agent, lang);
    const effectiveSystemPrompt = interpolate(rawSystemPrompt);

    // 5. Build system prompt (enriched with learnings)
    const todayStr = new Date().toISOString().slice(0, 10);
    const systemParts: string[] = [];
    systemParts.push(effectiveSystemPrompt || promptDefaultAgent(lang));
    systemParts.push(promptTodayDate(lang, todayStr));

    // Procedural skills index — for each slug in agent.skills_json, surface a
    // one-line entry (slug + frontmatter description) so the model knows the
    // skill exists and what triggers it. Full body is loaded on demand via
    // `kernel_skill_load`. Cheap on tokens — typically <50 tok per skill.
    if (this.skillResolver && agent.skills_json) {
      let attached: string[] = [];
      try { attached = JSON.parse(agent.skills_json) as string[]; } catch { attached = []; }
      if (Array.isArray(attached) && attached.length > 0) {
        const idx = this.skillResolver.buildPromptIndex(attached);
        if (idx) systemParts.push(idx);
      }
    }

    if (depth > 0) {
      systemParts.push(promptInvokedBy(lang, depth, maxChainDepth));
    }

    // Progressive-discovery hint — the LLM only sees a tiny bootstrap toolset
    // (social baseline + workspace publish + meta tools). The full catalog is
    // discoverable via the meta tools and reachable two ways: activate-and-call
    // for ergonomic single calls, or code_run to compose multiple calls in one
    // inference round.
    if (agent.progressive_discovery) {
      systemParts.push(promptProgressiveDiscovery(lang));
    }

    // Inject fleet directory — every agent knows every other agent by default.
    // Re-rendered each run so new agents are visible without manual updates.
    const directoryBlock = service.buildDirectoryBlock(agent.id);
    if (directoryBlock) systemParts.push(directoryBlock);

    // Inject global reporting-hierarchy context (rank, superiors, peers, subordinates).
    // No-op if the agent has no rank assigned.
    const hierarchyBlock = service.buildHierarchyBlock(agent.id);
    if (hierarchyBlock) systemParts.push(hierarchyBlock);

    // Inject unread office-inbox messages from colleagues. These are async
    // requests/escalations from other agents in the same flow that the linear
    // declarative chain cannot carry (e.g. Developer → Manager hand-back).
    // We mark them read BEFORE the run starts so a provider retry doesn't
    // re-inject them.
    const inbox = service.getUnreadInbox(agent.id);
    if (inbox.length > 0) {
      const inboxEntries = inbox.map((m) => ({
        senderName: service.getAgent(m.from_agent_id)?.name ?? m.from_agent_id,
        timestamp: m.created_at.slice(0, 16).replace("T", " "),
        subject: m.subject,
        body: m.body,
      }));
      systemParts.push(promptInboxBlock(lang, inboxEntries));
      service.markInboxRead(inbox.map(m => m.id));
      events?.emit("agent:inbox:delivered", {
        agent_id: agent.id, agent_name: agent.name, run_id: run.id,
        count: inbox.length, message_ids: inbox.map(m => m.id),
      });
      service.logEvent({
        run_id: run.id, agent_id: agent.id, agent_name: agent.name,
        event_type: "run", event_subtype: "inbox_delivered",
        detail: `${inbox.length} pending inbox message(s) from colleagues`,
        raw_data: { count: inbox.length, message_ids: inbox.map(m => m.id) },
      });
    }

    // Semantic ranking gate — ONE embed of the goal serves all three rankers
    // (learnings, similar runs, memory). Falls back to lexical when the flag
    // is off, the embeddings client isn't wired, or the embed call fails.
    // Costs ~50-100ms (local MiniLM) / <30ms (LMStudio) per run when enabled.
    const useSemantic = !!this.configRef?.agents?.useSemanticRanking;
    const embedClient = useSemantic ? service.getEmbeddingsClient() : null;
    let goalVector: number[] | null = null;
    if (embedClient) {
      try {
        const [vec] = await embedClient.embed([effectiveGoal]);
        goalVector = vec ?? null;
      } catch (err) {
        log.debug(`Goal embed failed, falling back to lexical: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const cosW = this.configRef?.agents?.semanticRankingCosineWeight;
    const minS = this.configRef?.agents?.semanticRankingMinScore;

    // Inject learnings — ranked by relevance to current goal, not blind top-confidence
    const learnings = goalVector
      ? service.getRelevantLearningsByEmbedding(agent.id, effectiveGoal, goalVector, 15, cosW, minS)
      : service.getRelevantLearnings(agent.id, effectiveGoal, 15);
    const learningsBlock = promptLearningsBlock(lang, learnings);
    if (learningsBlock) systemParts.push(learningsBlock);

    // Inject performance stats summary
    const stats = service.getAgentStats(agent.id);
    const perfBlock = promptPerformanceBlock(lang, stats);
    if (perfBlock) systemParts.push(perfBlock);

    // Inject similar past runs — "when you were asked X, you produced Y"
    // This is the core of semantic recall: recognize situations you've been in before.
    const similarRuns = goalVector
      ? service.findSimilarPastRunsByEmbedding(agent.id, effectiveGoal, goalVector, 3, 30, cosW, minS)
      : service.findSimilarPastRuns(agent.id, effectiveGoal, 3);
    if (similarRuns.length > 0) {
      systemParts.push(
        promptSimilarRunsBlock(
          lang,
          similarRuns.map((r) => ({
            ok: r.status === "completed",
            goal: r.goal.slice(0, 200).replace(/\s+/g, " "),
            result: (r.result || r.error || "(empty)").slice(0, 300).replace(/\s+/g, " "),
          })),
        ),
      );
    }

    // Inject conversational memory — ranked by goal relevance, not pure recency
    const memory = goalVector
      ? service.getRelevantMemoryByEmbedding(agent.id, effectiveGoal, goalVector, 50, 100, cosW, minS)
      : service.getRelevantMemory(agent.id, effectiveGoal, 50);
    let memoryBlock = "";
    if (memory.length > 0) {
      // System prompt: compact summary of relevance-ranked memory (chronological).
      const summaryEntries = [...memory].reverse().map((m) => ({
        role: m.role,
        timestamp: m.created_at.slice(5, 16).replace("T", " "),
        content: m.content.slice(0, 200),
      }));
      systemParts.push(promptMemorySummaryBlock(lang, summaryEntries));

      // Short memory block injected directly into the goal (top 10 most relevant)
      const suffixEntries = memory.slice(0, 10).map((m) => ({
        role: m.role,
        timestamp: m.created_at.slice(5, 16).replace("T", " "),
        content: m.content.slice(0, 300),
      }));
      memoryBlock = promptMemoryGoalSuffix(lang, suffixEntries);
    }

    // Auto-inject a workspace/analysis hint so agents with access use the
    // shared workspace proactively. No restriction → fleet-wide; explicit
    // allow_list → whenever any kernel_workspace_* tool is granted (the
    // upgrade pass in agents/index.ts ensures analysis tools are present too).
    const allowedForHint: string[] = parseJsonArray(agent.allowed_tools);
    const hasWorkspaceAccess =
      allowedForHint.length === 0 ||
      allowedForHint.some(t => t.startsWith("kernel_workspace_"));
    if (hasWorkspaceAccess) {
      systemParts.push(promptWorkspaceMandate(lang));
    }

    // Final language reinforcement — fights drift in weak local models that
    // get pulled toward English by tool descriptions and code samples.
    systemParts.push(promptStyleDirective(lang));

    const systemText = systemParts.join("\n\n");

    // Save user message to memory
    // Don't save goal to memory here — the dashboard chat handler already
    // persists the user's actual message via POST /api/agents/:id/memory.
    // Saving the full conversationalGoal (with RULES, RECENT WORK, etc.)
    // would pollute the chat history with system scaffolding.

    // 5. Build initial messages — inject memory at the END of the goal (recency bias)
    const goalWithMemory = memoryBlock
      ? effectiveGoal + memoryBlock
      : effectiveGoal;
    const llmMessages: ChatMessage[] = [
      { role: "user", content: goalWithMemory },
    ];

    // 6. LLM tool-use loop with safety controls — delegate to the shared core loop.
    //    Persistence, event emission, and pretty logging are wired via hooks so the
    //    loop stays provider-agnostic and reusable from chat/eval/triage.
    const maxIter = agent.max_iterations;
    const maxTokens = agent.max_tokens ?? 150_000;
    const maxConsecErrors = agent.max_errors ?? 3;
    const timeoutMs = agent.timeout_ms || 300_000;

    let finalContent = "";
    let totalTokensFromLoop = 0;
    const toolsUsedSet = new Set<string>();
    let abortReason = "";
    let hitMaxIterations = false;
    // Per-step running token counter so the LIVE UI can show cumulative
    // consumption alongside each event without having to wait for the run
    // to finish. Incremented inside onThought / onFinal hooks. The final
    // `tokens_used` field on the run row remains the authoritative number
    // — this just lets the timeline render `tokens_total: 1234` per step.
    let runningTokens = 0;

    try {
      // Sticky fallback loop: try the primary first. If it throws a retryable
      // error (quota / 429 / 402 / 404 / 5xx / network timeout), move to the
      // next entry in the chain and restart the tool-loop with a fresh copy of
      // the initial messages. Once an entry starts streaming successfully, it
      // is committed for the rest of the run (no mid-run swap).
      const initialMessagesSnapshot: ChatMessage[] = JSON.parse(JSON.stringify(llmMessages));
      let loopResult: LlmLoopResult | undefined;
      let chainIdx = 0;
      while (chainIdx < effectiveChain.length) {
        const entry = effectiveChain[chainIdx];
        provider = entry.provider; // outer `provider` tracks the active entry
        if (chainIdx > 0) {
          // Reset messages on retry so the new model starts from the same goal
          llmMessages.length = 0;
          for (const m of JSON.parse(JSON.stringify(initialMessagesSnapshot)) as ChatMessage[]) {
            llmMessages.push(m);
          }
        }
        try {
          loopResult = await runToolLoop({
            provider: entry.provider,
            systemText,
            model: entry.model || undefined,
            messages: llmMessages,
            tools: llmTools,
        executeTool: (name, input) => this.executeTool(toolExecutor, name, { ...input, __caller_agent_id: agent.id }),
        caller: `agent:${agent.name}`,
        budgets: {
          maxIterations: maxIter,
          maxTokens,
          maxErrors: maxConsecErrors,
          timeoutMs,
        },
        isCancelled: () => runState.cancelled,
        hooks: {
          onRateLimitWait: ({ waitMs, attempt }) => {
            const detail = `Rate limited — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/3)`;
            log.warn(`Agent "${agent.name}": ${detail}`);
            events?.emit("agent:flow:step", {
              agent_id: agent.id, agent_name: agent.name, run_id: run.id,
              step_number: stepNumber, type: "rate_limit_wait",
              content_preview: detail, wait_ms: waitMs, attempt,
            });
            service.logEvent({
              run_id: run.id, agent_id: agent.id, agent_name: agent.name,
              event_type: "step", event_subtype: "rate_limit_wait",
              detail, raw_data: { wait_ms: waitMs, attempt },
            });
          },
          onFinal: ({ content, tokens }) => {
            stepNumber++;
            const stepTokens = Number(tokens) || 0;
            runningTokens += stepTokens;
            service.addStep({
              run_id: run.id, step_number: stepNumber, type: "final",
              content, tokens,
            });
            events?.emit("agent:flow:step", {
              agent_id: agent.id, agent_name: agent.name, run_id: run.id,
              step_number: stepNumber, type: "final",
              content_preview: content.slice(0, 2000),
              tokens: stepTokens,
              tokens_total: runningTokens,
            });
            service.logEvent({
              run_id: run.id, agent_id: agent.id, agent_name: agent.name,
              event_type: "step", event_subtype: "final",
              detail: content.slice(0, 200),
              raw_data: { step_number: stepNumber },
              tokens_used: tokens,
            });
          },
          onThought: ({ content, tokens }) => {
            stepNumber++;
            const stepTokens = Number(tokens) || 0;
            runningTokens += stepTokens;
            service.addStep({
              run_id: run.id, step_number: stepNumber, type: "thought",
              content, tokens,
            });
            events?.emit("agent:flow:step", {
              agent_id: agent.id, agent_name: agent.name, run_id: run.id,
              step_number: stepNumber, type: "thought",
              content_preview: content.slice(0, 2000),
              tokens: stepTokens,
              tokens_total: runningTokens,
            });
            service.logEvent({
              run_id: run.id, agent_id: agent.id, agent_name: agent.name,
              event_type: "step", event_subtype: "thought",
              detail: content.slice(0, 200),
              raw_data: { step_number: stepNumber },
              tokens_used: tokens,
            });
          },
          onToolCall: ({ tool_name, tool_input, preview }) => {
            stepNumber++;
            toolsUsedSet.add(tool_name);
            service.addStep({
              run_id: run.id, step_number: stepNumber, type: "tool_call",
              tool_name, tool_input,
            });
            events?.emit("agent:flow:step", {
              agent_id: agent.id, agent_name: agent.name, run_id: run.id,
              step_number: stepNumber, type: "tool_call", tool_name,
              content_preview: JSON.stringify(tool_input).slice(0, 800),
              tokens_total: runningTokens,
            });
            service.logEvent({
              run_id: run.id, agent_id: agent.id, agent_name: agent.name,
              event_type: "step", event_subtype: "tool_call",
              detail: preview ? `${tool_name}(${preview})` : tool_name,
              raw_data: { step_number: stepNumber, tool_name, tool_input },
            });
          },
          onToolResult: ({ tool_name, text, isError }) => {
            stepNumber++;
            service.addStep({
              run_id: run.id, step_number: stepNumber, type: "tool_result",
              tool_name, tool_output: text,
            });
            events?.emit("agent:flow:step", {
              agent_id: agent.id, agent_name: agent.name, run_id: run.id,
              step_number: stepNumber, type: "tool_result", tool_name,
              // Preview was 200 chars which hid almost all tool output in the
              // LIVE tab. 2000 covers most useful tool returns; full text
              // stays in DB (tool_output) for the HISTORY tab.
              content_preview: text.slice(0, 2000),
              tokens_total: runningTokens,
            });
            service.logEvent({
              run_id: run.id, agent_id: agent.id, agent_name: agent.name,
              event_type: "step", event_subtype: "tool_result",
              detail: `${tool_name}: ${text.slice(0, 150)}`,
              raw_data: { step_number: stepNumber, tool_name, is_error: isError },
            });
          },
            },
          });
          break; // success (or soft abort via loopResult.abortReason) — commit this entry
        } catch (innerErr) {
          const retryable = isRetryableChainError(innerErr);
          const nextIdx = chainIdx + 1;
          if (!retryable || nextIdx >= effectiveChain.length) throw innerErr;
          const fromLabel = `${entry.provider.name}/${entry.model || "(default)"}`;
          const toEntry = effectiveChain[nextIdx];
          const toLabel = `${toEntry.provider.name}/${toEntry.model || "(default)"}`;
          const reason = innerErr instanceof Error ? innerErr.message : String(innerErr);
          log.warn(`Agent "${agent.name}": ${fromLabel} failed (${reason.slice(0, 100)}), falling back to ${toLabel}`);
          if (isProviderQuotaError(reason)) markProviderExhausted(entry.provider.name);
          events?.emit("agent:flow:fallback_used", {
            agent_id: agent.id, agent_name: agent.name, run_id: run.id,
            from_provider: entry.provider.name, from_model: entry.model,
            to_provider: toEntry.provider.name, to_model: toEntry.model,
            reason: reason.slice(0, 200),
          });
          service.logEvent({
            run_id: run.id, agent_id: agent.id, agent_name: agent.name,
            event_type: "step", event_subtype: "fallback_used",
            detail: `Fallback ${fromLabel} → ${toLabel}: ${reason.slice(0, 150)}`,
            raw_data: { from_provider: entry.provider.name, from_model: entry.model,
                        to_provider: toEntry.provider.name, to_model: toEntry.model, reason },
          });
          chainIdx = nextIdx;
        }
      }
      if (!loopResult) {
        throw new Error(`Model chain exhausted — all ${effectiveChain.length} entries failed without recovery`);
      }

      finalContent = loopResult.finalContent;
      totalTokensFromLoop = loopResult.totalTokens;
      abortReason = loopResult.abortReason;
      hitMaxIterations = loopResult.hitMaxIterations;
      totalTokens += totalTokensFromLoop;

      if (abortReason) {
        log.warn(`Agent "${agent.name}": ${abortReason}`);
      }
      if (hitMaxIterations) {
        log.warn(`Agent "${agent.name}": hit max iterations (${maxIter})`);
      }

      if (abortReason) {
        // Safety-aborted — record as error step and fail the run
        stepNumber++;
        service.addStep({
          run_id: run.id,
          step_number: stepNumber,
          type: "error",
          content: `Safety abort: ${abortReason}`,
        });
        events?.emit("agent:flow:step", {
          agent_id: agent.id, agent_name: agent.name, run_id: run.id,
          step_number: stepNumber, type: "error",
          content_preview: `Safety abort: ${abortReason}`,
        });
        service.logEvent({
          run_id: run.id, agent_id: agent.id, agent_name: agent.name,
          event_type: "step", event_subtype: "error",
          detail: `Safety abort: ${abortReason}`,
          raw_data: { step_number: stepNumber },
        });

        const failResult: ExecutionResult = {
          status: "failed",
          result: finalContent,
          error: `Safety abort: ${abortReason}`,
          steps_count: stepNumber,
          tokens_used: totalTokens,
        };

        events?.emit("agent:flow:run_completed", {
          agent_id: agent.id, agent_name: agent.name, run_id: run.id,
          status: "failed", steps_count: stepNumber, tokens_used: totalTokens,
          result_preview: finalContent.slice(0, 200), error: failResult.error,
        });
        service.logEvent({
          run_id: run.id, agent_id: agent.id, agent_name: agent.name,
          event_type: "run", event_subtype: "completed",
          detail: `Failed: ${failResult.error.slice(0, 200)}`,
          raw_data: { status: "failed", steps_count: stepNumber, tokens_used: totalTokens },
          tokens_used: totalTokens,
        });

        return failResult;
      }

      const execResult: ExecutionResult = {
        status: "completed",
        result: finalContent,
        error: "",
        steps_count: stepNumber,
        tokens_used: totalTokens,
      };

      // Save agent response to conversational memory (only for manual/chat runs)
      if (run.trigger_type === "manual") {
        service.addMemory(agent.id, "assistant", finalContent.slice(0, 2000), run.id);
      }

      // Emit flow event: run completed
      events?.emit("agent:flow:run_completed", {
        agent_id: agent.id, agent_name: agent.name, run_id: run.id,
        status: execResult.status, steps_count: execResult.steps_count,
        tokens_used: execResult.tokens_used,
        result_preview: execResult.result.slice(0, 200),
      });
      service.logEvent({
        run_id: run.id, agent_id: agent.id, agent_name: agent.name,
        event_type: "run", event_subtype: "completed",
        detail: `${execResult.status}: ${execResult.steps_count} steps, ${execResult.tokens_used} tokens`,
        raw_data: { status: execResult.status, steps_count: execResult.steps_count, tokens_used: execResult.tokens_used },
        tokens_used: execResult.tokens_used,
      });

      // Emit structured result for cross-module consumption
      if (execResult.status === "completed") {
        events?.emit("agent:flow:result", {
          agent_id: agent.id,
          agent_name: agent.name,
          run_id: run.id,
          flow_id: agent.flow_id || "",
          result: execResult.result,
          trigger_type: run.trigger_type,
        });
      }

      // 7. Post-completion: auto-evaluate and close feedback loop
      await this.autoEvaluate(agent, run, effectiveGoal, execResult, [...toolsUsedSet], service, events);

      // 8. Post-completion: execute declarative chains
      this.executeDeclarativeChains(agent, run, execResult, service, depth, events);

      return execResult;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Quota exhaustion: cycle through ALL remaining providers until one works
      const isQuotaError = errorMsg.includes("insufficient_quota") || errorMsg.includes("exceeded your current quota") || errorMsg.includes("credit balance") || errorMsg.includes("API error 429") || errorMsg.includes("API error 402");
      if (isQuotaError) {
        // Try every available provider that isn't exhausted
        for (const [, candidate] of this.providers) {
          if (!candidate.available() || candidate.name === provider.name) continue;
          // Use the shared health tracker (same state LlmClient consults)
          // — covers xAI 403+credits, OpenAI insufficient_quota, Anthropic
          // billing, and the exponential backoff windows. The legacy
          // isProviderExhausted is kept as a belt-and-braces fallback.
          if (providerHealth.isBlocked(candidate.name)) continue;
          if (isProviderExhausted(candidate.name)) continue;

          log.warn(`Agent "${agent.name}": ${provider.name} quota exhausted, trying ${candidate.name}`);
          try {
            // For local models (lmstudio), use a shorter goal to avoid context overflow
            const retryGoal = candidate.name === "lmstudio"
              ? effectiveGoal.slice(0, 2000)
              : goalWithMemory;
            const retrySystem = candidate.name === "lmstudio"
              ? systemText.slice(0, 3000)
              : systemText;
            // Local models struggle with many tools — limit to 8 max
            const retryTools = candidate.name === "lmstudio"
              ? llmTools.slice(0, 8)
              : llmTools;
            const retryResult = await runToolLoop({
              provider: candidate,
              systemText: retrySystem,
              model: undefined,
              messages: [{ role: "user", content: retryGoal }],
              tools: retryTools,
              executeTool: (name, input) => this.executeTool(toolExecutor, name, { ...input, __caller_agent_id: agent.id }),
              caller: `agent:${agent.name}/retry`,
              budgets: { maxIterations: maxIter, maxTokens, maxErrors: maxConsecErrors, timeoutMs },
              isCancelled: () => runState.cancelled,
            });
            const retryExecResult: ExecutionResult = {
              status: retryResult.abortReason ? "failed" : "completed",
              result: retryResult.finalContent,
              error: retryResult.abortReason ? `Safety abort: ${retryResult.abortReason}` : "",
              steps_count: stepNumber + retryResult.iterations,
              tokens_used: totalTokens + retryResult.totalTokens,
            };
            service.addMemory(agent.id, "assistant", retryResult.finalContent.slice(0, 2000), run.id);
            events?.emit("agent:flow:run_completed", {
              agent_id: agent.id, agent_name: agent.name, run_id: run.id,
              status: retryExecResult.status, steps_count: retryExecResult.steps_count,
              tokens_used: retryExecResult.tokens_used,
              result_preview: retryExecResult.result.slice(0, 200),
            });
            log.info(`Agent "${agent.name}": fallback to ${candidate.name} succeeded`);
            return retryExecResult;
          } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            log.warn(`Agent "${agent.name}": ${candidate.name} also failed: ${retryMsg.slice(0, 100)}`);
            if (retryMsg.includes("insufficient_quota") || retryMsg.includes("429") || retryMsg.includes("credit balance")) {
              markProviderExhausted(candidate.name);
            }
            continue; // try next provider
          }
        }
      }

      log.error(`Agent "${agent.name}" execution error:`, err);

      stepNumber++;
      service.addStep({
        run_id: run.id,
        step_number: stepNumber,
        type: "error",
        content: errorMsg,
      });
      events?.emit("agent:flow:step", {
        agent_id: agent.id, agent_name: agent.name, run_id: run.id,
        step_number: stepNumber, type: "error",
        content_preview: errorMsg.slice(0, 200),
      });
      service.logEvent({
        run_id: run.id, agent_id: agent.id, agent_name: agent.name,
        event_type: "step", event_subtype: "error",
        detail: errorMsg.slice(0, 200),
        raw_data: { step_number: stepNumber },
      });
      events?.emit("agent:flow:run_completed", {
        agent_id: agent.id, agent_name: agent.name, run_id: run.id,
        status: "failed", steps_count: stepNumber, tokens_used: totalTokens,
        result_preview: finalContent.slice(0, 200), error: errorMsg,
      });
      service.logEvent({
        run_id: run.id, agent_id: agent.id, agent_name: agent.name,
        event_type: "run", event_subtype: "completed",
        detail: `Failed: ${errorMsg.slice(0, 200)}`,
        raw_data: { status: "failed", steps_count: stepNumber, tokens_used: totalTokens },
        tokens_used: totalTokens,
      });

      // Save error to conversational memory
      service.addMemory(agent.id, "assistant", `[Error] ${errorMsg.slice(0, 500)}`, run.id);

      const failedResult: ExecutionResult = {
        status: "failed",
        result: finalContent,
        error: errorMsg,
        steps_count: stepNumber,
        tokens_used: totalTokens,
      };

      // Auto-evaluate the failure so we still extract a lesson for next time
      await this.autoEvaluate(agent, run, effectiveGoal, failedResult, [...toolsUsedSet], service, events);

      return failedResult;
    } finally {
      this.activeRuns.delete(run.id);
    }
  }

  /** Public accessor so other executors (claude_code) can hand off to the same auto-eval flow. */
  getEvalService(): EvalServiceLike | null {
    return this.evalService;
  }

  /** Public entrypoint exposed so the claude_code executor can reuse the same closed-loop. */
  async runAutoEvaluate(
    agent: Agent,
    run: AgentRun,
    goal: string,
    execResult: ExecutionResult,
    toolsUsed: string[],
    service: AgentService,
    events?: EventBus,
  ): Promise<void> {
    return this.autoEvaluate(agent, run, goal, execResult, toolsUsed, service, events);
  }

  /**
   * Self-evaluation: use a lightweight LLM to grade the run, auto-create feedback,
   * and extract a learning if one is useful. This closes the feedback loop so the
   * agent improves from its own results without waiting for a human.
   */
  private async autoEvaluate(
    agent: Agent,
    run: AgentRun,
    goal: string,
    execResult: ExecutionResult,
    toolsUsed: string[],
    service: AgentService,
    events?: EventBus,
  ): Promise<void> {
    if (!this.evalService || !this.evalService.isEnabled()) return;

    // Notify the 3D flow that grading is in progress
    events?.emit("agent:flow:auto_eval_started", {
      agent_id: agent.id,
      agent_name: agent.name,
      run_id: run.id,
    });

    try {
      const evalResult = await this.evalService.evaluate({
        goal,
        result: execResult.result,
        error: execResult.error,
        steps_count: execResult.steps_count,
        tools_used: toolsUsed,
        status: execResult.status,
        agent,
        service,
      });
      if (!evalResult) {
        events?.emit("agent:flow:auto_eval_skipped", {
          agent_id: agent.id,
          agent_name: agent.name,
          run_id: run.id,
        });
        return;
      }

      // Snapshot active learnings count BEFORE feedback for reinforcement diff
      const learningsBefore = service.getLearnings(agent.id).length;

      // Persist feedback — this also reinforces/penalizes active learnings via addFeedback()
      const feedback = service.addFeedback({
        agent_id: agent.id,
        run_id: run.id,
        rating: evalResult.score,
        outcome: evalResult.outcome,
        lesson: evalResult.lesson,
      });

      // Emit the grade so the 3D office shows a visible review over the agent's desk
      events?.emit("agent:flow:auto_eval", {
        agent_id: agent.id,
        agent_name: agent.name,
        run_id: run.id,
        score: evalResult.score,
        outcome: evalResult.outcome,
        confidence: evalResult.confidence,
        issues: evalResult.issues.slice(0, 120),
      });

      // If the evaluator extracted a concrete lesson AND it is confident, store it
      // as a typed learning that will be injected into future runs.
      let learningCreated: { type: string; content: string; confidence: number } | null = null;
      if (evalResult.lesson && evalResult.confidence >= 0.5) {
        const type: "avoid" | "prefer" | "insight" | "pattern" =
          evalResult.outcome === "failure" ? "avoid"
          : evalResult.outcome === "success" ? "prefer"
          : "insight";
        // Confidence is score-weighted so auto-learnings start lower than human ones
        const baseConfidence = evalResult.score >= 4 ? 0.6 : evalResult.score >= 3 ? 0.4 : 0.3;
        const finalConfidence = Math.min(0.75, baseConfidence * evalResult.confidence + 0.2);
        const l = service.addLearning({
          agent_id: agent.id,
          type,
          content: `[auto] ${evalResult.lesson}`,
          confidence: finalConfidence,
          source_runs: [run.id],
        });
        learningCreated = { type: l.type, content: l.content, confidence: l.confidence };

        events?.emit("agent:flow:learning_created", {
          agent_id: agent.id,
          agent_name: agent.name,
          run_id: run.id,
          learning_id: l.id,
          learning_type: l.type,
          content: evalResult.lesson.slice(0, 150),
          confidence: l.confidence,
        });
      }

      // Detect learning auto-deactivations from cleanup logic (learnings that fell below threshold)
      const learningsAfter = service.getLearnings(agent.id).length;
      const deactivatedCount = Math.max(0, learningsBefore - learningsAfter + (learningCreated ? 1 : 0));
      if (deactivatedCount > 0) {
        events?.emit("agent:flow:learning_deactivated", {
          agent_id: agent.id,
          agent_name: agent.name,
          run_id: run.id,
          count: deactivatedCount,
        });
      }

      // (pretty log emitted via writeAgentEvent from the logEvent call below)

      service.logEvent({
        run_id: run.id,
        agent_id: agent.id,
        agent_name: agent.name,
        event_type: "run",
        event_subtype: "auto_eval",
        detail: `score=${evalResult.score} outcome=${evalResult.outcome} lesson=${evalResult.lesson ? "yes" : "no"}`,
        raw_data: {
          score: evalResult.score,
          outcome: evalResult.outcome,
          confidence: evalResult.confidence,
          has_lesson: !!evalResult.lesson,
          learning_created: !!learningCreated,
          deactivated_count: deactivatedCount,
        },
        tokens_used: evalResult.tokens_used,
      });
    } catch (err) {
      log.warn(`Auto-eval failed for run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Declarative chain execution ───────────────────

  /**
   * True if `agentId` already appears in this run's ancestor lineage — i.e.
   * launching a chain to it would form a cycle (A→B→A …). The depth cap alone
   * lets cyclic chains amplify into many runs before it trips; this stops them.
   */
  private chainLineageHasAgent(service: AgentService, run: AgentRun, agentId: string): boolean {
    let current: AgentRun | undefined = run;
    let hops = 0;
    while (current && hops < 64) {
      if ((current as { agent_id?: string }).agent_id === agentId) return true;
      const parentId = (current as { parent_run_id?: string }).parent_run_id;
      if (!parentId) break;
      current = service.getRun(parentId);
      hops++;
    }
    return false;
  }

  private executeDeclarativeChains(
    sourceAgent: Agent,
    sourceRun: AgentRun,
    sourceResult: ExecutionResult,
    service: AgentService,
    depth: number,
    events?: EventBus,
  ): void {
    const declarativeCap = this.configRef?.agents?.maxInvokeDepth ?? DEFAULT_MAX_CHAIN_DEPTH;
    if (depth >= declarativeCap) return;

    const chains = service.getChainsBySource(sourceAgent.id);
    if (chains.length === 0) return;

    for (const chain of chains) {
      if (!chain.active) continue;
      if (!evaluateChainCondition(chain.condition, sourceResult)) continue;

      const targetAgent = service.getAgent(chain.target_agent_id);
      if (!targetAgent || !targetAgent.active) continue;

      // Cycle guard: skip if the target already ran in this lineage (fork-bomb
      // protection beyond the depth cap).
      if (this.chainLineageHasAgent(service, sourceRun, targetAgent.id)) {
        log.warn(`Declarative chain skipped (cycle): ${sourceAgent.name} → ${targetAgent.name}`);
        continue;
      }

      const chainLang = resolveAgentLanguage(targetAgent, this.configRef);
      const targetGoalTemplate = resolveAgentGoalTemplate(targetAgent, chainLang);
      let targetGoal: string;
      if (chain.pass_result) {
        if (chainLang === "es") {
          targetGoal =
            `Encadenado desde el agente "${sourceAgent.name}".\n\n` +
            `Resultado previo:\n${sourceResult.result}\n\n` +
            (targetGoalTemplate
              ? `Tu tarea: ${resolveGoal(targetGoalTemplate, { previous: sourceResult })}`
              : "Continuá con tu tarea asignada basándote en el contexto anterior.");
        } else {
          targetGoal =
            `Chained from agent "${sourceAgent.name}".\n\n` +
            `Previous result:\n${sourceResult.result}\n\n` +
            (targetGoalTemplate
              ? `Your task: ${resolveGoal(targetGoalTemplate, { previous: sourceResult })}`
              : "Continue with your assigned task based on the above context.");
        }
      } else {
        targetGoal = resolveGoal(targetGoalTemplate, {}) || (
          chainLang === "es"
            ? `Encadenado desde "${sourceAgent.name}"`
            : `Chained from "${sourceAgent.name}"`
        );
      }

      const delay = chain.delay_ms || 0;
      const label = chain.label || `${sourceAgent.name} → ${targetAgent.name}`;

      // (pretty log emitted via writeAgentEvent from service.logEvent)

      // Save inter-agent conversation to both agents' memories
      service.addMemory(sourceAgent.id, "assistant", `[To ${targetAgent.name}] ${sourceResult.result.slice(0, 1000)}`, sourceRun.id);
      service.addMemory(targetAgent.id, "user", `[From ${sourceAgent.name}] ${sourceResult.result.slice(0, 1000)}`, sourceRun.id);

      // Fire-and-forget with optional delay
      const trigger = () => {
        const targetRun = service.createRun({
          agent_id: targetAgent.id,
          trigger_type: "chain",
          trigger_payload: {
            chain_id: chain.id,
            source_agent_id: sourceAgent.id,
            source_run_id: sourceRun.id,
            label,
          },
          goal: targetGoal,
          parent_run_id: sourceRun.id,
          parent_agent_id: sourceAgent.id,
          depth: Math.max(0, Number((sourceRun as { depth?: number }).depth ?? 0)) + 1,
        });

        service.updateRun(targetRun.id, { status: "running", started_at: isoNow() });

        events?.emit("agent:flow:chain_triggered", {
          source_agent_id: sourceAgent.id,
          source_agent_name: sourceAgent.name,
          target_agent_id: targetAgent.id,
          target_agent_name: targetAgent.name,
          chain_id: chain.id,
          chain_label: label,
          run_id: targetRun.id,
        });
        const handoffPreview = (sourceResult.result ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
        service.logEvent({
          run_id: targetRun.id, agent_id: targetAgent.id, agent_name: targetAgent.name,
          event_type: "chain", event_subtype: "triggered",
          detail: handoffPreview ? `${label} — handoff: "${handoffPreview}${handoffPreview.length === 400 ? "…" : ""}"` : label,
          raw_data: {
            source_agent_id: sourceAgent.id,
            source_agent_name: sourceAgent.name,
            chain_id: chain.id,
            handoff_full: sourceResult.result ?? "",
          },
        });

        this.execute({
          agent: targetAgent,
          goal: targetGoal,
          run: targetRun,
          service,
          events,
          depth: depth + 1,
        })
          .then((result) => {
            service.updateRun(targetRun.id, {
              status: result.status,
              result: result.result,
              error: result.error,
              steps_count: result.steps_count,
              tokens_used: result.tokens_used,
              completed_at: isoNow(),
            });
            // (chain completion already visible via the target run's DONE event)
          })
          .catch((err) => {
            service.updateRun(targetRun.id, {
              status: "failed",
              error: String(err),
              completed_at: isoNow(),
            });
            log.error(`Declarative chain "${label}": failed`, err);
          });
      };

      if (delay > 0) {
        setTimeout(trigger, delay);
      } else {
        trigger();
      }
    }
  }

  // ── Private helpers ─────────────────────────────────

  private resolveTools(agent: Agent, embeddings: EmbeddingsClient | null = null): {
    llmTools: LlmToolDef[];
    toolExecutor: Map<string, (args: unknown) => Promise<ToolResult>>;
  } {
    const allowed: string[] = parseJsonArray(agent.allowed_tools);
    const denied: string[] = parseJsonArray(agent.denied_tools);
    const deniedSet = new Set(denied);

    let filtered = this.allTools;

    if (allowed.length > 0) {
      // Baseline "social" tools every agent gets so every agent can see and
      // talk to every other agent. Opt-out is via denied_tools — nothing else
      // required. Agents with allowed_tools = [] (i.e. "all tools") already
      // have these.
      const allowedSet = new Set([...allowed, ...SOCIAL_TOOL_BASELINE]);
      filtered = filtered.filter((t) => allowedSet.has(t.name));
    }

    if (deniedSet.size > 0) {
      filtered = filtered.filter((t) => !deniedSet.has(t.name));
    }

    // Convert every filtered tool to its LLM-shaped schema once. We need this
    // catalog *fully* even when progressive_discovery is on — kernel_tool_search
    // ranks against it. What changes is which subset gets pushed into the
    // `llmTools` array we hand to the LLM each turn.
    const fullCatalog: LlmToolDef[] = [];
    const dropped: string[] = [];
    // Dedup: when the same tool name is registered by two sources (e.g. an
    // MCP server bridged twice, or a kernel module that mirrors a bridged
    // MCP), the LLM API rejects the whole call with
    // `Duplicate function definition provided`. The chat module already
    // dedupes when sending its own catalog — mirror that here so agents
    // don't get a 400 when their allowed_tools list selects a duplicate.
    const seenNames = new Set<string>();
    for (const t of filtered) {
      if (seenNames.has(t.name)) continue;
      seenNames.add(t.name);
      try {
        const raw = zodToJsonSchema(t.inputSchema) as Record<string, unknown>;
        // Normalize: LLM APIs (Claude, OpenAI) require top-level `type` and `properties`.
        const schema: Record<string, unknown> = { ...raw };
        if (!schema.type || typeof schema.type !== "string") schema.type = "object";
        if (!("properties" in schema) || typeof schema.properties !== "object") schema.properties = {};
        fullCatalog.push({
          name: t.name,
          description: t.description,
          input_schema: schema,
        });
      } catch (err) {
        dropped.push(t.name);
        log.warn(`AgentExecutor: failed to convert schema for tool "${t.name}": ${err}`);
      }
    }
    if (dropped.length > 0) {
      log.warn(`AgentExecutor: dropped ${dropped.length} tools with invalid schemas: ${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? "..." : ""}`);
    }

    const toolExecutor = new Map<string, (args: unknown) => Promise<ToolResult>>();
    for (const t of filtered) {
      // Map.set overwrites silently, but we want first-wins semantics to
      // mirror the LLM-side dedup above (otherwise the schema we sent and
      // the handler we run could come from different registrations).
      if (!toolExecutor.has(t.name)) toolExecutor.set(t.name, t.handler);
    }

    // Default path: the LLM sees the entire filtered catalog every turn.
    // Even here we install agent-scoped overrides for the meta tools so a
    // call to `kernel_code_run` can't escape the agent's allowed_tools (the
    // module-level meta handlers see the kernel-wide catalog). Same goes
    // for kernel_tool_search and kernel_tool_describe — they should never
    // leak the existence of denied tools to the agent.
    const scopedSearch = buildToolSearch(() => filtered);
    const scopedDescribe = buildToolDescribe(() => filtered);
    const scopedCodeRun = buildCodeRun(() => filtered, {
      ranking: new RankingService(embeddings),
      embeddings,
    });
    if (toolExecutor.has("kernel_tool_search")) toolExecutor.set("kernel_tool_search", scopedSearch.handler);
    if (toolExecutor.has("kernel_tool_describe")) toolExecutor.set("kernel_tool_describe", scopedDescribe.handler);
    if (toolExecutor.has("kernel_code_run")) toolExecutor.set("kernel_code_run", scopedCodeRun.handler);

    if (!agent.progressive_discovery) {
      return { llmTools: fullCatalog, toolExecutor };
    }

    // Progressive discovery path. The LLM starts with a tiny bootstrap that
    // includes the meta tools (search/describe/code_run) and calls
    // `kernel_tool_activate` to grow the directly-callable set on demand.
    // We mutate the same `llmTools` array — `runToolLoop` reads `tools` by
    // reference each iteration, so newly activated schemas show up the next
    // turn with no plumbing.
    //
    // Two flows are now possible:
    //   1. search → describe → activate → call (ergonomic, low overhead)
    //   2. search → code_run({ script: "await tool('kernel_x', {...})" })
    //      (composes multiple calls in ONE inference round — David's "code mode")
    const BOOTSTRAP_NAMES = new Set<string>([
      ...SOCIAL_TOOL_BASELINE,
      "kernel_workspace_analysis_save",
      "kernel_workspace_analysis_list",
      "kernel_workspace_search",
      "kernel_workspace_read",
      "kernel_tool_search",
      "kernel_tool_describe",
      "kernel_code_run",
    ]);
    const llmTools: LlmToolDef[] = fullCatalog.filter((t) => BOOTSTRAP_NAMES.has(t.name));
    const activatedNames = new Set(llmTools.map((t) => t.name));

    // ── kernel_tool_activate ─────────────────────────────
    // Synthetic, per-agent. Pushes the requested tools' schemas into the
    // live `llmTools` array so the next turn lets the model call them
    // directly without going through code_run. The catalog this dispatches
    // against is the agent's `fullCatalog` (already gated by allowed/denied).
    const activateToolDef: LlmToolDef = {
      name: "kernel_tool_activate",
      description:
        "Activate one or more kernel tools by exact name so the model can call them directly on subsequent turns. " +
        "Get names from `kernel_tool_search` first. Activated tools STAY available for the rest of this run. " +
        "Use this when you want low-overhead direct tool calls; for multi-step composition prefer `kernel_code_run`.",
      input_schema: {
        type: "object",
        properties: {
          names: {
            type: "array",
            items: { type: "string" },
            description: "Exact tool names returned by kernel_tool_search.",
          },
        },
        required: ["names"],
      },
    };
    llmTools.push(activateToolDef);
    activatedNames.add("kernel_tool_activate");

    const fullCatalogByName = new Map(fullCatalog.map((t) => [t.name, t]));

    const activateHandler = async (args: unknown): Promise<ToolResult> => {
      const a = (args ?? {}) as { names?: unknown };
      const names = Array.isArray(a.names) ? a.names.filter((n): n is string => typeof n === "string") : [];
      if (names.length === 0) {
        return {
          content: [{ type: "text", text: "kernel_tool_activate: `names` must be a non-empty array of tool names." }],
          isError: true,
        };
      }
      const activated: string[] = [];
      const missing: string[] = [];
      const alreadyOn: string[] = [];
      for (const name of names) {
        if (activatedNames.has(name)) {
          alreadyOn.push(name);
          continue;
        }
        const def = fullCatalogByName.get(name);
        if (!def) {
          missing.push(name);
          continue;
        }
        llmTools.push(def);
        activatedNames.add(name);
        activated.push(name);
      }
      const lines: string[] = [];
      if (activated.length > 0) {
        lines.push(`## Activated ${activated.length} tool(s)`);
        for (const n of activated) {
          const def = fullCatalogByName.get(n)!;
          lines.push(`- **${n}** — ${def.description}`);
        }
      }
      if (alreadyOn.length > 0) lines.push(`\n_Already active: ${alreadyOn.join(", ")}_`);
      if (missing.length > 0) lines.push(`\n_Not in this agent's catalog (denied or unknown): ${missing.join(", ")}_`);
      const out = {
        activated,
        alreadyActive: alreadyOn,
        missing,
        totalActive: activatedNames.size,
      };
      return {
        content: [{ type: "text", text: lines.join("\n") || "Nothing to activate." }],
        structuredContent: out,
        isError: missing.length > 0 && activated.length === 0,
      };
    };
    toolExecutor.set("kernel_tool_activate", activateHandler);

    log.info(
      `AgentExecutor: agent "${agent.name}" using progressive_discovery — ` +
      `${llmTools.length} bootstrap tools, ${fullCatalog.length} discoverable.`,
    );

    return { llmTools, toolExecutor };
  }

  private async executeTool(
    executor: Map<string, (args: unknown) => Promise<ToolResult>>,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    const handler = executor.get(toolName);
    if (!handler) {
      log.warn(`Agent tool not found: ${toolName}`);
      return { text: `Tool not found: ${toolName}`, isError: true };
    }

    try {
      const result = await handler(toolInput);
      const text = result.content.map((c) => c.text).join("\n");
      return { text, isError: result.isError ?? false };
    } catch (err) {
      log.error(`Agent tool execution error (${toolName}):`, err);
      return {
        text: `Error executing ${toolName}: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}

/**
 * Parse an optional <msg role="..." replies_to="..."> wrapper produced by an
 * agent. The wrapper is stripped before the content is returned to the caller
 * agent; the role is stored on the conversation message for debate detection.
 *
 * Accepted shape (whitespace tolerant):
 *   <msg role="counter" replies_to="abcd-..."> body... </msg>
 *
 * Returns the role string if the tag exists and role is a recognised value,
 * else null (caller falls back to 'answer' or 'stmt').
 */
export function extractRoleFromReply(text: string):
  "stmt" | "question" | "answer" | "counter" | "vote" | "summary" | null {
  if (!text) return null;
  const m = text.match(/<msg\b[^>]*\brole\s*=\s*"([a-z]+)"/i);
  if (!m) return null;
  const r = m[1].toLowerCase();
  if (r === "stmt" || r === "question" || r === "answer" || r === "counter" || r === "vote" || r === "summary") {
    return r;
  }
  return null;
}

/** Strip a leading/trailing <msg ...>...</msg> wrapper if present; return body. */
export function stripRoleWrapper(text: string): string {
  if (!text) return text;
  const m = text.match(/^\s*<msg\b[^>]*>([\s\S]*?)<\/msg>\s*$/i);
  if (m) return m[1].trim();
  return text;
}

/** Resolve {{variable}} placeholders in a goal template */
export function resolveGoal(
  template: string,
  variables: Record<string, unknown>,
): string {
  if (!template) return "";
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path: string) => {
    const parts = path.split(".");
    let value: unknown = variables;
    for (const part of parts) {
      if (value == null || typeof value !== "object") return "";
      value = (value as Record<string, unknown>)[part];
    }
    return value != null ? String(value) : "";
  });
}

/** Parse a JSON array that may be double-encoded (string of a string). */
function parseJsonArray(raw: string): string[] {
  try {
    let parsed = JSON.parse(raw);
    // Handle double-encoded JSON: '""[...]""' → parse again
    if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
    }
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Evaluate a chain condition against an execution result */
function evaluateChainCondition(conditionJson: string, result: ExecutionResult): boolean {
  try {
    const cond = JSON.parse(conditionJson);
    if (!cond || typeof cond !== "object" || Object.keys(cond).length === 0) return true;

    if (cond.status && cond.status !== result.status) return false;
    if (cond.result_contains && !result.result.includes(cond.result_contains)) return false;
    if (cond.min_steps && result.steps_count < cond.min_steps) return false;

    return true;
  } catch {
    return true;
  }
}
