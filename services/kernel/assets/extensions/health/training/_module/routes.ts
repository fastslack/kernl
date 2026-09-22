import { HttpError, type KernelHttpServer, type SqliteDb, type EventBus, log } from "@kernl/extension-sdk";
import { TrainingService } from "./service.js";

export function registerTrainingRoutes(
  server: KernelHttpServer,
  db: SqliteDb,
  events?: EventBus,
): void {
  let _trainingSvc: TrainingService | null = null;
  function getTrainingSvc(): TrainingService | null {
    if (_trainingSvc) return _trainingSvc;
    try {
      db.prepare("SELECT 1 FROM training_workouts LIMIT 0").get();
      _trainingSvc = new TrainingService(db);
      return _trainingSvc;
    } catch { return null; }
  }

  const requireTrainingSvc = (): TrainingService => {
    const svc = getTrainingSvc();
    if (!svc) throw new HttpError(500, "Training not available");
    return svc;
  };

  server.route("GET", "/api/training/exercises", () => {
    const svc = getTrainingSvc();
    if (!svc) return { exercises: [] };
    return { exercises: svc.searchExercises() };
  });

  server.route<{
    name: string; sport?: string; mood_before?: number; fatigue_level?: number; notes?: string;
  }>("POST", "/api/training/start-workout", ({ body }) => {
    const svc = requireTrainingSvc();
    if (!body.name) throw new HttpError(400, "name required");
    const workout = svc.startWorkout(body);
    events?.emit("data.changed", { module: "training", action: "start_workout" });
    return workout;
  });

  server.route<{
    workout_id: string; exercise_name: string; reps?: number; weight_kg?: number;
    duration_secs?: number; distance_m?: number; rpe?: number; is_warmup?: boolean; notes?: string;
  }>("POST", "/api/training/log-set", ({ body }) => {
    const svc = requireTrainingSvc();
    if (!body.workout_id || !body.exercise_name) {
      throw new HttpError(400, "workout_id and exercise_name required");
    }
    const set = svc.logSet(body);
    events?.emit("data.changed", { module: "training", action: "log_set" });
    return set;
  });

  server.route<{
    workout_id: string; mood_after?: number; calories_burned?: number; notes?: string;
  }>("POST", "/api/training/finish-workout", ({ body }) => {
    const svc = requireTrainingSvc();
    if (!body.workout_id) throw new HttpError(400, "workout_id required");
    const workout = svc.finishWorkout(body.workout_id, body);
    if (!workout) throw new HttpError(404, "Workout not found");
    events?.emit("data.changed", { module: "training", action: "finish_workout" });
    return workout;
  });

  server.route<{
    sport: string; duration_minutes: number; distance_m?: number;
    avg_hr?: number; max_hr?: number; calories?: number; elevation_m?: number;
    date?: string; notes?: string;
  }>("POST", "/api/training/log-cardio", ({ body }) => {
    const svc = requireTrainingSvc();
    if (!body.sport || !body.duration_minutes) {
      throw new HttpError(400, "sport and duration_minutes required");
    }
    const cardio = svc.logCardio(body);
    events?.emit("data.changed", { module: "training", action: "log_cardio" });
    return cardio;
  });

  server.route<{ workout_id: string }>("POST", "/api/training/delete-workout", ({ body }) => {
    if (!body.workout_id) throw new HttpError(400, "workout_id required");
    db.prepare("DELETE FROM training_sets WHERE workout_id = ?").run(body.workout_id);
    const result = db.prepare("DELETE FROM training_workouts WHERE id = ?").run(body.workout_id);
    log.info(`Delete workout ${body.workout_id}: ${result.changes} rows removed`);
    if (result.changes === 0) throw new HttpError(404, "Workout not found");
    events?.emit("data.changed", { module: "training", action: "delete_workout" });
    return { ok: true, deleted: body.workout_id };
  });

  server.route("GET", "/api/training/workout/:id", ({ params: { id } }) => {
    const workout = requireTrainingSvc().getWorkout(id);
    if (!workout) throw new HttpError(404, "Not found");
    return workout;
  });

  server.route("GET", "/api/training/programs", () => {
    const svc = getTrainingSvc();
    if (!svc) return { programs: [] };
    return { programs: svc.listPrograms() };
  });

  server.route("GET", "/api/training/prs", () => {
    const svc = getTrainingSvc();
    if (!svc) return { prs: [] };
    return { prs: svc.getPrs() };
  });
}
