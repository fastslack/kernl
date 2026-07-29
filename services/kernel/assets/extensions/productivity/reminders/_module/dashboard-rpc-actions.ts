/**
 * Reminders dashboard RPC slice — `dashboard.reminders` panel.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import { queryReminders } from "./dashboard-queries.js";

export interface RemindersDashboardRpcDeps {
  db: SqliteDb;
}

export function remindersDashboardRpcActions(deps: RemindersDashboardRpcDeps): RpcAction[] {
  const { db } = deps;
  return [
    {
      name: "dashboard.reminders",
      handler: async () => queryReminders(db),
    },
  ];
}
