/**
 * The one "walk a chain of LLM links until one answers" loop.
 *
 * Used by `LlmClient.chat` (the `llm()` driver) and by
 * `ChatService._chatCompletionWithChain`; exported so the agent executor can
 * adopt it too. Each caller keeps its own policy — what a link is, which
 * errors end the walk, what gets logged, what the final error looks like —
 * and passes it in. `orderLinksByHealth` is the optional health-based
 * reordering `LlmClient` applies before walking.
 */
import * as providerHealth from "./provider-health.js";

export interface FallbackFailure<L> {
  link: L;
  index: number;
  error: unknown;
}

export interface FallbackChainOptions<L> {
  /**
   * An error that would fail the same way on every link (a malformed request,
   * a bad tool schema). The walk stops and this error is rethrown unchanged.
   */
  isFatal: (err: unknown, link: L, index: number) => boolean;
  /** Called once per failed link, before the walk stops or moves on. */
  onLinkFailed?: (failure: FallbackFailure<L>, info: { isLast: boolean; fatal: boolean; total: number }) => void;
  /** Called when a link other than the first one answered. */
  onRecovered?: (link: L, index: number) => void;
  /** The error to throw when every link failed — or there were no links. */
  exhausted: (failures: Array<FallbackFailure<L>>) => unknown;
}

/**
 * Try `call` on each link in order and return the first result. A failing
 * link is recorded and the next one tried, unless `isFatal` says the error
 * would repeat everywhere. When every link failed, `exhausted(failures)` is
 * thrown.
 */
export async function runWithFallbackChain<L, R>(
  links: readonly L[],
  call: (link: L, ctx: { index: number; isLast: boolean }) => Promise<R>,
  opts: FallbackChainOptions<L>,
): Promise<R> {
  const failures: Array<FallbackFailure<L>> = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const isLast = i === links.length - 1;
    try {
      const result = await call(link, { index: i, isLast });
      if (i > 0) opts.onRecovered?.(link, i);
      return result;
    } catch (err) {
      const fatal = opts.isFatal(err, link, i);
      const failure = { link, index: i, error: err };
      failures.push(failure);
      opts.onLinkFailed?.(failure, { isLast, fatal, total: links.length });
      if (fatal) throw err;
    }
  }
  throw opts.exhausted(failures);
}

/**
 * Sort chain links by the shared health tracker's score. The configured
 * primary keeps a boost while it's healthy; once it accumulates enough
 * consecutive failures, the boost is dropped (soft auto-unpin) and the
 * fastest healthy alternative becomes the head of the chain for this call.
 *
 * Blocked-but-not-dead links land at the tail so we still try them as a
 * last resort instead of returning "all chain links exhausted".
 */
export function orderLinksByHealth<L>(
  links: readonly L[],
  slugOf: (link: L) => string,
  primarySlug: string,
): L[] {
  const ranked = providerHealth.rankCandidates(
    links.map(l => slugOf(l)),
    { primary: primarySlug },
  );
  // Map ranked slugs back to links, preserving duplicates by consuming
  // each link once (a chain may legitimately have two links of the same
  // slug — e.g. two different Claude models on the same provider).
  const remaining = [...links];
  const out: L[] = [];
  for (const slug of ranked) {
    const idx = remaining.findIndex(l => slugOf(l) === slug);
    if (idx >= 0) {
      out.push(remaining[idx]);
      remaining.splice(idx, 1);
    }
  }
  // Anything not matched (defensive) goes to the tail in original order
  out.push(...remaining);
  return out;
}
