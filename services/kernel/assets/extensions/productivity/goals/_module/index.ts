import type { ExtensibleModule, DashboardDescriptor, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { goalsMigrations } from "./migrations/001_goals.js";
import { GoalsService } from "./service.js";
import { goalsTools } from "./tools.js";
import { queryGoals } from "./dashboard-queries.js";
import { goalsRpcActions } from "./rpc-actions.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";

export function createGoalsModule(): ExtensibleModule {
  let tools: ToolDefinition[] = [];
  let dbRef: SqliteDb | null = null;

  return {
    name: "goals",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "goals", goalsMigrations);
      dbRef = ctx.sqlite;

      if (ctx.graph?.capabilities.cypher) {
        await ctx.graph.run(
          "CREATE CONSTRAINT goal_id IF NOT EXISTS FOR (g:Goal) REQUIRE g.id IS UNIQUE",
        );
      }

      const service = new GoalsService(ctx.sqlite, () => ctx.graph);
      tools = goalsTools(service);
    },

    getTools() {
      return tools;
    },

    getRpcActions() {
      return dbRef ? goalsRpcActions(dbRef) : [];
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
