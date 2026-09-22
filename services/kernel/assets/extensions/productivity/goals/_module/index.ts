import {
  type ExtensibleModule,
  type DashboardDescriptor,
  type ModuleContext,
  type ToolDefinition,
  runMigrations,
} from "@kernl/extension-sdk";
import { goalsMigrations } from "./migrations/001_goals.js";
import { GoalsService } from "./service.js";
import { goalsTools } from "./tools.js";
import { queryGoals } from "./dashboard-queries.js";
import { goalsRpcActions } from "./rpc-actions.js";

export function createGoalsModule(): ExtensibleModule {
  let tools: ToolDefinition[] = [];
  let serviceRef: GoalsService | null = null;

  return {
    name: "goals",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "goals", goalsMigrations);

      if (ctx.graph?.capabilities.cypher) {
        await ctx.graph.run(
          "CREATE CONSTRAINT goal_id IF NOT EXISTS FOR (g:Goal) REQUIRE g.id IS UNIQUE",
        );
      }

      const service = new GoalsService(ctx.sqlite, () => ctx.graph);
      serviceRef = service;
      tools = goalsTools(service);
    },

    getTools() {
      return tools;
    },

    getRpcActions() {
      return serviceRef ? goalsRpcActions(serviceRef) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        channels: [
          { name: "goals", query: (db) => queryGoals(db) },
        ],
        channelMappings: [
          { moduleKey: "goals", channels: ["goals", "calendar"] },
        ],
        stores: ["goals"],
        fetchEndpoints: [
          { url: "/api/dashboard/goals", store: "goals" },
        ],
      };
    },

    async shutdown() {},
  };
}
