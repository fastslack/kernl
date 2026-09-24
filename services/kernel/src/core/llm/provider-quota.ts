/**
 * Quota-exhaustion tracking for chat providers: an in-memory set, persisted to
 * the `provider_status` table so a provider that ran out of credit stays out of
 * rotation for the rest of the day, across restarts.
 */
import { log } from "../logger.js";
import type { SqliteDb } from "../db/sqlite.js";
import { runMigrations, type Migration } from "../db/migrations.js";
import * as providerHealth from "./provider-health.js";

/** Providers that have hit their quota (429/402). Persisted to DB + in-memory cache. */
const _quotaExhausted = new Set<string>();
let _dbRef: SqliteDb | null = null;

/**
 * Schema for the `provider_status` quota-tracking table. Run via the shared
 * migration runner under module "llm" (previously a raw `CREATE TABLE IF NOT
 * EXISTS` exec inside initProviderStatus). `IF NOT EXISTS` is kept so
 * pre-existing databases created by the old raw exec migrate cleanly.
 */
export const providerStatusMigrations: Migration[] = [
  {
    version: 1,
    sql: `CREATE TABLE IF NOT EXISTS provider_status (
    name TEXT PRIMARY KEY,
    exhausted INTEGER NOT NULL DEFAULT 0,
    exhausted_at TEXT,
    daily_budget_tokens INTEGER NOT NULL DEFAULT 0,
    tokens_used_today INTEGER NOT NULL DEFAULT 0,
    budget_date TEXT NOT NULL DEFAULT ''
  )`,
  },
];

/** Connect the quota tracker to the SQLite database for persistence across requests. */
export function initProviderStatus(db: SqliteDb): void {
  _dbRef = db;
  // Create table if missing
  runMigrations(db, "llm", providerStatusMigrations);
  // Load persisted state — only consider exhausted if same day (auto-reset daily)
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare("SELECT name, exhausted, budget_date FROM provider_status").all() as Array<{ name: string; exhausted: number; budget_date: string }>;
  for (const r of rows) {
    if (r.exhausted && r.budget_date === today) {
      _quotaExhausted.add(r.name);
      log.warn(`Provider "${r.name}" still exhausted from earlier today`);
    } else if (r.exhausted && r.budget_date !== today) {
      // New day → clear exhaustion
      db.prepare("UPDATE provider_status SET exhausted = 0, tokens_used_today = 0, budget_date = ? WHERE name = ?").run(today, r.name);
      log.info(`Provider "${r.name}" quota reset (new day)`);
    }
  }
}

/** Mark a provider as out of quota (called on 429/402 errors). */
export function markProviderExhausted(providerName: string): void {
  // Idempotent — every failed call funnels through 2–3 catch blocks (provider
  // 429 handler, chain-runner, instrumentProvider). We only persist + log on
  // the first one. Health tracking (recordFailure) is intentionally NOT done
  // here: instrumentProvider's catch already records the failure once with
  // kind="exhausted", and adding another call here would double-count and
  // double-log "exhausted (failure #N)".
  if (_quotaExhausted.has(providerName)) return;
  _quotaExhausted.add(providerName);
  log.warn(`Provider "${providerName}" marked as quota-exhausted — falling back to alternatives`);
  if (_dbRef) {
    const today = new Date().toISOString().slice(0, 10);
    _dbRef.prepare(
      "INSERT INTO provider_status (name, exhausted, exhausted_at, budget_date) VALUES (?, 1, datetime('now'), ?) ON CONFLICT(name) DO UPDATE SET exhausted = 1, exhausted_at = datetime('now'), budget_date = ?"
    ).run(providerName, today, today);
  }
}

/** Check if a provider has been marked as quota-exhausted. */
export function isProviderExhausted(providerName: string): boolean {
  return _quotaExhausted.has(providerName);
}

/**
 * Clear an exhausted flag manually — used by the operator endpoint when a
 * paid quota is reset out-of-band (e.g. billing top-up) before the daily
 * auto-reset kicks in. Pass an empty/undefined name to clear ALL providers.
 */
export function clearProviderExhausted(providerName?: string): number {
  let cleared = 0;
  const today = new Date().toISOString().slice(0, 10);
  if (!providerName) {
    cleared = _quotaExhausted.size;
    _quotaExhausted.clear();
    if (_dbRef) {
      _dbRef.prepare(
        "UPDATE provider_status SET exhausted = 0, tokens_used_today = 0, budget_date = ? WHERE exhausted = 1",
      ).run(today);
    }
    // Also clear the in-memory LlmHealth backoff window — otherwise an
    // operator who just topped up their account would still have to wait
    // for MAX_EXHAUSTED_BACKOFF_MS (1 h default) before the provider goes
    // back into rotation.
    providerHealth.clearBlock();
    if (cleared > 0) log.info(`Provider exhaustion cleared for all (${cleared} provider(s))`);
    return cleared;
  }
  if (_quotaExhausted.delete(providerName)) cleared = 1;
  if (_dbRef) {
    _dbRef.prepare(
      "UPDATE provider_status SET exhausted = 0, tokens_used_today = 0, budget_date = ? WHERE name = ?",
    ).run(today, providerName);
  }
  providerHealth.clearBlock(providerName);
  if (cleared > 0) log.info(`Provider "${providerName}" exhaustion cleared`);
  return cleared;
}
