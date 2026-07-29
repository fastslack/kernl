/**
 * SQLite-backed audit log of EVERY LLM call routed through `LlmClient`.
 *
 * One row per chatOnce() — success or fail. Purpose:
 *
 *   - Diagnose "why did Grok burn through credit last night" without
 *     guessing — every call is there with timestamp + caller + tokens.
 *   - Spot the EmailTriage agent that's looping on an error.
 *   - Estimate per-day cost by joining slug/model + token counts.
 *   - Provide the data behind a future "Recent calls" panel in /models.
 *
 * Same loose-coupling pattern as `provider-health`: `attachDb()` opens
 * the table and switches recording on; without it, `record()` is a
 * no-op so tests stay self-contained.
 *
 * Retention: bounded by row count (KEEP_LAST). Beyond that, oldest rows
 * are pruned in batches — much cheaper than per-row DELETE. Per-day
 * cleanup tasks elsewhere can do further aggregation if needed.
 */

import { log } from "../logger.js";
import type { SqliteDb } from "../db/sqlite.js";

export interface LlmCallRecord {
  slug: string;            // logical provider slug (grok, claude, nvidia, …)
  model: string;
  ok: boolean;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  errorKind?: string;      // exhausted / auth / rate-limit / transient
  errorMsg?: string;       // truncated to 500 chars on insert
  caller?: string;         // free-form ("email-triage", "agent:foo", "probe", "subs-translate", …)
  startedAt: number;       // epoch ms
}

const KEEP_LAST = 5_000;
const PRUNE_EVERY = 500;   // after this many inserts, sweep down to KEEP_LAST

// Same globalThis pattern as provider-health: extensions bundle this
// module independently, but we need ONE shared DB handle (set by the
// kernel at boot) so every call across kernel + extension bundles lands
// in the same llm_call_log table.
interface CallLogGlobals {
  __mtwLlmCallLogDb?: SqliteDb | null;
  __mtwLlmCallLogInsertsSincePrune?: number;
}
const G = globalThis as CallLogGlobals;
function db(): SqliteDb | null { return G.__mtwLlmCallLogDb ?? null; }

export function attachDb(db: SqliteDb): void {
  G.__mtwLlmCallLogDb = db;
  db.exec(
    "CREATE TABLE IF NOT EXISTS llm_call_log (\n" +
      "  id            INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
      "  slug          TEXT NOT NULL,\n" +
      "  model         TEXT NOT NULL,\n" +
      "  ok            INTEGER NOT NULL,\n" +
      "  latency_ms    INTEGER NOT NULL,\n" +
      "  input_tokens  INTEGER,\n" +
      "  output_tokens INTEGER,\n" +
      "  error_kind    TEXT,\n" +
      "  error_msg     TEXT,\n" +
      "  caller        TEXT,\n" +
      "  started_at    INTEGER NOT NULL\n" +
      ")",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_llm_call_log_started ON llm_call_log(started_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_llm_call_log_slug    ON llm_call_log(slug, started_at DESC)");
}

/**
 * Record one LLM call. Cheap — single INSERT, periodic prune. Always
 * also emits a kernel log line so the audit trail survives even if the
 * DB write fails or the table got dropped.
 */
export function record(r: LlmCallRecord): void {
  const tag = r.caller ? `${r.slug}/${shortModel(r.model)}·${r.caller}` : `${r.slug}/${shortModel(r.model)}`;
  if (r.ok) {
    log.info(`LlmCall ✓ ${tag} ${r.latencyMs}ms ${tokenSummary(r)}`);
  } else {
    const errSnippet = (r.errorMsg ?? "").slice(0, 120).replace(/\s+/g, " ");
    log.warn(`LlmCall ✗ ${tag} ${r.latencyMs}ms [${r.errorKind ?? "?"}] ${errSnippet}`);
  }
  const currentDb = db();
  if (!currentDb) return;
  try {
    currentDb
      .prepare(
        "INSERT INTO llm_call_log " +
          "(slug, model, ok, latency_ms, input_tokens, output_tokens, error_kind, error_msg, caller, started_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        r.slug,
        r.model,
        r.ok ? 1 : 0,
        r.latencyMs,
        r.inputTokens ?? null,
        r.outputTokens ?? null,
        r.errorKind ?? null,
        (r.errorMsg ?? "").slice(0, 500) || null,
        r.caller ?? null,
        r.startedAt,
      );
    G.__mtwLlmCallLogInsertsSincePrune = (G.__mtwLlmCallLogInsertsSincePrune ?? 0) + 1;
    if ((G.__mtwLlmCallLogInsertsSincePrune ?? 0) >= PRUNE_EVERY) prune();
  } catch (err) {
    log.warn(`LlmCallLog: persist failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Drop rows older than the most-recent KEEP_LAST. Idempotent. */
function prune(): void {
  const currentDb = db();
  if (!currentDb) return;
  G.__mtwLlmCallLogInsertsSincePrune = 0;
  try {
    currentDb
      .prepare(
        "DELETE FROM llm_call_log WHERE id NOT IN (SELECT id FROM llm_call_log ORDER BY id DESC LIMIT ?)",
      )
      .run(KEEP_LAST);
  } catch { /* ignore */ }
}

/** Read recent call log entries — for the /api/llm/calls endpoint. */
export interface RecentCallsQuery {
  limit?: number;
  slug?: string;
  okOnly?: boolean;
  failOnly?: boolean;
}
export function recent(q: RecentCallsQuery = {}): LlmCallRecord[] {
  const currentDb = db();
  if (!currentDb) return [];
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.slug)     { where.push("slug = ?"); params.push(q.slug); }
  if (q.okOnly)   { where.push("ok = 1"); }
  if (q.failOnly) { where.push("ok = 0"); }
  const sql =
    "SELECT slug, model, ok, latency_ms, input_tokens, output_tokens, error_kind, error_msg, caller, started_at " +
    "FROM llm_call_log " +
    (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
    "ORDER BY id DESC LIMIT ?";
  params.push(limit);
  return (currentDb.prepare(sql).all(...params) as Array<Record<string, unknown>>).map((row) => ({
    slug: row.slug as string,
    model: row.model as string,
    ok: !!row.ok,
    latencyMs: row.latency_ms as number,
    inputTokens: (row.input_tokens as number | null) ?? undefined,
    outputTokens: (row.output_tokens as number | null) ?? undefined,
    errorKind: (row.error_kind as string | null) ?? undefined,
    errorMsg: (row.error_msg as string | null) ?? undefined,
    caller: (row.caller as string | null) ?? undefined,
    startedAt: row.started_at as number,
  }));
}

function shortModel(m: string): string {
  if (!m) return "?";
  const tail = m.split("/").pop() ?? m;
  return tail.length > 28 ? tail.slice(0, 27) + "…" : tail;
}

function tokenSummary(r: LlmCallRecord): string {
  const i = r.inputTokens, o = r.outputTokens;
  if (i === undefined && o === undefined) return "";
  return `in=${i ?? "?"} out=${o ?? "?"}`;
}
