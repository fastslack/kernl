import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { tableExists } from "../../../../../src/core/db/query-helpers.js";

export interface DashboardGoals {
  kpis: { total: number; active: number; completed: number; avgProgress: number };
  activeGoals: Array<{ id: string; title: string; type: string; status: string; target_date: string | null; progress: number; keyResultCount: number }>;
  recentlyCompleted: Array<{ id: string; title: string; updated_at: string }>;
}

export function queryGoals(db: SqliteDb): DashboardGoals | null {
  if (!tableExists(db, "goals")) return null;

  const stats = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
       FROM goals`,
    )
    .get() as { total: number; active: number; completed: number };

  // Active goals with progress (avg of key_results current_value/target_value)
  const activeGoals = db
    .prepare(
      `SELECT g.id, g.title, g.type, g.status, g.target_date,
              COALESCE(AVG(CASE WHEN kr.target_value > 0 THEN MIN(kr.current_value / kr.target_value * 100, 100) ELSE 0 END), 0) as progress,
              COUNT(kr.id) as keyResultCount
       FROM goals g
       LEFT JOIN key_results kr ON kr.goal_id = g.id
       WHERE g.status = 'active'
       GROUP BY g.id
       ORDER BY g.updated_at DESC LIMIT 15`,
    )
    .all() as Array<{ id: string; title: string; type: string; status: string; target_date: string | null; progress: number; keyResultCount: number }>;

  // Round progress
  for (const g of activeGoals) g.progress = Math.round(g.progress);

  const avgProgress = activeGoals.length > 0
    ? Math.round(activeGoals.reduce((s, g) => s + g.progress, 0) / activeGoals.length)
    : 0;

  const recentlyCompleted = db
    .prepare(
      `SELECT id, title, updated_at FROM goals
       WHERE status = 'completed' ORDER BY updated_at DESC LIMIT 5`,
    )
    .all() as DashboardGoals["recentlyCompleted"];

  return {
    kpis: { total: stats.total ?? 0, active: stats.active ?? 0, completed: stats.completed ?? 0, avgProgress },
    activeGoals,
    recentlyCompleted,
  };
}
