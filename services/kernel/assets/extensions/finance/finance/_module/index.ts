import type { ExtensibleModule, ModuleContext, ToolDefinition, DashboardDescriptor } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { financeMigrations } from "./migrations/001_finance.js";
import { FinanceService } from "./service.js";
import { financeTools } from "./tools.js";
import { queryFinance } from "./dashboard-query.js";
import { financeRpcActions } from "./rpc-actions.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";

export function createFinanceModule(): ExtensibleModule {
  let tools: ToolDefinition[] = [];
  let dbRef: SqliteDb | null = null;

  return {
    name: "finance",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "finance", financeMigrations);
      dbRef = ctx.sqlite;
      const service = new FinanceService(ctx.sqlite, () => ctx.graph);
      tools = financeTools(service);
    },

    getTools() {
      return tools;
    },

    getRpcActions() {
      return dbRef ? financeRpcActions(dbRef) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        channels: [
          { name: "finance", query: (db) => queryFinance(db) },
        ],
        channelMappings: [
          { moduleKey: "finance", channels: ["finance"] },
        ],
        stores: ["finance"],
        fetchEndpoints: [
          { url: "/api/dashboard/finance", store: "finance" },
        ],
      };
    },

    async shutdown() {},
  };
}
