import type {
  DashboardDescriptor,
  ExtensibleModule,
  KernelModule,
  ModuleContext,
  ToolDefinition,
} from "../../../../../src/core/types.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
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
import type { AgentDriver } from "../../../../../src/core/types.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";

export interface GoogleSyncModule extends ExtensibleModule {
  getService(): GoogleSyncService | null;
}

export function createGoogleSyncModule(): GoogleSyncModule {
  let tools: ToolDefinition[] = [];
  let syncService: GoogleSyncService | null = null;
  let capturedConfig: KernelConfig | null = null;
  let dbRef: SqliteDb | null = null;
  /** Captured at initialize() — agent drivers need notifier + getModule. */
  let ctxRef: ModuleContext | null = null;

  return {
    name: "google-sync",

    async initialize(ctx: ModuleContext) {
      ctxRef = ctx;
      runMigrations(ctx.sqlite, "google-sync", googleSyncMigrations);
      runMigrations(ctx.sqlite, "google-sync-full", fullSyncMigrations);
      runMigrations(ctx.sqlite, "google-sync-triage", emailTriageMigrations);
      runMigrations(ctx.sqlite, "google-sync-account-id", accountIdMigrations);
      runMigrations(ctx.sqlite, "google-sync-auth-health", authHealthMigrations);

      const { clientId, clientSecret, callbackPort } = ctx.config.google;
      capturedConfig = ctx.config;
      dbRef = ctx.sqlite;

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

      syncService = new GoogleSyncService(
        auth, client, ctx.sqlite,
        getGraph,
        crmService, reminderService, taskService, shoppingService,
      );

      // Create Neo4j constraints for full sync nodes
      await syncService.createConstraints();

      tools = [
        ...googleSyncTools(auth, client, ctx.sqlite, crmService, reminderService, taskService, shoppingService, syncService),
        ...agentGoogleSyncTools({
          auth, client, db: ctx.sqlite,
          crmService, reminderService, taskService,
          syncService,
        }),
      ];
    },

    getTools() {
      return tools;
    },

    getService() {
      return syncService;
    },

    /**
     * Scheduled agent drivers owned by this extension (gsync:contacts /
     * gmail / calendar / graph-enrich). Collected by
     * ModuleRegistry.collectAgentDrivers() — the kernel never names
     * google-sync.
     */
    getAgentDrivers(): AgentDriver[] {
      return googleSyncAgentDrivers({
        service: () => syncService,
        db: () => dbRef,
        notifier: () => ctxRef?.notifier ?? null,
        ctx: () => ctxRef,
      });
    },

    getDashboardRpcActions() {
      return dbRef && capturedConfig
        ? googleSyncDashboardRpcActions({ db: dbRef, config: capturedConfig })
        : [];
    },

    getDashboardDescriptor(): DashboardDescriptor | null {
      if (!capturedConfig) return null;
      const config = capturedConfig;
      return {
        registerRoutes: (server, db) => {
          registerGoogleOAuthRoutes(server, db, config);
        },
      };
    },

    async shutdown() {},
  };
}
