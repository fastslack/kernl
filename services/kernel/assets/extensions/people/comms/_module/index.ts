import type { ExtensibleModule, DashboardDescriptor, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { Notifier } from "../../../../../src/core/notify/notifier.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { commsMigrations } from "./migrations.js";
import { CommsService } from "./service.js";
import { EmailService } from "./email-service.js";
import { commsTools, commsTriageTools } from "./tools.js";
import { agentCommsTools } from "./agent-tools.js";
import { EmailAnalysisService } from "./email-analysis-service.js";
import { EmailTriageService } from "./email-triage-service.js";
import { emailAnalysisTools } from "./email-analysis-tools.js";
import { registerEmailRoutes } from "./email-routes.js";
import { registerEmailSuggestionsRoutes } from "./email-suggestions-routes.js";
import { commsDashboardRpcActions } from "./dashboard-rpc-actions.js";
import { commsAgentDrivers } from "./agent-drivers.js";
import type { AgentDriver } from "../../../../../src/core/types.js";
import { GoogleAuth } from "../../../integration/google-sync/_module/auth.js";
import { GoogleClient } from "../../../integration/google-sync/_module/google-client.js";
import { log } from "../../../../../src/core/logger.js";
import { gateToolList } from "../../../../../src/core/license/index.js";
import { queryComms } from "./dashboard-queries.js";
import { registerCommsDashboardRoutes } from "./dashboard-routes.js";
import type { TaskService } from "../../../productivity/tasks/_module/service.js";
import type { ReminderService } from "../../../productivity/reminders/_module/service.js";
import type { CrmService } from "../../crm/_module/service.js";
import type { ShoppingService } from "../../../home/shopping/_module/service.js";

export interface CommsModule extends ExtensibleModule {
  getService(): CommsService | null;
  getEmailService(): EmailService | null;
  /**
   * Email-analysis pipeline (LLM-suggests tasks/reminders/contacts/shopping
   * from inbound mail). Created during `initialize()` once the sqlite handle
   * and config are available.
   */
  getEmailAnalysisService(): EmailAnalysisService | null;
  /**
   * Email-triage pipeline (filtering + label classification). Also created
   * during `initialize()`.
   */
  getEmailTriageService(): EmailTriageService | null;
  /**
   * Returns the email-analysis MCP tools wired against the supplied sibling
   * services. Returns `[]` if the module isn't initialized yet.
   *
   * Bootstrap calls this AFTER all extensions have loaded so tasks/crm/
   * reminders/shopping (which may also be extensions) have a chance to come
   * online first.
   */
  getEmailAnalysisTools(deps: {
    taskService: TaskService;
    reminderService: ReminderService;
    crmService: CrmService;
    shoppingService: ShoppingService;
  }): ToolDefinition[];
  /**
   * Returns the comms-triage MCP tools (same late-bind pattern as above —
   * it needs the LLM API keys from kernel config).
   */
  getCommsTriageTools(): ToolDefinition[];
}

export function createCommsModule(): CommsModule {
  let tools: ToolDefinition[] = [];
  let serviceRef: CommsService | null = null;
  let emailServiceRef: EmailService | null = null;
  let emailAnalysisRef: EmailAnalysisService | null = null;
  let emailTriageRef: EmailTriageService | null = null;
  let dbRef: SqliteDb | null = null;
  let eventsRef: EventBus | null = null;
  let configRef: KernelConfig | null = null;
  let notifierRef: Notifier | null = null;

  return {
    name: "comms",

    async initialize(ctx: ModuleContext) {
      dbRef = ctx.sqlite;
      eventsRef = ctx.events;
      configRef = ctx.config;
      notifierRef = ctx.notifier;
      runMigrations(ctx.sqlite, "comms", commsMigrations);
      ensureEmailAccountsSchema(ctx.sqlite);

      const service = new CommsService(ctx.sqlite, ctx.events);
      service.setNotifier(ctx.notifier);
      serviceRef = service;

      // Email client service (reads google_emails + email_actions)
      emailServiceRef = new EmailService(ctx.sqlite, ctx.events);

      // Email analysis + triage pipelines — used to be wired in bootstrap
      // but they only consume sqlite + config, so they belong here. The
      // tools that USE these services (which need cross-module handles)
      // are still resolved post-extension-load via getEmailAnalysisTools().
      emailAnalysisRef = new EmailAnalysisService(ctx.sqlite, ctx.config);
      emailTriageRef = new EmailTriageService(ctx.sqlite, ctx.config);

      // Wire Google OAuth + Resend fallback so accounts can register providers
      // on-the-fly (e.g., right after the user adds them via the dashboard).
      const { clientId, clientSecret, callbackPort } = ctx.config.google;
      let googleAuth: GoogleAuth | null = null;
      if (clientId && clientSecret) {
        try {
          googleAuth = new GoogleAuth(ctx.sqlite, clientId, clientSecret, callbackPort);
          if (googleAuth.isAuthenticated()) {
            service.setGoogleClient(new GoogleClient(googleAuth));
            log.info("Comms: legacy Gmail provider enabled (shared OAuth tokens)");
          }
        } catch {
          log.debug("Comms: Gmail auth init skipped");
          googleAuth = null;
        }
      }
      service.setProviderContext({
        googleAuth,
        resendFallbackKey: ctx.config.resend.apiKey,
      });

      // Register providers for every configured account
      try {
        const accounts = service.listAccounts();
        for (const account of accounts) {
          const result = service.registerAccountProvider(account.id);
          if (!result.ok) {
            log.warn(`Comms: provider not registered for ${account.label}: ${result.reason}`);
          }
        }
        if (accounts.length > 0) {
          log.info(`Comms: ${accounts.length} email account(s) initialized`);
        }

        // One-time backfill: if there's a single gmail account, tag legacy emails with it
        const backfilled = service.backfillLegacyEmails();
        if (backfilled > 0) {
          log.info(`Comms: backfilled ${backfilled} legacy email(s) with account_id`);
        }
      } catch {
        log.debug("Comms: no email accounts configured yet");
      }

      // Partial gate. Templates + campaigns + the LLM-powered enrich-draft
      // are the Pro tier (they compete with Mailchimp / ConvertKit). Basic
      // send/receive/threads/accounts stay free so the free user still has a
      // functional personal email layer.
      const PRO_SUBSTRINGS = ["_template", "_campaign", "_enrich_draft"];
      const isPro = (n: string): boolean => PRO_SUBSTRINGS.some((s) => n.includes(s));
      const all = [...commsTools(service), ...agentCommsTools(service)];
      const free = all.filter((t) => !isPro(t.name));
      const pro = all.filter((t) => isPro(t.name));
      tools = [
        ...free,
        ...gateToolList(pro, ctx.license, "pro:comms", "comms"),
      ];

      // ARCH 3D beam bridge — comms is the source of inbound mail. We
      // emit "arch.cross_module" ourselves so the kernel framework doesn't
      // need to know about our event names.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.events.on("comms:mail:received" as any, (p: any) => {
        ctx.events.emit("arch.cross_module", {
          source: "comms",
          target: "dashboard",
          label: `${p?.count ?? 1} email(s) ${p?.source ?? "inbound"}`,
        }).catch(() => {});
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.events.on("contact.interaction" as any, (p: any) => {
        // Only forward when the originator is email (chat-originated
        // interactions are handled by the chat module's bridge — TBD).
        if (p?.type === "message") return;
        ctx.events.emit("arch.cross_module", {
          source: "comms",
          target: "crm",
          label: `contact: ${p?.contactName ?? ""}`,
        }).catch(() => {});
      });
    },

    getTools() {
      return tools;
    },

    getService() {
      return serviceRef;
    },

    getEmailService() {
      return emailServiceRef;
    },

    getEmailAnalysisService() {
      return emailAnalysisRef;
    },

    getEmailTriageService() {
      return emailTriageRef;
    },

    getEmailAnalysisTools(deps) {
      if (!emailAnalysisRef || !serviceRef) return [];
      return emailAnalysisTools(
        emailAnalysisRef,
        deps.taskService,
        deps.reminderService,
        deps.crmService,
        deps.shoppingService,
        serviceRef,
      );
    },

    getCommsTriageTools() {
      if (!serviceRef || !dbRef || !configRef) return [];
      return commsTriageTools(serviceRef, dbRef, {
        openaiApiKey: configRef.webIntel.openaiApiKey || configRef.voice.openaiApiKey || "",
        anthropicApiKey: configRef.webIntel.anthropicApiKey,
        defaultProvider: configRef.chat.defaultProvider,
      });
    },

    /**
     * Agent handler factories — consumed by `createBuiltinHandlers()` so the
     * builtin-handlers file no longer dynamic-imports comms internals.
     */
    getAgentHandlers(): Record<string, () => Promise<unknown>> {
      return {
        "comms:email-triage": () => import("./email-triage-service.js"),
      };
    },

    /**
     * Scheduled agent drivers owned by this extension: the inbound mail team
     * (comms:inbox-fetch / auto-label / archive-old) + the LLM email triage
     * (email:triage). Collected by ModuleRegistry.collectAgentDrivers() —
     * the kernel never names comms.
     */
    getAgentDrivers(): AgentDriver[] {
      return commsAgentDrivers({
        db: () => dbRef,
        service: () => serviceRef,
        triage: () => emailTriageRef,
        events: () => eventsRef,
        notifier: () => notifierRef,
      });
    },

    getDashboardRpcActions(deps?: {
      taskService?: TaskService | null;
      reminderService?: ReminderService | null;
      crmService?: CrmService | null;
      shoppingService?: ShoppingService | null;
    }) {
      if (!serviceRef && !emailAnalysisRef) return [];
      return commsDashboardRpcActions({
        commsService: serviceRef,
        emailAnalysisService: emailAnalysisRef,
        taskService: deps?.taskService ?? null,
        reminderService: deps?.reminderService ?? null,
        crmService: deps?.crmService ?? null,
        shoppingService: deps?.shoppingService ?? null,
      });
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        nav: [
          { id: "comms", label: "Comms", icon: "✉", group: "people", order: 30 },
        ],
        channels: [
          { name: "comms", query: (db) => queryComms(db) },
        ],
        channelMappings: [
          { moduleKey: "comms", channels: ["comms"] },
        ],
        stores: ["comms"],
        fetchEndpoints: [
          { url: "/api/dashboard/comms", store: "comms" },
        ],
        registerRoutes: (server) => {
          if (dbRef && serviceRef && eventsRef) {
            registerCommsDashboardRoutes(server, dbRef, serviceRef, eventsRef);
          }
          // Email-analysis suggestions surfaced on the dashboard. Moved here
          // from the dashboard module so that core stops importing this
          // extension's routes directly.
          registerEmailSuggestionsRoutes(server, emailAnalysisRef ?? null);
          // Email client routes — moved from bootstrap. The routes need
          // emailService + commsService (both owned by this module) plus
          // emailAnalysis + notifier + config + triage (which all live
          // here too as of Tier 5).
          if (emailServiceRef && serviceRef && emailAnalysisRef && notifierRef && configRef) {
            registerEmailRoutes(
              server,
              emailServiceRef,
              serviceRef,
              emailAnalysisRef,
              notifierRef,
              configRef,
              emailTriageRef,
            );
          }
        },
      };
    },

    async shutdown() {},
  };
}

/**
 * Widen the `provider` CHECK constraint on `email_accounts` to include 'imap_smtp'.
 * Idempotent + crash-recoverable: if a prior run died mid-swap (e.g. email_accounts_v2
 * exists but email_accounts got dropped), we finish the rename and move on.
 * Done outside runMigrations because `PRAGMA foreign_keys` can't be toggled
 * inside bun:sqlite's implicit transaction around `db.exec()`.
 *
 * Also drops any pre-existing federation triggers that reference missing
 * columns (NEW.updated_at / NEW.created_at). Those triggers are regenerated
 * by the federation module on boot, but while they're broken they poison any
 * ALTER TABLE RENAME because SQLite validates all triggers during a rename.
 */
function ensureEmailAccountsSchema(db: SqliteDb): void {
  dropBrokenFedTriggers(db);

  const accountsRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_accounts'")
    .get() as { sql: string } | undefined;
  const v2Row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_accounts_v2'")
    .get() as { sql: string } | undefined;

  // Crash recovery: previous attempt left email_accounts_v2 but no email_accounts.
  if (!accountsRow && v2Row) {
    log.warn("Comms: recovering half-swapped email_accounts schema");
    db.run("PRAGMA foreign_keys = OFF");
    try {
      db.run("ALTER TABLE email_accounts_v2 RENAME TO email_accounts");
      db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_email_accounts_email ON email_accounts(email)");
    } finally {
      db.run("PRAGMA foreign_keys = ON");
    }
    return;
  }

  if (!accountsRow?.sql) return; // table doesn't exist yet
  if (accountsRow.sql.includes("imap_smtp")) {
    // Already widened — clean up any stale email_accounts_v2 from a prior partial run.
    if (v2Row) db.run("DROP TABLE email_accounts_v2");
    return;
  }

  log.info("Comms: widening email_accounts.provider CHECK constraint");

  db.run("PRAGMA foreign_keys = OFF");
  try {
    // Clean up any stale v2 table left by a previous failed run so CREATE TABLE succeeds.
    if (v2Row) db.run("DROP TABLE email_accounts_v2");

    db.run(`
      CREATE TABLE email_accounts_v2 (
        id              TEXT PRIMARY KEY,
        label           TEXT NOT NULL,
        email           TEXT NOT NULL,
        type            TEXT NOT NULL DEFAULT 'personal'
                        CHECK(type IN ('personal','work','transactional','marketing')),
        provider        TEXT NOT NULL DEFAULT 'gmail'
                        CHECK(provider IN ('gmail','resend','imap_smtp')),
        company         TEXT NOT NULL DEFAULT '',
        signature       TEXT NOT NULL DEFAULT '',
        provider_config TEXT NOT NULL DEFAULT '{}',
        is_default      INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      )
    `);
    db.run("INSERT INTO email_accounts_v2 SELECT * FROM email_accounts");
    db.run("DROP TABLE email_accounts");
    db.run("ALTER TABLE email_accounts_v2 RENAME TO email_accounts");
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_email_accounts_email ON email_accounts(email)");
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
}

function dropBrokenFedTriggers(db: SqliteDb): void {
  try {
    const rows = db.prepare(`
      SELECT t.name AS name
      FROM sqlite_master t
      WHERE t.type = 'trigger' AND t.name LIKE 'fed_sync_%'
        AND (
          (t.sql LIKE '%NEW.updated_at%' AND NOT EXISTS (
            SELECT 1 FROM pragma_table_info(t.tbl_name) WHERE name = 'updated_at'))
          OR
          (t.sql LIKE '%NEW.created_at%' AND NOT EXISTS (
            SELECT 1 FROM pragma_table_info(t.tbl_name) WHERE name = 'created_at'))
        )
    `).all() as Array<{ name: string }>;

    for (const t of rows) {
      db.run(`DROP TRIGGER IF EXISTS "${t.name}"`);
      log.warn(`Comms: dropped broken federation trigger ${t.name} (will be regenerated)`);
    }
  } catch (err) {
    log.debug(`Comms: could not probe for broken fed triggers: ${err instanceof Error ? err.message : String(err)}`);
  }
}
