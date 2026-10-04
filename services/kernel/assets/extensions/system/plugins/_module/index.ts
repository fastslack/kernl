import {
  HttpError,
  type ExtensibleModule,
  type KernelHttpServer,
  type ModuleContext,
  defineModule,
} from "@kernl/extension-sdk";
import { pluginsMigrations } from "./migrations/001_plugins.js";
import { PluginManagerService } from "./service.js";
import { pluginsTools } from "./tools.js";

export type PluginsModule = ExtensibleModule & {
  getService(): PluginManagerService;
};

export function createPluginsModule(): PluginsModule {
  let service!: PluginManagerService;

  const mod = defineModule({
    name: "plugins",
    migrations: pluginsMigrations,

    init(ctx) {
      service = new PluginManagerService(ctx.sqlite, () => ctx.graph, ctx.config);

      // Register API routes for the extensions dashboard
      if (ctx.config.dashboard.enabled) {
        registerApiRoutes(ctx, service);
      }
      return service;
    },

    tools: (s) => pluginsTools(s),

    dashboard: {
      nav: [
        { id: "extensions", label: "Extensions", icon: "🧩", group: "system", order: 90 },
      ],
      channels: [],
      channelMappings: [],
      stores: [],
      fetchEndpoints: [],
    },
  });

  return Object.assign(mod, {
    getService() {
      return service;
    },
  });
}

// Internal: register HTTP API routes for the plugins dashboard
function registerApiRoutes(ctx: ModuleContext, service: PluginManagerService) {
  const server = (ctx as unknown as { httpServer?: KernelHttpServer }).httpServer;
  if (!server) return;

  // GET /api/plugins — list installed, repos, registry
  server.route("GET", "/api/plugins", () => {
    const installed = service.listInstalled();
    const repos = service.listRepos();
    const registry = service.browsePlugins();
    return { installed, repos, registry };
  });

  // GET /api/plugins/:name/descriptor — get frontend descriptor
  server.route("GET", "/api/plugins/:name/descriptor", async ({ params: { name } }) => {
    const descriptor = await service.getFrontendDescriptor(name);
    if (!descriptor) throw new HttpError(404, "No descriptor");
    return descriptor;
  });

  // GET /api/plugins/:name/data — get plugin dashboard data
  server.route("GET", "/api/plugins/:name/data", ({ params: { name } }) => {
    const plugin = service.getInstalledByName(name);
    if (!plugin) throw new HttpError(404, "Plugin not found");
    // Plugin data comes from its getDashboardData if available
    // For now, return manifest info
    const manifest = service.getManifest(name);
    return { manifest, plugin };
  });
}
