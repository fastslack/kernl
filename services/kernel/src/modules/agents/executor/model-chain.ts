import { log } from "../../../core/logger.js";
import * as providerHealth from "../../../core/llm/provider-health.js";
import type { ChatLlmProvider } from "../../../core/llm/chat-adapters.js";

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

/** One resolved (provider, model) attempt in an agent's fallback chain. */
export interface ModelChainEntry {
  provider: ChatLlmProvider;
  model: string;
  configProvider: string;
}

export type ModelChainResolution =
  | { ok: true; chain: ModelChainEntry[] }
  | { ok: false; error: string };

export interface ModelChainInput {
  agentName: string;
  /** The agent's own chain (service.resolveModelChain(agent)). */
  agentChain: Array<{ provider: string; model: string }>;
  /** `agents.defaultModelChain` from the kernel config. */
  globalChain: Array<{ provider: string; model: string }>;
  providers: Map<string, ChatLlmProvider>;
  defaultProvider: string;
  /** How many tools this run will send — gates tool-incapable providers. */
  toolCount: number;
}

/**
 * Resolve the model fallback chain. Each entry is (provider, model).
 * Agent-level chain wins; the global `agents.defaultModelChain` is
 * appended as a common tail (deduped by provider+model) so any agent
 * without a full custom 3-slot chain still benefits from global
 * fallbacks — this is the UX "1 default + 2 fallbacks for everyone".
 *
 * Empty entries ({provider:"", model:""}) are dropped — they represent
 * an agent with no explicit preference. Without this drop they'd resolve
 * to `defaultProvider` and race ahead of the curated global chain
 * (regression: an agent with no chain + an exhausted default provider
 * would fall back to *any* available LLM regardless of user preference).
 *
 * Pipeline: dedupe → availability (strict) → last-resort alive provider →
 * tool-capability filter → health re-order. On an empty result the caller
 * gets the exact error message to fail the run with.
 */
export function buildModelChain(input: ModelChainInput): ModelChainResolution {
  const { agentName, agentChain, globalChain, providers, defaultProvider, toolCount } = input;
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
    rawChain.push({ provider: defaultProvider, model: "" });
  }
  const effectiveChain: ModelChainEntry[] = [];
  for (const entry of rawChain) {
    const requestedName = entry.provider || defaultProvider;
    // STRICT resolve: only use exactly the provider this chain entry
    // requested. resolveProvider() used to fall back to *any* healthy
    // alternative here — but that paired the alternative provider with
    // the original (provider-specific) model name, producing nonsense
    // like `claude/grok-4-fast-reasoning` → 400. The chain itself is
    // the right place to express fallbacks; mid-resolve substitution
    // contaminates models across providers.
    const desired = providers.get(requestedName);
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
    for (const [name, p] of providers) {
      if (!p.available()) continue;
      if (toolCount > 0 && p.supportsToolLoop === false) continue;
      effectiveChain.push({ provider: p, model: "", configProvider: name });
      log.warn(`Agent "${agentName}": entire chain unavailable, last-resort fallback to ${name}/(default)`);
      break;
    }
  }

  // Drop providers that cannot execute the tools this run is about to send.
  // Done after availability and before the health re-ordering, so a
  // tool-incapable provider can never become effectiveChain[0].
  const capable = selectToolCapable(effectiveChain, toolCount);
  if (capable.dropped.length > 0) {
    log.warn(
      `Agent "${agentName}": dropped ${capable.dropped.join(", ")} from the chain — ` +
        `${toolCount} tools to run and those providers cannot execute a tool loop.`,
    );
    effectiveChain.length = 0;
    effectiveChain.push(...capable.chain);
  }

  if (effectiveChain.length === 0) {
    const toolBlocked = capable.dropped.length > 0;
    return {
      ok: false,
      error: toolBlocked
        ? `No LLM provider in the chain can run tool calls. Dropped: ${capable.dropped.join(", ")}. ` +
          `Configure a provider that supports tools (Settings → AI), or set this agent's executor to "claude_code" to use the CLI's own tool loop.`
        : `No available LLM provider for chain: ${rawChain.map(e => `${e.provider || "(default)"}/${e.model || "(default)"}`).join(", ")}`,
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
  return { ok: true, chain: effectiveChain };
}
