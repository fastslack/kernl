import type { ExtensibleModule, DashboardDescriptor, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { trainingMigrations } from "./migrations/001_training.js";
import { TrainingService } from "./service.js";
import { trainingTools } from "./tools.js";
import { queryTraining } from "./dashboard-queries.js";
import { trainingRpcActions } from "./rpc-actions.js";
import { registerTrainingRoutes } from "./routes.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";

export function createTrainingModule(): ExtensibleModule {
  let tools: ToolDefinition[] = [];
  let dbRef: SqliteDb | null = null;
  let eventsRef: EventBus | null = null;

  return {
    name: "training",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "training", trainingMigrations);
      dbRef = ctx.sqlite;
      eventsRef = ctx.events;
      const service = new TrainingService(ctx.sqlite);
      tools = trainingTools(service);
    },

    getTools() {
      return tools;
    },

    getRpcActions() {
      return dbRef ? trainingRpcActions(dbRef) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        nav: [
          { id: "training", label: "Train", icon: "\uD83D\uDCAA", group: "wellness", order: 30 },
        ],
        channels: [
          { name: "training", query: (db) => queryTraining(db) },
        ],
        channelMappings: [
          { moduleKey: "training", channels: ["training"] },
        ],
        stores: ["training"],
        fetchEndpoints: [
          { url: "/api/dashboard/training", store: "training" },
        ],
        registerRoutes: (server) => {
          if (dbRef) {
            registerTrainingRoutes(server, dbRef, eventsRef ?? undefined);
          }
        },
      };
    },

    async shutdown() {},
  };
}
