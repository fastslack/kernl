import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensibleModule, defineModule, log } from "@kernl/extension-sdk";
import { apiRegistryMigrations } from "./migrations/001_api_registry.js";
import { ApiRegistryService } from "./service.js";
import { apiRegistryTools } from "./tools.js";
import { registerApiRegistryRoutes } from "./api-routes.js";
import { apiRegistryDashboardRpcActions } from "./dashboard-rpc-actions.js";
import type { ApiSeedData } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ApiRegistryModule extends ExtensibleModule {
  getService(): ApiRegistryService | null;
}

// Load seed data function
const loadSeedData = async (): Promise<ApiSeedData> => {
  const seedPath = resolve(__dirname, "seed", "apis.json");
  const content = await readFile(seedPath, "utf-8");
  return JSON.parse(content) as ApiSeedData;
};

export function createApiRegistryModule(): ApiRegistryModule {
  let service: ApiRegistryService | null = null;

  return {
    ...defineModule({
      name: "api-registry",
      migrations: apiRegistryMigrations,
      async init(ctx) {
        const encryptionKey = ctx.config.encryption?.key ?? "";
        if (!encryptionKey) {
          log.warn("KERNEL_ENCRYPTION_KEY not set - API keys will not be encrypted securely");
        }

        const svc = new ApiRegistryService(ctx.sqlite, encryptionKey);
        service = svc;

        // Auto-seed if table is empty
        const count = ctx.sqlite.query("SELECT COUNT(*) as count FROM api_registry").get() as { count: number };
        if (count.count === 0) {
          try {
            const data = await loadSeedData();
            await svc.seed(data);
          } catch (err) {
            log.warn(`Auto-seed skipped: ${err}`);
          }
        }
        return svc;
      },
      tools: (svc) => apiRegistryTools(svc, loadSeedData),
      dashboardRpc: (svc) => apiRegistryDashboardRpcActions({ apiRegistryService: svc }),
      dashboard: (svc) => ({
        registerRoutes: (server) => {
          if (svc) registerApiRegistryRoutes(server, svc);
        },
      }),
    }),

    getService() {
      return service;
    },
  };
}

// Export service type for external use
export type { ApiRegistryService } from "./service.js";
