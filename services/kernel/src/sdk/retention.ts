/**
 * Building blocks for `RetentionPolicy` (see core/types.ts). Most policies are
 * "rows of table T older than N days, except the ones that must stay" — that
 * is `agePolicy`. Anything subtler writes its own estimate/purge and can still
 * use `deleteBatch` to keep each write short.
 */

import type { SqliteDb } from "../core/db/sqlite.js";
import type { RetentionKind, RetentionPolicy, RetentionRunContext } from "../core/types.js";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Delete up to `limit` rows of `table` matching `where` and return how many
 * went. Selecting rowids first keeps it one short statement per batch.
 */
export function deleteBatch(
  db: SqliteDb,
  table: string,
  where: string,
  params: ReadonlyArray<string | number | null>,
  limit: number,
): number {
  const t = quoteIdent(table);
  db.prepare(`DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE ${where} LIMIT ?)`).run(...params, limit);
  // Not `.run().changes`: bun counts rows written by triggers too (an FTS
  // sync trigger turned one deleted row into 4), and the runner stops on a
  // batch shorter than the limit. SQL changes() counts only this statement.
  return (db.prepare("SELECT changes() AS n").get() as { n: number }).n;
}

export function countWhere(
  db: SqliteDb,
  table: string,
  where: string,
  params: ReadonlyArray<string | number | null>,
): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)} WHERE ${where}`).get(...params) as { n: number };
    return row.n;
  } catch {
    // Table not created yet (extension installed but never initialised).
    return 0;
  }
}

/**
 * The ceiling the user set for a policy's `capacity` on the storage page, or
 * `fallback` when they never touched it. 0 means no limit. Reads the storage
 * module's table directly so a collector needs no handle on that module; a
 * missing table (storage not initialised yet) reads as the fallback.
 */
export function retentionCap(db: SqliteDb, policyId: string, fallback = 0): number {
  try {
    const row = db.prepare("SELECT cap FROM retention_settings WHERE policy_id = ?").get(policyId) as
      | { cap: number | null }
      | undefined;
    if (!row || row.cap === null) return fallback;
    return row.cap > 0 ? row.cap : 0;
  } catch {
    return fallback;
  }
}

export interface AgePolicySpec {
  id: string;
  label: string;
  description: string;
  kind: RetentionKind;
  table: string;
  /** Column compared against the cutoff (ISO text). */
  dateColumn: string;
  /** Extra condition every deleted row must also meet — what is always kept is NOT in here. */
  where?: string;
  /** Other tables the policy accounts for (child rows deleted by cascade, say). */
  alsoTables?: string[];
  defaultDays: number;
  defaultEnabled: boolean;
  dayOptions?: number[];
}

/** "Rows of `table` whose `dateColumn` is older than the retention, matching `where`." */
export function agePolicy(spec: AgePolicySpec): RetentionPolicy {
  const cond = (rc: RetentionRunContext): { where: string; params: Array<string | number | null> } => {
    const extra = spec.where ? ` AND (${spec.where})` : "";
    return { where: `${quoteIdent(spec.dateColumn)} < ?${extra}`, params: [rc.cutoff ?? ""] };
  };
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    kind: spec.kind,
    tables: [spec.table, ...(spec.alsoTables ?? [])],
    defaultDays: spec.defaultDays,
    defaultEnabled: spec.defaultEnabled,
    dayOptions: spec.dayOptions,
    estimate(rc) {
      if (!rc.cutoff) return 0;
      const { where, params } = cond(rc);
      return countWhere(rc.db, spec.table, where, params);
    },
    purge(rc) {
      if (!rc.cutoff) return 0;
      const { where, params } = cond(rc);
      try {
        return deleteBatch(rc.db, spec.table, where, params, rc.batchSize);
      } catch (err) {
        if (/no such table/i.test(String(err))) return 0;
        throw err;
      }
    },
  };
}
