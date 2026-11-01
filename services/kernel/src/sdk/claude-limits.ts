/**
 * The subscription's usage limit, as the Claude Code CLI reports it.
 *
 * Hitting the 5-hour or weekly limit does not throw. The SDK sends an
 * assistant message whose text is the notice ("You've hit your limit ·
 * resets …") with `error: "rate_limit"`, then a result of subtype `success`
 * carrying `is_error: true` and `api_error_status: 429`. Read only for its
 * text, that is a perfectly good answer: the chat returned the notice as the
 * model's reply, an agent run closed as completed with the notice as its
 * result, and the provider chain never learned it had something to fall back
 * from.
 *
 * Fable has a weekly limit of its own, so a limit on one model is first
 * routed around inside the subscription and only then surfaced as a 429 the
 * provider chain moves past.
 */

import { log } from "./log.js";

export type ClaudeLimitKind = "rate_limit" | "billing";

export interface ClaudeLimitHit {
  kind: ClaudeLimitKind;
  /** When the limit lifts, epoch ms, if the CLI said. */
  resetsAt?: number;
  /** "five_hour", "seven_day", "seven_day_opus", … */
  limitType?: string;
  /** The CLI's own words. */
  detail: string;
}

/** The model a limited one is retried on. `CLAUDE_CODE_LIMIT_FALLBACK_MODEL=""` turns it off. */
const DEFAULT_FALLBACK_MODEL = "claude-fable-5-1";
/** How long a limit with no reset time keeps a model out. */
const UNKNOWN_RESET_MS = 60 * 60 * 1000;

export class ClaudeUsageLimitError extends Error {
  /** Work was already streamed or done before the limit hit — a retry would repeat it. */
  partial = false;

  constructor(readonly hit: ClaudeLimitHit, readonly model: string) {
    const what = hit.kind === "billing" ? "402 billing limit" : "429 usage limit";
    const resets = hit.resetsAt ? `, resets ${new Date(hit.resetsAt).toISOString()}` : "";
    super(
      `claude_code: ${what} reached on ${model} (${hit.limitType ?? hit.kind}${resets}) — quota exhausted. ${hit.detail}`.trim(),
    );
    this.name = "ClaudeUsageLimitError";
  }
}

function toMs(epoch: unknown): number | undefined {
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return undefined;
  // The CLI reports seconds; accept ms too.
  return epoch < 1e12 ? epoch * 1000 : epoch;
}

function assistantText(msg: Record<string, unknown>): string {
  const content = (msg.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
    .join("");
}

/**
 * Fed every SDK message of one query. Tells the caller which messages are the
 * limit notice (so their text is not taken as the answer) and, at the end,
 * whether the query died on a limit.
 */
export class ClaudeLimitObserver {
  private hitValue: ClaudeLimitHit | null = null;
  private resetsAt?: number;
  private limitType?: string;

  /** True when `msg` is (part of) the limit notice and must not count as output. */
  observe(msg: unknown): boolean {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as Record<string, unknown>;

    if (m.type === "rate_limit_event") {
      const info = m.rate_limit_info as { status?: string; resetsAt?: number; rateLimitType?: string } | undefined;
      if (info?.status === "rejected") {
        this.resetsAt = toMs(info.resetsAt) ?? this.resetsAt;
        this.limitType = info.rateLimitType ?? this.limitType;
        if (this.hitValue) this.enrich();
      }
      return false;
    }

    const notice = /^you['’]ve hit your (?:(?:weekly|monthly|daily|usage) )?limit\s*[·—-]\s*resets\b/i;
    if (m.type === "assistant" && (m.error === "rate_limit" || m.error === "billing_error" || notice.test(assistantText(m).trim()))) {
      this.record(m.error === "billing_error" ? "billing" : "rate_limit", assistantText(m));
      return true;
    }

    if (m.type === "result" && m.is_error === true) {
      const status = m.api_error_status;
      if (status === 429 || status === 402 || this.hitValue || (typeof m.result === "string" && notice.test(m.result.trim()))) {
        const text = typeof m.result === "string" ? m.result : "";
        this.record(status === 402 ? "billing" : "rate_limit", text);
        return true;
      }
    }
    return false;
  }

  get hit(): ClaudeLimitHit | null {
    return this.hitValue;
  }

  private record(kind: ClaudeLimitKind, detail: string): void {
    if (!this.hitValue) this.hitValue = { kind, detail: detail.trim() };
    else if (!this.hitValue.detail && detail.trim()) this.hitValue.detail = detail.trim();
    if (kind === "billing") this.hitValue.kind = "billing";
    this.enrich();
  }

  private enrich(): void {
    if (!this.hitValue) return;
    if (this.resetsAt) this.hitValue.resetsAt = this.resetsAt;
    if (this.limitType) this.hitValue.limitType = this.limitType;
  }
}

// One map for the kernel and every extension bundle that carries a copy of
// this file — otherwise chat and agents would each rediscover the same limit.
const LIMITS_KEY = Symbol.for("kernl.claudeCodeLimitedModels");
const DETAILS_KEY = Symbol.for("kernl.claudeCodeLimitDetails");
function limitDetails(): Map<string, ClaudeLimitHit> {
  const g = globalThis as unknown as Record<symbol, Map<string, ClaudeLimitHit> | undefined>;
  return (g[DETAILS_KEY] ??= new Map<string, ClaudeLimitHit>());
}

/** Diagnostic view, including the short aliases used by the global chain. */
export function getClaudeModelLimit(model: string, now: number = Date.now()): (ClaudeLimitHit & { blockedUntil: number }) | null {
  const candidates = [model];
  if (/^(sonnet|opus|haiku|fable)$/.test(model)) {
    candidates.push(...[...limited().keys()].filter((key) => key.startsWith(`claude-${model}-`)));
  }
  for (const key of candidates) {
    if (!isClaudeModelLimited(key, now)) continue;
    const hit = limitDetails().get(key);
    return { kind: hit?.kind ?? "rate_limit", detail: hit?.detail ?? "Usage limit reached", ...hit, blockedUntil: limited().get(key)! };
  }
  return null;
}
function limited(): Map<string, number> {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  return (g[LIMITS_KEY] ??= new Map<string, number>());
}

/** Keep `model` out until its limit lifts. */
export function rememberClaudeLimit(model: string, hit: ClaudeLimitHit, now: number = Date.now()): void {
  const until = hit.resetsAt && hit.resetsAt > now ? hit.resetsAt : now + UNKNOWN_RESET_MS;
  limited().set(model, until);
  limitDetails().set(model, { ...hit });
}

export function isClaudeModelLimited(model: string, now: number = Date.now()): boolean {
  const until = limited().get(model);
  if (until === undefined) return false;
  if (now >= until) {
    limited().delete(model);
    return false;
  }
  return true;
}

export function clearClaudeLimits(): void {
  limited().clear();
  limitDetails().clear();
}

function fallbackModel(): string {
  const env = process.env.CLAUDE_CODE_LIMIT_FALLBACK_MODEL;
  return env === undefined ? DEFAULT_FALLBACK_MODEL : env.trim();
}

/** The model to retry a limited one on, or null when there is none left. */
export function claudeLimitFallback(model: string, now: number = Date.now()): string | null {
  const next = fallbackModel();
  if (!next || next === model || /fable/i.test(model)) return null;
  return isClaudeModelLimited(next, now) ? null : next;
}

/** `requested`, or its fallback while `requested` is known to be limited. */
export function routeAroundClaudeLimit(requested: string, now: number = Date.now()): string {
  if (!isClaudeModelLimited(requested, now)) return requested;
  return claudeLimitFallback(requested, now) ?? requested;
}

/**
 * Run `attempt` on `requested` (or on its fallback while it is limited); on a
 * usage limit, remember it and run once more on the fallback model. A limit
 * that hit after work was done (`partial`) is not retried.
 */
export async function withClaudeLimitFallback<T>(
  requested: string,
  attempt: (model: string) => Promise<T>,
): Promise<T> {
  const first = routeAroundClaudeLimit(requested);
  try {
    return await attempt(first);
  } catch (err) {
    if (!(err instanceof ClaudeUsageLimitError)) throw err;
    rememberClaudeLimit(first, err.hit);
    const next = err.partial ? null : claudeLimitFallback(first);
    if (!next) throw err;
    log.warn(`Claude Code: usage limit on ${first} — retrying on ${next}`);
    try {
      return await attempt(next);
    } catch (err2) {
      if (err2 instanceof ClaudeUsageLimitError) rememberClaudeLimit(next, err2.hit);
      throw err2;
    }
  }
}
