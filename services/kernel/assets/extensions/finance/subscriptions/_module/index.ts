import {
  type ExtensibleModule,
  type DashboardDescriptor,
  type ModuleContext,
  type ToolDefinition,
  runMigrations,
  type SqliteDb,
} from "@kernl/extension-sdk";
import { subscriptionsMigrations } from "./migrations/001_subscriptions.js";
import { SubscriptionService } from "./service.js";
import { subscriptionTools } from "./tools.js";
import { querySubscriptions } from "./dashboard-queries.js";
import { subscriptionsRpcActions } from "./rpc-actions.js";

export function createSubscriptionsModule(): ExtensibleModule {
  let tools: ToolDefinition[] = [];
  let dbRef: SqliteDb | null = null;

  return {
    name: "subscriptions",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "subscriptions", subscriptionsMigrations);
      dbRef = ctx.sqlite;
      const service = new SubscriptionService(ctx.sqlite, () => ctx.graph);
      tools = subscriptionTools(service);
    },

    getTools() {
      return tools;
    },

    getRpcActions() {
      return dbRef ? subscriptionsRpcActions(dbRef) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        nav: [
          { id: "subscriptions", label: "Subs", icon: "\uD83D\uDD04", group: "finance", order: 20 },
        ],
        channels: [
          { name: "subscriptions", query: (db) => querySubscriptions(db) },
        ],
        channelMappings: [
          { moduleKey: "subscriptions", channels: ["subscriptions", "calendar"] },
        ],
        stores: ["subscriptions"],
        fetchEndpoints: [
          { url: "/api/dashboard/subscriptions", store: "subscriptions" },
        ],
      };
    },

    async shutdown() {},
  };
}
