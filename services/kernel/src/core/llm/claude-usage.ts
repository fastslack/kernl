/**
 * How much of each Claude subscription is used: the 5-hour window, the week, and each model's own week, as
 * percentages with their reset times — what the CLI's `/usage` shows, per connected account.
 *
 * Read through the Agent SDK's `/usage` control request (experimental in the SDK): a session is opened on the
 * account's own config dir and asked for its plan usage, without sending the model anything — no tokens, about
 * half a second per account. Cached per account for CACHE_MS so a dashboard that polls costs one read every few
 * minutes; `force` reads again now.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { findClaudeCli, claudeAuthEnv } from "../../sdk/claude-cli.js";
import { log } from "../logger.js";

export interface UsageWindow {
  /** "session" (the 5-hour window), "weekly" (all models), "model" (one model's own weekly share). */
  key: "session" | "weekly" | "model";
  /** For key "model": its name ("Fable"). */
  model?: string;
  /** 0–100. */
  pct: number;
  severity: "normal" | "warning" | "critical";
  /** ISO time it resets, or null when the window is not running. */
  resetsAt: string | null;
  /** This window is full and stopping the account (a model's window: stopping that model). */
  blocking: boolean;
}

export interface ClaudeAccountUsage {
  plan: string | null;
  windows: UsageWindow[];
  /** When it was read (ISO). */
  at: string;
  /** Why there are no windows. */
  error?: string;
}

const CACHE_MS = 3 * 60_000;
const TIMEOUT_MS = 20_000;

const iso = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const pctOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
const severityOf = (v: unknown, pct: number): UsageWindow["severity"] =>
  v === "critical" || v === "warning" || v === "normal" ? v : pct >= 100 ? "critical" : pct >= 80 ? "warning" : "normal";

/** The `/usage` answer, as windows. Exported for tests. */
export function parseClaudeUsage(r: unknown): ClaudeAccountUsage {
  const at = new Date().toISOString();
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const plan = typeof o.subscription_type === "string" ? o.subscription_type : null;
  const rl = o.rate_limits && typeof o.rate_limits === "object" ? (o.rate_limits as Record<string, unknown>) : null;
  if (!o.rate_limits_available || !rl) return { plan, windows: [], at, error: "Esta sesión no tiene límites de plan (clave de API o sin perfil)" };

  const windows: UsageWindow[] = [];
  if (Array.isArray(rl.limits)) {
    for (const raw of rl.limits) {
      if (!raw || typeof raw !== "object") continue;
      const l = raw as Record<string, unknown>;
      const pct = pctOf(l.percent);
      if (pct === null) continue;
      const kind = l.kind === "session" ? "session" : l.kind === "weekly_all" ? "weekly" : l.kind === "weekly_scoped" ? "model" : null;
      if (!kind) continue;
      const scope = l.scope as { model?: { display_name?: unknown } } | null | undefined;
      const model = kind === "model" && typeof scope?.model?.display_name === "string" ? scope.model.display_name : undefined;
      windows.push({ key: kind, ...(model ? { model } : {}), pct, severity: severityOf(l.severity, pct), resetsAt: iso(l.resets_at), // `is_active` marks the window the account is being counted against right now, not a stop: dev at 75% of
      // its 5 hours came back active. Only a full window stops it; a model's own week only stops that model.
      blocking: pct >= 100 && (kind !== "model" || l.is_active === true) });
    }
  } else {
    for (const [key, field] of [["session", "five_hour"], ["weekly", "seven_day"]] as const) {
      const w = rl[field] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
      const pct = pctOf(w?.utilization);
      if (pct === null) continue;
      windows.push({ key, pct, severity: severityOf(undefined, pct), resetsAt: iso(w?.resets_at), blocking: pct >= 100 });
    }
  }
  return { plan, windows, at };
}

const cache = new Map<string, { at: number; usage: ClaudeAccountUsage }>();
const pending = new Map<string, Promise<ClaudeAccountUsage>>();

/** One account's plan usage (cached for a few minutes; `force` reads it again). Never throws. */
export async function claudeAccountUsage(accountId: string, force = false): Promise<ClaudeAccountUsage> {
  const hit = cache.get(accountId);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.usage;
  const inFlight = pending.get(accountId);
  if (inFlight) return inFlight;
  const p = readUsage(accountId).then((usage) => {
    // A failed read keeps showing the last good one, marked with the error.
    const shown = usage.error && hit && hit.usage.windows.length ? { ...hit.usage, error: usage.error } : usage;
    cache.set(accountId, { at: Date.now(), usage: shown });
    return shown;
  }).finally(() => pending.delete(accountId));
  pending.set(accountId, p);
  return p;
}

async function readUsage(accountId: string): Promise<ClaudeAccountUsage> {
  const at = new Date().toISOString();
  const bin = findClaudeCli();
  if (!bin) return { plan: null, windows: [], at, error: "No está instalado el CLI de Claude Code" };
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  // Streaming input that never sends a message: the session opens, answers the control request, and closes.
  async function* idle() { await done; }
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "kernl-usage/0.1", ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined };
  if (process.env.HOST_HOME) env.HOME = process.env.HOST_HOME;
  Object.assign(env, claudeAuthEnv({ accountId }));
  const q = query({ prompt: idle(), options: { maxTurns: 1, persistSession: false, settingSources: [], allowedTools: [], pathToClaudeCodeExecutable: bin, env } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ask = (q as unknown as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<unknown> })
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof ask !== "function") return { plan: null, windows: [], at, error: "Esta versión del SDK no informa el uso del plan" };
    const r = await Promise.race([
      ask.call(q, { skipBehaviors: true }),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("no respondió a tiempo")), TIMEOUT_MS); }),
    ]);
    return parseClaudeUsage(r);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.debug(`claude usage (${accountId}): ${msg}`);
    return { plan: null, windows: [], at, error: `No se pudo leer el uso: ${msg.slice(0, 160)}` };
  } finally {
    clearTimeout(timer);
    release();
    try { await (q as unknown as { interrupt?: () => Promise<void> }).interrupt?.(); } catch { /* already closed */ }
  }
}
