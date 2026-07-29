import { log } from "../../../../../src/core/logger.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import type { ChatLlmProvider } from "../../../../../src/modules/chat/llm-adapter.js";
import { resolveProvider } from "../../../../../src/modules/chat/llm-adapter.js";
import type { ChatMessage } from "../../../../../src/modules/chat/types.js";
import type { Agent } from "../../../../../src/modules/agents/types.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";
import { buildAgentChain, runWithChain } from "./chain-runner.js";
import { resolveAgentLanguage } from "../../../../../src/modules/agents/i18n.js";
import { promptEvalSystem } from "../../../../../src/core/i18n/prompts.js";
import { stripReasoning } from "../../../../../src/core/llm/strip-reasoning.js";

export interface EvalResult {
  score: number;        // 1-5
  outcome: "success" | "partial" | "failure" | "neutral";
  lesson: string;       // extracted improvement / pattern (empty if nothing useful)
  issues: string;       // what went wrong (empty if fine)
  confidence: number;   // 0-1, how sure the evaluator is about its own grade
  tokens_used: number;
}

export class AgentEvalService {
  private providers: Map<string, ChatLlmProvider> = new Map();
  private evalProvider = "";
  private evalModel = "";
  private enabled = false;
  private configRef: KernelConfig | null = null;

  setProviders(providers: Map<string, ChatLlmProvider>, providerName: string, model: string): void {
    this.providers = providers;
    this.evalProvider = providerName;
    this.evalModel = model;
    const provider = resolveProvider(this.providers, providerName);
    this.enabled = provider !== null;
    log.info(`AgentEvalService: enabled=${this.enabled} fallback-provider=${providerName} model=${model || "(default)"} (per-agent model_chain takes precedence)`);
  }

  setConfig(config: KernelConfig): void {
    this.configRef = config;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async evaluate(input: {
    goal: string;
    result: string;
    error?: string;
    steps_count: number;
    tools_used: string[];
    status: "completed" | "failed";
    agent?: Agent;
    service?: AgentService;
  }): Promise<EvalResult | null> {
    if (!this.enabled) return null;

    // Eval is a structured-JSON grading task, NOT the agent's own work. Route
    // it through the configured (deterministic) eval provider FIRST, and only
    // fall back to the agent's own model_chain if that's down/quota'd. Reasoning
    // models (MiniMax-M2.x, DeepSeek-R1, …) sitting at the head of an agent's
    // chain reliably emit a <think> block + prose instead of the required JSON
    // object — stripReasoning then yields no `{…}`, the parse fails, and we burn
    // two ~1800tk calls before landing on sonnet anyway. Putting the eval model
    // up front skips that waste. (NOTE: this reorders eval ONLY; the agent's
    // chain still takes full precedence for its actual goal execution.)
    const key = (c: { providerName: string; model: string }): string =>
      `${c.providerName}::${c.model || ""}`;
    const evalFirst = buildAgentChain(
      undefined,
      undefined,
      this.providers,
      { provider: this.evalProvider, model: this.evalModel },
    );
    const seen = new Set(evalFirst.map(key));
    const agentChain = buildAgentChain(
      input.agent,
      input.service,
      this.providers,
      undefined,
      this.configRef?.agents?.defaultModelChain,
    );
    const candidates = [...evalFirst, ...agentChain.filter((c) => !seen.has(key(c)))];

    const userContent = [
      `## Goal`,
      input.goal.slice(0, 2000),
      "",
      `## Execution summary`,
      `- Status: ${input.status}`,
      `- Steps: ${input.steps_count}`,
      `- Tools used: ${input.tools_used.length > 0 ? input.tools_used.join(", ") : "(none)"}`,
      input.error ? `- Error: ${input.error.slice(0, 500)}` : "",
      "",
      `## Final result`,
      input.result.slice(0, 3000) || "(empty)",
    ].filter(Boolean).join("\n");

    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: userContent }] },
    ];

    // Evaluator language: from the evaluated agent when we have it, else from config.
    const evalLang = input.agent
      ? resolveAgentLanguage(input.agent, this.configRef)
      : (this.configRef?.language ?? "es");

    try {
      return await runWithChain(candidates, "AgentEvalService", async (cand) => {
        const completion = await cand.provider.chatCompletion(messages, {
          model: cand.model || undefined,
          system: promptEvalSystem(evalLang),
          // The eval JSON itself is tiny (~100 tokens), but reasoning models
          // (MiniMax-M2.x, DeepSeek-R1, etc.) burn their whole budget inside a
          // <think> block BEFORE emitting it. At 400 they truncate mid-thought,
          // never close </think>, and stripReasoning correctly yields "" →
          // "unparseable eval response" → a cascade of fallback retries that
          // costs far more than one call with enough headroom. Give the model
          // room to finish thinking AND answer.
          max_tokens: 2048,
          temperature: 0,
          caller: input.agent ? `auto-eval:${input.agent.name}` : "auto-eval",
        });
        const parsed = this.parseEvalJson(completion.content);
        if (!parsed) {
          throw new Error(
            `unparseable eval response: ${completion.content.slice(0, 200)}`,
          );
        }
        return { ...parsed, tokens_used: completion.tokens_used };
      });
    } catch (err) {
      log.warn(`AgentEvalService: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private parseEvalJson(raw: string): Omit<EvalResult, "tokens_used"> | null {
    if (!raw) return null;
    // Strip reasoning-model <think> blocks FIRST — their prose contains braces
    // that would otherwise hijack the indexOf("{")…lastIndexOf("}") slice below.
    let cleaned = stripReasoning(raw);
    // Strip markdown fences if LLM added them anyway
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    // Find first { and last } to be lenient
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1)) as {
        score?: number;
        outcome?: string;
        lesson?: string;
        issues?: string;
        confidence?: number;
      };
      const score = Math.max(1, Math.min(5, Math.round(obj.score ?? 3)));
      const outcome = ((): EvalResult["outcome"] => {
        const v = (obj.outcome ?? "").toLowerCase();
        if (v === "success" || v === "partial" || v === "failure" || v === "neutral") return v;
        // Derive from score if not explicit
        if (score >= 4) return "success";
        if (score === 3) return "partial";
        if (score <= 2) return "failure";
        return "neutral";
      })();
      return {
        score,
        outcome,
        lesson: (obj.lesson ?? "").trim().slice(0, 500),
        issues: (obj.issues ?? "").trim().slice(0, 500),
        confidence: Math.max(0, Math.min(1, obj.confidence ?? 0.5)),
      };
    } catch {
      return null;
    }
  }
}
