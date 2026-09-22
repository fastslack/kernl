import {
  type ExtensibleModule,
  type ModuleContext,
  type ToolDefinition,
  type DashboardDescriptor,
  runMigrations,
  type EventBus,
} from "@kernl/extension-sdk";
import { shoppingMigrations } from "./migrations/001_shopping.js";
import { ShoppingService } from "./service.js";
import { shoppingTools } from "./tools.js";
import { shoppingRpcActions } from "./rpc-actions.js";
import { queryShopping } from "./dashboard-queries.js";
import { registerShoppingRoutes } from "./routes.js";

export function createShoppingModule(): ExtensibleModule & { getService(): ShoppingService | null } {
  let tools: ToolDefinition[] = [];
  let serviceInstance: ShoppingService | null = null;
  let eventsRef: EventBus | null = null;

  return {
    name: "shopping",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "shopping", shoppingMigrations);
      eventsRef = ctx.events;

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

      serviceInstance = new ShoppingService(ctx.sqlite, () => ctx.graph);
      tools = shoppingTools(serviceInstance);
    },

    getTools() {
      return tools;
    },

    getService() {
      return serviceInstance;
    },

    getRpcActions() {
      return serviceInstance ? shoppingRpcActions({ service: serviceInstance, events: eventsRef }) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        channels: [{ name: "shopping", query: (db) => queryShopping(db) }],
        registerRoutes: (server) => {
          if (serviceInstance) {
            registerShoppingRoutes(server, serviceInstance, eventsRef ?? undefined);
          }
        },
      };
    },

    async shutdown() {},
  };
}
