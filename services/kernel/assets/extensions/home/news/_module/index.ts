import {
  type KernelModule,
  type DashboardDescriptor,
  type EventBus,
  defineModule,
  log,
} from "@kernl/extension-sdk";
import { newsMigrations, seedDefaultFeeds } from "./news-migrations.js";
import { NewsService } from "./news-service.js";
import { newsDashboardRpcActions } from "./dashboard-rpc-actions.js";
import { registerNewsRoutes } from "./routes.js";

export { NewsService } from "./news-service.js";
export { newsMigrations, seedDefaultFeeds } from "./news-migrations.js";

export interface NewsModule extends KernelModule {
  getService(): NewsService | null;
  getDashboardDescriptor?(): DashboardDescriptor;
}

export function createNewsModule(): NewsModule {
  // Kept outside the module state: shutdown() drops it, and getService(),
  // the dashboard RPC actions and the routes go empty afterwards.
  let service: NewsService | null = null;
  let events: EventBus | null = null;

  const mod = defineModule({
    name: "news",
    migrations: newsMigrations,
    init(ctx) {
      seedDefaultFeeds(ctx.sqlite);
      service = new NewsService(ctx.sqlite, () => ctx.graph);
      events = ctx.events;
      log.info("news module initialized");
    },
    dashboardRpc: () => (service ? newsDashboardRpcActions({ newsService: service }) : []),
    dashboard: {
      registerRoutes: (server) => {
        if (service) {
          registerNewsRoutes(server, service, events ?? undefined);
        }
      },
    },
    shutdown() {
      service = null;
    },
  });
  // The descriptor is static, so getDashboardDescriptor never answers null.
  return Object.assign(mod, { getService: () => service }) as NewsModule;
}

export default createNewsModule;
