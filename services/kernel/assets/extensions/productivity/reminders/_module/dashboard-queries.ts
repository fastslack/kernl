import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { toRecord, today, daysFromNow } from "../../../../../src/core/db/query-helpers.js";

export interface DashboardReminders {
  upcoming24h: Array<{ id: string; title: string; trigger_at: string; repeat: string }>;
  overdue: Array<{ id: string; title: string; trigger_at: string }>;
  byStatus: Record<string, number>;
  firedToday: number;
  recurringCount: number;
}

export function queryReminders(db: SqliteDb): DashboardReminders {
  const now = new Date().toISOString();
  const in24h = new Date(Date.now() + 24 * 3_600_000).toISOString();
  const todayStr = today();
  const tomorrowStr = daysFromNow(1);

  const upcoming24h = db
    .prepare(
      `SELECT id, title, trigger_at, repeat FROM reminders
       WHERE status IN ('active','snoozed') AND trigger_at <= ?
       ORDER BY trigger_at ASC LIMIT 20`,
    )
    .all(in24h) as DashboardReminders["upcoming24h"];

  const overdue = db
    .prepare(
      `SELECT id, title, trigger_at FROM reminders
       WHERE status IN ('active','snoozed') AND trigger_at < ?
       ORDER BY trigger_at ASC LIMIT 20`,
    )
    .all(now) as DashboardReminders["overdue"];

  const byStatus = toRecord(
    db
      .prepare(`SELECT status as key, COUNT(*) as count FROM reminders GROUP BY status`)
      .all() as Array<{ key: string; count: number }>,
  );

  const firedToday = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM reminders
         WHERE last_fired_at >= ? AND last_fired_at < ?`,
      )
      .get(`${todayStr}T00:00:00`, `${tomorrowStr}T00:00:00`) as { count: number }
  ).count;

  const recurringCount = (
    db
      .prepare(`SELECT COUNT(*) as count FROM reminders WHERE repeat != 'none' AND status IN ('active','snoozed')`)
      .get() as { count: number }
  ).count;

  return { upcoming24h, overdue, byStatus, firedToday, recurringCount };
}
