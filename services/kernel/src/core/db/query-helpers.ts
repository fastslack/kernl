import type { SqliteDb } from "./sqlite.js";

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

/**
 * Today's date as ISO string (YYYY-MM-DD).
 */
export function today(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Date N days from now as ISO string (YYYY-MM-DD).
 */
export function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().split("T")[0];
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
