/**
 * Retry / backoff primitives shared by every LLM HTTP path.
 *
 *   - `sleep`, `withJitter` — the one sleep and the one jitter.
 *   - `parseRetryAfterMs` — turns a rate-limited response's headers into a
 *     concrete "wait this long" hint. Used by `LlmClient.chatOnce` (via the
 *     `retryAfterMs` it attaches to errors) and by `retryWithBackoff`.
 *   - `retryWithBackoff` — the in-place 429 retry loop the chat adapters
 *     (`ChatClaudeProvider`, `ChatOpenAiProvider`, `ChatLmStudioProvider`)
 *     wrap around their fetch.
 *
 * `LlmClient` keeps its own retry *policy* (retry transient errors in place,
 * fail a 429 over to the next chain link unless it is the last one) because
 * it runs inside a fallback chain and a concurrency limiter; the adapters are
 * called one provider at a time and simply wait out a 429. Both read the
 * provider's hints through the same parser.
 */

import { log } from "../logger.js";

export const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

/** ±15% jitter so retries from concurrent callers don't re-converge into a
 *  fresh thundering herd against the same provider. */
export function withJitter(ms: number): number {
  return Math.round(ms * (0.85 + Math.random() * 0.3));
}

/** Errors carry an optional `retryAfterMs` hint parsed from the provider's
 *  rate-limit headers — see `parseRetryAfterMs`. */
export interface RetryableError extends Error {
  retryAfterMs?: number;
}

/**
 * Pull a concrete "wait this long" hint out of a rate-limited HTTP response.
 * Honors, in priority order:
 *   - `Retry-After` (delta-seconds OR an HTTP date) — standard, used by most
 *   - `anthropic-ratelimit-{requests,tokens}-reset` (ISO 8601 timestamp)
 *   - `x-ratelimit-reset-{requests,tokens}` (OpenAI; secs or `1m30s`-style)
 * Returns undefined when no usable hint is present.
 */
export function parseRetryAfterMs(headers: Headers): number | undefined {
  const ra = headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  for (const h of ["anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-reset"]) {
    const v = headers.get(h);
    if (v) {
      const d = Date.parse(v);
      if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
    }
  }
  for (const h of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const v = headers.get(h);
    if (v) {
      const ms = parseDurationish(v);
      if (ms !== undefined) return ms;
    }
  }
  return undefined;
}

/** Parse OpenAI-style reset values: a bare number of seconds, or compound
 *  durations like "1m30s" / "6m0s" / "750ms". Returns ms or undefined. */
function parseDurationish(v: string): number | undefined {
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const m = v.match(/(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?/);
  if (!m) return undefined;
  const mins = Number(m[1] ?? 0);
  const secs = Number(m[2] ?? 0);
  const ms = Number(m[3] ?? 0);
  const total = mins * 60_000 + secs * 1000 + ms;
  return total > 0 ? total : undefined;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000;

/**
 * Retry a fetch call on 429 with exponential backoff (2s, 4s — three attempts
 * in total). The provider's own hint wins when it sends one: `Retry-After`
 * (seconds or HTTP date) or the Anthropic / OpenAI reset headers, parsed by
 * `parseRetryAfterMs`. The last 429 response is returned to the caller
 * unconsumed so it can build its error from the body.
 *
 * Only 429 is retried in place: a 5xx or Anthropic 529 surfaces immediately,
 * so the caller's own fallback (chat chain, agent model chain) moves on.
 */
export async function retryWithBackoff(
  fn: () => Promise<Response>,
  onRateLimitWait?: (waitMs: number, attempt: number) => void,
): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fn();
    if (resp.status !== 429) return resp;

    if (attempt === MAX_RETRIES) return resp;

    const waitMs = parseRetryAfterMs(resp.headers) ?? BASE_BACKOFF_MS * Math.pow(2, attempt - 1); // 2s, 4s, 8s

    log.warn(`Rate limit hit (429), retrying in ${waitMs / 1000}s (attempt ${attempt}/${MAX_RETRIES})...`);
    onRateLimitWait?.(waitMs, attempt);

    // Consume the body to free the connection
    await resp.text().catch(() => "");

    await sleep(waitMs);
  }

  // Unreachable, but TypeScript needs it
  return fn();
}
