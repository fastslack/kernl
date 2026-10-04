import { type ExtensibleModule, defineModule } from "@kernl/extension-sdk";
import { crmMigrations } from "./migrations/001_crm.js";
import { CrmService } from "./service.js";
import { crmTools } from "./tools.js";
import { registerCrmDashboardRoutes } from "./dashboard-routes.js";
import { registerContactsRoutes } from "./routes.js";
import { contactsRpcActions } from "./rpc-actions.js";
import { queryCrm } from "./dashboard-queries.js";

export interface CrmModule extends ExtensibleModule {
  getService(): CrmService | null;
}

export function createCrmModule(): CrmModule {
  let serviceRef: CrmService | null = null;

  const mod = defineModule({
    name: "crm",
    migrations: crmMigrations,

    async init(ctx) {
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

      // Listen for cross-module events
      ctx.events.on("contact.interaction", async (payload) => {
        const { contactId, type, summary } = payload as {
          contactId: string;
          type: "email" | "call" | "meeting" | "message" | "social" | "other";
          summary: string;
        };
        service.logInteraction({ contact_id: contactId, type, summary });
      });

      return { service, events: ctx.events };
    },

    tools: (s) => crmTools(s.service),
    rpc: (s) => contactsRpcActions(s.service, s.events),

    dashboard: (s) => ({
      channels: [{ name: "crm", query: (db) => queryCrm(db) }],
      registerRoutes: (server) => {
        if (s) {
          registerCrmDashboardRoutes(server, s.service);
          registerContactsRoutes(server, s.service, s.events ?? undefined);
        }
      },
    }),
  });

  return Object.assign(mod, {
    getService() {
      return serviceRef;
    },
  });
}
