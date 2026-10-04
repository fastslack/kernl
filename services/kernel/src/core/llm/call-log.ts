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
 * are pruned in batches — much cheaper than per-row DELETE. Totals survive
 * the prune: every record() also bumps `llm_usage_daily`, one row per
 * (UTC day, slug, model, caller), which is what `usage()` reads.
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
  /** Prompt tokens served from / written to the provider's prompt cache. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Cost the provider itself reported (Claude Code does); never estimated here. */
  costUsd?: number;
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
  const cols = new Set(
    (db.prepare("SELECT name FROM pragma_table_info('llm_call_log')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [col, type] of [
    ["cache_read_tokens", "INTEGER"],
    ["cache_write_tokens", "INTEGER"],
    ["cost_usd", "REAL"],
  ] as const) {
    if (!cols.has(col)) db.exec(`ALTER TABLE llm_call_log ADD COLUMN ${col} ${type}`);
  }

  db.exec(
    "CREATE TABLE IF NOT EXISTS llm_usage_daily (\n" +
      "  day                TEXT NOT NULL,\n" +
      "  slug               TEXT NOT NULL,\n" +
      "  model              TEXT NOT NULL,\n" +
      "  caller             TEXT NOT NULL,\n" +
      "  calls              INTEGER NOT NULL DEFAULT 0,\n" +
      "  fails              INTEGER NOT NULL DEFAULT 0,\n" +
      "  input_tokens       INTEGER NOT NULL DEFAULT 0,\n" +
      "  output_tokens      INTEGER NOT NULL DEFAULT 0,\n" +
      "  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,\n" +
      "  cache_write_tokens INTEGER NOT NULL DEFAULT 0,\n" +
      "  cost_usd           REAL NOT NULL DEFAULT 0,\n" +
      "  PRIMARY KEY (day, slug, model, caller)\n" +
      ")",
  );
  // First attach after the rollup existed: seed it from whatever the call
  // log still holds, so the panel doesn't start from zero.
  const seeded = (db.prepare("SELECT COUNT(*) AS n FROM llm_usage_daily").get() as { n: number }).n > 0;
  if (!seeded) {
    db.exec(
      "INSERT INTO llm_usage_daily " +
        "(day, slug, model, caller, calls, fails, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) " +
        "SELECT date(started_at / 1000, 'unixepoch'), slug, model, COALESCE(caller, ''), " +
        "COUNT(*), SUM(ok = 0), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), " +
        "COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0), COALESCE(SUM(cost_usd), 0) " +
        "FROM llm_call_log GROUP BY 1, 2, 3, 4",
    );
  }
}

/**
 * Record one LLM call. Cheap — single INSERT, periodic prune. Also emits
 * a kernel log line so the audit trail survives even if the DB write
 * fails or the table got dropped; `silent` skips it for callers that
 * already log the call through llm/logger.
 */
export function record(r: LlmCallRecord, opts: { silent?: boolean } = {}): void {
  if (!opts.silent) logCall(r);
  persist(r);
}

function logCall(r: LlmCallRecord): void {
  const tag = r.caller ? `${r.slug}/${shortModel(r.model)}·${r.caller}` : `${r.slug}/${shortModel(r.model)}`;
  if (r.ok) {
    log.info(`LlmCall ✓ ${tag} ${r.latencyMs}ms ${tokenSummary(r)}`);
  } else {
    const errSnippet = (r.errorMsg ?? "").slice(0, 120).replace(/\s+/g, " ");
    log.warn(`LlmCall ✗ ${tag} ${r.latencyMs}ms [${r.errorKind ?? "?"}] ${errSnippet}`);
  }
}

function persist(r: LlmCallRecord): void {
  const currentDb = db();
  if (!currentDb) return;
  try {
    currentDb
      .prepare(
        "INSERT INTO llm_call_log " +
          "(slug, model, ok, latency_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, " +
          "error_kind, error_msg, caller, started_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        r.slug,
        r.model,
        r.ok ? 1 : 0,
        r.latencyMs,
        r.inputTokens ?? null,
        r.outputTokens ?? null,
        r.cacheReadTokens ?? null,
        r.cacheWriteTokens ?? null,
        r.costUsd ?? null,
        r.errorKind ?? null,
        (r.errorMsg ?? "").slice(0, 500) || null,
        r.caller ?? null,
        r.startedAt,
      );
    currentDb
      .prepare(
        "INSERT INTO llm_usage_daily " +
          "(day, slug, model, caller, calls, fails, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) " +
          "VALUES (date(? / 1000, 'unixepoch'), ?, ?, ?, 1, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (day, slug, model, caller) DO UPDATE SET " +
          "calls = calls + 1, fails = fails + excluded.fails, " +
          "input_tokens = input_tokens + excluded.input_tokens, " +
          "output_tokens = output_tokens + excluded.output_tokens, " +
          "cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, " +
          "cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens, " +
          "cost_usd = cost_usd + excluded.cost_usd",
      )
      .run(
        r.startedAt,
        r.slug,
        r.model,
        r.caller ?? "",
        r.ok ? 0 : 1,
        r.inputTokens ?? 0,
        r.outputTokens ?? 0,
        r.cacheReadTokens ?? 0,
        r.cacheWriteTokens ?? 0,
        r.costUsd ?? 0,
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
    "SELECT slug, model, ok, latency_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, " +
    "error_kind, error_msg, caller, started_at " +
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
    cacheReadTokens: (row.cache_read_tokens as number | null) ?? undefined,
    cacheWriteTokens: (row.cache_write_tokens as number | null) ?? undefined,
    costUsd: (row.cost_usd as number | null) ?? undefined,
    errorKind: (row.error_kind as string | null) ?? undefined,
    errorMsg: (row.error_msg as string | null) ?? undefined,
    caller: (row.caller as string | null) ?? undefined,
    startedAt: row.started_at as number,
  }));
}

/** Token totals from `llm_usage_daily`, grouped one way — for /api/llm/usage. */
export type UsageGroup = "model" | "slug" | "caller" | "day";
export interface UsageQuery {
  /** Inclusive UTC days, YYYY-MM-DD. Omitted → no bound. */
  from?: string;
  to?: string;
  group?: UsageGroup;
  slug?: string;
  model?: string;
}
/**
 * Where a row's dollars come from: the provider's own figure (Claude Code
 * reports one), an estimate from `llm_model_prices` (LiteLLM's table, input
 * and output only — cache tokens unpriced), or nothing when the model has no
 * price (local runtimes, free tiers, unlisted models).
 */
export type CostKind = "reported" | "estimated" | "mixed" | "none";
export interface UsageRow {
  key: string;
  /** Set when grouping by model: the provider that served it. */
  slug?: string;
  calls: number;
  fails: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costKind: CostKind;
}

type Price = { inputPerMTok: number; outputPerMTok: number };

/** Prices keyed `slug\0model`, lower-cased; empty when the table isn't there yet. */
function loadPrices(currentDb: SqliteDb): Map<string, Price> {
  const out = new Map<string, Price>();
  try {
    const rows = currentDb
      .prepare("SELECT provider, model, input_per_mtok, output_per_mtok FROM llm_model_prices")
      .all() as Array<{ provider: string; model: string; input_per_mtok: number; output_per_mtok: number }>;
    for (const r of rows) {
      out.set(`${r.provider}\0${r.model.toLowerCase()}`, { inputPerMTok: r.input_per_mtok, outputPerMTok: r.output_per_mtok });
    }
  } catch { /* prices not initialised — every row stays "none" */ }
  return out;
}

/** Providers answer with a dated id ("gpt-4.1-nano-2025-04-14"); the table lists the alias. */
function priceFor(prices: Map<string, Price>, slug: string, model: string): Price | undefined {
  const m = model.toLowerCase();
  return prices.get(`${slug}\0${m}`) ?? prices.get(`${slug}\0${m.replace(/-\d{4}-?\d{2}-?\d{2}$/, "")}`);
}

export function usage(q: UsageQuery = {}): UsageRow[] {
  const currentDb = db();
  if (!currentDb) return [];
  const group = q.group ?? "model";
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.from)  { where.push("day >= ?");   params.push(q.from); }
  if (q.to)    { where.push("day <= ?");   params.push(q.to); }
  if (q.slug)  { where.push("slug = ?");   params.push(q.slug); }
  if (q.model) { where.push("model = ?");  params.push(q.model); }
  // Always split by slug+model underneath: pricing is per model, whatever
  // the grouping the caller asked for.
  const keyCol = group === "model" ? "model" : group;
  const sql =
    `SELECT ${keyCol} AS k, slug, model, SUM(calls) calls, SUM(fails) fails, SUM(input_tokens) i, SUM(output_tokens) o, ` +
    "SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw, SUM(cost_usd) usd FROM llm_usage_daily " +
    (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
    `GROUP BY ${keyCol}, slug, model`;
  const prices = loadPrices(currentDb);
  const folded = new Map<string, UsageRow & { kinds: Set<"reported" | "estimated" | "none"> }>();
  for (const row of currentDb.prepare(sql).all(...params) as Array<Record<string, unknown>>) {
    const slug = String(row.slug);
    const id = group === "model" ? `${slug}\0${row.k}` : String(row.k ?? "");
    let acc = folded.get(id);
    if (!acc) {
      acc = {
        key: String(row.k ?? ""),
        ...(group === "model" ? { slug } : {}),
        calls: 0, fails: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        costUsd: 0, costKind: "none", kinds: new Set(),
      };
      folded.set(id, acc);
    }
    const i = Number(row.i) || 0;
    const o = Number(row.o) || 0;
    const reported = Number(row.usd) || 0;
    acc.calls += Number(row.calls) || 0;
    acc.fails += Number(row.fails) || 0;
    acc.inputTokens += i;
    acc.outputTokens += o;
    acc.cacheReadTokens += Number(row.cr) || 0;
    acc.cacheWriteTokens += Number(row.cw) || 0;
    if (reported > 0) {
      acc.costUsd += reported;
      acc.kinds.add("reported");
    } else if (i + o > 0) {
      const p = priceFor(prices, slug, String(row.model));
      if (p) {
        acc.costUsd += (i * p.inputPerMTok + o * p.outputPerMTok) / 1e6;
        acc.kinds.add("estimated");
      } else {
        acc.kinds.add("none");
      }
    }
  }
  const total = (r: UsageRow) => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
  const rows = [...folded.values()].map(({ kinds, ...r }) => {
    const priced = [...kinds].filter((k) => k !== "none");
    const costKind: CostKind = priced.length === 0 ? "none" : priced.length > 1 || kinds.has("none") ? "mixed" : priced[0];
    return { ...r, costKind };
  });
  return group === "day"
    ? rows.sort((a, b) => a.key.localeCompare(b.key))
    : rows.sort((a, b) => total(b) - total(a));
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
