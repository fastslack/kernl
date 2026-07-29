import type { ExtensibleModule, DashboardDescriptor, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { timeTrackingMigrations } from "./migrations/001_time_tracking.js";
import { TimeTrackingService } from "./service.js";
import { timeTrackingTools } from "./tools.js";
import { queryTimeTracking } from "./dashboard-queries.js";
import { timeTrackingRpcActions } from "./rpc-actions.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";

export function createTimeTrackingModule(): ExtensibleModule {
  let tools: ToolDefinition[] = [];
  let dbRef: SqliteDb | null = null;

  return {
    name: "time-tracking",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "time-tracking", timeTrackingMigrations);
      dbRef = ctx.sqlite;
      const service = new TimeTrackingService(ctx.sqlite, () => ctx.graph);
      tools = timeTrackingTools(service);
    },

    getTools() {
      return tools;
    },

    getRpcActions() {
      return dbRef ? timeTrackingRpcActions(dbRef) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        channels: [
          { name: "timeTracking", query: (db) => queryTimeTracking(db) },
        ],
        channelMappings: [
          { moduleKey: "time", channels: ["timeTracking"] },
        ],
        stores: ["timeTracking"],
        fetchEndpoints: [
          { url: "/api/dashboard/timeTracking", store: "timeTracking" },
        ],
      };
    },

    async shutdown() {},
  };
}
