import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { safeAll, toRecord, today, daysFromNow } from "../../../../../src/core/db/query-helpers.js";

export interface DashboardTasks {
  kpis: {
    total: number;
    inProgress: number;
    completedThisWeek: number;
    overdue: number;
    avgCompletionDays: number;
    onTrackPct: number;
  };
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  byContext: Record<string, number>;
  byTag: Record<string, number>;
  velocity: Array<{ week: string; created: number; completed: number }>;
  inProgressTasks: Array<{
    id: string; title: string; priority: string; context: string;
    progress: number; started_at: string | null; due_date: string | null;
    target_date: string | null; estimated_minutes: number;
    tracked_minutes: number; tags: string;
  }>;
  overdue: Array<{
    id: string; title: string; due_date: string; priority: string;
    progress: number; days_overdue: number;
  }>;
  dueSoon: Array<{
    id: string; title: string; due_date: string; priority: string;
    progress: number; status: string;
  }>;
  recentlyCompleted: Array<{
    id: string; title: string; completed_at: string;
    duration_days: number; tracked_minutes: number;
  }>;
  blocked: Array<{ id: string; title: string; priority: string; context: string }>;
  completionStats: { avgDurationDays: number; completedLast30: number; completedLast7: number };
}

export function queryTasks(db: SqliteDb): DashboardTasks {
  const todayStr = today();
  const weekAhead = daysFromNow(7);
  const thirtyDaysAgo = daysFromNow(-30);
  const sevenDaysAgo = daysFromNow(-7);
  const eightWeeksAgo = daysFromNow(-56);

  // ── Time-tracking integration (graceful if table missing) ──
  const timeByTask = new Map<string, number>();
  const timeRows = safeAll<{ task_id: string; total: number }>(db,
    `SELECT task_id, SUM(duration_minutes) as total FROM time_entries WHERE task_id IS NOT NULL GROUP BY task_id`,
  );
  for (const r of timeRows) timeByTask.set(r.task_id, r.total ?? 0);

  // ── Consolidated KPIs + breakdowns + completion stats (single CTE query) ──
  const consolidated = db.prepare(`
    WITH base AS (SELECT * FROM tasks WHERE deleted_at IS NULL),
    kpi AS (
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as inProgress,
        SUM(CASE WHEN status = 'done' AND completed_at >= ? THEN 1 ELSE 0 END) as completedThisWeek,
        SUM(CASE WHEN status != 'done' AND due_date IS NOT NULL AND due_date < ? THEN 1 ELSE 0 END) as overdue,
        SUM(CASE WHEN status = 'done' AND completed_at >= ? THEN 1 ELSE 0 END) as completedLast30,
        SUM(CASE WHEN status = 'done' AND completed_at >= ? THEN 1 ELSE 0 END) as completedLast7
      FROM base
    ),
    avg_comp AS (
      SELECT AVG(julianday(completed_at) - julianday(started_at)) as avg_days
      FROM base WHERE status = 'done' AND started_at IS NOT NULL AND completed_at IS NOT NULL
    )
    SELECT kpi.*, avg_comp.avg_days FROM kpi, avg_comp
  `).get(
    sevenDaysAgo + "T00:00:00", todayStr,
    thirtyDaysAgo + "T00:00:00", sevenDaysAgo + "T00:00:00",
  ) as {
    total: number; inProgress: number; completedThisWeek: number; overdue: number;
    completedLast30: number; completedLast7: number; avg_days: number | null;
  };

  // On-track: tasks with target_date, check if progress >= expected * 0.8
  const trackableTasks = db
    .prepare(
      `SELECT started_at, target_date, progress FROM tasks
       WHERE status = 'in_progress' AND target_date IS NOT NULL AND started_at IS NOT NULL
         AND deleted_at IS NULL`,
    )
    .all() as Array<{ started_at: string; target_date: string; progress: number }>;

  let onTrackCount = 0;
  const nowMs = Date.now();
  for (const t of trackableTasks) {
    const startMs = new Date(t.started_at).getTime();
    const targetMs = new Date(t.target_date).getTime();
    const totalSpan = targetMs - startMs;
    if (totalSpan <= 0) { onTrackCount++; continue; }
    const elapsed = nowMs - startMs;
    const expectedProgress = Math.min(100, (elapsed / totalSpan) * 100);
    if (t.progress >= expectedProgress * 0.8) onTrackCount++;
  }
  const onTrackPct = trackableTasks.length > 0
    ? Math.round((onTrackCount / trackableTasks.length) * 100)
    : 100;

  const avgCompletionDays = consolidated.avg_days != null
    ? Math.round(consolidated.avg_days * 10) / 10 : 0;

  const kpis = {
    total: consolidated.total ?? 0,
    inProgress: consolidated.inProgress ?? 0,
    completedThisWeek: consolidated.completedThisWeek ?? 0,
    overdue: consolidated.overdue ?? 0,
    avgCompletionDays,
    onTrackPct,
  };

  // ── Consolidated breakdowns (single query for status + priority + context) ──
  const statusRows = db
    .prepare(`SELECT status as key, COUNT(*) as count FROM tasks WHERE deleted_at IS NULL GROUP BY status`)
    .all() as Array<{ key: string; count: number }>;
  const byStatus = toRecord(statusRows);

  const breakdownRows = db.prepare(`
    SELECT
      'priority' as dim, priority as key, COUNT(*) as count
      FROM tasks WHERE status != 'done' AND deleted_at IS NULL GROUP BY priority
    UNION ALL
    SELECT
      'context' as dim,
      CASE WHEN context = '' THEN '(none)' ELSE context END as key,
      COUNT(*) as count
      FROM tasks WHERE status != 'done' AND deleted_at IS NULL GROUP BY key
  `).all() as Array<{ dim: string; key: string; count: number }>;

  const byPriority: Record<string, number> = {};
  const byContext: Record<string, number> = {};
  for (const r of breakdownRows) {
    if (r.dim === "priority") byPriority[r.key] = r.count;
    else byContext[r.key] = r.count;
  }

  // Tags breakdown — split comma-separated tags and count
  const tagRows = db
    .prepare(`SELECT tags FROM tasks WHERE status != 'done' AND tags <> '' AND deleted_at IS NULL`)
    .all() as Array<{ tags: string }>;
  const byTag: Record<string, number> = {};
  for (const row of tagRows) {
    for (const tag of row.tags.split(",")) {
      const t = tag.trim();
      if (t) byTag[t] = (byTag[t] ?? 0) + 1;
    }
  }

  // ── Velocity (single UNION query for created + completed) ──
  const velocityRows = db.prepare(`
    SELECT 'created' as type, strftime('%Y-W%W', created_at) as week, COUNT(*) as count
    FROM tasks WHERE created_at >= ? AND deleted_at IS NULL
    GROUP BY week
    UNION ALL
    SELECT 'completed' as type, strftime('%Y-W%W', completed_at) as week, COUNT(*) as count
    FROM tasks WHERE completed_at IS NOT NULL AND completed_at >= ? AND deleted_at IS NULL
    GROUP BY week
  `).all(eightWeeksAgo + "T00:00:00", eightWeeksAgo + "T00:00:00") as Array<{
    type: string; week: string; count: number;
  }>;

  const weekSet = new Set<string>();
  const createdMap = new Map<string, number>();
  const completedMap = new Map<string, number>();
  for (const r of velocityRows) {
    weekSet.add(r.week);
    if (r.type === "created") createdMap.set(r.week, r.count);
    else completedMap.set(r.week, r.count);
  }
  const velocity = [...weekSet].sort().map((w) => ({
    week: w,
    created: createdMap.get(w) ?? 0,
    completed: completedMap.get(w) ?? 0,
  }));

  // ── In-progress tasks ──
  const inProgressTasks = (
    db
      .prepare(
        `SELECT id, title, priority, context, progress, started_at, due_date,
                target_date, estimated_minutes, tags
         FROM tasks WHERE status = 'in_progress' AND deleted_at IS NULL
         ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                  progress DESC`,
      )
      .all() as Array<{
        id: string; title: string; priority: string; context: string;
        progress: number; started_at: string | null; due_date: string | null;
        target_date: string | null; estimated_minutes: number; tags: string;
      }>
  ).map((t) => ({ ...t, tracked_minutes: timeByTask.get(t.id) ?? 0 }));

  // ── Overdue + Due soon + Blocked (single query) ──
  const taskListRows = db.prepare(`
    SELECT id, title, due_date, priority, progress, status, context,
           CASE
             WHEN status NOT IN ('done') AND due_date IS NOT NULL AND due_date < ? THEN 'overdue'
             WHEN status NOT IN ('done') AND due_date >= ? AND due_date <= ? THEN 'due_soon'
             WHEN status = 'blocked' THEN 'blocked'
           END as category
    FROM tasks
    WHERE deleted_at IS NULL AND (
         (status NOT IN ('done') AND due_date IS NOT NULL AND due_date < ?)
       OR (status NOT IN ('done') AND due_date >= ? AND due_date <= ?)
       OR status = 'blocked')
    ORDER BY
      CASE WHEN status = 'blocked' THEN
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
      ELSE 0 END,
      due_date
  `).all(todayStr, todayStr, weekAhead, todayStr, todayStr, weekAhead) as Array<{
    id: string; title: string; due_date: string | null; priority: string;
    progress: number; status: string; context: string; category: string;
  }>;

  const overdue: DashboardTasks["overdue"] = [];
  const dueSoon: DashboardTasks["dueSoon"] = [];
  const blocked: DashboardTasks["blocked"] = [];

  for (const t of taskListRows) {
    if (t.category === "overdue" && overdue.length < 20) {
      overdue.push({
        id: t.id, title: t.title, due_date: t.due_date!, priority: t.priority, progress: t.progress,
        days_overdue: Math.floor((Date.now() - new Date(t.due_date!).getTime()) / 86_400_000),
      });
    } else if (t.category === "due_soon" && dueSoon.length < 20) {
      dueSoon.push({
        id: t.id, title: t.title, due_date: t.due_date!, priority: t.priority,
        progress: t.progress, status: t.status,
      });
    } else if (t.category === "blocked" && blocked.length < 20) {
      blocked.push({ id: t.id, title: t.title, priority: t.priority, context: t.context });
    }
  }

  // ── Recently completed ──
  const recentlyCompleted = (
    db
      .prepare(
        `SELECT id, title, completed_at, started_at FROM tasks
         WHERE status = 'done' AND completed_at IS NOT NULL AND completed_at >= ?
           AND deleted_at IS NULL
         ORDER BY completed_at DESC LIMIT 10`,
      )
      .all(`${sevenDaysAgo}T00:00:00`) as Array<{
        id: string; title: string; completed_at: string; started_at: string | null;
      }>
  ).map((t) => ({
    id: t.id,
    title: t.title,
    completed_at: t.completed_at,
    duration_days: t.started_at
      ? Math.round((new Date(t.completed_at).getTime() - new Date(t.started_at).getTime()) / 86_400_000 * 10) / 10
      : 0,
    tracked_minutes: timeByTask.get(t.id) ?? 0,
  }));

  const completionStats = {
    avgDurationDays: avgCompletionDays,
    completedLast30: consolidated.completedLast30 ?? 0,
    completedLast7: consolidated.completedLast7 ?? 0,
  };

  return {
    kpis, byStatus, byPriority, byContext, byTag, velocity,
    inProgressTasks, overdue, dueSoon, recentlyCompleted, blocked, completionStats,
  };
}
