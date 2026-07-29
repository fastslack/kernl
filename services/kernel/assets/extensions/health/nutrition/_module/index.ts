import type { ExtensibleModule, DashboardDescriptor, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { nutritionMigrations } from "./migrations/001_nutrition.js";
import { NutritionService } from "./service.js";
import { nutritionTools } from "./tools.js";
import { queryNutrition } from "./dashboard-queries.js";
import { nutritionRpcActions } from "./rpc-actions.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";

export function createNutritionModule(): ExtensibleModule {
  let tools: ToolDefinition[] = [];
  let dbRef: SqliteDb | null = null;

  return {
    name: "nutrition",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "nutrition", nutritionMigrations);
      dbRef = ctx.sqlite;
      const service = new NutritionService(ctx.sqlite);
      tools = nutritionTools(service);
    },

    getTools() {
      return tools;
    },

    getRpcActions() {
      return dbRef ? nutritionRpcActions(dbRef) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        nav: [
          { id: "nutrition", label: "Food", icon: "\uD83E\uDD57", group: "wellness", order: 40 },
        ],
        channels: [
          { name: "nutrition", query: (db) => queryNutrition(db) },
        ],
        channelMappings: [
          { moduleKey: "nutrition", channels: ["nutrition"] },
        ],
        stores: ["nutrition"],
        fetchEndpoints: [
          { url: "/api/dashboard/nutrition", store: "nutrition" },
        ],
      };
    },

    async shutdown() {},
  };
}
