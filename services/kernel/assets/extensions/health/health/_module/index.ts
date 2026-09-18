import {
  type ExtensibleModule,
  type DashboardDescriptor,
  type ModuleContext,
  type ToolDefinition,
  runMigrations,
  type SqliteDb,
} from "@kernl/extension-sdk";
import { healthMigrations } from "./migrations/001_health.js";
import { HealthService } from "./service.js";
import { healthTools } from "./tools.js";
import { queryHealth } from "./dashboard-queries.js";
import { healthRpcActions } from "./rpc-actions.js";

export function createHealthModule(): ExtensibleModule {
  let tools: ToolDefinition[] = [];
  let dbRef: SqliteDb | null = null;

  return {
    name: "health",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "health", healthMigrations);
      dbRef = ctx.sqlite;
      const service = new HealthService(ctx.sqlite, () => ctx.graph);
      tools = healthTools(service);
    },

    getTools() {
      return tools;
    },

    getRpcActions() {
      return dbRef ? healthRpcActions(dbRef) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        nav: [
          { id: "health", label: "Health", icon: "\u2764", group: "wellness", order: 20 },
        ],
        channels: [
          { name: "health", query: (db) => queryHealth(db) },
        ],
        channelMappings: [
          { moduleKey: "health", channels: ["health", "calendar"] },
        ],
        stores: ["healthData"],
        fetchEndpoints: [
          { url: "/api/dashboard/health", store: "healthData" },
        ],
      };
    },

    async shutdown() {},
  };
}
