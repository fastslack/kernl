import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { tableExists, toRecord, today, daysFromNow } from "../../../../../src/core/db/query-helpers.js";

export interface DashboardSubscriptions {
  kpis: { total: number; active: number; paused: number; monthlyTotalCents: number };
  activeList: Array<{ id: string; name: string; provider: string; amount_cents: number; billing_cycle: string; next_billing: string; category: string }>;
  byCategory: Record<string, number>;
  byCycle: Record<string, number>;
  upcoming7d: Array<{ id: string; name: string; amount_cents: number; next_billing: string }>;
}

export function querySubscriptions(db: SqliteDb): DashboardSubscriptions | null {
  if (!tableExists(db, "subscriptions")) return null;

  const todayStr = today();
  const in7 = daysFromNow(7);

  const stats = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
         SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused
       FROM subscriptions`,
    )
    .get() as { total: number; active: number; paused: number };

  // Normalize to monthly: weekly*4.33, monthly*1, quarterly/3, yearly/12
  const monthlyTotal = db
    .prepare(
      `SELECT COALESCE(SUM(
         CASE billing_cycle
           WHEN 'weekly' THEN CAST(amount_cents * 4.33 AS INTEGER)
           WHEN 'monthly' THEN amount_cents
           WHEN 'quarterly' THEN amount_cents / 3
           WHEN 'yearly' THEN amount_cents / 12
           ELSE amount_cents
         END
       ), 0) as total
       FROM subscriptions WHERE status = 'active'`,
    )
    .get() as { total: number };

  const activeList = db
    .prepare(
      `SELECT id, name, provider, amount_cents, billing_cycle, next_billing, category
       FROM subscriptions WHERE status = 'active'
       ORDER BY next_billing LIMIT 20`,
    )
    .all() as DashboardSubscriptions["activeList"];

  const byCategory = toRecord(
    db
      .prepare(
        `SELECT CASE WHEN category = '' THEN '(none)' ELSE category END as key,
                COUNT(*) as count
         FROM subscriptions WHERE status = 'active' GROUP BY key`,
      )
      .all() as Array<{ key: string; count: number }>,
  );

  const byCycle = toRecord(
    db
      .prepare(
        `SELECT billing_cycle as key, COUNT(*) as count
         FROM subscriptions WHERE status = 'active' GROUP BY key`,
      )
      .all() as Array<{ key: string; count: number }>,
  );

  const upcoming7d = db
    .prepare(
      `SELECT id, name, amount_cents, next_billing
       FROM subscriptions
       WHERE status = 'active' AND next_billing >= ? AND next_billing <= ?
       ORDER BY next_billing`,
    )
    .all(todayStr, in7) as DashboardSubscriptions["upcoming7d"];

  return {
    kpis: { total: stats.total ?? 0, active: stats.active ?? 0, paused: stats.paused ?? 0, monthlyTotalCents: monthlyTotal.total },
    activeList,
    byCategory,
    byCycle,
    upcoming7d,
  };
}
