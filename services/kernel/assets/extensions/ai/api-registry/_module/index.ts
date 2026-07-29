import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensibleModule,
  DashboardDescriptor,
  ModuleContext,
  ToolDefinition,
} from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { apiRegistryMigrations } from "./migrations/001_api_registry.js";
import { ApiRegistryService } from "./service.js";
import { apiRegistryTools } from "./tools.js";
import { registerApiRegistryRoutes } from "./api-routes.js";
import { apiRegistryDashboardRpcActions } from "./dashboard-rpc-actions.js";
import type { ApiSeedData } from "./types.js";
import { log } from "../../../../../src/core/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ApiRegistryModule extends ExtensibleModule {
  getService(): ApiRegistryService | null;
}

export function createApiRegistryModule(): ApiRegistryModule {
  let tools: ToolDefinition[] = [];
  let service: ApiRegistryService | null = null;

  return {
    name: "api-registry",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "api-registry", apiRegistryMigrations);

      const encryptionKey = ctx.config.encryption?.key ?? "";
      if (!encryptionKey) {
        log.warn("KERNEL_ENCRYPTION_KEY not set - API keys will not be encrypted securely");
      }

      service = new ApiRegistryService(ctx.sqlite, encryptionKey);

      // Load seed data function
      const loadSeedData = async (): Promise<ApiSeedData> => {
        const seedPath = resolve(__dirname, "seed", "apis.json");
        const content = await readFile(seedPath, "utf-8");
        return JSON.parse(content) as ApiSeedData;
      };

      tools = apiRegistryTools(service, loadSeedData);

      // Auto-seed if table is empty
      const count = ctx.sqlite.query("SELECT COUNT(*) as count FROM api_registry").get() as { count: number };
      if (count.count === 0) {
        try {
          const data = await loadSeedData();
          await service.seed(data);
        } catch (err) {
          log.warn(`Auto-seed skipped: ${err}`);
        }
      }
    },

    getTools() {
      return tools;
    },

    getService() {
      return service;
    },

    getDashboardRpcActions() {
      return service ? apiRegistryDashboardRpcActions({ apiRegistryService: service }) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        registerRoutes: (server) => {
          if (service) registerApiRegistryRoutes(server, service);
        },
      };
    },

    async shutdown() {
      // No cleanup needed
    },
  };
}

// Export service type for external use
export type { ApiRegistryService } from "./service.js";
