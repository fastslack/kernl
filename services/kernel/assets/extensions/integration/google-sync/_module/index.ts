import {
  type ExtensibleModule,
  defineModule,
  runMigrations,
} from "@kernl/extension-sdk";
import { googleSyncMigrations } from "./migrations/001_google_sync.js";
import { fullSyncMigrations } from "./migrations/002_full_sync.js";
import { emailTriageMigrations } from "./migrations/003_email_triage.js";
import { accountIdMigrations } from "./migrations/004_account_id.js";
import { authHealthMigrations } from "./migrations/005_auth_health.js";
import { GoogleAuth } from "./auth.js";
import { GoogleClient } from "./google-client.js";
import { CrmService } from "../../../people/crm/_module/service.js";
import { ReminderService } from "../../../productivity/reminders/_module/service.js";
import { TaskService } from "../../../productivity/tasks/_module/service.js";
import { ShoppingService } from "../../../home/shopping/_module/service.js";
import { googleSyncTools } from "./tools.js";
import { agentGoogleSyncTools } from "./agent-tools.js";
import { GoogleSyncService } from "./sync-service.js";
import { registerGoogleOAuthRoutes } from "./oauth-routes.js";
import { googleSyncDashboardRpcActions } from "./dashboard-rpc-actions.js";
import { googleSyncAgentDrivers } from "./agent-drivers.js";

export interface GoogleSyncModule extends ExtensibleModule {
  getService(): GoogleSyncService | null;
}

export function createGoogleSyncModule(): GoogleSyncModule {
  let syncService: GoogleSyncService | null = null;

  const mod = defineModule({
    name: "google-sync",

    async init(ctx) {
      // Five migration sets, each under its own key.
      runMigrations(ctx.sqlite, "google-sync", googleSyncMigrations);
      runMigrations(ctx.sqlite, "google-sync-full", fullSyncMigrations);
      runMigrations(ctx.sqlite, "google-sync-triage", emailTriageMigrations);
      runMigrations(ctx.sqlite, "google-sync-account-id", accountIdMigrations);
      runMigrations(ctx.sqlite, "google-sync-auth-health", authHealthMigrations);

      const { clientId, clientSecret, callbackPort } = ctx.config.google;

      const auth = new GoogleAuth(ctx.sqlite, clientId, clientSecret, callbackPort);
      const client = new GoogleClient(auth);

      // Services from other modules (already initialized, migrations ran).
      // All four take a live graph getter so /extensions toggles flip the
      // active backend without recreating instances.
      const getGraph = () => ctx.graph;
      const crmService = new CrmService(ctx.sqlite, getGraph);
      const reminderService = new ReminderService(ctx.sqlite, getGraph);
      const taskService = new TaskService(ctx.sqlite, getGraph);
      const shoppingService = new ShoppingService(ctx.sqlite, getGraph);

      const service = new GoogleSyncService(
        auth, client, ctx.sqlite,
        getGraph,
        crmService, reminderService, taskService, shoppingService,
      );
      syncService = service;

      // Create Neo4j constraints for full sync nodes
      await service.createConstraints();

      // The agent drivers need notifier + getModule, hence the whole ctx.
      return { ctx, auth, client, crmService, reminderService, taskService, shoppingService, syncService: service };
    },

    tools: (s) => [
      ...googleSyncTools(s.auth, s.client, s.ctx.sqlite, s.crmService, s.reminderService, s.taskService, s.shoppingService, s.syncService),
      ...agentGoogleSyncTools({
        auth: s.auth, client: s.client, db: s.ctx.sqlite,
        crmService: s.crmService, reminderService: s.reminderService, taskService: s.taskService,
        syncService: s.syncService,
      }),
    ],

    /**
     * Scheduled agent drivers owned by this extension (gsync:contacts /
     * gmail / calendar / graph-enrich). Collected by
     * ModuleRegistry.collectAgentDrivers() — the kernel never names
     * google-sync.
     */
    agentDrivers: (s) =>
      googleSyncAgentDrivers({
        service: () => s.syncService,
        db: () => s.ctx.sqlite,
        notifier: () => s.ctx.notifier ?? null,
        ctx: () => s.ctx,
      }),

    dashboardRpc: (s) => googleSyncDashboardRpcActions({ db: s.ctx.sqlite, config: s.ctx.config }),

    dashboard: (s) =>
      s
        ? {
            registerRoutes: (server, db) => {
              registerGoogleOAuthRoutes(server, db, s.ctx.config);
            },
          }
        : null,
  });

  return Object.assign(mod, {
    getService() {
      return syncService;
    },
  });
}
