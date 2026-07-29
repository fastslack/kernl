/**
 * Training RPC Actions — workouts, sets, PRs, cardio, programs via mtwRequest.
 */

import crypto from "node:crypto";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";

export function trainingRpcActions(db: SqliteDb): RpcAction[] {
  return [
    {
      name: "training.workouts.list",
      handler: async (args) => {
        const from = typeof args.from === "string" ? args.from : "";
        const limit = Math.min(100, Math.max(10, typeof args.limit === "number" ? args.limit : 30));
        let where = "1=1";
        const params: unknown[] = [];
        if (from) { where += " AND date >= ?"; params.push(from); }

        const rows = db.prepare(
          `SELECT id, program_id, template_id, name, sport, date, start_time, end_time,
                  duration_minutes, calories_burned, notes, mood_before, mood_after, fatigue_level, created_at
           FROM training_workouts WHERE ${where} ORDER BY date DESC, created_at DESC LIMIT ?`,
        ).all(...params, limit);
        return { workouts: rows };
      },
    },
    {
      name: "training.workouts.detail",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const workout = db.prepare("SELECT * FROM training_workouts WHERE id = ?").get(id);
        if (!workout) throw new Error("Not found");
        const sets = db.prepare(
          "SELECT * FROM training_sets WHERE workout_id = ? ORDER BY created_at",
        ).all(id);
        return { workout, sets };
      },
    },
    {
      name: "training.workouts.start",
      handler: async (args) => {
        const name = typeof args.name === "string" ? args.name.trim() : "Workout";
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO training_workouts (id, program_id, template_id, name, sport, date, start_time, notes, mood_before, fatigue_level, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, args.program_id ?? null, args.template_id ?? null, name,
          args.sport ?? "", now.split("T")[0], now,
          args.notes ?? "", args.mood_before ?? null, args.fatigue_level ?? null, now,
        );
        return { ok: true, id };
      },
    },
    {
      name: "training.workouts.finish",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const now = new Date().toISOString();
        const workout = db.prepare("SELECT start_time FROM training_workouts WHERE id = ?").get(id) as { start_time: string } | undefined;
        const duration = workout?.start_time
          ? Math.round((Date.now() - new Date(workout.start_time).getTime()) / 60000)
          : (typeof args.duration_minutes === "number" ? args.duration_minutes : null);

        db.prepare(
          "UPDATE training_workouts SET end_time = ?, duration_minutes = ?, calories_burned = ?, mood_after = ?, notes = COALESCE(?, notes) WHERE id = ?",
        ).run(now, duration, args.calories_burned ?? null, args.mood_after ?? null, args.notes ?? null, id);
        return { ok: true, duration };
      },
    },
    {
      name: "training.sets.log",
      handler: async (args) => {
        const workoutId = typeof args.workout_id === "string" ? args.workout_id : "";
        const exerciseName = typeof args.exercise_name === "string" ? args.exercise_name.trim() : "";
        if (!workoutId || !exerciseName) throw new Error("workout_id and exercise_name required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        // Auto set_number
        const last = db.prepare(
          "SELECT MAX(set_number) as n FROM training_sets WHERE workout_id = ? AND exercise_name = ?",
        ).get(workoutId, exerciseName) as { n: number | null };
        const setNumber = (last?.n ?? 0) + 1;

        db.prepare(
          `INSERT INTO training_sets (id, workout_id, exercise_id, exercise_name, set_number, reps, weight_kg, duration_secs, distance_m, rpe, is_warmup, is_pr, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, workoutId, args.exercise_id ?? null, exerciseName, setNumber,
          args.reps ?? null, args.weight_kg ?? null, args.duration_secs ?? null,
          args.distance_m ?? null, args.rpe ?? null,
          args.is_warmup ? 1 : 0, args.is_pr ? 1 : 0,
          args.notes ?? "", now,
        );
        return { ok: true, id, setNumber };
      },
    },
    {
      name: "training.prs.list",
      handler: async (args) => {
        const exercise = typeof args.exercise_name === "string" ? args.exercise_name : "";
        let where = "1=1";
        const params: unknown[] = [];
        if (exercise) { where += " AND exercise_name = ?"; params.push(exercise); }

        const rows = db.prepare(
          `SELECT id, exercise_name, pr_type, value, unit, date, notes, created_at
           FROM training_prs WHERE ${where} ORDER BY date DESC`,
        ).all(...params);
        return { prs: rows };
      },
    },
    {
      name: "training.cardio.log",
      handler: async (args) => {
        const sport = typeof args.sport === "string" ? args.sport.trim() : "";
        if (!sport) throw new Error("sport required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO training_cardio (id, workout_id, sport, date, duration_minutes, distance_m, avg_pace_min_km, avg_hr, max_hr, calories, elevation_m, avg_power_w, avg_cadence, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, args.workout_id ?? null, sport,
          typeof args.date === "string" ? args.date : now.split("T")[0],
          args.duration_minutes ?? null, args.distance_m ?? null,
          args.avg_pace_min_km ?? null, args.avg_hr ?? null, args.max_hr ?? null,
          args.calories ?? null, args.elevation_m ?? null,
          args.avg_power_w ?? null, args.avg_cadence ?? null,
          args.notes ?? "", now,
        );
        return { ok: true, id };
      },
    },
    {
      name: "training.cardio.list",
      handler: async (args) => {
        const limit = Math.min(100, typeof args.limit === "number" ? args.limit : 30);
        const rows = db.prepare(
          "SELECT * FROM training_cardio ORDER BY date DESC, created_at DESC LIMIT ?",
        ).all(limit);
        return { cardio: rows };
      },
    },
    {
      name: "training.programs.list",
      handler: async (args) => {
        const status = typeof args.status === "string" ? args.status : "";
        let where = "1=1";
        const params: unknown[] = [];
        if (status) { where += " AND status = ?"; params.push(status); }
        const rows = db.prepare(
          `SELECT id, name, description, goal, difficulty, days_per_week, duration_weeks, status, start_date, end_date, created_at, updated_at
           FROM training_programs WHERE ${where} ORDER BY updated_at DESC`,
        ).all(...params);
        return { programs: rows };
      },
    },
    {
      name: "training.weeklySummary",
      handler: async (args) => {
        const weeks = typeof args.weeks === "number" ? args.weeks : 4;
        const since = new Date(Date.now() - weeks * 7 * 86400000).toISOString().split("T")[0];
        const workouts = db.prepare(
          "SELECT COUNT(*) as count, SUM(duration_minutes) as total_minutes, SUM(calories_burned) as total_calories FROM training_workouts WHERE date >= ?",
        ).get(since);
        const cardio = db.prepare(
          "SELECT COUNT(*) as count, SUM(duration_minutes) as total_minutes, SUM(distance_m) as total_distance FROM training_cardio WHERE date >= ?",
        ).get(since);
        const prs = db.prepare(
          "SELECT COUNT(*) as count FROM training_prs WHERE date >= ?",
        ).get(since);
        return { period: { from: since, weeks }, workouts, cardio, prs };
      },
    },
  ];
}
