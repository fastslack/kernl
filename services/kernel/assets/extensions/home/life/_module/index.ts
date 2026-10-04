import { type KernelModule, defineModule, log } from "@kernl/extension-sdk";
import { lifeMigrations } from "./life-migrations.js";
import { LifeService } from "./life-service.js";
import { lifeDashboardRpcActions } from "./dashboard-rpc-actions.js";
import { lifeTools } from "./life-tools.js";

export { LifeService } from "./life-service.js";
export { lifeMigrations } from "./life-migrations.js";

export interface LifeModule extends KernelModule {
  getService(): LifeService | null;
}

export function createLifeModule(): LifeModule {
  // Kept outside the module state: shutdown() drops it, and both
  // getService() and the dashboard RPC actions go empty afterwards.
  let service: LifeService | null = null;

  const mod = defineModule({
    name: "life",
    migrations: lifeMigrations,
    init(ctx) {
      service = new LifeService(ctx.sqlite, ctx.config.life, ctx.systemRegistry);
      log.info("life module initialized");
      return service;
    },
    tools: (s, ctx) => lifeTools(s, ctx.sqlite),
    dashboardRpc: () => (service ? lifeDashboardRpcActions({ lifeService: service }) : []),
    shutdown() {
      service = null;
    },
  });
  return Object.assign(mod, { getService: () => service });
}

export default createLifeModule;
