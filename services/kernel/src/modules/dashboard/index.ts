import type { KernelModule, ModuleContext, ToolDefinition } from "../../core/types.js";
import { dashboardTools } from "./tools.js";
import { buildTodayCard } from "./agent-tools.js";

export function createDashboardModule(): KernelModule {
  let tools: ToolDefinition[] = [];

  return {
    name: "dashboard",

    async initialize(ctx: ModuleContext) {
      // Dashboard has no migrations — it reads from other modules' tables
      tools = [...dashboardTools(ctx.sqlite), buildTodayCard(ctx.sqlite)];
    },

    getTools() {
      return tools;
    },

    async shutdown() {},
  };
}
