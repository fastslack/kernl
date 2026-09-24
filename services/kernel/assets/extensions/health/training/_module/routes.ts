import { HttpError, type KernelHttpServer, type EventBus } from "@kernl/extension-sdk";
import type { TrainingService } from "./service.js";
import { trainingOperations } from "./operations.js";

type RouteMethod = Parameters<KernelHttpServer["operation"]>[0];

export function registerTrainingRoutes(
  server: KernelHttpServer,
  service: TrainingService | null,
  events?: EventBus,
): void {
  // ── Operations shared with the WS RPC (operations.ts) ─────────
  // The training page names each RPC action after its path, so the two roads
  // reach the same function.
  const op = trainingOperations({ service, events });
  ([
    ["GET", "/api/training/exercises", "training.exercises"],
    ["POST", "/api/training/start-workout", "training.startWorkout"],
    ["POST", "/api/training/log-set", "training.logSet"],
    ["POST", "/api/training/finish-workout", "training.finishWorkout"],
    ["POST", "/api/training/log-cardio", "training.logCardio"],
    ["POST", "/api/training/delete-workout", "training.deleteWorkout"],
    ["GET", "/api/training/programs", "training.programs"],
    ["GET", "/api/training/prs", "training.prs.list"],
  ] as Array<[RouteMethod, string, string]>).forEach(([method, path, name]) => server.operation(method, path, op[name]));

  server.route("GET", "/api/training/workout/:id", ({ params: { id } }) => {
    if (!service) throw new HttpError(500, "Training not available");
    const workout = service.getWorkout(id);
    if (!workout) throw new HttpError(404, "Not found");
    return workout;
  });
}
