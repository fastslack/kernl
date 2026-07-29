/**
 * CRM dashboard RPC slice — `dashboard.crm` panel.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import { queryCrm } from "./dashboard-queries.js";

export interface CrmDashboardRpcDeps {
  db: SqliteDb;
}

export function crmDashboardRpcActions(deps: CrmDashboardRpcDeps): RpcAction[] {
  const { db } = deps;
  return [
    {
      name: "dashboard.crm",
      handler: async () => queryCrm(db),
    },
  ];
}
