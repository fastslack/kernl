import type {
  ExtensibleModule,
  ModuleContext,
  ToolDefinition,
  DashboardDescriptor,
} from "../../core/types.js";
import { runMigrations } from "../../core/db/migrations.js";
import { marketplaceMigrations } from "./migrations.js";
import { MarketplaceService } from "./service.js";
import { marketplaceTools } from "./tools.js";
import { queryMarketplace } from "./dashboard-query.js";
import { registerMarketplaceRoutes } from "./api-routes.js";
import { marketplaceDashboardRpcActions } from "./dashboard-rpc-actions.js";
import { seedBundledItems, seedDefaultThemes } from "./seeders.js";
import { join, resolve } from "node:path";
import { CatalogRegistry } from "./catalog/registry.js";
import { BundledProvider } from "./catalog/bundled-provider.js";
import { RemoteProvider, type RemoteProviderOptions } from "./catalog/remote-provider.js";
import { CatalogReposService } from "./catalog-repos-service.js";
import type { ExtensionService } from "../extensions/service.js";
import type { AgentService } from "../agents/service.js";
import type { SkillRegistry } from "../../skills/registry.js";
import type { Identity } from "../../core/attestation.js";

export interface MarketplaceModule extends ExtensibleModule {
  getService(): MarketplaceService | null;
  /**
   * Wire the unified catalog registry. Called from bootstrap once the
   * extensions service is online so the marketplace can browse + install
   * everything (skills, plugins, bundles, modules, themes) through one path.
   */
  attachCatalog(extensionService: ExtensionService, options?: { rootDir?: string; identity?: Identity | null; cacheDir?: string }): void;
  /** Add a remote catalog provider — fetches items from another kernel /
   *  marketplace and downloads watermarked bundles. */
  addRemoteProvider(opts: RemoteProviderOptions): void;
  /** Subscribed-git-repos service — exposes add/sync/remove/install-all. */
  getReposService(): CatalogReposService | null;
}

export function createMarketplaceModule(
  skillRegistry: SkillRegistry | null,
  agentService: AgentService | null,
): MarketplaceModule {
  let tools: ToolDefinition[] = [];
  let service: MarketplaceService | null = null;
  let reposService: CatalogReposService | null = null;

  return {
    name: "marketplace",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "marketplace", marketplaceMigrations);

      service = new MarketplaceService(ctx.sqlite, ctx.events);
      tools = marketplaceTools(service);

      // Seed bundled items — cross-reference skill registry for statuses
      const skillStatuses: Record<string, string> = {};
      if (skillRegistry) {
        for (const [id, state] of skillRegistry.getAllSkills()) {
          skillStatuses[id] = state.status;
        }
      }
      seedBundledItems(ctx.sqlite, skillStatuses);
      seedDefaultThemes(ctx.sqlite);
    },

    attachCatalog(extensionService, options) {
      if (!service) {
        throw new Error("Marketplace not initialized — call initialize() first");
      }
      const registry = new CatalogRegistry({ extensionService });
      registry.registerProvider(
        new BundledProvider({ rootDir: options?.rootDir ?? process.cwd() }),
      );
      service.setCatalogRegistry(registry);
      if (options?.identity !== undefined) {
        service.setIdentity(options.identity);
      }

      // Subscribed-repos persistence layer. Cache lives at
      // <dataDir>/catalog-cache (or whatever the caller passes); each subscribed
      // repo gets its own subdir keyed by `repoUrlToSlug(url)`.
      const cacheRoot = resolve(options?.cacheDir ?? join(process.cwd(), "data", "catalog-cache"));
      reposService = new CatalogReposService(service.getDb(), registry, cacheRoot);
      reposService.registerAllOnBoot();
      service.setReposService(reposService);
    },

    addRemoteProvider(opts) {
      const svc = service?.getCatalogRegistry();
      if (!svc) {
        throw new Error("Catalog registry not attached — call attachCatalog() first");
      }
      svc.registerProvider(new RemoteProvider(opts));
    },

    getReposService() {
      return reposService;
    },

    getTools() {
      return tools;
    },

    getService() {
      return service;
    },

    getDashboardRpcActions() {
      return service ? marketplaceDashboardRpcActions({ marketplaceService: service }) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        channels: [
          { name: "marketplace", query: (db) => queryMarketplace(db) },
        ],
        channelMappings: [
          { moduleKey: "marketplace", channels: ["marketplace"] },
        ],
        registerRoutes: (server, db) => {
          if (service) {
            registerMarketplaceRoutes(server, service, db);
          }
        },
        stores: ["marketplace"],
        fetchEndpoints: [
          { url: "/api/marketplace", store: "marketplace" },
        ],
      };
    },

    async shutdown() {},
  };
}
