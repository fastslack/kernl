import type {
  ExtensibleModule,
  DashboardDescriptor,
  ModuleContext,
  ToolDefinition,
} from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { rssRegistryMigrations } from "./migrations.js";
import { RssRegistryService } from "./service.js";
import { RssScheduler } from "./scheduler.js";
import { rssRegistryTools } from "./tools.js";
import { registerRssRegistryRoutes } from "./api-routes.js";
import { rssRegistryRpcActions } from "./rpc-actions.js";
import type { EmbeddingsClient } from "../../../../../src/core/embeddings/client.js";

export interface RssRegistryModule extends ExtensibleModule {
  getService(): RssRegistryService | null;
  /**
   * Wire the kernel's embeddings client post-bootstrap (created after
   * extensions load). Enables semantic relevance ranking of rss items;
   * null degrades to lexical token-overlap ranking.
   */
  setEmbeddingsClient(client: EmbeddingsClient | null): void;
  /**
   * RPC actions exposed by this extension. Registered against the kernel's
   * mtwRpc registry by the bootstrap after the extension loads. Returning
   * an empty list is safe (the service may not be initialized yet).
   */
  getRpcActions(): Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }>;
}

export function createRssRegistryModule(): RssRegistryModule {
  let tools: ToolDefinition[] = [];
  let service: RssRegistryService | null = null;
  let scheduler: RssScheduler | null = null;

  return {
    name: "rss-registry",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "rss-registry", rssRegistryMigrations);
      service = new RssRegistryService(ctx.sqlite, ctx.events);

      // First-run seed: populate the catalog with curated feeds so users
      // don't stare at an empty registry.
      const count = ctx.sqlite
        .prepare("SELECT COUNT(*) as count FROM rss_registry")
        .get() as { count: number };
      if (count.count === 0) {
        try {
          service.seedBuiltins(false);
        } catch {
          // never block boot on seed failures
        }
      }

      tools = rssRegistryTools(service);

      scheduler = new RssScheduler(service);
      scheduler.start();
    },

    getTools() {
      return tools;
    },

    getService() {
      return service;
    },

    setEmbeddingsClient(client: EmbeddingsClient | null) {
      service?.setEmbeddingsClient(client);
    },

    getRpcActions() {
      return service ? rssRegistryRpcActions(service) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        nav: [
          {
            id: "rss-registry",
            label: "RSS Sources",
            icon: "📡",
            group: "system",
            // After Extensions (90). A feed registry is a niche setting; it was
            // heading the System group purely because 65 sorts before 90.
            order: 120,
          },
        ],
        stores: ["rssRegistry"],
        fetchEndpoints: [
          { url: "/api/registry/rss", store: "rssRegistry" },
        ],
        registerRoutes: (server) => {
          if (service) registerRssRegistryRoutes(server, service);
        },
      };
    },

    async shutdown() {
      scheduler?.stop();
    },
  };
}

export default createRssRegistryModule;
