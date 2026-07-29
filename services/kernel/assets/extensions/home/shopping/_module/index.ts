import type { KernelModule, ModuleContext, ToolDefinition, DashboardDescriptor } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { shoppingMigrations } from "./migrations/001_shopping.js";
import { ShoppingService } from "./service.js";
import { shoppingTools } from "./tools.js";
import { shoppingRpcActions } from "./rpc-actions.js";
import { shoppingDashboardRpcActions } from "./dashboard-rpc-actions.js";
import { registerShoppingRoutes } from "./routes.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { KernelConfig } from "../../../../../src/core/config.js";

export function createShoppingModule(): KernelModule & { getService(): ShoppingService | null } {
  let tools: ToolDefinition[] = [];
  let serviceInstance: ShoppingService | null = null;
  let dbRef: SqliteDb | null = null;
  let eventsRef: EventBus | null = null;
  let configRef: KernelConfig | null = null;

  return {
    name: "shopping",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "shopping", shoppingMigrations);
      dbRef = ctx.sqlite;
      eventsRef = ctx.events;
      configRef = ctx.config;

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
      return dbRef ? shoppingRpcActions(dbRef) : [];
    },

    getDashboardRpcActions() {
      return dbRef ? shoppingDashboardRpcActions({ db: dbRef }) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        registerRoutes: (server) => {
          if (dbRef) {
            registerShoppingRoutes(
              server,
              dbRef,
              serviceInstance ?? undefined,
              configRef ?? undefined,
              eventsRef ?? undefined,
            );
          }
        },
      };
    },

    async shutdown() {},
  };
}
