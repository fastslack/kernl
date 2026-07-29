import type { ExtensibleModule, DashboardDescriptor, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { crmMigrations } from "./migrations/001_crm.js";
import { CrmService } from "./service.js";
import { crmTools } from "./tools.js";
import { registerCrmDashboardRoutes } from "./dashboard-routes.js";
import { registerContactsRoutes } from "./routes.js";
import { contactsRpcActions } from "./rpc-actions.js";
import { crmDashboardRpcActions } from "./dashboard-rpc-actions.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";

export interface CrmModule extends ExtensibleModule {
  getService(): CrmService | null;
}

export function createCrmModule(): CrmModule {
  let tools: ToolDefinition[] = [];
  let serviceRef: CrmService | null = null;
  let dbRef: SqliteDb | null = null;
  let eventsRef: EventBus | null = null;

  return {
    name: "crm",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "crm", crmMigrations);
      dbRef = ctx.sqlite;
      eventsRef = ctx.events;

      // Constraint creation runs against whatever graph driver is active at
      // boot. Idempotent (`IF NOT EXISTS`) — safe to retry on restart after
      // toggling backends in /extensions.
      if (ctx.graph?.capabilities.cypher) {
        await ctx.graph.run(
          "CREATE CONSTRAINT person_id IF NOT EXISTS FOR (p:Person) REQUIRE p.id IS UNIQUE",
        );
      }

      const service = new CrmService(ctx.sqlite, () => ctx.graph);
      serviceRef = service;
      tools = crmTools(service);

      // Listen for cross-module events
      ctx.events.on("contact.interaction", async (payload) => {
        const { contactId, type, summary } = payload as {
          contactId: string;
          type: "email" | "call" | "meeting" | "message" | "social" | "other";
          summary: string;
        };
        service.logInteraction({ contact_id: contactId, type, summary });
      });
    },

    getTools() {
      return tools;
    },

    getService() {
      return serviceRef;
    },

    getRpcActions() {
      return dbRef ? contactsRpcActions(dbRef) : [];
    },

    getDashboardRpcActions() {
      return dbRef ? crmDashboardRpcActions({ db: dbRef }) : [];
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        registerRoutes: (server) => {
          if (serviceRef) registerCrmDashboardRoutes(server, serviceRef);
          if (dbRef) registerContactsRoutes(server, dbRef, eventsRef ?? undefined);
        },
      };
    },

    async shutdown() {},
  };
}
