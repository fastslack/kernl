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

import { isClaudeAccountConnected, listClaudeAccounts, primaryClaudeAccountId } from "./claude-accounts.js";
import { log } from "./log.js";
import { CLAUDE_LIMIT_WAITING } from "./claude-access.js";

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

/**
 * A run stopped by the subscription's usage limit: cut mid-work
 * (ClaudeUsageLimitError) or kept waiting for the reset (CLAUDE_LIMIT_WAITING).
 * Nothing about the run's work is wrong, so it must not count against it.
 */
export function isClaudeUsageLimitStop(message: string | null | undefined): boolean {
  if (!message) return false;
  return message.startsWith(CLAUDE_LIMIT_WAITING) || /^claude_code: 429 usage limit reached\b/.test(message);
}

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
// ".v2": the key format changed to "<account>|<model>"; bundles still carrying
// the old copy of this file must not read or write this map.
const LIMITS_KEY = Symbol.for("kernl.claudeCodeLimits.v2");
const DETAILS_KEY = Symbol.for("kernl.claudeCodeLimitDetails.v2");
function limitDetails(): Map<string, ClaudeLimitHit> {
  const g = globalThis as unknown as Record<symbol, Map<string, ClaudeLimitHit> | undefined>;
  return (g[DETAILS_KEY] ??= new Map<string, ClaudeLimitHit>());
}

function limited(): Map<string, number> {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  return (g[LIMITS_KEY] ??= new Map<string, number>());
}

// Accounts whose CLI session failed (expired, revoked) while a run rotated
// onto them, epoch ms until which they are skipped. Same sharing as above.
const DOWN_KEY = Symbol.for("kernl.claudeCodeAccountsDown.v2");
/** How long an account whose session failed stays out of rotation. */
const ACCOUNT_DOWN_MS = 10 * 60 * 1000;
function accountsDown(): Map<string, number> {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  return (g[DOWN_KEY] ??= new Map<string, number>());
}

/**
 * Keep `accountId` out of rotation for a while: its credentials file is there
 * (so it reads as connected) but the CLI could not use the session. Without
 * this every run would keep landing on it while the primary is limited.
 */
export function rememberClaudeAccountDown(accountId: string, now: number = Date.now(), ttlMs: number = ACCOUNT_DOWN_MS): void {
  accountsDown().set(accountId, now + ttlMs);
}

export function isClaudeAccountDown(accountId: string, now: number = Date.now()): boolean {
  const until = accountsDown().get(accountId);
  if (until === undefined) return false;
  if (now >= until) {
    accountsDown().delete(accountId);
    return false;
  }
  return true;
}

const FABLE_MODEL = /fable/i;
const MODEL_FAMILY_LIMIT = /opus|sonnet|haiku|fable/i;

/** The short family names the global chain uses for a Claude model ("sonnet"). */
const FAMILY_ALIAS = /^(sonnet|opus|haiku|fable)$/;
export function isClaudeFamilyAlias(model: string): boolean {
  return FAMILY_ALIAS.test(model);
}

/**
 * Whether `model` is the model `wanted` names: the same id, or — when
 * `wanted` is a bare family alias — a full id of that family
 * ("sonnet" → "claude-sonnet-5-5", never "claude-opus-5-5").
 */
export function claudeModelMatches(wanted: string, model: string): boolean {
  return model === wanted || (isClaudeFamilyAlias(wanted) && model.startsWith(`claude-${wanted}-`));
}

/**
 * Accounts a run could actually use: connected and not marked down. With none
 * (fresh install, tests) the primary still stands in, so limits keep working on it.
 */
function connectedAccountIds(now: number = Date.now()): string[] {
  const ids = listClaudeAccounts()
    .map((a) => a.id)
    .filter((id) => isClaudeAccountConnected(id) && !isClaudeAccountDown(id, now));
  return ids.length > 0 ? ids : [primaryClaudeAccountId()];
}

/**
 * The stored key that keeps `model` out of `accountId`, if any. `<acc>|*` is
 * the subscription-wide limit (5-hour, weekly, unknown): it blocks every model
 * but Fable, whose weekly bucket is its own.
 */
function blockingKey(accountId: string, model: string, now: number): string | null {
  const keys = FABLE_MODEL.test(model) ? [`${accountId}|${model}`] : [`${accountId}|*`, `${accountId}|${model}`];
  for (const key of keys) {
    const until = limited().get(key);
    if (until === undefined) continue;
    if (now >= until) {
      limited().delete(key);
      continue;
    }
    return key;
  }
  return null;
}

function limitOn(accountId: string, model: string, now: number): (ClaudeLimitHit & { blockedUntil: number }) | null {
  const candidates = [model];
  if (isClaudeFamilyAlias(model)) {
    const prefix = `${accountId}|`;
    candidates.push(...[...limited().keys()]
      .filter((key) => key.startsWith(prefix) && key.slice(prefix.length) !== model && claudeModelMatches(model, key.slice(prefix.length)))
      .map((key) => key.slice(prefix.length)));
  }
  for (const candidate of candidates) {
    const key = blockingKey(accountId, candidate, now);
    if (!key) continue;
    const hit = limitDetails().get(key);
    return { kind: hit?.kind ?? "rate_limit", detail: hit?.detail ?? "Usage limit reached", ...hit, blockedUntil: limited().get(key)! };
  }
  return null;
}

/**
 * Diagnostic view, including the short aliases used by the global chain. With
 * an account: that account. Without: only when every connected account is
 * limited, reported by the one that frees up first.
 */
export function getClaudeModelLimit(model: string, now: number = Date.now(), accountId?: string): (ClaudeLimitHit & { blockedUntil: number }) | null {
  if (accountId !== undefined) return limitOn(accountId, model, now);
  let earliest: (ClaudeLimitHit & { blockedUntil: number }) | null = null;
  for (const id of connectedAccountIds(now)) {
    const l = limitOn(id, model, now);
    if (!l) return null;
    if (!earliest || l.blockedUntil < earliest.blockedUntil) earliest = l;
  }
  return earliest;
}

/**
 * Keep `model` out of the account until its limit lifts. Model-specific hits
 * (a family named in `limitType`, no `limitType` at all, or any hit seen on a
 * Fable model) are stored per model; the rest block the account as a whole. Default account: the primary.
 */
export function rememberClaudeLimit(model: string, hit: ClaudeLimitHit, now: number = Date.now(), accountId: string = primaryClaudeAccountId()): void {
  const until = hit.resetsAt && hit.resetsAt > now ? hit.resetsAt : now + UNKNOWN_RESET_MS;
  // No limitType at all stays per model (the pre-accounts behaviour, pinned by
  // the diagnostics tests); only a named non-family type is known to be account-wide.
  const specific = FABLE_MODEL.test(model) || !hit.limitType || MODEL_FAMILY_LIMIT.test(hit.limitType);
  const key = `${accountId}|${specific ? model : "*"}`;
  limited().set(key, until);
  limitDetails().set(key, { ...hit });
}

export function isClaudeModelLimited(model: string, now: number = Date.now(), accountId: string = primaryClaudeAccountId()): boolean {
  if (isClaudeFamilyAlias(model)) return limitOn(accountId, model, now) !== null;
  return blockingKey(accountId, model, now) !== null;
}

/** Live limits on one account for the dashboard: `model` is "*" for the whole subscription. */
export function listClaudeLimits(accountId: string, now: number = Date.now()): Array<{ model: string; blockedUntil: number; detail: string }> {
  const prefix = `${accountId}|`;
  const out: Array<{ model: string; blockedUntil: number; detail: string }> = [];
  for (const [key, until] of limited()) {
    if (!key.startsWith(prefix) || now >= until) continue;
    out.push({ model: key.slice(prefix.length), blockedUntil: until, detail: limitDetails().get(key)?.detail ?? "" });
  }
  return out.sort((x, y) => x.model.localeCompare(y.model));
}

export function clearClaudeLimits(): void {
  limited().clear();
  limitDetails().clear();
  accountsDown().clear();
}

function fallbackModel(): string {
  const env = process.env.CLAUDE_CODE_LIMIT_FALLBACK_MODEL;
  return env === undefined ? DEFAULT_FALLBACK_MODEL : env.trim();
}

/** The configured fallback for `model`, before any limit check. */
function fallbackCandidate(model: string): string | null {
  const next = fallbackModel();
  if (!next || next === model || /fable/i.test(model)) return null;
  return next;
}

/** The model to retry a limited one on, or null when there is none left. */
export function claudeLimitFallback(model: string, now: number = Date.now(), accountId?: string): string | null {
  const next = fallbackCandidate(model);
  if (!next) return null;
  return isClaudeModelLimited(next, now, accountId) ? null : next;
}

/**
 * Where to run `requested`: the first connected account (list order) not
 * limited on it, then the same for its fallback. Null when every route is out.
 */
export function pickClaudeRoute(requested: string, now: number = Date.now()): { accountId: string; model: string } | null {
  const fallback = fallbackCandidate(requested);
  const models = fallback ? [requested, fallback] : [requested];
  const accounts = connectedAccountIds(now);
  for (const model of models) {
    for (const accountId of accounts) {
      if (!isClaudeModelLimited(model, now, accountId)) return { accountId, model };
    }
  }
  return null;
}

/** `requested`, or its fallback while `requested` is known to be limited. */
export function routeAroundClaudeLimit(requested: string, now: number = Date.now()): string {
  if (!isClaudeModelLimited(requested, now)) return requested;
  return claudeLimitFallback(requested, now) ?? requested;
}

/** Where one attempt of a call runs. */
export interface ClaudeRoute {
  accountId: string;
  model: string;
}

/**
 * Thrown by an attempt whose account's CLI session could not be used (expired,
 * revoked). With other accounts connected the call moves on and the account
 * sits out for a while; with none it surfaces as `cause`.
 */
export class ClaudeAccountSessionError extends Error {
  constructor(message: string, readonly accountId: string) {
    super(message);
    this.name = "ClaudeAccountSessionError";
  }
}

/**
 * Run `attempt` across the subscription accounts: the first connected account
 * not limited on `requested`, then the next one each time an attempt hits a
 * usage limit, and only once every account is out on `requested`, its
 * fallback model (pickClaudeRoute's order). Each limit is remembered on the
 * account that hit it, so the next call starts on an account still free.
 *
 * `pinnedAccount` keeps every attempt on that account (only the model may
 * change), for a caller that deliberately addresses one subscription.
 *
 * Not retried: a limit that hit after work was streamed (`partial`) and any
 * error that is not a limit or a dead session. When no route is left the last
 * limit error is thrown, which the provider chain treats as exhausted.
 */
export async function withClaudeAccountRotation<T>(
  requested: string,
  attempt: (route: ClaudeRoute) => Promise<T>,
  opts: { pinnedAccount?: string; now?: () => number; onMove?: (from: ClaudeRoute, to: ClaudeRoute, reason: string) => void } = {},
): Promise<T> {
  const now = opts.now ?? Date.now;
  const pinned = opts.pinnedAccount;
  const next = (): ClaudeRoute | null => {
    if (pinned !== undefined) {
      if (!isClaudeModelLimited(requested, now(), pinned)) return { accountId: pinned, model: requested };
      const model = claudeLimitFallback(requested, now(), pinned);
      return model ? { accountId: pinned, model } : null;
    }
    return pickClaudeRoute(requested, now());
  };
  // Nothing known to be free: try the first route anyway, the CLI has the last word.
  let route: ClaudeRoute = next()
    ?? (pinned !== undefined
      ? { accountId: pinned, model: requested }
      : { accountId: primaryClaudeAccountId(), model: routeAroundClaudeLimit(requested, now()) });
  const tried = new Set<string>();
  for (;;) {
    tried.add(`${route.accountId}|${route.model}`);
    let reason: string;
    try {
      return await attempt(route);
    } catch (err) {
      if (err instanceof ClaudeUsageLimitError) {
        rememberClaudeLimit(route.model, err.hit, now(), route.accountId);
        if (err.partial) throw err;
        reason = `usage limit (${err.hit.limitType ?? err.hit.kind})`;
      } else if (err instanceof ClaudeAccountSessionError && pinned === undefined && listClaudeAccounts().length > 1) {
        rememberClaudeAccountDown(route.accountId, now());
        reason = "session unusable";
      } else {
        throw err;
      }
      const to = next();
      if (!to || tried.has(`${to.accountId}|${to.model}`)) throw err;
      log.warn(`Claude Code: ${reason} on account ${route.accountId} / ${route.model} — retrying on ${to.accountId} / ${to.model}`);
      opts.onMove?.(route, to, reason);
      route = to;
    }
  }
}

/**
 * Run `attempt` on `requested` (or on its fallback while it is limited); on a
 * usage limit, remember it and run once more on the fallback model. A limit
 * that hit after work was done (`partial`) is not retried. Primary account
 * only — callers that can run on any account use withClaudeAccountRotation.
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
