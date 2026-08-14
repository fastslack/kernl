import { join } from "node:path";
import type {
  ExtensibleModule,
  KernelModule,
  ModuleContext,
  ToolDefinition,
  DashboardDescriptor,
} from "../../core/types.js";
import { runMigrations } from "../../core/db/migrations.js";
import { extensionsMigrations } from "./migrations.js";
import { ExtensionService } from "./service.js";
import { extensionsTools } from "./tools.js";
import { registerExtensionsRoutes } from "./api-routes.js";
import { linkPayloadModules } from "./ensure-packages.js";
import type { InstallerDeps } from "./installer.js";

export { loadActiveExtensions } from "./loader.js";
export { seedBuiltinExtensions } from "./seed-builtin.js";
export { ExtensionService } from "./service.js";
export type { InstallerDeps } from "./installer.js";
export type { ExtensionManifest } from "./schema.js";

/**
 * Bootstrap surface: a handle passed around so other parts of the kernel
 * (bootstrap, API routes, facades) can talk to the extension service
 * without re-looking-up the module.
 */
export interface ExtensionsModuleHandle extends ExtensibleModule {
  readonly service: ExtensionService;
}

export function createExtensionsModule(
  options: {
    dataPath: string;
    installerDeps?: Partial<InstallerDeps>;
  },
): ExtensionsModuleHandle {
  let service: ExtensionService | null = null;
  let tools: ToolDefinition[] = [];

  const handle = {
    name: "extensions",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "extensions", extensionsMigrations);

      const deps: InstallerDeps = {
        db: ctx.sqlite,
        skillRegistry: options.installerDeps?.skillRegistry ?? null,
        agentsFacade: options.installerDeps?.agentsFacade ?? null,
        notificationRegistry: options.installerDeps?.notificationRegistry ?? null,
        themeSubsystem: options.installerDeps?.themeSubsystem ?? null,
        sandboxDriverRegistry: options.installerDeps?.sandboxDriverRegistry ?? null,
        llmProviderRegistry: options.installerDeps?.llmProviderRegistry ?? null,
      };

      const extensionsDir = join(options.dataPath, "extensions");
      // Before anything loads: an extension materialized into this directory
      // sits outside the payload's node_modules, and every package it imports
      // without declaring stops resolving there. Re-pointed each boot because
      // the payload path moves with the app version.
      linkPayloadModules(extensionsDir);

      service = new ExtensionService(ctx.sqlite, {
        extensionsDir,
        installerDeps: deps,
        licenseHas: (feature) => ctx.license.has(feature),
      });
      tools = extensionsTools(service);
    },
    getTools() {
      return tools;
    },
    getDashboardDescriptor(): DashboardDescriptor {
      return {
        registerRoutes: (server) => {
          if (service) registerExtensionsRoutes(server, service);
        },
        stores: ["extensions"],
        fetchEndpoints: [{ url: "/api/extensions", store: "extensions" }],
      };
    },
    async shutdown() {
      service = null;
      tools = [];
    },
    get service(): ExtensionService {
      if (!service) {
        throw new Error("extensions module not yet initialized");
      }
      return service;
    },
  };

  return handle;
}
