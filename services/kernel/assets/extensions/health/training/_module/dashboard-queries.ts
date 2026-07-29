import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { tableExists, today, daysFromNow } from "../../../../../src/core/db/query-helpers.js";

export interface DashboardTraining {
  kpis: { totalWorkouts: number; workoutsThisWeek: number; prsAllTime: number; activeProgramName: string | null };
  recentWorkouts: Array<{ id: string; name: string; date: string; duration_minutes: number | null; calories_burned: number | null }>;
  recentCardio: Array<{ id: string; sport: string; date: string; duration_minutes: number; distance_m: number | null; avg_hr: number | null }>;
  topPrs: Array<{ exercise_name: string; pr_type: string; value: number; unit: string; date: string }>;
  weeklyVolume: Array<{ week: string; workouts: number; total_sets: number }>;
  activeProgram: { id: string; name: string; goal: string; status: string; days_per_week: number } | null;
}

export function queryTraining(db: SqliteDb): DashboardTraining | null {
  if (!tableExists(db, "training_workouts")) return null;

  const todayStr = today();
  const weekAgo = daysFromNow(-7);
  const eightWeeksAgo = daysFromNow(-56);

  const totalWorkouts = (db.prepare("SELECT COUNT(*) as c FROM training_workouts").get() as { c: number }).c;

  const workoutsThisWeek = (
    db.prepare("SELECT COUNT(*) as c FROM training_workouts WHERE date >= ?").get(weekAgo) as { c: number }
  ).c;

  const prsAllTime = (db.prepare("SELECT COUNT(*) as c FROM training_prs").get() as { c: number }).c;

  const activeProgram = db
    .prepare("SELECT id, name, goal, status, days_per_week FROM training_programs WHERE status = 'active' LIMIT 1")
    .get() as { id: string; name: string; goal: string; status: string; days_per_week: number } | undefined ?? null;

  const recentWorkouts = db
    .prepare(
      `SELECT id, name, date, duration_minutes, calories_burned FROM training_workouts
       ORDER BY date DESC, created_at DESC LIMIT 10`,
    )
    .all() as DashboardTraining["recentWorkouts"];

  const recentCardio = db
    .prepare(
      `SELECT id, sport, date, duration_minutes, distance_m, avg_hr FROM training_cardio
       ORDER BY date DESC, created_at DESC LIMIT 5`,
    )
    .all() as DashboardTraining["recentCardio"];

  const topPrs = db
    .prepare(
      `SELECT exercise_name, pr_type, value, unit, date FROM training_prs
       ORDER BY date DESC LIMIT 10`,
    )
    .all() as DashboardTraining["topPrs"];

  const weeklyVolume = db
    .prepare(
      `SELECT strftime('%Y-W%W', date) as week,
              COUNT(DISTINCT id) as workouts,
              0 as total_sets
       FROM training_workouts WHERE date >= ?
       GROUP BY week ORDER BY week`,
    )
    .all(eightWeeksAgo) as Array<{ week: string; workouts: number; total_sets: number }>;

  // Enrich with set counts
  const setsByWorkout = db
    .prepare(
      `SELECT w.id, COUNT(s.id) as sets
       FROM training_workouts w
       LEFT JOIN training_sets s ON s.workout_id = w.id
       WHERE w.date >= ?
       GROUP BY w.id`,
    )
    .all(eightWeeksAgo) as Array<{ id: string; sets: number }>;
  const setsMapByWeek = new Map<string, number>();
  for (const r of setsByWorkout) {
    // We need the workout's week — get from recentWorkouts join
  }
  // Simple approach: just get total sets per week directly
  const weekSets = db
    .prepare(
      `SELECT strftime('%Y-W%W', w.date) as week, COUNT(s.id) as sets
       FROM training_workouts w
       LEFT JOIN training_sets s ON s.workout_id = w.id
       WHERE w.date >= ?
       GROUP BY week`,
    )
    .all(eightWeeksAgo) as Array<{ week: string; sets: number }>;
  const weekSetsMap = new Map<string, number>();
  for (const r of weekSets) weekSetsMap.set(r.week, r.sets);
  for (const w of weeklyVolume) w.total_sets = weekSetsMap.get(w.week) ?? 0;

  return {
    kpis: {
      totalWorkouts,
      workoutsThisWeek,
      prsAllTime,
      activeProgramName: activeProgram?.name ?? null,
    },
    recentWorkouts,
    recentCardio,
    topPrs,
    weeklyVolume,
    activeProgram,
  };
}
