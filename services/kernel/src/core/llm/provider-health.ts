/**
 * LLM provider health tracker — in-memory state for self-healing routing.
 *
 * Tracks per-provider:
 *   - EWMA response latency (weight 20% on new observation)
 *   - Consecutive failure count
 *   - Rate-limit / exhaustion windows with exponential backoff
 *
 * Used by `chat/llm-adapter.ts` (resolveProvider) and `core/llm-client.ts`
 * (chain ordering) to pick the best available provider per call instead of
 * walking a static fallback list. Inspired by aiden's `providers/router.ts`,
 * adapted to Kernl's slug-based naming.
 *
 * Per-provider rate-limit windows are tuned to actual reset characteristics
 * (Groq resets in seconds, Gemini in ~90s). A flat "exhausted until tomorrow"
 * is far too conservative for fast-reset APIs.
 *
 * State is in-memory only — quota persistence (per-day exhaustion) is still
 * handled by `chat/llm-adapter.ts:provider_status`. This module sits on top
 * for short-term routing decisions.
 */

import { log } from "../logger.js";
import type { SqliteDb } from "../db/sqlite.js";

// ── Per-provider rate-limit base windows (ms) ───────────────────────────
// Tuned per provider's typical reset behaviour. Used as the BASE for
// exponential backoff on consecutive failures (cap = 5 min).

const RATE_LIMIT_WINDOWS_MS: Record<string, number> = {
  // Cloud APIs that reset fast
  groq: 15_000,
  gemini: 90_000,
  openrouter: 30_000,
  cerebras: 30_000,
  // Standard 60s windows
  openai: 60_000,
  anthropic: 60_000,
  claude: 60_000,
  nvidia: 60_000,
  grok: 30_000,
  xai: 30_000,
  // Local — never rate-limited
  ollama: 0,
  lmstudio: 0,
  claude_code: 0,
  "claude-code": 0,
  // Custom OpenAI-compatible — conservative default
  custom: 30_000,
};

const DEFAULT_WINDOW_MS = 60_000;
const MAX_BACKOFF_MS = 300_000; // 5 min cap — for transient 429 / rate-limit failures.
/**
 * Cap for `exhausted` failures (billing / `insufficient_quota` / `credit balance`).
 * Those don't self-heal on the rate-limit reset window — they require a human
 * to top up the account. Retrying every 5 min is just log spam. Default = 1 h;
 * override with `LLM_HEALTH_EXHAUSTED_BACKOFF_MS` for tighter or looser caps.
 *
 * To force an immediate retry after topping up, hit `/api/llm-providers/health/reset`
 * (or restart the kernel) — the in-memory state will clear and the provider
 * goes back into rotation on the next request.
 */
const MAX_EXHAUSTED_BACKOFF_MS = (() => {
  const env = Number(process.env.LLM_HEALTH_EXHAUSTED_BACKOFF_MS);
  return Number.isFinite(env) && env > 0 ? env : 60 * 60_000;
})();
const AUTO_UNPIN_THRESHOLD = 3;

// ── Failure kinds ───────────────────────────────────────────────────────

export type FailureKind = "rate-limit" | "exhausted" | "transient" | "auth";

// ── In-memory state ─────────────────────────────────────────────────────

interface HealthEntry {
  /** EWMA latency in ms. Undefined until first successful call. */
  ewmaMs?: number;
  /** Consecutive failures since last success. Reset on success. */
  failures: number;
  /** Timestamp at which the current backoff window expires. */
  blockedUntil: number;
  /** Last success timestamp (for stale-detection / debugging). */
  lastSuccessAt?: number;
  /** Last failure kind (for diagnostics). */
  lastFailureKind?: FailureKind;
}

// ── Singleton state via globalThis ────────────────────────────────────
// CRITICAL: this module is bundled into both the kernel image AND each
// extension's `backend/entry.js`. Without the globalThis trick, every
// bundle would have its OWN `state` Map — subs:translate (kernel) and
// ReflectionOptimizer (extension) would write to two different Maps and
// disagree about whether grok is blocked. Stashing the Map on globalThis
// makes the first loader win and all subsequent loaders share it.

interface HealthGlobals {
  __mtwLlmHealthState?: Map<string, HealthEntry>;
  __mtwLlmHealthDb?: SqliteDb | null;
}
const G = globalThis as HealthGlobals;
const state: Map<string, HealthEntry> = (G.__mtwLlmHealthState ??= new Map<string, HealthEntry>());

// ── SQLite persistence ────────────────────────────────────────────────
// In-memory is the source of truth for hot reads/writes; the DB is a
// disk-backed mirror so kernel restarts don't lose learned state.
// `attachDb()` creates the table, loads any prior state into the Map,
// and switches on write-through (debounced 500ms per slug to coalesce
// bursts of failures from a single retry storm). Tests that don't call
// attachDb still get full in-memory behaviour.
//
// The DB handle is ALSO global so extension bundles see the same one
// the kernel attached, even though they have their own copy of this
// module's code.

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
const WRITE_DEBOUNCE_MS = 500;

function getAttachedDb(): SqliteDb | null {
  return G.__mtwLlmHealthDb ?? null;
}

export function attachDb(db: SqliteDb): void {
  G.__mtwLlmHealthDb = db;
  db.exec(
    "CREATE TABLE IF NOT EXISTS llm_provider_health (\n" +
      "  slug              TEXT PRIMARY KEY,\n" +
      "  ewma_ms           REAL,\n" +
      "  failures          INTEGER NOT NULL DEFAULT 0,\n" +
      "  blocked_until     INTEGER NOT NULL DEFAULT 0,\n" +
      "  last_success_at   INTEGER,\n" +
      "  last_failure_kind TEXT,\n" +
      "  updated_at        INTEGER NOT NULL\n" +
      ")",
  );
  // Hydrate the in-memory Map from disk. Stale `blocked_until` from a
  // long shutdown will auto-clear on the first isBlocked() read because
  // that function checks Date.now() against the timestamp.
  const rows = db
    .prepare(
      "SELECT slug, ewma_ms, failures, blocked_until, last_success_at, last_failure_kind " +
        "FROM llm_provider_health",
    )
    .all() as Array<{
      slug: string;
      ewma_ms: number | null;
      failures: number;
      blocked_until: number;
      last_success_at: number | null;
      last_failure_kind: string | null;
    }>;
  for (const r of rows) {
    state.set(r.slug, {
      ewmaMs: r.ewma_ms ?? undefined,
      failures: r.failures,
      blockedUntil: r.blocked_until,
      lastSuccessAt: r.last_success_at ?? undefined,
      lastFailureKind: (r.last_failure_kind as FailureKind | null) ?? undefined,
    });
  }
  if (rows.length > 0) {
    log.info(`LlmHealth: hydrated ${rows.length} provider health record(s) from sqlite`);
  }
}

function persistSoon(slug: string): void {
  const db = getAttachedDb();
  if (!db) return;
  const existing = pendingWrites.get(slug);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingWrites.delete(slug);
    const e = state.get(slug);
    const currentDb = getAttachedDb();
    if (!currentDb || !e) return;
    try {
      currentDb
        .prepare(
          "INSERT INTO llm_provider_health " +
            "(slug, ewma_ms, failures, blocked_until, last_success_at, last_failure_kind, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(slug) DO UPDATE SET " +
            "  ewma_ms=excluded.ewma_ms, " +
            "  failures=excluded.failures, " +
            "  blocked_until=excluded.blocked_until, " +
            "  last_success_at=excluded.last_success_at, " +
            "  last_failure_kind=excluded.last_failure_kind, " +
            "  updated_at=excluded.updated_at",
        )
        .run(
          slug,
          e.ewmaMs ?? null,
          e.failures,
          e.blockedUntil,
          e.lastSuccessAt ?? null,
          e.lastFailureKind ?? null,
          Date.now(),
        );
    } catch (err) {
      // Persistence failures must not break the LLM call path.
      log.warn(`LlmHealth: persist failed for "${slug}": ${err instanceof Error ? err.message : err}`);
    }
  }, WRITE_DEBOUNCE_MS);
  pendingWrites.set(slug, timer);
}

function get(slug: string): HealthEntry {
  let e = state.get(slug);
  if (!e) {
    e = { failures: 0, blockedUntil: 0 };
    state.set(slug, e);
  }
  return e;
}

function baseWindow(slug: string): number {
  return RATE_LIMIT_WINDOWS_MS[slug] ?? DEFAULT_WINDOW_MS;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Record a successful chat completion. Updates EWMA latency (20% weight on
 * new observation), clears failure count, and lifts any backoff window.
 */
export function recordSuccess(slug: string, latencyMs: number): void {
  const e = get(slug);
  e.ewmaMs = e.ewmaMs === undefined ? latencyMs : e.ewmaMs * 0.8 + latencyMs * 0.2;
  if (e.failures > 0) {
    log.debug(`LlmHealth: ${slug} recovered (was ${e.failures} consecutive failure(s))`);
  }
  e.failures = 0;
  e.blockedUntil = 0;
  e.lastSuccessAt = Date.now();
  e.lastFailureKind = undefined;
  persistSoon(slug);
}

/**
 * Record a failure and apply exponential backoff: window = base × 2^(fails-1)
 * capped at 5 min. `kind` controls the multiplier and cap:
 *   - `rate-limit` / `transient`: standard exponential backoff, capped at 5 min.
 *   - `exhausted`: 10× base for the first hit, then grows exponentially with
 *     consecutive failures, capped at `MAX_EXHAUSTED_BACKOFF_MS` (1 h default).
 *     This kind is reserved for hard quota errors (402, insufficient_quota,
 *     credit balance) that DON'T self-heal — they need the user to top up.
 *     Retrying every 5 min there is pure log spam.
 *   - `auth`: short backoff (just block briefly so we move on, no retry).
 */
export function recordFailure(
  slug: string,
  kind: FailureKind = "transient",
  retryAfterMs?: number,
): void {
  const e = get(slug);
  e.failures += 1;
  e.lastFailureKind = kind;

  const base = baseWindow(slug);
  if (base === 0) {
    // Local providers: don't apply backoff — failure here usually means the
    // process isn't running. The caller's available() check handles it.
    return;
  }

  let window: number;
  if (kind === "auth") {
    window = Math.min(MAX_BACKOFF_MS, 30_000);
  } else if (kind === "exhausted") {
    // 1st failure: base × 10 (e.g. OpenAI = 60s × 10 = 10 min)
    // Further failures grow exponentially. Cap is the dedicated long cap so a
    // billing-exhausted provider doesn't get hammered every 5 min.
    const raw = base * 10 * Math.pow(2, Math.max(0, e.failures - 1));
    window = Math.min(MAX_EXHAUSTED_BACKOFF_MS, raw);
  } else if ((kind === "rate-limit" || kind === "transient") && retryAfterMs && retryAfterMs > 0) {
    // The provider told us exactly when it resets — honor it (capped) instead
    // of guessing with exponential backoff. Add a touch of headroom so we don't
    // retry the very millisecond the window opens.
    window = Math.min(MAX_BACKOFF_MS, retryAfterMs + 250);
  } else {
    // Exponential backoff with downward jitter (×0.8–1.0) so a synchronized
    // burst of failures doesn't unblock in lockstep and immediately re-storm
    // the provider. Jitter is applied after the cap so the window never exceeds
    // MAX_BACKOFF_MS.
    const capped = Math.min(MAX_BACKOFF_MS, base * Math.pow(2, e.failures - 1));
    window = Math.round(capped * (0.8 + Math.random() * 0.2));
  }

  e.blockedUntil = Date.now() + window;
  log.warn(
    `LlmHealth: ${slug} ${kind} (failure #${e.failures}) — blocked for ${Math.round(window / 1000)}s`,
  );
  persistSoon(slug);
}

/**
 * Returns true if the provider is currently inside a backoff window.
 * Auto-clears expired windows on read so the state stays self-healing
 * without needing a periodic sweep.
 */
export function isBlocked(slug: string): boolean {
  const e = state.get(slug);
  if (!e || e.blockedUntil === 0) return false;
  if (Date.now() >= e.blockedUntil) {
    e.blockedUntil = 0;
    return false;
  }
  return true;
}

/**
 * Score for ranking candidates — LOWER is better.
 * Components:
 *   latencySec  : EWMA latency in seconds (default 2s when unknown)
 *   penalty     : sqrt(consecutiveFailures) × 5 — punishes flaky providers
 *   primaryBoost: -1000 when this slug is the requested primary AND
 *                 has fewer than AUTO_UNPIN_THRESHOLD consecutive failures
 *                 (soft auto-unpin: stop boosting a primary that keeps failing)
 *
 * Use `pickBest()` for the common case; this is exposed for diagnostics.
 */
export function getScore(slug: string, primary?: string): number {
  const e = state.get(slug);
  const ewmaMs = e?.ewmaMs ?? 2000;
  const fails = e?.failures ?? 0;
  const latencySec = ewmaMs / 1000;
  const penalty = Math.sqrt(fails) * 5;

  let primaryBoost = 0;
  if (primary && slug === primary) {
    if (fails >= AUTO_UNPIN_THRESHOLD) {
      // Soft auto-unpin: log once per crossing, drop the boost
      if (fails === AUTO_UNPIN_THRESHOLD) {
        log.warn(
          `LlmHealth: soft auto-unpin "${slug}" (primary) — ${fails} consecutive failures, no longer prioritized`,
        );
      }
    } else {
      primaryBoost = -1000;
    }
  }

  return latencySec + penalty + primaryBoost;
}

/**
 * Pick the best slug from a list of candidates. Filters out blocked slugs,
 * sorts the rest by score (lower is better), returns the head.
 *
 * Returns `null` if every candidate is blocked. Caller can decide whether to
 * fall back to a "last resort" iteration (try blocked ones in original order).
 */
export function pickBest(
  candidates: string[],
  opts?: { primary?: string },
): string | null {
  const available = candidates.filter(s => !isBlocked(s));
  if (available.length === 0) return null;
  available.sort((a, b) => getScore(a, opts?.primary) - getScore(b, opts?.primary));
  return available[0];
}

/**
 * Return the candidate list ordered by health score (best first), with
 * blocked candidates moved to the tail. Useful for the "walk the chain"
 * pattern — try the best, then the next best, then the blocked ones as
 * a last resort.
 */
export function rankCandidates(
  candidates: string[],
  opts?: { primary?: string },
): string[] {
  const available: string[] = [];
  const blocked: string[] = [];
  for (const s of candidates) {
    if (isBlocked(s)) blocked.push(s);
    else available.push(s);
  }
  available.sort((a, b) => getScore(a, opts?.primary) - getScore(b, opts?.primary));
  // Blocked ones preserve original order so the caller's last-resort attempt
  // stays predictable.
  return [...available, ...blocked];
}

/**
 * Get a diagnostic snapshot. Used by `/api/llm-providers` status endpoints
 * and by tests. Mutating the returned object is safe (it's a copy).
 */
export function getHealth(slug: string): {
  ewmaMs?: number;
  failures: number;
  blocked: boolean;
  blockedFor?: number;
  lastSuccessAt?: number;
  lastFailureKind?: FailureKind;
} {
  const e = state.get(slug);
  if (!e) return { failures: 0, blocked: false };
  const blocked = isBlocked(slug);
  return {
    ewmaMs: e.ewmaMs,
    failures: e.failures,
    blocked,
    blockedFor: blocked ? Math.max(0, e.blockedUntil - Date.now()) : undefined,
    lastSuccessAt: e.lastSuccessAt,
    lastFailureKind: e.lastFailureKind,
  };
}

/** Get health snapshots for every slug we've seen. */
export function getAllHealth(): Record<string, ReturnType<typeof getHealth>> {
  const out: Record<string, ReturnType<typeof getHealth>> = {};
  for (const slug of state.keys()) out[slug] = getHealth(slug);
  return out;
}

/**
 * Clear the in-memory backoff window for one slug (or all when omitted).
 * Called by the operator endpoint `/api/llm-providers/clear-exhausted` so that
 * a billing top-up immediately puts the provider back in rotation, without
 * waiting for `MAX_EXHAUSTED_BACKOFF_MS` to expire.
 *
 * Resets `failures` to 0 and clears `blockedUntil`, but preserves EWMA latency
 * (that's a useful signal independent of billing state).
 *
 * Returns the number of entries whose block window was cleared.
 */
export function clearBlock(slug?: string): number {
  let cleared = 0;
  if (!slug) {
    for (const [s, e] of state.entries()) {
      if (e.blockedUntil > 0 || e.failures > 0) cleared++;
      e.blockedUntil = 0;
      e.failures = 0;
      e.lastFailureKind = undefined;
      persistSoon(s);
    }
    if (cleared > 0) log.info(`LlmHealth: cleared block window on ${cleared} provider(s)`);
    return cleared;
  }
  const e = state.get(slug);
  if (!e) return 0;
  if (e.blockedUntil > 0 || e.failures > 0) cleared = 1;
  e.blockedUntil = 0;
  e.failures = 0;
  e.lastFailureKind = undefined;
  persistSoon(slug);
  if (cleared > 0) log.info(`LlmHealth: cleared block window for "${slug}"`);
  return cleared;
}

/** Reset all in-memory state. Test-only. */
export function _resetForTests(): void {
  state.clear();
}

// ── Failure-classification helper ───────────────────────────────────────

/**
 * Inspect an error message and decide which failure kind to record.
 * Centralized so every callsite uses the same rules.
 */
export function classifyError(err: unknown): FailureKind {
  const msg = err instanceof Error ? err.message : String(err);
  // "exhausted" must be checked BEFORE the auth check below — xAI returns
  // HTTP 403 for both "bad key" and "out of credits" and uses the *body*
  // to disambiguate (e.g. "Your team … has either used all available
  // credits or reached its monthly spending limit"). Without these
  // billing phrases here, a quota-exhausted Grok would be miscategorized
  // as "auth" and the UI would suggest rotating a perfectly valid key.
  if (/\b402\b|insufficient_quota|exceeded your current quota|credit balance|billing|all (available )?credits|used.*credits|out of credits|monthly (spending|sp[a-z]* limit|limit)|quota exhausted/i.test(msg)) {
    return "exhausted";
  }
  if (/\b429\b|rate[_ ]?limit|too[_ ]many[_ ]requests/i.test(msg)) {
    return "rate-limit";
  }
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid[_ ]?api[_ ]?key/i.test(msg)) {
    return "auth";
  }
  return "transient";
}
