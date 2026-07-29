/**
 * Outbound LLM concurrency limiter + per-provider pacing.
 *
 * The single biggest cause of `429 / "Server is temporarily limiting requests"`
 * in this codebase is *burst* traffic: agents, cinema/email embeddings, email
 * triage, curators and the chat loop all call `llm().chat()` independently with
 * NO shared backpressure. When several of them fire at once every call hits the
 * provider simultaneously and the provider rate-limits the whole batch.
 *
 * This module sits in front of every real provider HTTP call (see
 * `client.ts:chatOnce`) and enforces:
 *   - a GLOBAL max in-flight cap across the whole kernel, and
 *   - a PER-PROVIDER max in-flight cap (so one chatty subsystem can't starve a
 *     provider), and
 *   - an optional PER-PROVIDER minimum spacing between calls (pacing) — used to
 *     smooth out spawns of the `claude-code` CLI, which is very 429-prone when
 *     hammered.
 *
 * Tunables (all optional, env-driven, read once at module load):
 *   LLM_MAX_CONCURRENCY              global in-flight cap        (default 4)
 *   LLM_MAX_CONCURRENCY_PER_PROVIDER per-slug in-flight cap      (default 2)
 *   LLM_MIN_INTERVAL_MS              min ms between calls, all   (default 0)
 *
 * State lives on `globalThis` for the same reason `provider-health.ts` does:
 * this file is bundled into the kernel image AND into each extension's
 * `backend/entry.js`, so without the global trick each bundle would get its own
 * private semaphore and the cap would be silently multiplied by the number of
 * loaders.
 */

import { log } from "../logger.js";

// ── Async counting semaphore ────────────────────────────────────────────
// Permits are handed directly to the next waiter on release (no permit
// increment in that path) so the cap is never exceeded under contention.

class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Math.max(1, permits);
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next(); // transfer the permit directly — do NOT increment
    else this.permits += 1;
  }

  get inFlight(): number {
    return Math.max(0, this.max - this.permits);
  }

  get waiting(): number {
    return this.waiters.length;
  }

  // `max` is the configured ceiling; `permits` is what's currently free.
  // We stash max so diagnostics can report in-flight without extra state.
  max = 0;
}

function makeSemaphore(permits: number): Semaphore {
  const s = new Semaphore(permits);
  s.max = Math.max(1, permits);
  return s;
}

// ── Config ──────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

const GLOBAL_MAX = envInt("LLM_MAX_CONCURRENCY", 4);
const PER_PROVIDER_MAX = envInt("LLM_MAX_CONCURRENCY_PER_PROVIDER", 2);
const GLOBAL_MIN_INTERVAL_MS = envInt("LLM_MIN_INTERVAL_MS", 0);

// Built-in per-slug minimum spacing (ms) on top of the global default. The
// claude-code CLI cold-starts a child process per call and Anthropic rate-limits
// aggressively, so default to spacing those out even when the global interval
// is 0. Override the global floor with LLM_MIN_INTERVAL_MS.
const SLUG_MIN_INTERVAL_MS: Record<string, number> = {
  "claude-code": 800,
  claude_code: 800,
};

function minIntervalFor(slug: string): number {
  return Math.max(GLOBAL_MIN_INTERVAL_MS, SLUG_MIN_INTERVAL_MS[slug] ?? 0);
}

// ── Per-slug gate ─────────────────────────────────────────────────────────

interface SlugGate {
  sem: Semaphore;
  /** Earliest timestamp the next call to this slug may start (pacing). */
  nextAllowedAt: number;
  minIntervalMs: number;
}

interface LimiterGlobals {
  __mtwLlmGlobalSem?: Semaphore;
  __mtwLlmSlugGates?: Map<string, SlugGate>;
}
const G = globalThis as LimiterGlobals;

const globalSem: Semaphore = (G.__mtwLlmGlobalSem ??= makeSemaphore(GLOBAL_MAX));
const gates: Map<string, SlugGate> = (G.__mtwLlmSlugGates ??= new Map());

function gateFor(slug: string): SlugGate {
  let g = gates.get(slug);
  if (!g) {
    g = {
      sem: makeSemaphore(PER_PROVIDER_MAX),
      nextAllowedAt: 0,
      minIntervalMs: minIntervalFor(slug),
    };
    gates.set(slug, g);
  }
  return g;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Acquire a slot for an outbound LLM call to `slug`. Awaits until both the
 * global and the per-provider concurrency caps have room AND the per-provider
 * pacing window has elapsed. Returns a release function — call it exactly once
 * when the HTTP call completes (success OR failure). The returned function is
 * idempotent, so calling it twice is harmless.
 *
 * IMPORTANT: release the slot before any retry/backoff sleep — a slot held
 * during backoff would defeat the whole point of the limiter.
 */
export async function acquire(slug: string): Promise<() => void> {
  await globalSem.acquire();
  const g = gateFor(slug);
  try {
    await g.sem.acquire();
  } catch (err) {
    globalSem.release();
    throw err;
  }

  // Pacing: enforce a minimum gap between calls to this provider. We hold both
  // permits during the wait so the spacing is real (a 5th caller can't sneak
  // past while we sleep).
  if (g.minIntervalMs > 0) {
    const wait = g.nextAllowedAt - Date.now();
    if (wait > 0) await sleep(wait);
    g.nextAllowedAt = Date.now() + g.minIntervalMs;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    g.sem.release();
    globalSem.release();
  };
}

/** Diagnostic snapshot for the LLM providers dashboard / debugging. */
export function getStats(): {
  global: { max: number; inFlight: number; waiting: number };
  perProvider: Record<string, { max: number; inFlight: number; waiting: number }>;
} {
  const perProvider: Record<string, { max: number; inFlight: number; waiting: number }> = {};
  for (const [slug, g] of gates.entries()) {
    perProvider[slug] = { max: g.sem.max, inFlight: g.sem.inFlight, waiting: g.sem.waiting };
  }
  return {
    global: { max: globalSem.max, inFlight: globalSem.inFlight, waiting: globalSem.waiting },
    perProvider,
  };
}

log.debug(
  `LlmLimiter: global=${GLOBAL_MAX} perProvider=${PER_PROVIDER_MAX} minInterval=${GLOBAL_MIN_INTERVAL_MS}ms`,
);
