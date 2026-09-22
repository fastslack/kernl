import { defineModule } from "@kernl/extension-sdk";
import { subscriptionsMigrations } from "./migrations/001_subscriptions.js";
import { SubscriptionService } from "./service.js";
import { subscriptionTools } from "./tools.js";
import { querySubscriptions } from "./dashboard-queries.js";
import { subscriptionsRpcActions } from "./rpc-actions.js";

export function createSubscriptionsModule() {
  return defineModule({
    name: "subscriptions",
    migrations: subscriptionsMigrations,
    init: (ctx) => new SubscriptionService(ctx.sqlite, () => ctx.graph),
    tools: subscriptionTools,
    rpc: subscriptionsRpcActions,
    // Literal, not dashboardChannel(): the module also maps the "calendar" channel.
    dashboard: {
      nav: [
        { id: "subscriptions", label: "Subs", icon: "🔄", group: "finance", order: 20 },
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
    },
  });
}
