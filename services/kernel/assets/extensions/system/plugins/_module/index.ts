import type { ExtensibleModule, DashboardDescriptor, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { pluginsMigrations } from "./migrations/001_plugins.js";
import { PluginManagerService } from "./service.js";
import { pluginsTools } from "./tools.js";
import { log } from "../../../../../src/core/logger.js";

export type PluginsModule = ExtensibleModule & {
  getService(): PluginManagerService;
};

export function createPluginsModule(): PluginsModule {
  let tools: ToolDefinition[] = [];
  let service: PluginManagerService;

  return {
    name: "plugins",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "plugins", pluginsMigrations);

      service = new PluginManagerService(ctx.sqlite, () => ctx.graph, ctx.config);
      tools = pluginsTools(service);

      // Register API routes for the extensions dashboard
      if (ctx.config.dashboard.enabled) {
        this.registerApiRoutes(ctx);
      }
    },

    getTools() {
      return tools;
    },

    getService() {
      return service;
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        nav: [
          { id: "extensions", label: "Extensions", icon: "🧩", group: "system", order: 90 },
        ],
        channels: [],
        channelMappings: [],
        stores: [],
        fetchEndpoints: [],
      };
    },

    async shutdown() {},

    // Internal: register HTTP API routes for the plugins dashboard
    registerApiRoutes(ctx: ModuleContext) {
      const server = (ctx as any).httpServer;
      if (!server) return;

      // GET /api/plugins — list installed, repos, registry
      server.get("/api/plugins", (_req: any, res: any) => {
        try {
          const installed = service.listInstalled();
          const repos = service.listRepos();
          const registry = service.browsePlugins();
          server.json(res, 200, { installed, repos, registry });
        } catch (err) {
          server.json(res, 500, { error: String(err) });
        }
      });

      // GET /api/plugins/:name/descriptor — get frontend descriptor
      server.get("/api/plugins/:name/descriptor", async (req: any, res: any) => {
        try {
          const name = req.params?.name ?? req.url?.split("/")[3];
          const descriptor = await service.getFrontendDescriptor(name);
          if (!descriptor) {
            server.json(res, 404, { error: "No descriptor" });
            return;
          }
          server.json(res, 200, descriptor);
        } catch (err) {
          server.json(res, 500, { error: String(err) });
        }
      });

      // GET /api/plugins/:name/data — get plugin dashboard data
      server.get("/api/plugins/:name/data", async (req: any, res: any) => {
        try {
          const name = req.params?.name ?? req.url?.split("/")[3];
          const plugin = service.getInstalledByName(name);
          if (!plugin) {
            server.json(res, 404, { error: "Plugin not found" });
            return;
          }
          // Plugin data comes from its getDashboardData if available
          // For now, return manifest info
          const manifest = service.getManifest(name);
          server.json(res, 200, { manifest, plugin });
        } catch (err) {
          server.json(res, 500, { error: String(err) });
        }
      });
    },
  } as PluginsModule & { registerApiRoutes: (ctx: ModuleContext) => void };
}
