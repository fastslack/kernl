/**
 * Training RPC Actions — workouts, sets, PRs, cardio, programs via mtwRequest.
 *
 * The operations shared with the HTTP routes (operations.ts) are exposed
 * under their own names. The older names below keep their argument and
 * result shapes but call the same operations / service methods, so they get
 * the same validation, PR detection and data.changed events.
 */

import { HttpError, pickArgs, rpcActionsFrom, type RpcAction } from "@kernl/extension-sdk";
import { trainingOperations, type TrainingOperationDeps } from "./operations.js";

export function trainingRpcActions(deps: TrainingOperationDeps): RpcAction[] {
  const op = trainingOperations(deps);
  const svc = () => {
    if (!deps.service) throw new HttpError(500, "Training not available");
    return deps.service;
  };

  return rpcActionsFrom({
    ...op,

    "training.workouts.list": (input) => {
      const args = pickArgs(input, { from: "string", limit: "number" });
      return { workouts: svc().listWorkouts({ from: args.from || undefined, limit: Math.min(100, Math.max(10, args.limit ?? 30)) }) };
    },

    "training.workouts.detail": (input) => {
      const id = pickArgs(input, { id: "string" }).id;
      if (!id) throw new HttpError(400, "Missing id");
      const found = svc().getWorkout(id);
      if (!found) throw new HttpError(404, "Not found");
      const { sets, ...workout } = found;
      return { workout, sets };
    },

    "training.workouts.start": (input) => {
      // This name never required one.
      const name = pickArgs(input, { name: "string" }).name?.trim() || "Workout";
      const workout = op["training.startWorkout"]({ ...input, name }) as { id: string };
      return { ok: true, id: workout.id };
    },

    "training.workouts.finish": (input) => {
      const workout = op["training.finishWorkout"]({ ...input, workout_id: input.id ?? input.workout_id }) as { duration_minutes: number | null };
      return { ok: true, duration: workout.duration_minutes };
    },

    "training.sets.log": (input) => {
      const set = op["training.logSet"](input) as { id: string; set_number: number };
      return { ok: true, id: set.id, setNumber: set.set_number };
    },

    "training.cardio.log": (input) => {
      const cardio = op["training.logCardio"](input) as { id: string };
      return { ok: true, id: cardio.id };
    },

    "training.cardio.list": (input) => ({
      cardio: svc().listCardio({ limit: Math.min(100, pickArgs(input, { limit: "number" }).limit ?? 30) }),
    }),

    "training.programs.list": op["training.programs"],

    "training.weeklySummary": (input) => svc().getPeriodTotals(pickArgs(input, { weeks: "number" }).weeks ?? 4),
  });
}
