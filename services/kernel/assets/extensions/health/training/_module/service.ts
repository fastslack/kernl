import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type {
  TrainingExercise, TrainingProgram, TrainingSessionTemplate,
  TrainingTemplateExercise, TrainingWorkout, TrainingSet,
  TrainingPr, TrainingCardio, ExerciseCategory, Equipment,
  ProgramGoal, ProgramDifficulty, PrType,
} from "./types.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

export class TrainingService {
  constructor(private db: SqliteDb) {
    this.seedDefaultExercises();
  }

  // ── Exercise Library ──────────────────────────────────────────────────────

  addExercise(input: {
    name: string; category?: ExerciseCategory; muscle_groups?: string[];
    equipment?: Equipment; instructions?: string; notes?: string;
  }): TrainingExercise {
    const ex: TrainingExercise = {
      id: newId(), name: input.name,
      category: input.category ?? "strength",
      muscle_groups: JSON.stringify(input.muscle_groups ?? []),
      equipment: input.equipment ?? "none",
      instructions: input.instructions ?? "",
      notes: input.notes ?? "", created_at: isoNow(),
    };
    this.db.prepare(`
      INSERT INTO training_exercises (id,name,category,muscle_groups,equipment,instructions,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(ex.id,ex.name,ex.category,ex.muscle_groups,ex.equipment,ex.instructions,ex.notes,ex.created_at);
    return ex;
  }

  searchExercises(query?: string, category?: ExerciseCategory, equipment?: Equipment): TrainingExercise[] {
    let sql = "SELECT * FROM training_exercises WHERE 1=1";
    const params: unknown[] = [];
    if (query) { sql += " AND name LIKE ?"; params.push(`%${query}%`); }
    if (category) { sql += " AND category = ?"; params.push(category); }
    if (equipment) { sql += " AND equipment = ?"; params.push(equipment); }
    sql += " ORDER BY name ASC";
    return this.db.prepare(sql).all(...params) as TrainingExercise[];
  }

  // ── Programs ──────────────────────────────────────────────────────────────

  createProgram(input: {
    name: string; description?: string; goal?: ProgramGoal;
    difficulty?: ProgramDifficulty; days_per_week?: number;
    duration_weeks?: number; start_date?: string; notes?: string;
  }): TrainingProgram {
    const now = isoNow();
    const program: TrainingProgram = {
      id: newId(), name: input.name, description: input.description ?? "",
      goal: input.goal ?? "general", difficulty: input.difficulty ?? "intermediate",
      days_per_week: input.days_per_week ?? 3, duration_weeks: input.duration_weeks ?? 8,
      status: "active",
      start_date: input.start_date ?? null, end_date: null,
      notes: input.notes ?? "", created_at: now, updated_at: now,
    };
    this.db.prepare(`
      INSERT INTO training_programs (id,name,description,goal,difficulty,days_per_week,duration_weeks,status,start_date,end_date,notes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(program.id,program.name,program.description,program.goal,program.difficulty,
           program.days_per_week,program.duration_weeks,program.status,program.start_date,
           program.end_date,program.notes,program.created_at,program.updated_at);
    return program;
  }

  listPrograms(status?: string): TrainingProgram[] {
    if (status) return this.db.prepare("SELECT * FROM training_programs WHERE status = ? ORDER BY created_at DESC").all(status) as TrainingProgram[];
    return this.db.prepare("SELECT * FROM training_programs ORDER BY status ASC, created_at DESC").all() as TrainingProgram[];
  }

  getProgram(id: string): TrainingProgram | undefined {
    return this.db.prepare("SELECT * FROM training_programs WHERE id = ?").get(id) as TrainingProgram | undefined;
  }

  addSessionTemplate(input: {
    program_id: string; name: string; day_of_week?: number;
    week_number?: number; order_index?: number; notes?: string;
  }): TrainingSessionTemplate {
    const session: TrainingSessionTemplate = {
      id: newId(), program_id: input.program_id, name: input.name,
      day_of_week: input.day_of_week ?? null,
      week_number: input.week_number ?? null,
      order_index: input.order_index ?? 0,
      notes: input.notes ?? "", created_at: isoNow(),
    };
    this.db.prepare(`
      INSERT INTO training_sessions_template (id,program_id,name,day_of_week,week_number,order_index,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(session.id,session.program_id,session.name,session.day_of_week,
           session.week_number,session.order_index,session.notes,session.created_at);
    return session;
  }

  addTemplateExercise(input: {
    session_id: string; exercise_name: string; exercise_id?: string;
    sets?: number; reps?: string; weight_kg?: number; duration_secs?: number;
    rest_secs?: number; rpe?: number; notes?: string; order_index?: number;
  }): TrainingTemplateExercise {
    const ex: TrainingTemplateExercise = {
      id: newId(), session_id: input.session_id,
      exercise_id: input.exercise_id ?? null,
      exercise_name: input.exercise_name,
      sets: input.sets ?? 3, reps: input.reps ?? "8-12",
      weight_kg: input.weight_kg ?? null,
      duration_secs: input.duration_secs ?? null,
      rest_secs: input.rest_secs ?? 60,
      rpe: input.rpe ?? null,
      notes: input.notes ?? "", order_index: input.order_index ?? 0,
    };
    this.db.prepare(`
      INSERT INTO training_template_exercises (id,session_id,exercise_id,exercise_name,sets,reps,weight_kg,duration_secs,rest_secs,rpe,notes,order_index)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(ex.id,ex.session_id,ex.exercise_id,ex.exercise_name,ex.sets,ex.reps,
           ex.weight_kg,ex.duration_secs,ex.rest_secs,ex.rpe,ex.notes,ex.order_index);
    return ex;
  }

  // ── Workout Log ───────────────────────────────────────────────────────────

  startWorkout(input: {
    name: string; sport?: string; program_id?: string; template_id?: string;
    mood_before?: number; fatigue_level?: number; notes?: string;
  }): TrainingWorkout {
    const now = isoNow();
    const workout: TrainingWorkout = {
      id: newId(), name: input.name,
      sport: input.sport ?? "strength",
      program_id: input.program_id ?? null,
      template_id: input.template_id ?? null,
      date: now.split("T")[0], start_time: now, end_time: null,
      duration_minutes: null, calories_burned: null,
      notes: input.notes ?? "",
      mood_before: input.mood_before ?? null,
      mood_after: null, fatigue_level: input.fatigue_level ?? null,
      created_at: now,
    };
    this.db.prepare(`
      INSERT INTO training_workouts (id,program_id,template_id,name,sport,date,start_time,end_time,duration_minutes,calories_burned,notes,mood_before,mood_after,fatigue_level,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(workout.id,workout.program_id,workout.template_id,workout.name,workout.sport,
           workout.date,workout.start_time,workout.end_time,workout.duration_minutes,
           workout.calories_burned,workout.notes,workout.mood_before,workout.mood_after,
           workout.fatigue_level,workout.created_at);
    return workout;
  }

  finishWorkout(id: string, input?: { mood_after?: number; calories_burned?: number; notes?: string }): TrainingWorkout | undefined {
    const workout = this.db.prepare("SELECT * FROM training_workouts WHERE id = ?").get(id) as TrainingWorkout | undefined;
    if (!workout) return undefined;
    const now = isoNow();
    const duration = Math.round((new Date(now).getTime() - new Date(workout.start_time).getTime()) / 60000);
    this.db.prepare(`
      UPDATE training_workouts SET end_time=?,duration_minutes=?,mood_after=?,calories_burned=?,notes=? WHERE id=?
    `).run(now, duration, input?.mood_after ?? null, input?.calories_burned ?? null, input?.notes ?? workout.notes, id);
    return { ...workout, end_time: now, duration_minutes: duration };
  }

  logSet(input: {
    workout_id: string; exercise_name: string; exercise_id?: string;
    set_number?: number; reps?: number; weight_kg?: number;
    duration_secs?: number; distance_m?: number; rpe?: number;
    is_warmup?: boolean; notes?: string;
  }): TrainingSet {
    const existingSets = this.db.prepare(
      "SELECT COUNT(*) as c FROM training_sets WHERE workout_id = ? AND exercise_name = ?"
    ).get(input.workout_id, input.exercise_name) as { c: number };

    const set: TrainingSet = {
      id: newId(), workout_id: input.workout_id,
      exercise_id: input.exercise_id ?? null,
      exercise_name: input.exercise_name,
      set_number: input.set_number ?? (existingSets.c + 1),
      reps: input.reps ?? null, weight_kg: input.weight_kg ?? null,
      duration_secs: input.duration_secs ?? null,
      distance_m: input.distance_m ?? null,
      rpe: input.rpe ?? null,
      is_warmup: input.is_warmup ? 1 : 0,
      is_pr: 0, notes: input.notes ?? "", created_at: isoNow(),
    };

    // Check if PR
    if (input.weight_kg && input.reps) {
      const volume = input.weight_kg * input.reps;
      const prevBest = this.db.prepare(`
        SELECT MAX(ts.weight_kg * ts.reps) as best FROM training_sets ts
        WHERE ts.exercise_name = ? AND ts.is_warmup = 0 AND ts.workout_id != ?
      `).get(input.exercise_name, input.workout_id) as { best: number | null };
      if (!prevBest.best || volume > prevBest.best) {
        set.is_pr = 1;
        this.recordPr({ exercise_name: input.exercise_name, pr_type: "volume", value: volume, unit: "kg*reps", workout_id: input.workout_id, date: new Date().toISOString().split("T")[0] });
      }
    }

    this.db.prepare(`
      INSERT INTO training_sets (id,workout_id,exercise_id,exercise_name,set_number,reps,weight_kg,duration_secs,distance_m,rpe,is_warmup,is_pr,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(set.id,set.workout_id,set.exercise_id,set.exercise_name,set.set_number,
           set.reps,set.weight_kg,set.duration_secs,set.distance_m,set.rpe,
           set.is_warmup,set.is_pr,set.notes,set.created_at);

    return set;
  }

  getWorkout(id: string): (TrainingWorkout & { sets: TrainingSet[] }) | undefined {
    const workout = this.db.prepare("SELECT * FROM training_workouts WHERE id = ?").get(id) as TrainingWorkout | undefined;
    if (!workout) return undefined;
    const sets = this.db.prepare("SELECT * FROM training_sets WHERE workout_id = ? ORDER BY exercise_name, set_number").all(id) as TrainingSet[];
    return { ...workout, sets };
  }

  listWorkouts(filters?: { from?: string; to?: string; program_id?: string; sport?: string; limit?: number }): TrainingWorkout[] {
    let sql = "SELECT * FROM training_workouts WHERE 1=1";
    const params: unknown[] = [];
    if (filters?.from) { sql += " AND date >= ?"; params.push(filters.from); }
    if (filters?.to) { sql += " AND date <= ?"; params.push(filters.to); }
    if (filters?.program_id) { sql += " AND program_id = ?"; params.push(filters.program_id); }
    if (filters?.sport) { sql += " AND sport = ?"; params.push(filters.sport); }
    sql += " ORDER BY date DESC, start_time DESC";
    if (filters?.limit) { sql += " LIMIT ?"; params.push(filters.limit); }
    return this.db.prepare(sql).all(...params) as TrainingWorkout[];
  }

  // ── PRs ───────────────────────────────────────────────────────────────────

  recordPr(input: { exercise_name: string; pr_type: PrType; value: number; unit?: string; workout_id?: string; date?: string; notes?: string }): TrainingPr {
    const pr: TrainingPr = {
      id: newId(), exercise_name: input.exercise_name,
      pr_type: input.pr_type, value: input.value,
      unit: input.unit ?? "kg",
      workout_id: input.workout_id ?? null,
      date: input.date ?? isoNow().split("T")[0],
      notes: input.notes ?? "", created_at: isoNow(),
    };
    this.db.prepare(`
      INSERT INTO training_prs (id,exercise_name,pr_type,value,unit,workout_id,date,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(pr.id,pr.exercise_name,pr.pr_type,pr.value,pr.unit,pr.workout_id,pr.date,pr.notes,pr.created_at);
    return pr;
  }

  getPrs(exerciseName?: string): TrainingPr[] {
    if (exerciseName) {
      return this.db.prepare(
        "SELECT * FROM training_prs WHERE exercise_name LIKE ? ORDER BY date DESC"
      ).all(`%${exerciseName}%`) as TrainingPr[];
    }
    // Latest PR per exercise per type
    return this.db.prepare(`
      SELECT p.* FROM training_prs p
      INNER JOIN (
        SELECT exercise_name, pr_type, MAX(date) as max_date
        FROM training_prs GROUP BY exercise_name, pr_type
      ) latest ON p.exercise_name = latest.exercise_name AND p.pr_type = latest.pr_type AND p.date = latest.max_date
      ORDER BY p.date DESC
    `).all() as TrainingPr[];
  }

  // ── Cardio ────────────────────────────────────────────────────────────────

  logCardio(input: {
    sport: string; duration_minutes: number; distance_m?: number;
    avg_pace_min_km?: number; avg_hr?: number; max_hr?: number;
    calories?: number; elevation_m?: number; avg_power_w?: number;
    avg_cadence?: number; date?: string; notes?: string; workout_id?: string;
  }): TrainingCardio {
    const cardio: TrainingCardio = {
      id: newId(), workout_id: input.workout_id ?? null,
      sport: input.sport,
      date: input.date ?? isoNow().split("T")[0],
      duration_minutes: input.duration_minutes,
      distance_m: input.distance_m ?? null,
      avg_pace_min_km: input.avg_pace_min_km ?? (input.distance_m
        ? Math.round(input.duration_minutes / (input.distance_m / 1000) * 100) / 100 : null),
      avg_hr: input.avg_hr ?? null, max_hr: input.max_hr ?? null,
      calories: input.calories ?? null, elevation_m: input.elevation_m ?? null,
      avg_power_w: input.avg_power_w ?? null, avg_cadence: input.avg_cadence ?? null,
      notes: input.notes ?? "", created_at: isoNow(),
    };
    this.db.prepare(`
      INSERT INTO training_cardio (id,workout_id,sport,date,duration_minutes,distance_m,avg_pace_min_km,avg_hr,max_hr,calories,elevation_m,avg_power_w,avg_cadence,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(cardio.id,cardio.workout_id,cardio.sport,cardio.date,cardio.duration_minutes,
           cardio.distance_m,cardio.avg_pace_min_km,cardio.avg_hr,cardio.max_hr,
           cardio.calories,cardio.elevation_m,cardio.avg_power_w,cardio.avg_cadence,
           cardio.notes,cardio.created_at);
    return cardio;
  }

  listCardio(filters?: { sport?: string; from?: string; to?: string; limit?: number }): TrainingCardio[] {
    let sql = "SELECT * FROM training_cardio WHERE 1=1";
    const params: unknown[] = [];
    if (filters?.sport) { sql += " AND sport = ?"; params.push(filters.sport); }
    if (filters?.from) { sql += " AND date >= ?"; params.push(filters.from); }
    if (filters?.to) { sql += " AND date <= ?"; params.push(filters.to); }
    sql += " ORDER BY date DESC";
    if (filters?.limit) { sql += " LIMIT ?"; params.push(filters.limit); }
    return this.db.prepare(sql).all(...params) as TrainingCardio[];
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  getStrengthProgress(exerciseName: string, weeks = 12): {
    exercise: string; data: Array<{ date: string; max_weight: number; max_volume: number; sets: number }>
  } {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - weeks * 7);
    const rows = this.db.prepare(`
      SELECT tw.date,
             MAX(ts.weight_kg) as max_weight,
             MAX(ts.weight_kg * ts.reps) as max_volume,
             COUNT(*) as sets
      FROM training_sets ts
      JOIN training_workouts tw ON ts.workout_id = tw.id
      WHERE ts.exercise_name LIKE ? AND ts.is_warmup = 0 AND tw.date >= ?
      GROUP BY tw.date ORDER BY tw.date ASC
    `).all(`%${exerciseName}%`, cutoff.toISOString().split("T")[0]) as Array<{ date: string; max_weight: number; max_volume: number; sets: number }>;

    return { exercise: exerciseName, data: rows };
  }

  getWeeklySummary(weeks = 4): Array<{
    week: string; workouts: number; total_sets: number; total_volume_kg: number; cardio_minutes: number;
  }> {
    const results = [];
    const today = new Date();
    for (let i = weeks - 1; i >= 0; i--) {
      const weekStart = new Date(today);
      weekStart.setDate(weekStart.getDate() - i * 7 - weekStart.getDay());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      const from = weekStart.toISOString().split("T")[0];
      const to = weekEnd.toISOString().split("T")[0];

      const workouts = this.db.prepare("SELECT COUNT(*) as c FROM training_workouts WHERE date >= ? AND date <= ?").get(from, to) as { c: number };
      const sets = this.db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(weight_kg * reps), 0) as vol FROM training_sets ts JOIN training_workouts tw ON ts.workout_id = tw.id WHERE tw.date >= ? AND tw.date <= ? AND ts.is_warmup = 0").get(from, to) as { c: number; vol: number };
      const cardio = this.db.prepare("SELECT COALESCE(SUM(duration_minutes), 0) as mins FROM training_cardio WHERE date >= ? AND date <= ?").get(from, to) as { mins: number };

      results.push({
        week: from, workouts: workouts.c, total_sets: sets.c,
        total_volume_kg: Math.round(sets.vol), cardio_minutes: Math.round(cardio.mins),
      });
    }
    return results;
  }

  private seedDefaultExercises(): void {
    const count = this.db.prepare("SELECT COUNT(*) as c FROM training_exercises").get() as { c: number };
    if (count.c > 0) return;

    const defaults: Array<{ name: string; category: ExerciseCategory; muscle_groups: string[]; equipment: Equipment }> = [
      { name: "Squat", category: "strength", muscle_groups: ["quads", "glutes", "hamstrings"], equipment: "barbell" },
      { name: "Bench Press", category: "strength", muscle_groups: ["chest", "triceps", "shoulders"], equipment: "barbell" },
      { name: "Deadlift", category: "strength", muscle_groups: ["hamstrings", "glutes", "back", "traps"], equipment: "barbell" },
      { name: "Overhead Press", category: "strength", muscle_groups: ["shoulders", "triceps"], equipment: "barbell" },
      { name: "Pull-up", category: "strength", muscle_groups: ["lats", "biceps", "rhomboids"], equipment: "bodyweight" },
      { name: "Push-up", category: "strength", muscle_groups: ["chest", "triceps", "shoulders"], equipment: "bodyweight" },
      { name: "Dumbbell Row", category: "strength", muscle_groups: ["lats", "rhomboids", "biceps"], equipment: "dumbbell" },
      { name: "Romanian Deadlift", category: "strength", muscle_groups: ["hamstrings", "glutes"], equipment: "barbell" },
      { name: "Plank", category: "strength", muscle_groups: ["core"], equipment: "bodyweight" },
      { name: "Running", category: "cardio", muscle_groups: ["legs", "cardio"], equipment: "none" },
      { name: "Cycling", category: "cardio", muscle_groups: ["legs", "cardio"], equipment: "cardio_machine" },
      { name: "Swimming", category: "cardio", muscle_groups: ["full_body", "cardio"], equipment: "none" },
    ];

    for (const ex of defaults) {
      this.addExercise(ex);
    }
  }
}
