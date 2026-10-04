/**
 * Training operations the dashboard reaches over both the WS RPC and HTTP.
 *
 * The training page calls `ctx.rpc(action, body, fallback)` with the action
 * named after the route (`/api/training/log-set` → `training.logSet`). None of
 * those names were registered, so every call failed over WS and landed on the
 * HTTP route; meanwhile the RPC actions that did exist (`training.sets.log`,
 * `training.workouts.start`…) wrote raw SQL and skipped what the service does,
 * PR detection above all. Now each route and its RPC name are this one
 * function over TrainingService: routes.ts binds the paths, rpc-actions.ts
 * exposes the names and adapts its older names onto the same calls.
 */

import { HttpError, log, pickArgs, type EventBus, type Operation } from "@kernl/extension-sdk";
import type { TrainingService } from "./service.js";

export interface TrainingOperationDeps {
  service: TrainingService | null;
  events?: EventBus | null;
}

const CARDIO_FIELDS = {
  sport: "string", duration_minutes: "number", distance_m: "number", avg_pace_min_km: "number",
  avg_hr: "number", max_hr: "number", calories: "number", elevation_m: "number",
  avg_power_w: "number", avg_cadence: "number", date: "string", notes: "string", workout_id: "string",
} as const;

export function trainingOperations(deps: TrainingOperationDeps): Record<string, Operation> {
  const { service, events } = deps;

  const svc = (): TrainingService => {
    if (!service) throw new HttpError(500, "Training not available");
    return service;
  };
  const changed = (action: string) => events?.emit("data.changed", { module: "training", action });

  return {
    "training.exercises": () => ({ exercises: service ? service.searchExercises() : [] }),

    "training.startWorkout": (input) => {
      const args = pickArgs(input, {
        name: "string", sport: "string", program_id: "string", template_id: "string",
        mood_before: "number", fatigue_level: "number", notes: "string",
      });
      const name = args.name?.trim() ?? "";
      if (!name) throw new HttpError(400, "name required");
      const workout = svc().startWorkout({ ...args, name });
      changed("start_workout");
      return workout;
    },

    "training.logSet": (input) => {
      const args = pickArgs(input, {
        workout_id: "string", exercise_name: "string", exercise_id: "string", set_number: "number",
        reps: "number", weight_kg: "number", duration_secs: "number", distance_m: "number",
        rpe: "number", is_warmup: "boolean", notes: "string",
      });
      const exerciseName = args.exercise_name?.trim() ?? "";
      if (!args.workout_id || !exerciseName) {
        throw new HttpError(400, "workout_id and exercise_name required");
      }
      const set = svc().logSet({ ...args, workout_id: args.workout_id, exercise_name: exerciseName });
      changed("log_set");
      return set;
    },

    "training.finishWorkout": (input) => {
      const args = pickArgs(input, { workout_id: "string", mood_after: "number", calories_burned: "number", notes: "string" });
      if (!args.workout_id) throw new HttpError(400, "workout_id required");
      const workout = svc().finishWorkout(args.workout_id, args);
      if (!workout) throw new HttpError(404, "Workout not found");
      changed("finish_workout");
      return workout;
    },

    "training.logCardio": (input) => {
      const args = pickArgs(input, CARDIO_FIELDS);
      const sport = args.sport?.trim() ?? "";
      if (!sport || !args.duration_minutes) {
        throw new HttpError(400, "sport and duration_minutes required");
      }
      const cardio = svc().logCardio({ ...args, sport, duration_minutes: args.duration_minutes });
      changed("log_cardio");
      return cardio;
    },

    "training.deleteWorkout": (input) => {
      const workoutId = pickArgs(input, { workout_id: "string" }).workout_id;
      if (!workoutId) throw new HttpError(400, "workout_id required");
      const deleted = svc().deleteWorkout(workoutId);
      log.info(`Delete workout ${workoutId}: ${deleted ? "removed" : "not found"}`);
      if (!deleted) throw new HttpError(404, "Workout not found");
      changed("delete_workout");
      return { ok: true, deleted: workoutId };
    },

    "training.programs": (input) => {
      const status = pickArgs(input, { status: "string" }).status;
      return { programs: service ? service.listPrograms(status || undefined) : [] };
    },

    "training.prs.list": (input) => {
      const exercise = pickArgs(input, { exercise_name: "string" }).exercise_name;
      return { prs: service ? service.getPrs(exercise || undefined) : [] };
    },
  };
}
