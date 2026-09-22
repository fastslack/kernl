import {
  type ExtensibleModule,
  type DashboardDescriptor,
  type ModuleContext,
  type ToolDefinition,
  runMigrations,
} from "@kernl/extension-sdk";
import { nutritionMigrations } from "./migrations/001_nutrition.js";
import { NutritionService } from "./service.js";
import { nutritionTools } from "./tools.js";
import { queryNutrition } from "./dashboard-queries.js";
import { nutritionRpcActions } from "./rpc-actions.js";

export function createNutritionModule(): ExtensibleModule {
  let tools: ToolDefinition[] = [];
  let service: NutritionService | null = null;

  return {
    name: "nutrition",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "nutrition", nutritionMigrations);
      service = new NutritionService(ctx.sqlite);
      tools = nutritionTools(service);
    },

    getTools() {
      return tools;
    },

    getRpcActions() {
      return service ? nutritionRpcActions(service) : [];
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
