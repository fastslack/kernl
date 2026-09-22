import { defineModule, dashboardChannel, type EventBus } from "@kernl/extension-sdk";
import { trainingMigrations } from "./migrations/001_training.js";
import { TrainingService } from "./service.js";
import { trainingTools } from "./tools.js";
import { queryTraining } from "./dashboard-queries.js";
import { trainingRpcActions } from "./rpc-actions.js";
import { registerTrainingRoutes } from "./routes.js";

export function createTrainingModule() {
  let service: TrainingService | null = null;
  let events: EventBus | null = null;

  return defineModule({
    name: "training",
    migrations: trainingMigrations,
    init(ctx) {
      events = ctx.events;
      service = new TrainingService(ctx.sqlite);
      return service;
    },
    tools: trainingTools,
    rpc: (s) => trainingRpcActions({ service: s, events }),
    dashboard: dashboardChannel("training", (db) => queryTraining(db), {
      nav: [
        { id: "training", label: "Train", icon: "💪", group: "wellness", order: 30 },
      ],
      registerRoutes: (server) => {
        if (service) {
          registerTrainingRoutes(server, service, events ?? undefined);
        }
      },
    }),
  });
}
