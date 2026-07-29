import type {
  ExtensibleModule,
  DashboardDescriptor,
  ModuleContext,
  ToolDefinition,
} from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { rssReaderMigrations } from "./migrations.js";
import { RssReaderService } from "./service.js";
import { registerRssReaderRoutes } from "./api-routes.js";

export interface RssReaderModule extends ExtensibleModule {
  getService(): RssReaderService | null;
}

export function createRssReaderModule(): RssReaderModule {
  let service: RssReaderService | null = null;

  return {
    name: "rss-reader",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "rss-reader", rssReaderMigrations);
      service = new RssReaderService(ctx.sqlite);
    },

    getTools(): ToolDefinition[] {
      // The reader is a UI consumer of rss-registry — no agent-callable tools.
      return [];
    },

    getService() {
      return service;
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        nav: [
          {
            id: "rss-reader",
            label: "RSS Reader",
            icon: "📰",
            group: "dashboard",
            order: 25,
          },
        ],
        stores: ["rssReader"],
        fetchEndpoints: [
          { url: "/api/reader/rss/bootstrap", store: "rssReader" },
        ],
        registerRoutes: (server) => {
          if (service) registerRssReaderRoutes(server, service);
        },
      };
    },

    async shutdown() {},
  };
}

export default createRssReaderModule;
