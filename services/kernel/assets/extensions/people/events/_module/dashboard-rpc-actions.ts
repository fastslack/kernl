/**
 * Events dashboard RPC slice — `dashboard.calendar` panel.
 *
 * The `queryCalendar` aggregator still lives in `src/modules/dashboard/api.ts`
 * because it composes events + reminders + meal blocks + system timeline.
 * Once those other queries are extracted we can move the function here.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { SystemRegistry } from "../../../../../src/core/system-registry.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
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
      handler: async (args) => {
        const date = typeof args.date === "string" ? args.date : new Date().toISOString().split("T")[0];
        const limit = typeof args.limit === "number" ? args.limit : 150;
        return queryCalendar(db, date, limit, systemRegistry);
      },
    },
  ];
}
