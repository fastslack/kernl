import type { KernelModule, ModuleContext, ToolDefinition, DashboardDescriptor } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { newsMigrations, seedDefaultFeeds } from "./news-migrations.js";
import { NewsService } from "./news-service.js";
import { newsDashboardRpcActions } from "./dashboard-rpc-actions.js";
import { registerNewsRoutes } from "./routes.js";
import { log } from "../../../../../src/core/logger.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";

export { NewsService } from "./news-service.js";
export { newsMigrations, seedDefaultFeeds } from "./news-migrations.js";

export interface NewsModule extends KernelModule {
  getService(): NewsService | null;
  getDashboardDescriptor?(): DashboardDescriptor;
}

export function createNewsModule(): NewsModule {
  let service: NewsService | null = null;
  let eventsRef: EventBus | null = null;

  return {
    name: "news",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "news", newsMigrations);
      seedDefaultFeeds(ctx.sqlite);
      service = new NewsService(ctx.sqlite, () => ctx.graph);
      eventsRef = ctx.events;
      log.info("news module initialized");
    },

    getTools(): ToolDefinition[] {
      return [];
    },

    getService() {
      return service;
    },

    getDashboardRpcActions() {
      return service ? newsDashboardRpcActions({ newsService: service }) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        registerRoutes: (server) => {
          if (service) {
            registerNewsRoutes(server, service, eventsRef ?? undefined);
          }
        },
      };
    },

    async shutdown() {
      service = null;
    },
  };
}

export default createNewsModule;
