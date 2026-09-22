import { defineModule } from "@kernl/extension-sdk";
import { goalsMigrations } from "./migrations/001_goals.js";
import { GoalsService } from "./service.js";
import { goalsTools } from "./tools.js";
import { queryGoals } from "./dashboard-queries.js";
import { goalsRpcActions } from "./rpc-actions.js";

export function createGoalsModule() {
  return defineModule({
    name: "goals",
    migrations: goalsMigrations,
    async init(ctx) {
      if (ctx.graph?.capabilities.cypher) {
        await ctx.graph.run(
          "CREATE CONSTRAINT goal_id IF NOT EXISTS FOR (g:Goal) REQUIRE g.id IS UNIQUE",
        );
      }
      return new GoalsService(ctx.sqlite, () => ctx.graph);
    },
    tools: (s) => goalsTools(s),
    rpc: (s) => goalsRpcActions(s),
    // Not dashboardChannel: goals also refreshes the calendar channel.
    dashboard: {
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
    },
  });
}
