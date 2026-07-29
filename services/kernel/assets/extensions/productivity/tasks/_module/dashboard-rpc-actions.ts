/**
 * Tasks dashboard RPC slice — `dashboard.tasks` panel.
 *
 * Owned by the tasks extension and registered through `getDashboardRpcActions`
 * on the KernelModule contract. Replaces the hand-wired case in the legacy
 * `src/modules/dashboard/rpc-actions.ts`.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import { queryTasks } from "./dashboard-queries.js";

export interface TasksDashboardRpcDeps {
  db: SqliteDb;
}

export function tasksDashboardRpcActions(deps: TasksDashboardRpcDeps): RpcAction[] {
  const { db } = deps;
  return [
    {
      name: "dashboard.tasks",
      handler: async () => queryTasks(db),
    },
  ];
}
