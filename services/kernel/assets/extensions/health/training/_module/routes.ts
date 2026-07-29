import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import { TrainingService } from "./service.js";
import { log } from "../../../../../src/core/logger.js";

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

  server.get("/api/training/exercises", (_req, res) => {
    const svc = getTrainingSvc();
    if (!svc) { server.json(res, 200, { exercises: [] }); return; }
    const exercises = svc.searchExercises();
    server.json(res, 200, { exercises });
  });

  server.post("/api/training/start-workout", async (req, res) => {
    const svc = getTrainingSvc();
    if (!svc) { server.json(res, 500, { error: "Training not available" }); return; }
    try {
      const body = await server.parseBody<{
        name: string; sport?: string; mood_before?: number; fatigue_level?: number; notes?: string;
      }>(req);
      if (!body.name) { server.json(res, 400, { error: "name required" }); return; }
      const workout = svc.startWorkout(body);
      events?.emit("data.changed", { module: "training", action: "start_workout" });
      server.json(res, 200, workout);
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.post("/api/training/log-set", async (req, res) => {
    const svc = getTrainingSvc();
    if (!svc) { server.json(res, 500, { error: "Training not available" }); return; }
    try {
      const body = await server.parseBody<{
        workout_id: string; exercise_name: string; reps?: number; weight_kg?: number;
        duration_secs?: number; distance_m?: number; rpe?: number; is_warmup?: boolean; notes?: string;
      }>(req);
      if (!body.workout_id || !body.exercise_name) {
        server.json(res, 400, { error: "workout_id and exercise_name required" }); return;
      }
      const set = svc.logSet(body);
      events?.emit("data.changed", { module: "training", action: "log_set" });
      server.json(res, 200, set);
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.post("/api/training/finish-workout", async (req, res) => {
    const svc = getTrainingSvc();
    if (!svc) { server.json(res, 500, { error: "Training not available" }); return; }
    try {
      const body = await server.parseBody<{
        workout_id: string; mood_after?: number; calories_burned?: number; notes?: string;
      }>(req);
      if (!body.workout_id) { server.json(res, 400, { error: "workout_id required" }); return; }
      const workout = svc.finishWorkout(body.workout_id, body);
      if (!workout) { server.json(res, 404, { error: "Workout not found" }); return; }
      events?.emit("data.changed", { module: "training", action: "finish_workout" });
      server.json(res, 200, workout);
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.post("/api/training/log-cardio", async (req, res) => {
    const svc = getTrainingSvc();
    if (!svc) { server.json(res, 500, { error: "Training not available" }); return; }
    try {
      const body = await server.parseBody<{
        sport: string; duration_minutes: number; distance_m?: number;
        avg_hr?: number; max_hr?: number; calories?: number; elevation_m?: number;
        date?: string; notes?: string;
      }>(req);
      if (!body.sport || !body.duration_minutes) {
        server.json(res, 400, { error: "sport and duration_minutes required" }); return;
      }
      const cardio = svc.logCardio(body);
      events?.emit("data.changed", { module: "training", action: "log_cardio" });
      server.json(res, 200, cardio);
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.post("/api/training/delete-workout", async (req, res) => {
    try {
      const body = await server.parseBody<{ workout_id: string }>(req);
      if (!body.workout_id) { server.json(res, 400, { error: "workout_id required" }); return; }
      db.prepare("DELETE FROM training_sets WHERE workout_id = ?").run(body.workout_id);
      const result = db.prepare("DELETE FROM training_workouts WHERE id = ?").run(body.workout_id);
      log.info(`Delete workout ${body.workout_id}: ${result.changes} rows removed`);
      if (result.changes === 0) {
        server.json(res, 404, { error: "Workout not found" }); return;
      }
      events?.emit("data.changed", { module: "training", action: "delete_workout" });
      server.json(res, 200, { ok: true, deleted: body.workout_id });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.get("/api/training/workout/:id", (req, res) => {
    const svc = getTrainingSvc();
    if (!svc) { server.json(res, 500, { error: "Training not available" }); return; }
    const id = (req as any).params?.id || req.url?.split("/api/training/workout/")[1]?.split("?")[0];
    if (!id) { server.json(res, 400, { error: "id required" }); return; }
    const workout = svc.getWorkout(id);
    if (!workout) { server.json(res, 404, { error: "Not found" }); return; }
    server.json(res, 200, workout);
  });

  server.get("/api/training/programs", (_req, res) => {
    const svc = getTrainingSvc();
    if (!svc) { server.json(res, 200, { programs: [] }); return; }
    const programs = svc.listPrograms();
    server.json(res, 200, { programs });
  });

  server.get("/api/training/prs", (_req, res) => {
    const svc = getTrainingSvc();
    if (!svc) { server.json(res, 200, { prs: [] }); return; }
    const prs = svc.getPrs();
    server.json(res, 200, { prs });
  });
}
