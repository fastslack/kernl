/**
 * Events dashboard RPC slice — `dashboard.calendar` panel.
 *
 * The `queryCalendar` aggregator still lives in `src/modules/dashboard/api.ts`
 * because it composes events + reminders + meal blocks + system timeline.
 * Once those other queries are extracted we can move the function here.
 */

import { pickArgs, type SqliteDb, type SystemRegistry, type RpcAction } from "@kernl/extension-sdk";
import { queryCalendar } from "../../../../../src/modules/dashboard/api.js";

export interface EventsDashboardRpcDeps {
  db: SqliteDb;
  systemRegistry: SystemRegistry;
}

export function eventsDashboardRpcActions(deps: EventsDashboardRpcDeps): RpcAction[] {
  const { db, systemRegistry } = deps;
  return [
    {
      name: "dashboard.calendar",
      // Same window as its HTTP twin, GET /api/dashboard/calendar: `start`
      // (default today) and `days` (150 when absent, at most 365). This read
      // `date`/`limit`, which no caller sends, so over WS the planner always
      // got today + 150 days whatever it asked for. Kept as aliases.
      handler: async (args) => {
        const { start, date, days, limit } = pickArgs(args, { start: "string", date: "string", days: "number", limit: "number" });
        const from = start || date || new Date().toISOString().split("T")[0];
        return queryCalendar(db, from, Math.min(days || limit || 150, 365), systemRegistry);
      },
    },
  ];
}
