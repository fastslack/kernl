import { defineModule } from "@kernl/extension-sdk";
import { healthMigrations } from "./migrations/001_health.js";
import { HealthService } from "./service.js";
import { healthTools } from "./tools.js";
import { queryHealth } from "./dashboard-queries.js";
import { healthRpcActions } from "./rpc-actions.js";

export function createHealthModule() {
  return defineModule({
    name: "health",
    migrations: healthMigrations,
    init: (ctx) => new HealthService(ctx.sqlite, () => ctx.graph),
    tools: healthTools,
    rpc: healthRpcActions,
    // Literal, not dashboardChannel(): the store is "healthData" and the
    // module also maps the "calendar" channel.
    dashboard: {
      nav: [
        { id: "health", label: "Health", icon: "❤", group: "wellness", order: 20 },
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
    },
  });
}
