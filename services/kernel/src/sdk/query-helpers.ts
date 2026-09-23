import type { SqliteDb } from "../core/db/sqlite.js";
import { toInstant } from "./clock.js";

/**
 * Check if a table exists in the database.
 * Used by dashboard query functions to gracefully degrade when a module's tables
 * haven't been created yet (module not initialized or migrations not run).
 */
export function tableExists(db: SqliteDb, table: string): boolean {
  try {
    db.prepare(`SELECT 1 FROM ${table} LIMIT 0`).get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a query that might fail (e.g. references a table that doesn't exist).
 * Returns the fallback value on error instead of throwing.
 */
export function safeGet<T>(db: SqliteDb, sql: string, params: unknown[], fallback: T): T {
  try {
    return (db.prepare(sql).get(...params) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Run a query returning multiple rows that might fail.
 * Returns empty array on error.
 */
export function safeAll<T>(db: SqliteDb, sql: string, params: unknown[] = []): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

/**
 * Try a primary query, fall back to a simpler one on error.
 * Used when the primary query JOINs tables that may not exist (e.g. email_accounts).
 */
export function queryWithFallback<T>(
  db: SqliteDb,
  primarySql: string,
  fallbackSql: string,
  params: unknown[] = [],
): T[] {
  try {
    return db.prepare(primarySql).all(...params) as T[];
  } catch {
    return db.prepare(fallbackSql).all(...params) as T[];
  }
}

/**
 * Convert rows with key/count columns to a Record.
 */
export function toRecord(rows: Array<{ key: string; count: number }>): Record<string, number> {
  const rec: Record<string, number> = {};
  for (const r of rows) rec[r.key] = r.count;
  return rec;
}

// Dates live in clock.ts (kernel timezone); re-exported for existing imports.
export { today, daysFromNow } from "./clock.js";

/**
 * Rewrite the timestamps in `columns` that are not UTC instants yet (no
 * trailing Z) as instants, read by `toInstant`: a value without a zone is
 * the kernel's local time. Idempotent, so a module can run it at every boot;
 * a missing table or column is skipped. Returns how many values changed.
 */
export function normalizeInstants(db: SqliteDb, table: string, columns: readonly string[]): number {
  let changed = 0;
  for (const column of columns) {
    let rows: Array<{ rid: number; v: string }>;
    try {
      rows = db.prepare(
        `SELECT rowid AS rid, ${column} AS v FROM ${table}
          WHERE ${column} IS NOT NULL AND ${column} <> '' AND ${column} NOT LIKE '%Z'`,
      ).all() as Array<{ rid: number; v: string }>;
    } catch {
      continue;
    }
    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
    for (const r of rows) {
      const next = toInstant(r.v);
      if (next && next !== r.v) {
        update.run(next, r.rid);
        changed++;
      }
    }
  }
  return changed;
}

/**
 * Run a query returning multiple rows that might fail.
 * Uses rest params for convenience (matches common local convention).
 * Returns empty array on error.
 */
export function safeQuery<T>(db: SqliteDb, sql: string, ...params: unknown[]): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

/**
 * Run a query returning a single row that might fail.
 * Returns null on error.
 */
export function safeQueryOne<T>(db: SqliteDb, sql: string, ...params: unknown[]): T | null {
  try {
    return (db.prepare(sql).get(...params) as T) ?? null;
  } catch {
    return null;
  }
}

/**
 * Count rows in a table with optional WHERE clause.
 */
export function countRows(db: SqliteDb, table: string, where?: string, params: unknown[] = []): number {
  const sql = where ? `SELECT COUNT(*) as c FROM ${table} WHERE ${where}` : `SELECT COUNT(*) as c FROM ${table}`;
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

// ── Partial updates ──────────────────────────────────────────

/**
 * How a patch field reaches its column: stored as is, JSON-encoded, as 0/1,
 * or with its own column name and/or conversion.
 */
export type PatchColumn =
  | "text"
  | "json"
  | "bool"
  | { column?: string; to?: (value: never) => unknown };

/**
 * The SET clause of a partial UPDATE: one `col = ?` per field of `patch`
 * that `spec` lists and that is not undefined, in `spec` order.
 *
 * Replaces the `if (input.x !== undefined) { sets.push("x = ?"); params.push(…) }`
 * ladder every service wrote by hand. `spec` is also the allow-list: a key
 * it does not name never reaches the SQL, so the column names can't come
 * from the caller. The caller adds its own extras (updated_at, side columns)
 * to the returned arrays before running the UPDATE.
 */
export function buildPatch(
  patch: object,
  spec: Record<string, PatchColumn>,
): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  const values = patch as Record<string, unknown>;
  for (const [field, kind] of Object.entries(spec)) {
    const value = values[field];
    if (value === undefined) continue;
    if (kind === "text") { sets.push(`${field} = ?`); params.push(value); }
    else if (kind === "json") { sets.push(`${field} = ?`); params.push(JSON.stringify(value)); }
    else if (kind === "bool") { sets.push(`${field} = ?`); params.push(value ? 1 : 0); }
    else {
      sets.push(`${kind.column ?? field} = ?`);
      params.push(kind.to ? kind.to(value as never) : value);
    }
  }
  return { sets, params };
}
