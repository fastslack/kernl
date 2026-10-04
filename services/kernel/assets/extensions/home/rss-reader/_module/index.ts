import { type ExtensibleModule, defineModule } from "@kernl/extension-sdk";
import { rssReaderMigrations } from "./migrations.js";
import { RssReaderService } from "./service.js";
import { registerRssReaderRoutes } from "./api-routes.js";

export interface RssReaderModule extends ExtensibleModule {
  getService(): RssReaderService | null;
}

export function createRssReaderModule(): RssReaderModule {
  let service: RssReaderService | null = null;

  // The reader is a UI consumer of rss-registry — no agent-callable tools.
  const mod = defineModule({
    name: "rss-reader",
    migrations: rssReaderMigrations,
    init(ctx) {
      service = new RssReaderService(ctx.sqlite);
    },
    dashboard: {
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
    },
  });
  return Object.assign(mod, { getService: () => service });
}

export default createRssReaderModule;
