/**
 * Per-agent model_chain runner.
 *
 * Single source of truth for "pick a provider+model honoring the agent's
 * model_chain, fall back through entries on quota / rate-limit errors, and
 * mark exhausted providers". Used by the main executor (indirectly via its
 * own chain logic), AgentEvalService, MeetingExecutor and ReflectionOptimizer
 * so the user's `/models` configuration applies to every LLM call the fleet
 * issues — not just the agent's own goal execution.
 */

import { log } from "../../../../../src/core/logger.js";
import {
  type ChatLlmProvider,
} from "../../../../../src/modules/chat/llm-adapter.js";
import * as providerHealth from "../../../../../src/core/llm/provider-health.js";
import type { Agent, ModelChainEntry } from "../../../../../src/modules/agents/types.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";

export interface ChainCandidate {
  provider: ChatLlmProvider;
  model: string;
  providerName: string;
}

/**
 * Build the ordered candidate list for an agent. Order:
 *   1. Per-agent `model_chain` entries (most specific).
 *   2. The user's global `agents.defaultModelChain` (configured in /models).
 *   3. The supplied fallback (provider, model) — last-resort safety net.
 *
 * Duplicates are deduped by (providerName, model) and entries whose provider
 * can't resolve are skipped silently. Without (2) every meeting / eval /
 * reflection call dies on the first quota error of the agent's primary
 * provider, even when the user has a healthy fallback chain configured.
 */
export function buildAgentChain(
  agent: Agent | undefined,
  service: AgentService | undefined,
  providers: Map<string, ChatLlmProvider>,
  fallback?: { provider?: string; model?: string },
  globalChain?: ReadonlyArray<ModelChainEntry>,
): ChainCandidate[] {
  const out: ChainCandidate[] = [];
  const seen = new Set<string>();

  // When the user has the Claude Code CLI installed (OAuth via Max/Pro
  // subscription), prefer the SDK over the paid `claude` REST API for every
  // chain-based call — auto-eval, meetings, reflection. Without this, an
  // agent whose model_chain says `claude/<model>` burns API credits even
  // when the same model is available via the user's flat-rate subscription.
  const claudeCodeProv = providers.get("claude_code");
  const sdkAvailable = !!claudeCodeProv && claudeCodeProv.available();

  const push = (entry: ModelChainEntry): void => {
    let name = entry.provider || fallback?.provider || "";
    if (!name) return;
    let model = entry.model;
    // Auto-rewrite `claude` (paid REST API) → `claude_code` (SDK / OAuth)
    // whenever the CLI is logged in. Preserves the requested model so the SDK
    // runs exactly what the chain asked for, just over the user's Max/Pro
    // subscription instead of a metered API key that may have no credit.
    //
    // Two guards:
    //   - Only rewrite when the requested model actually looks like a Claude
    //     model (or is empty). A misconfigured `claude/gpt-4o-mini` stays on
    //     the REST API path — passing it to the SDK would surface a confusing
    //     "selected model … may not exist or you may not have access" error.
    //   - When the entry has no explicit model, force "claude-sonnet-4-5". The
    //     claude_code provider's own default falls back to CHAT_DEFAULT_MODEL,
    //     which may not be a Claude model name — same SDK error.
    if (name === "claude" && sdkAvailable) {
      const looksLikeClaude = !model || /^claude[-_]/i.test(model);
      if (looksLikeClaude) {
        name = "claude_code";
        if (!model) model = "claude-sonnet-4-5";
      }
    }
    const key = `${name}::${model || ""}`;
    if (seen.has(key)) return;
    // Strict resolution: we want to try exactly this (provider, model). If the
    // provider isn't registered or isn't available, skip this entry and let
    // the caller fall through to the NEXT chain entry — don't silently pick
    // some other provider the user didn't ask for.
    const provider = providers.get(name);
    if (!provider || !provider.available()) return;
    seen.add(key);
    out.push({ provider, model, providerName: name });
  };

  if (agent && service) {
    for (const entry of service.resolveModelChain(agent)) push(entry);
  }
  if (globalChain) {
    for (const entry of globalChain) push(entry);
  }
  if (fallback?.provider) {
    push({ provider: fallback.provider, model: fallback.model ?? "" });
  }
  return out;
}

/**
 * Run `call` against each candidate in order, skipping providers the
 * shared health tracker has flagged as blocked (quota / rate-limit /
 * auth / repeated transient failure). Returns the first successful
 * result.
 *
 * Two passes:
 *   1. First pass skips blocked providers entirely — they're hot on
 *      the do-not-call list because someone JUST got 403/429/etc.
 *   2. If every non-blocked candidate fails, we fall through to
 *      blocked ones as a last resort (the user may have just topped
 *      up; better to try than to dead-end).
 *
 * `instrumentProvider` (in chat/llm-adapter.ts) is what records
 * success/failure into `provider-health`, so we don't need a second
 * catch here to feed the tracker — just walking the chain is enough.
 *
 * `label` is used purely for log messages so failures are attributable.
 */
export async function runWithChain<T>(
  candidates: ChainCandidate[],
  label: string,
  call: (cand: ChainCandidate) => Promise<T>,
): Promise<T> {
  if (candidates.length === 0) {
    throw new Error(`${label}: no usable provider in chain`);
  }

  // Pass 1: only candidates the health tracker considers healthy.
  // Pass 2 (fallback): everything, including blocked ones — better to
  // try a maybe-recovered provider than to return "all exhausted".
  const passes: Array<{ filter: (c: ChainCandidate) => boolean; tag: string }> = [
    { filter: (c) => !providerHealth.isBlocked(c.providerName), tag: "healthy" },
    { filter: () => true, tag: "last-resort" },
  ];

  let lastErr: unknown = null;
  const triedKeys = new Set<string>();
  for (const pass of passes) {
    for (const cand of candidates) {
      const key = `${cand.providerName}::${cand.model}`;
      if (triedKeys.has(key)) continue;
      if (!pass.filter(cand)) continue;
      triedKeys.add(key);
      try {
        return await call(cand);
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          `${label}: ${cand.providerName}/${cand.model || "(default)"} failed, trying next: ${msg.slice(0, 200)}`,
        );
        // instrumentProvider already called recordFailure with the correct
        // classified kind — don't double-record here.
      }
    }
  }
  throw new Error(
    `${label}: all chain candidates exhausted: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}
