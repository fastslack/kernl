import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { travelMigrations } from "./migrations/001_travel.js";
import { TravelService } from "./service.js";
import { travelTools } from "./tools.js";

export function createTravelModule(): KernelModule {
  let tools: ToolDefinition[] = [];

  return {
    name: "travel",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "travel", travelMigrations);
      const service = new TravelService(ctx.sqlite);
      tools = travelTools(service);
    },

    getTools() {
      return tools;
    },

    async shutdown() {},
  };
}
