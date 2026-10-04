import { defineModule, dashboardChannel } from "@kernl/extension-sdk";
import { financeMigrations } from "./migrations/001_finance.js";
import { FinanceService } from "./service.js";
import { financeTools } from "./tools.js";
import { queryFinance } from "./dashboard-query.js";
import { financeRpcActions } from "./rpc-actions.js";

export function createFinanceModule() {
  return defineModule({
    name: "finance",
    migrations: financeMigrations,
    init: (ctx) => new FinanceService(ctx.sqlite, () => ctx.graph),
    tools: financeTools,
    rpc: financeRpcActions,
    dashboard: dashboardChannel("finance", (db) => queryFinance(db)),
  });
}
