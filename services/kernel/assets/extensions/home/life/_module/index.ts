import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { lifeMigrations } from "./life-migrations.js";
import { LifeService } from "./life-service.js";
import { lifeDashboardRpcActions } from "./dashboard-rpc-actions.js";
import { lifeTools } from "./life-tools.js";
import { log } from "../../../../../src/core/logger.js";

export { LifeService } from "./life-service.js";
export { lifeMigrations } from "./life-migrations.js";

export interface LifeModule extends KernelModule {
  getService(): LifeService | null;
}

export function createLifeModule(): LifeModule {
  let service: LifeService | null = null;
  let tools: ToolDefinition[] = [];

  return {
    name: "life",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "life", lifeMigrations);
      service = new LifeService(ctx.sqlite, ctx.config.life, ctx.systemRegistry);
      tools = lifeTools(service, ctx.sqlite);
      log.info("life module initialized");
    },

    getTools(): ToolDefinition[] {
      return tools;
    },

    getService() {
      return service;
    },

    getDashboardRpcActions() {
      return service ? lifeDashboardRpcActions({ lifeService: service }) : [];
    },

    async shutdown() {
      service = null;
    },
  };
}

export default createLifeModule;
