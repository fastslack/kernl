import { log } from "../../core/logger.js";
import { isoNow } from "../../core/helpers.js";
import { zodToJsonSchema } from "../../core/zod-to-json.js";
import type { ToolDefinition, ToolResult } from "../../core/types.js";
import type { KernelConfig, KernelLanguage } from "../../core/config.js";
import { isProviderExhausted, markProviderExhausted } from "../../core/llm/chat-adapters.js";
import * as providerHealth from "../../core/llm/provider-health.js";
import type { ChatLlmProvider } from "../../core/llm/chat-adapters.js";
import type { ChatMessage } from "../chat/types.js";
import { runToolLoop } from "../../core/llm/tool-loop.js";
import type { LlmLoopTool, LlmLoopResult, LlmLoopBudgets } from "../../core/llm/tool-loop.js";
import { buildToolSearch, buildToolDescribe, buildCodeRun } from "../meta/index.js";
import { RankingService } from "../../core/ranking/service.js";
import type { EmbeddingsClient } from "../../core/embeddings/client.js";
import type { Agent, AgentRun } from "./types.js";
import type { AgentService } from "./service.js";
import { normalizeDriverResult, driverThrewOutcome } from "./driver-result.js";
import type { BuiltinHandler } from "./builtin-handlers.js";
import type { AltExecutorLike, EvalServiceLike } from "./advanced-types.js";
import type { EventBus } from "../../core/event-bus.js";
import { resolveAgentSystemPrompt, resolveAgentGoalTemplate, resolveAgentLanguage } from "./i18n.js";
import {
  DEFAULT_MAX_CHAIN_DEPTH,
  failedBeforeStart,
  type ExecutionResult,
} from "./executor/shared.js";
import { agentAllowedTools, agentDeniedTools, agentVariables } from "./agent-fields.js";
import { buildModelChain, type ModelChainEntry, type ModelChainResolution } from "./executor/model-chain.js";
import { assembleSystemPrompt } from "./executor/system-prompt.js";
import { RunRecorder } from "./executor/run-recorder.js";
import { createInvokeHandler, invokeToolDef } from "./executor/invoke-tool.js";
import { localDate } from "../../sdk/clock.js";

// Public surface kept on this module — callers import these from executor.js.
export type { ExecutionResult } from "./executor/shared.js";
export { selectToolCapable } from "./executor/model-chain.js";
export { extractRoleFromReply, stripRoleWrapper } from "./executor/role-wrapper.js";

type LlmToolDef = LlmLoopTool;
type ToolExecutorMap = Map<string, (args: unknown) => Promise<ToolResult>>;

interface ExecuteParams {
  agent: Agent;
  goal: string;
  run: AgentRun;
  service: AgentService;
  events?: EventBus;
  depth?: number;
}

/** Everything the tool-loop phase of a native run needs. */
interface NativeLoopRun {
  agent: Agent;
  run: AgentRun;
  service: AgentService;
  events?: EventBus;
  depth: number;
  runState: { cancelled: boolean };
  recorder: RunRecorder;
  chain: ModelChainEntry[];
  llmTools: LlmToolDef[];
  toolExecutor: ToolExecutorMap;
  systemText: string;
  effectiveGoal: string;
  goalWithMemory: string;
}

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

/** Run-level quota check that triggers the cycle-through-all-providers retry. */
function isQuotaErrorMessage(errorMsg: string): boolean {
  return errorMsg.includes("insufficient_quota") || errorMsg.includes("exceeded your current quota") || errorMsg.includes("credit balance") || errorMsg.includes("API error 429") || errorMsg.includes("API error 402");
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

  /**
   * Run an agent to completion.
   *
   * Phases: depth guard → cancellation registration → short-circuits
   * (builtin handler, claude_code) → tools → model chain → prompt → tool loop.
   * Everything up to the tool loop runs synchronously (unless semantic
   * ranking has to embed the goal), exactly as it always has: callers that
   * don't await still observe run_started, the inbox being marked read, etc.
   * before execute() returns its promise.
   */
  async execute(params: ExecuteParams): Promise<ExecutionResult> {
    const { agent, goal, run, service, events } = params;
    const depth = params.depth ?? 0;

    // Chain depth guard
    const maxChainDepth = this.maxChainDepth();
    if (depth > maxChainDepth) {
      return failedBeforeStart(`Max chain depth exceeded (limit: ${maxChainDepth})`);
    }

    // Register active run for cancellation support
    const runState = { cancelled: false };
    this.activeRuns.set(run.id, runState);

    // Every way out of the run unregisters it — including the early failures
    // (no tools, no usable provider) and any early return added later. The
    // phases below still unregister on their own paths; deleting twice is a
    // no-op.
    try {
      const shortCircuit = this.tryShortCircuit(params, depth);
      if (shortCircuit) return await shortCircuit;

      const recorder = new RunRecorder(agent, run, service, events);

      // Emit flow event: run started
      recorder.emit("agent:flow:run_started", {
        goal: goal.slice(0, 300),
        trigger_type: run.trigger_type,
      });
      recorder.logEvent({
        event_type: "run",
        event_subtype: "started",
        detail: `Goal: ${goal.slice(0, 200)}`,
        raw_data: { goal: goal.slice(0, 300), trigger_type: run.trigger_type },
      });

      // 1-2. Tools, with the per-run kernel_agents_invoke handler.
      const { llmTools, toolExecutor } = this.resolveRunTools(agent, run, service, events, depth);
      if (llmTools.length === 0) {
        return this.noToolsResolved(agent);
      }

      // 3. Model fallback chain.
      const chainResolution = this.resolveModelChain(agent, service, llmTools.length);
      if (!chainResolution.ok) {
        return failedBeforeStart(chainResolution.error);
      }

      // 4. Interpolate variables in prompts
      const { lang, effectiveGoal, effectiveSystemPrompt } = this.interpolatePrompts(agent, goal);

      // 5. Build system prompt (enriched with learnings)
      const assembling = assembleSystemPrompt({
        agent, service, recorder,
        config: this.configRef,
        skillResolver: this.skillResolver,
        lang, depth, maxChainDepth,
        effectiveSystemPrompt,
        effectiveGoal,
        todayStr: localDate(),
        goalVector: null,
        memoryGoalSuffix: "",
      });
      const { systemText, memoryGoalSuffix } =
        assembling instanceof Promise ? await assembling : assembling;

      // Save user message to memory
      // Don't save goal to memory here — the dashboard chat handler already
      // persists the user's actual message via POST /api/agents/:id/memory.
      // Saving the full conversationalGoal (with RULES, RECENT WORK, etc.)
      // would pollute the chat history with system scaffolding.

      // 5. Build initial messages — inject memory at the END of the goal (recency bias)
      const goalWithMemory = memoryGoalSuffix
        ? effectiveGoal + memoryGoalSuffix
        : effectiveGoal;

      // 6. LLM tool-use loop with safety controls. Awaited so the finally
      // below runs after the loop, not as soon as its promise is returned —
      // the run must stay cancellable while it loops.
      return await this.runNativeLoop({
        agent, run, service, events, depth, runState, recorder,
        chain: chainResolution.chain,
        llmTools, toolExecutor, systemText, effectiveGoal, goalWithMemory,
      });
    } finally {
      this.activeRuns.delete(run.id);
    }
  }

  // ── execute() phases ────────────────────────────────

  private maxChainDepth(): number {
    return this.configRef?.agents?.maxInvokeDepth ?? DEFAULT_MAX_CHAIN_DEPTH;
  }

  /**
   * Paths that skip the native LLM loop entirely. Returns null when the run
   * goes native. Deliberately not async: the native path must not yield here.
   */
  private tryShortCircuit(params: ExecuteParams, depth: number): Promise<ExecutionResult> | null {
    const { agent } = params;
    // Builtin handler short-circuit — skip the LLM path entirely when the agent
    // is backed by a native function. Lets manual runs, chains, and the API
    // invoke handlers (like email:triage) without hitting LLM tool limits.
    if (agent.builtin_handler && this.builtinHandlers.has(agent.builtin_handler)) {
      return this.runBuiltinHandler(params, this.builtinHandlers.get(agent.builtin_handler)!);
    }
    // Route a claude_code agents al SDK — keep declarative chains/auto-eval
    // out of the way; the SDK-backed executor emits the same flow events.
    if (agent.executor_type === "claude_code") {
      return this.runClaudeCode(params, depth);
    }
    return null;
  }

  private async runBuiltinHandler(params: ExecuteParams, handler: BuiltinHandler): Promise<ExecutionResult> {
    const { agent, goal, run, service, events } = params;
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

  private async runClaudeCode(params: ExecuteParams, depth: number): Promise<ExecutionResult> {
    const { agent, goal, run, service, events } = params;
    if (!this.claudeCodeExecutor) {
      this.activeRuns.delete(run.id);
      return failedBeforeStart("claude_code executor not wired — check module initialization");
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

  /**
   * 1. Resolve allowed tools (baseline social tools auto-included unless denied).
   * 2. kernel_agents_invoke: its schema is in the baseline, but the handler
   *    needs per-run context (caller id, depth) to recurse safely. Only wire
   *    the schema when the tool wasn't denied.
   */
  private resolveRunTools(
    agent: Agent,
    run: AgentRun,
    service: AgentService,
    events: EventBus | undefined,
    depth: number,
  ): { llmTools: LlmToolDef[]; toolExecutor: ToolExecutorMap } {
    const { llmTools, toolExecutor } = this.resolveTools(agent, service.getEmbeddingsClient());

    const deniedSet = new Set(agentDeniedTools(agent));
    const invokeAllowed = !deniedSet.has("kernel_agents_invoke");
    if (invokeAllowed && !llmTools.some(t => t.name === "kernel_agents_invoke")) {
      llmTools.push(invokeToolDef());
    }

    toolExecutor.set("kernel_agents_invoke", createInvokeHandler({
      agent, run, service, events, depth,
      getConfig: () => this.configRef,
      execute: (p) => this.execute(p),
      cancelRun: (runId) => this.cancelRun(runId),
    }));

    return { llmTools, toolExecutor };
  }

  private noToolsResolved(agent: Agent): ExecutionResult {
    const allowedParsed = agentAllowedTools(agent);
    log.error(
      `Agent "${agent.name}": no tools resolved. ` +
      `allowed_tools=${JSON.stringify(allowedParsed)}, ` +
      `denied_tools=${agent.denied_tools}, ` +
      `total kernel tools=${this.allTools.length}, ` +
      `matching=${this.allTools.filter(t => allowedParsed.includes(t.name)).map(t => t.name).join(",")}`,
    );
    return failedBeforeStart(
      `No tools available for this agent (allowed: ${allowedParsed.join(", ")}; ${this.allTools.length} kernel tools loaded)`,
    );
  }

  /**
   * 3. Resolve the ordered (provider, model) fallback chain for this run —
   * see buildModelChain for the dedupe/availability/tool-capability/health
   * rules.
   */
  private resolveModelChain(agent: Agent, service: AgentService, toolCount: number): ModelChainResolution {
    const resolution = buildModelChain({
      agentName: agent.name,
      agentChain: service.resolveModelChain(agent),
      globalChain: this.configRef?.agents?.defaultModelChain ?? [],
      providers: this.providers,
      defaultProvider: this.defaultProvider,
      toolCount,
    });
    if (!resolution.ok) {
      // This run just proved the cached readiness verdict wrong, or confirmed
      // it. Either way the next gate check should re-probe rather than trust a
      // verdict from before whatever broke.
      void import("../../core/llm/readiness.js")
        .then((m) => m.markLlmReadinessStale("an agent run found no usable provider"))
        .catch(() => { /* readiness is optional wiring — never break a run over it */ });
    }
    return resolution;
  }

  /** 4. Interpolate {{variables}} in the goal and the agent's system prompt. */
  private interpolatePrompts(agent: Agent, goal: string): {
    lang: KernelLanguage;
    effectiveGoal: string;
    effectiveSystemPrompt: string;
  } {
    // Values are interpolated as stored (a non-string is stringified by replace).
    const vars = agentVariables(agent) as Record<string, string>;
    const interpolate = (text: string): string =>
      text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);

    const lang = resolveAgentLanguage(agent, this.configRef);
    const effectiveGoal = interpolate(goal);
    const rawSystemPrompt = resolveAgentSystemPrompt(agent, lang);
    const effectiveSystemPrompt = interpolate(rawSystemPrompt);
    return { lang, effectiveGoal, effectiveSystemPrompt };
  }

  /**
   * 6. LLM tool-use loop with safety controls — delegate to the shared core loop.
   *    Persistence, event emission, and pretty logging are wired via hooks so the
   *    loop stays provider-agnostic and reusable from chat/eval/triage.
   */
  private async runNativeLoop(r: NativeLoopRun): Promise<ExecutionResult> {
    const { agent, run, service, events, depth, recorder } = r;
    const maxIter = agent.max_iterations;

    let finalContent = "";
    let totalTokens = 0;
    // `provider` is kept for backward compat with downstream code — it tracks
    // whichever entry in the chain is currently active.
    const active = { provider: r.chain[0].provider };

    try {
      const loopResult = await this.runModelChain(r, active);

      finalContent = loopResult.finalContent;
      const abortReason = loopResult.abortReason;
      totalTokens += loopResult.totalTokens;

      if (abortReason) {
        log.warn(`Agent "${agent.name}": ${abortReason}`);
      }
      if (loopResult.hitMaxIterations) {
        log.warn(`Agent "${agent.name}": hit max iterations (${maxIter})`);
      }

      if (abortReason) {
        // Safety-aborted — record as error step and fail the run
        const error = `Safety abort: ${abortReason}`;
        recorder.recordErrorStep(error, error);
        const failResult: ExecutionResult = {
          status: "failed",
          result: finalContent,
          error,
          steps_count: recorder.stepNumber,
          tokens_used: totalTokens,
        };
        recorder.recordRunFailed(failResult.error, finalContent, totalTokens);
        return failResult;
      }

      const execResult: ExecutionResult = {
        status: "completed",
        result: finalContent,
        error: "",
        steps_count: recorder.stepNumber,
        tokens_used: totalTokens,
      };

      // Save agent response to conversational memory (only for manual/chat runs)
      if (run.trigger_type === "manual") {
        service.addMemory(agent.id, "assistant", finalContent.slice(0, 2000), run.id);
      }

      // Emit flow event: run completed
      recorder.emit("agent:flow:run_completed", {
        status: execResult.status, steps_count: execResult.steps_count,
        tokens_used: execResult.tokens_used,
        result_preview: execResult.result.slice(0, 200),
      });
      recorder.logEvent({
        event_type: "run", event_subtype: "completed",
        detail: `${execResult.status}: ${execResult.steps_count} steps, ${execResult.tokens_used} tokens`,
        raw_data: { status: execResult.status, steps_count: execResult.steps_count, tokens_used: execResult.tokens_used },
        tokens_used: execResult.tokens_used,
      });

      // Emit structured result for cross-module consumption
      if (execResult.status === "completed") {
        recorder.emit("agent:flow:result", {
          flow_id: agent.flow_id || "",
          result: execResult.result,
          trigger_type: run.trigger_type,
        });
      }

      // 7. Post-completion: auto-evaluate and close feedback loop
      await this.autoEvaluate(agent, run, r.effectiveGoal, execResult, [...recorder.toolsUsed], service, events);

      // 8. Post-completion: execute declarative chains
      this.executeDeclarativeChains(agent, run, execResult, service, depth, events);

      return execResult;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Quota exhaustion: cycle through ALL remaining providers until one works
      if (isQuotaErrorMessage(errorMsg)) {
        const retried = await this.retryOnOtherProviders(r, active.provider, totalTokens);
        if (retried) return retried;
      }

      log.error(`Agent "${agent.name}" execution error:`, err);

      recorder.recordErrorStep(errorMsg, errorMsg.slice(0, 200));
      recorder.recordRunFailed(errorMsg, finalContent, totalTokens);

      // Save error to conversational memory
      service.addMemory(agent.id, "assistant", `[Error] ${errorMsg.slice(0, 500)}`, run.id);

      const failedResult: ExecutionResult = {
        status: "failed",
        result: finalContent,
        error: errorMsg,
        steps_count: recorder.stepNumber,
        tokens_used: totalTokens,
      };

      // Auto-evaluate the failure so we still extract a lesson for next time
      await this.autoEvaluate(agent, run, r.effectiveGoal, failedResult, [...recorder.toolsUsed], service, events);

      return failedResult;
    } finally {
      this.activeRuns.delete(run.id);
    }
  }

  private loopBudgets(agent: Agent): LlmLoopBudgets {
    return {
      maxIterations: agent.max_iterations,
      maxTokens: agent.max_tokens ?? 150_000,
      maxErrors: agent.max_errors ?? 3,
      timeoutMs: agent.timeout_ms || 300_000,
    };
  }

  private toolRunner(toolExecutor: ToolExecutorMap, agent: Agent) {
    return (name: string, input: Record<string, unknown>) =>
      this.executeTool(toolExecutor, name, { ...input, __caller_agent_id: agent.id });
  }

  /**
   * Sticky fallback loop: try the primary first. If it throws a retryable
   * error (quota / 429 / 402 / 404 / 5xx / network timeout), move to the
   * next entry in the chain and restart the tool-loop with a fresh copy of
   * the initial messages. Once an entry starts streaming successfully, it
   * is committed for the rest of the run (no mid-run swap).
   *
   * `active.provider` tracks the entry being attempted, so on a throw it
   * names the provider that failed last.
   */
  private async runModelChain(r: NativeLoopRun, active: { provider: ChatLlmProvider }): Promise<LlmLoopResult> {
    const { agent, recorder, chain } = r;
    const llmMessages: ChatMessage[] = [
      { role: "user", content: r.goalWithMemory },
    ];
    const initialMessagesSnapshot: ChatMessage[] = JSON.parse(JSON.stringify(llmMessages));
    let loopResult: LlmLoopResult | undefined;
    let chainIdx = 0;
    while (chainIdx < chain.length) {
      const entry = chain[chainIdx];
      active.provider = entry.provider; // outer `provider` tracks the active entry
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
          systemText: r.systemText,
          model: entry.model || undefined,
          messages: llmMessages,
          tools: r.llmTools,
          executeTool: this.toolRunner(r.toolExecutor, agent),
          caller: `agent:${agent.name}`,
          budgets: this.loopBudgets(agent),
          isCancelled: () => r.runState.cancelled,
          hooks: recorder.loopHooks(),
        });
        break; // success (or soft abort via loopResult.abortReason) — commit this entry
      } catch (innerErr) {
        const retryable = isRetryableChainError(innerErr);
        const nextIdx = chainIdx + 1;
        if (!retryable || nextIdx >= chain.length) throw innerErr;
        const fromLabel = `${entry.provider.name}/${entry.model || "(default)"}`;
        const toEntry = chain[nextIdx];
        const toLabel = `${toEntry.provider.name}/${toEntry.model || "(default)"}`;
        const reason = innerErr instanceof Error ? innerErr.message : String(innerErr);
        log.warn(`Agent "${agent.name}": ${fromLabel} failed (${reason.slice(0, 100)}), falling back to ${toLabel}`);
        if (isProviderQuotaError(reason)) markProviderExhausted(entry.provider.name);
        recorder.emit("agent:flow:fallback_used", {
          from_provider: entry.provider.name, from_model: entry.model,
          to_provider: toEntry.provider.name, to_model: toEntry.model,
          reason: reason.slice(0, 200),
        });
        recorder.logEvent({
          event_type: "step", event_subtype: "fallback_used",
          detail: `Fallback ${fromLabel} → ${toLabel}: ${reason.slice(0, 150)}`,
          raw_data: { from_provider: entry.provider.name, from_model: entry.model,
                      to_provider: toEntry.provider.name, to_model: toEntry.model, reason },
        });
        chainIdx = nextIdx;
      }
    }
    if (!loopResult) {
      throw new Error(`Model chain exhausted — all ${chain.length} entries failed without recovery`);
    }
    return loopResult;
  }

  /**
   * Quota exhaustion: try every available provider that isn't exhausted,
   * outside the agent's chain. Returns the first result, or null when every
   * candidate failed too (the caller then records the original error).
   */
  private async retryOnOtherProviders(
    r: NativeLoopRun,
    failedProvider: ChatLlmProvider,
    totalTokens: number,
  ): Promise<ExecutionResult | null> {
    const { agent, run, service, recorder } = r;
    // Try every available provider that isn't exhausted
    for (const [, candidate] of this.providers) {
      if (!candidate.available() || candidate.name === failedProvider.name) continue;
      // Use the shared health tracker (same state LlmClient consults)
      // — covers xAI 403+credits, OpenAI insufficient_quota, Anthropic
      // billing, and the exponential backoff windows. The legacy
      // isProviderExhausted is kept as a belt-and-braces fallback.
      if (providerHealth.isBlocked(candidate.name)) continue;
      if (isProviderExhausted(candidate.name)) continue;

      log.warn(`Agent "${agent.name}": ${failedProvider.name} quota exhausted, trying ${candidate.name}`);
      try {
        // For local models (lmstudio), use a shorter goal to avoid context overflow
        const retryGoal = candidate.name === "lmstudio"
          ? r.effectiveGoal.slice(0, 2000)
          : r.goalWithMemory;
        const retrySystem = candidate.name === "lmstudio"
          ? r.systemText.slice(0, 3000)
          : r.systemText;
        // Local models struggle with many tools — limit to 8 max
        const retryTools = candidate.name === "lmstudio"
          ? r.llmTools.slice(0, 8)
          : r.llmTools;
        const retryResult = await runToolLoop({
          provider: candidate,
          systemText: retrySystem,
          model: undefined,
          messages: [{ role: "user", content: retryGoal }],
          tools: retryTools,
          executeTool: this.toolRunner(r.toolExecutor, agent),
          caller: `agent:${agent.name}/retry`,
          budgets: this.loopBudgets(agent),
          isCancelled: () => r.runState.cancelled,
        });
        const retryExecResult: ExecutionResult = {
          status: retryResult.abortReason ? "failed" : "completed",
          result: retryResult.finalContent,
          error: retryResult.abortReason ? `Safety abort: ${retryResult.abortReason}` : "",
          steps_count: recorder.stepNumber + retryResult.iterations,
          tokens_used: totalTokens + retryResult.totalTokens,
        };
        service.addMemory(agent.id, "assistant", retryResult.finalContent.slice(0, 2000), run.id);
        recorder.emit("agent:flow:run_completed", {
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
    return null;
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
    const allowed = agentAllowedTools(agent);
    const denied = agentDeniedTools(agent);
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
