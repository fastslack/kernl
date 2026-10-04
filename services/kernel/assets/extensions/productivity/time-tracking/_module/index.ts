import { defineModule } from "@kernl/extension-sdk";
import { timeTrackingMigrations } from "./migrations/001_time_tracking.js";
import { TimeTrackingService } from "./service.js";
import { timeTrackingTools } from "./tools.js";
import { queryTimeTracking } from "./dashboard-queries.js";
import { timeTrackingRpcActions } from "./rpc-actions.js";

export function createTimeTrackingModule() {
  return defineModule({
    name: "time-tracking",
    migrations: timeTrackingMigrations,
    init: (ctx) => ({ db: ctx.sqlite, service: new TimeTrackingService(ctx.sqlite, () => ctx.graph) }),
    tools: (s) => timeTrackingTools(s.service),
    rpc: (s) => timeTrackingRpcActions(s.db),
    // Not dashboardChannel: the channel is "timeTracking" but the tool prefix is "time".
    dashboard: {
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
    },
  });
}
