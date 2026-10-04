import { defineModule, type EventBus } from "@kernl/extension-sdk";
import { shoppingMigrations } from "./migrations/001_shopping.js";
import { ShoppingService } from "./service.js";
import { shoppingTools } from "./tools.js";
import { shoppingRpcActions } from "./rpc-actions.js";
import { queryShopping } from "./dashboard-queries.js";
import { registerShoppingRoutes } from "./routes.js";

export function createShoppingModule() {
  let service: ShoppingService | null = null;
  let events: EventBus | null = null;

  const mod = defineModule({
    name: "shopping",
    migrations: shoppingMigrations,
    async init(ctx) {
      events = ctx.events;

      if (ctx.graph?.capabilities.cypher) {
        await ctx.graph.run(
          "CREATE CONSTRAINT product_id IF NOT EXISTS FOR (p:Product) REQUIRE p.id IS UNIQUE",
        );
        await ctx.graph.run(
          "CREATE CONSTRAINT category_id IF NOT EXISTS FOR (c:Category) REQUIRE c.id IS UNIQUE",
        );
        await ctx.graph.run(
          "CREATE CONSTRAINT store_id IF NOT EXISTS FOR (s:Store) REQUIRE s.id IS UNIQUE",
        );
      }

      service = new ShoppingService(ctx.sqlite, () => ctx.graph);
      return service;
    },
    tools: shoppingTools,
    rpc: (s) => shoppingRpcActions({ service: s, events }),
    dashboard: {
      channels: [{ name: "shopping", query: (db) => queryShopping(db) }],
      registerRoutes: (server) => {
        if (service) {
          registerShoppingRoutes(server, service, events ?? undefined);
        }
      },
    },
  });
  return Object.assign(mod, { getService: () => service });
}
