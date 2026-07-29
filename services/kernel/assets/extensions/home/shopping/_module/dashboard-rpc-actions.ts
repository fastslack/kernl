/**
 * Shopping dashboard RPC slice — `dashboard.shopping` panel.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import { queryShopping } from "./dashboard-queries.js";

export interface ShoppingDashboardRpcDeps {
  db: SqliteDb;
}

export function shoppingDashboardRpcActions(deps: ShoppingDashboardRpcDeps): RpcAction[] {
  const { db } = deps;
  return [
    {
      name: "dashboard.shopping",
      handler: async () => queryShopping(db),
    },
  ];
}
