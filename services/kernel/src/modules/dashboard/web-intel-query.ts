/**
 * Dashboard read-model for the web-intel (research) panel.
 *
 * web-intel is a PAID module provided separately, so the public core cannot
 * import from its source. This query is self-contained
 * (it only touches core db helpers) and degrades gracefully: when the paid
 * module isn't installed its tables are absent, so `queryWebIntel` returns
 * `null` and the dashboard renders an empty panel. The route is wired via
 * `nullableRoute`, which already handles the null.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import { tableExists, toRecord, today } from "../../core/db/query-helpers.js";

// ── Types ────────────────────────────────────────────

export interface DashboardWebIntel {
  kpis: { totalTasks: number; activeTasks: number; totalResults: number; resultsToday: number; unreadResults: number; providers: number };
  recentResults: Array<{ id: string; task_name: string; title: string; summary: string; relevance: number; tags: string; source_url: string; found_at: string }>;
  taskStatus: Array<{ id: string; name: string; source_type: string; status: string; last_run_at: string | null; next_run_at: string | null; run_count: number; result_count: number }>;
  bySource: Record<string, number>;
  byRelevance: { high: number; medium: number; low: number };
}

// ── Query ────────────────────────────────────────────

export function queryWebIntel(db: SqliteDb): DashboardWebIntel | null {
  if (!tableExists(db, "research_tasks")) return null;

  const todayStr = today();

  const totalTasks = (db.prepare("SELECT COUNT(*) as c FROM research_tasks").get() as { c: number }).c;
  const activeTasks = (db.prepare("SELECT COUNT(*) as c FROM research_tasks WHERE status = 'active'").get() as { c: number }).c;
  const totalResults = (db.prepare("SELECT COUNT(*) as c FROM research_results").get() as { c: number }).c;
  const resultsToday = (db.prepare("SELECT COUNT(*) as c FROM research_results WHERE found_at >= ?").get(todayStr) as { c: number }).c;
  const unreadResults = (db.prepare("SELECT COUNT(*) as c FROM research_results WHERE is_read = 0").get() as { c: number }).c;
  const providers = (db.prepare("SELECT COUNT(*) as c FROM llm_providers").get() as { c: number }).c;

  const recentResults = db
    .prepare(
      `SELECT r.id, t.name as task_name, r.title, r.summary, r.relevance, r.tags, r.source_url, r.found_at
       FROM research_results r JOIN research_tasks t ON r.task_id = t.id
       ORDER BY r.found_at DESC LIMIT 20`,
    )
    .all() as DashboardWebIntel["recentResults"];

  const taskStatusRows = db
    .prepare(
      `SELECT t.id, t.name, t.source_type, t.status, t.last_run_at, t.next_run_at, t.run_count,
              (SELECT COUNT(*) FROM research_results WHERE task_id = t.id) as result_count
       FROM research_tasks t ORDER BY t.status, t.name`,
    )
    .all() as DashboardWebIntel["taskStatus"];

  const sourceRows = db
    .prepare("SELECT source_type as key, COUNT(*) as count FROM research_tasks GROUP BY source_type")
    .all() as Array<{ key: string; count: number }>;
  const bySource = toRecord(sourceRows);

  const high = (db.prepare("SELECT COUNT(*) as c FROM research_results WHERE relevance >= 75").get() as { c: number }).c;
  const medium = (db.prepare("SELECT COUNT(*) as c FROM research_results WHERE relevance >= 40 AND relevance < 75").get() as { c: number }).c;
  const low = (db.prepare("SELECT COUNT(*) as c FROM research_results WHERE relevance < 40").get() as { c: number }).c;

  return {
    kpis: { totalTasks, activeTasks, totalResults, resultsToday, unreadResults, providers },
    recentResults,
    taskStatus: taskStatusRows,
    bySource,
    byRelevance: { high, medium, low },
  };
}
