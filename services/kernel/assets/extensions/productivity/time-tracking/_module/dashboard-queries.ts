import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { tableExists, today, daysFromNow } from "../../../../../src/core/db/query-helpers.js";

// ── Types ────────────────────────────────────────────

export interface DashboardTimeTracking {
  kpis: { totalEntries: number; totalMinutes: number; runningTimer: boolean };
  todayMinutes: number;
  weekMinutes: number;
  recentEntries: Array<{ id: string; description: string; duration_minutes: number | null; tags: string; start_time: string; end_time: string | null }>;
  byTag: Record<string, number>;
  dailyTotals7d: Array<{ date: string; minutes: number }>;
}

// ── Query ────────────────────────────────────────────

export function queryTimeTracking(db: SqliteDb): DashboardTimeTracking | null {
  if (!tableExists(db, "time_entries")) return null;

  const todayStr = today();
  const weekAgo = daysFromNow(-7);

  const total = db
    .prepare(`SELECT COUNT(*) as cnt, COALESCE(SUM(duration_minutes), 0) as mins FROM time_entries WHERE end_time IS NOT NULL`)
    .get() as { cnt: number; mins: number };

  const running = db
    .prepare(`SELECT COUNT(*) as cnt FROM time_entries WHERE end_time IS NULL`)
    .get() as { cnt: number };

  const todayMins = (
    db.prepare(
      `SELECT COALESCE(SUM(duration_minutes), 0) as mins FROM time_entries
       WHERE end_time IS NOT NULL AND date(start_time) = ?`,
    ).get(todayStr) as { mins: number }
  ).mins;

  const weekMins = (
    db.prepare(
      `SELECT COALESCE(SUM(duration_minutes), 0) as mins FROM time_entries
       WHERE end_time IS NOT NULL AND date(start_time) >= ?`,
    ).get(weekAgo) as { mins: number }
  ).mins;

  const recentEntries = db
    .prepare(
      `SELECT id, description, duration_minutes, tags, start_time, end_time
       FROM time_entries ORDER BY start_time DESC LIMIT 10`,
    )
    .all() as DashboardTimeTracking["recentEntries"];

  // By tag (last 30d)
  const d30ago = daysFromNow(-30);
  const tagRows = db
    .prepare(`SELECT tags, duration_minutes FROM time_entries WHERE end_time IS NOT NULL AND tags <> '' AND date(start_time) >= ?`)
    .all(d30ago) as Array<{ tags: string; duration_minutes: number }>;
  const tagMins: Record<string, number> = {};
  for (const row of tagRows) {
    for (const tag of row.tags.split(",")) {
      const t = tag.trim();
      if (t) tagMins[t] = (tagMins[t] ?? 0) + row.duration_minutes;
    }
  }

  // Daily totals for last 7 days
  const dailyTotals7d = db
    .prepare(
      `SELECT date(start_time) as date, COALESCE(SUM(duration_minutes), 0) as minutes
       FROM time_entries
       WHERE end_time IS NOT NULL AND date(start_time) >= ?
       GROUP BY date(start_time) ORDER BY date`,
    )
    .all(weekAgo) as DashboardTimeTracking["dailyTotals7d"];

  return {
    kpis: { totalEntries: total.cnt, totalMinutes: total.mins, runningTimer: running.cnt > 0 },
    todayMinutes: todayMins,
    weekMinutes: weekMins,
    recentEntries,
    byTag: tagMins,
    dailyTotals7d,
  };
}
