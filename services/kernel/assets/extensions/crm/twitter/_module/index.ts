import type { ExtensibleModule, DashboardDescriptor, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { twitterMigrations } from "./migrations.js";
import { TwitterService } from "./service.js";
import { TwitterPublisher } from "./publisher.js";
import { twitterTools } from "./tools.js";
import { queryTwitter } from "./dashboard-query.js";
import { registerTwitterRoutes } from "./api-routes.js";
import { twitterDashboardRpcActions } from "./dashboard-rpc-actions.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";

export interface TwitterModule extends ExtensibleModule {
  getService(): TwitterService | null;
  getPublisher(): TwitterPublisher | null;
}

export function createTwitterModule(): TwitterModule {
  let tools: ToolDefinition[] = [];
  let service: TwitterService | null = null;
  let publisher: TwitterPublisher | null = null;
  let dbRef: SqliteDb | null = null;

  return {
    name: "twitter",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "twitter", twitterMigrations);
      dbRef = ctx.sqlite;
      service = new TwitterService(ctx.sqlite, ctx.config);
      publisher = new TwitterPublisher(service, ctx.events, ctx.systemRegistry, 60_000);
      tools = twitterTools(service);
    },

    getTools() {
      return tools;
    },

    getService() {
      return service;
    },

    getPublisher() {
      return publisher;
    },

    getDashboardRpcActions() {
      if (!dbRef) return [];
      return twitterDashboardRpcActions({
        db: dbRef,
        twitterService: service,
        twitterPublisher: publisher,
      });
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        nav: [
          { id: "x-manager", label: "X Manager", icon: "𝕏", group: "people", order: 50 },
        ],
        channels: [
          { name: "twitter", query: (db) => queryTwitter(db) },
        ],
        channelMappings: [
          { moduleKey: "twitter", channels: ["twitter"] },
        ],
        stores: ["twitter"],
        fetchEndpoints: [
          { url: "/api/dashboard/twitter", store: "twitter" },
        ],
        registerRoutes: (server, db) => {
          if (service && publisher) {
            registerTwitterRoutes(server, service, publisher);
          }
        },
      };
    },

    async shutdown() {
      publisher?.stop();
    },
  };
}
