import { log } from "../logger.js";
import * as providerHealth from "./provider-health.js";
import { fallbackOrder } from "./provider-catalog.js";
import type { ChatLlmProvider } from "./chat-provider.js";
import { isProviderExhausted } from "./provider-quota.js";

/**
 * Pick the best available chat provider for a request.
 *
 * Selection rules:
 *   1. The requested slug wins if it's available, not quota-exhausted, and
 *      not currently inside a backoff window — even if its score is worse.
 *      (Caller's explicit choice takes precedence over health ranking.)
 *   2. Otherwise, candidates from FALLBACK_ORDER are filtered by
 *      `available() && !quotaExhausted && !inBackoff`, then sorted by
 *      health score (EWMA latency + failure penalty, lower wins).
 *   3. Defensive sweep: any registered provider not in FALLBACK_ORDER that
 *      passes the same filters.
 *   4. Last resort: any provider whose only problem is being marked
 *      exhausted/in-backoff (better than returning null and crashing).
 *
 * LM Studio is intentionally last in FALLBACK_ORDER — it requires the
 * desktop app to be running and reachable from the kernel's namespace.
 */
/**
 * Resolve a provider together with the model it is allowed to be asked for.
 *
 * A model name belongs to exactly one provider, so it must never travel with a
 * substitution. It did: with NVIDIA in a backoff window, the chat resolved to
 * MiniMax and still sent NVIDIA's model, and MiniMax answered "invalid params,
 * unknown model" — which the UI then showed as NVIDIA's reply. When the
 * provider that comes back is not the one asked for, the model is dropped and
 * the substitute answers with its own default.
 */
export function resolveProviderFor(
  providers: Map<string, ChatLlmProvider>,
  requested: string,
  model: string,
): { provider: ChatLlmProvider; model: string; substituted: boolean } | null {
  const provider = resolveProvider(providers, requested);
  if (!provider) return null;
  const substituted = providers.get(requested) !== provider;
  return { provider, model: substituted ? "" : model, substituted };
}

export function resolveProvider(
  providers: Map<string, ChatLlmProvider>,
  requested: string,
): ChatLlmProvider | null {
  // The catalog's fallback order: recommended, free, paid, local, then the
  // subscription CLI. claude-code is a single-turn shim that ignores tools; a
  // caller that sends tools filters it out through `supportsToolLoop: false`.
  const FALLBACK_ORDER = fallbackOrder();

  // 1. Honour the explicit request when it's truly usable
  const requestedProv = providers.get(requested);
  const requestedHealthy =
    !!requestedProv?.available() &&
    !isProviderExhausted(requested) &&
    !providerHealth.isBlocked(requested);
  if (requestedHealthy) return requestedProv!;

  // Reason the requested one was rejected (used for log clarity)
  const rejectReason = !requestedProv?.available()
    ? "unavailable"
    : isProviderExhausted(requested)
    ? "quota exhausted"
    : providerHealth.isBlocked(requested)
    ? "in backoff window"
    : "unknown";

  // 2. Score-based selection across the canonical fallback list
  const tried = new Set<string>([requested]);
  const fallbackCandidates = FALLBACK_ORDER.filter(name => {
    if (tried.has(name)) return false;
    const p = providers.get(name);
    if (!p?.available()) return false;
    if (isProviderExhausted(name)) return false;
    if (providerHealth.isBlocked(name)) return false;
    return true;
  });
  const ranked = providerHealth.rankCandidates(fallbackCandidates, { primary: requested });
  for (const name of ranked) {
    tried.add(name);
    const p = providers.get(name);
    if (p) {
      log.warn(`Chat: provider "${requested}" ${rejectReason}, falling back to "${name}"`);
      return p;
    }
  }

  // 3. Any leftover provider not in FALLBACK_ORDER (defensive — covers
  //    extension-registered providers and the future `nvidia` slot).
  const leftovers: string[] = [];
  for (const [name, p] of providers) {
    if (tried.has(name)) continue;
    if (!p.available()) continue;
    if (isProviderExhausted(name)) continue;
    if (providerHealth.isBlocked(name)) continue;
    leftovers.push(name);
  }
  const rankedLeftovers = providerHealth.rankCandidates(leftovers);
  for (const name of rankedLeftovers) {
    const p = providers.get(name);
    if (p) {
      log.warn(`Chat: falling back to non-canonical provider "${name}"`);
      return p;
    }
  }

  // 4. Last resort — try anything still alive, including exhausted/blocked.
  //    Walking FALLBACK_ORDER preserves the previous "predictable last
  //    resort" behaviour the dashboard relies on.
  for (const name of FALLBACK_ORDER) {
    const p = providers.get(name);
    if (p?.available()) {
      log.warn(`Chat: all healthy providers exhausted, trying "${name}" as last resort`);
      return p;
    }
  }

  return null;
}
