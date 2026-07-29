import type { SqliteDb } from "../../core/db/sqlite.js";

export interface DailySummary {
  tasksDone: number;
  tasksCreated: number;
  interactions: number;
  remindersFired: number;
  purchases: number;
  issuesClosed: number;
}

export interface HabitEntry {
  name: string;
  doneToday: boolean;
  streak: number;
}

export interface WaterIntake {
  glasses: number;
  goal: number;
}

export interface MoodEntry {
  value: number;
  date: string;
}

export function queryDailySummary(db: SqliteDb): DailySummary {
  const today = new Date().toISOString().split("T")[0]!;
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split("T")[0]!;

  const tasksDone = (
    db.prepare(
      `SELECT COUNT(*) AS c FROM tasks WHERE status = 'done'
       AND updated_at >= ? AND updated_at < ?`,
    ).get(`${today}T00:00:00`, `${tomorrow}T00:00:00`) as { c: number }
  ).c;

  const tasksCreated = (
    db.prepare(
      `SELECT COUNT(*) AS c FROM tasks
       WHERE created_at >= ? AND created_at < ?`,
    ).get(`${today}T00:00:00`, `${tomorrow}T00:00:00`) as { c: number }
  ).c;

  const interactions = (
    db.prepare(
      `SELECT COUNT(*) AS c FROM interactions WHERE date = ?`,
    ).get(today) as { c: number }
  ).c;

  const remindersFired = (
    db.prepare(
      `SELECT COUNT(*) AS c FROM reminders
       WHERE last_fired_at >= ? AND last_fired_at < ?`,
    ).get(`${today}T00:00:00`, `${tomorrow}T00:00:00`) as { c: number }
  ).c;

  const purchases = (
    db.prepare(
      `SELECT COUNT(*) AS c FROM purchases WHERE purchased_at = ?`,
    ).get(today) as { c: number }
  ).c;

  let issuesClosed = 0;
  try {
    issuesClosed = (
      db.prepare(
        `SELECT COUNT(*) AS c FROM issues
         WHERE state IN ('closed','merged') AND closed_at >= ? AND closed_at < ?`,
      ).get(`${today}T00:00:00`, `${tomorrow}T00:00:00`) as { c: number }
    ).c;
  } catch {
    // issues table may not exist
  }

  return { tasksDone, tasksCreated, interactions, remindersFired, purchases, issuesClosed };
}

export function queryHabits(db: SqliteDb, date: string): HabitEntry[] {
  // Get all distinct habit names ever logged
  let rows: Array<{ value: string }>;
  try {
    rows = db.prepare(
      `SELECT DISTINCT value FROM life_log WHERE type = 'habit' ORDER BY value`,
    ).all() as Array<{ value: string }>;
  } catch {
    return [];
  }

  return rows.map((row) => {
    // Check if done today
    const todayEntry = db.prepare(
      `SELECT 1 FROM life_log WHERE type = 'habit' AND value = ? AND date = ? LIMIT 1`,
    ).get(row.value, date);

    // Calculate streak: count consecutive days backward from today (or yesterday if not done today)
    const streak = calculateStreak(db, row.value, date, !!todayEntry);

    return { name: row.value, doneToday: !!todayEntry, streak };
  });
}

function calculateStreak(db: SqliteDb, habitName: string, today: string, doneToday: boolean): number {
  if (!doneToday) {
    // Check if there was a streak ending yesterday
    const yesterday = dateAdd(today, -1);
    const yEntry = db.prepare(
      `SELECT 1 FROM life_log WHERE type = 'habit' AND value = ? AND date = ? LIMIT 1`,
    ).get(habitName, yesterday);
    if (!yEntry) return 0;
    return countBack(db, habitName, yesterday);
  }
  return countBack(db, habitName, today);
}

function countBack(db: SqliteDb, habitName: string, startDate: string): number {
  let count = 0;
  let current = startDate;
  for (let i = 0; i < 365; i++) {
    const entry = db.prepare(
      `SELECT 1 FROM life_log WHERE type = 'habit' AND value = ? AND date = ? LIMIT 1`,
    ).get(habitName, current);
    if (!entry) break;
    count++;
    current = dateAdd(current, -1);
  }
  return count;
}

function dateAdd(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0]!;
}

export function queryWaterIntake(db: SqliteDb, date: string): WaterIntake {
  try {
    const result = db.prepare(
      `SELECT COUNT(*) AS c FROM life_log WHERE type = 'water' AND date = ?`,
    ).get(date) as { c: number };
    return { glasses: result.c, goal: 8 };
  } catch {
    return { glasses: 0, goal: 8 };
  }
}

export function queryMoodLog(db: SqliteDb, days: number): MoodEntry[] {
  try {
    const rows = db.prepare(
      `SELECT value, date FROM life_log WHERE type = 'mood'
       ORDER BY date DESC LIMIT ?`,
    ).all(days) as Array<{ value: string; date: string }>;
    return rows.map((r) => ({
      value: parseInt(r.value, 10) || 3,
      date: r.date,
    }));
  } catch {
    return [];
  }
}
