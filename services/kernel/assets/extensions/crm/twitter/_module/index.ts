import { type ExtensibleModule, defineModule, dashboardChannel } from "@kernl/extension-sdk";
import { twitterMigrations } from "./migrations.js";
import { TwitterService } from "./service.js";
import { TwitterPublisher } from "./publisher.js";
import { twitterTools } from "./tools.js";
import { queryTwitter } from "./dashboard-query.js";
import { registerTwitterRoutes } from "./api-routes.js";
import { twitterDashboardRpcActions } from "./dashboard-rpc-actions.js";

export interface TwitterModule extends ExtensibleModule {
  getService(): TwitterService | null;
  getPublisher(): TwitterPublisher | null;
}

export function createTwitterModule(): TwitterModule {
  let service: TwitterService | null = null;
  let publisher: TwitterPublisher | null = null;

  const mod = defineModule({
    name: "twitter",
    migrations: twitterMigrations,
    init(ctx) {
      service = new TwitterService(ctx.sqlite, ctx.config);
      publisher = new TwitterPublisher(service, ctx.events, ctx.systemRegistry, 60_000);
      return { db: ctx.sqlite, service, publisher };
    },
    tools: (s) => twitterTools(s.service),
    dashboardRpc: (s) =>
      twitterDashboardRpcActions({
        db: s.db,
        twitterService: s.service,
        twitterPublisher: s.publisher,
      }),
    dashboard: dashboardChannel("twitter", (db) => queryTwitter(db), {
      nav: [
        { id: "x-manager", label: "X Manager", icon: "𝕏", group: "people", order: 50 },
      ],
      registerRoutes: (server) => {
        if (service && publisher) {
          registerTwitterRoutes(server, service, publisher);
        }
      },
    }),
    shutdown: (s) => s.publisher.stop(),
  });
  return Object.assign(mod, {
    getService: () => service,
    getPublisher: () => publisher,
  });
}
