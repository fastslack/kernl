import { z } from "zod";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { GoogleAuth } from "./auth.js";
import type { GoogleClient } from "./google-client.js";
import type { CrmService } from "../../../people/crm/_module/service.js";
import type { ReminderService } from "../../../productivity/reminders/_module/service.js";
import type { TaskService } from "../../../productivity/tasks/_module/service.js";
import type { ShoppingService } from "../../../home/shopping/_module/service.js";
import type { GoogleSyncService } from "./sync-service.js";
import type { ImportResult, SyncMeta } from "../../../../../src/core/integrations/google-types.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import { importContacts } from "./importers/contacts.js";
import { importCalendar } from "./importers/calendar.js";
import { importTasks } from "./importers/tasks.js";
import { importGmail } from "./importers/gmail.js";
import { importOtherContacts } from "./importers/other-contacts.js";
import { importTakeoutPlaces } from "./importers/takeout-places.js";

function formatResult(r: ImportResult): string {
  let text = `${r.source}: ${r.imported} imported, ${r.skipped} skipped`;
  if (r.errors.length > 0) {
    text += `\n  Errors:\n    ${r.errors.join("\n    ")}`;
  }
  return text;
}

function formatResults(results: ImportResult[]): string {
  const lines = results.map(formatResult);
  const total = results.reduce((sum, r) => sum + r.imported, 0);
  return `Sync complete — ${total} total items imported\n\n${lines.join("\n")}`;
}

export function googleSyncTools(
  auth: GoogleAuth,
  client: GoogleClient,
  db: SqliteDb,
  crmService: CrmService,
  reminderService: ReminderService,
  taskService: TaskService,
  shoppingService: ShoppingService,
  syncService?: GoogleSyncService,
): ToolDefinition[] {
  return [
    {
      name: "kernel_google_auth",
      description:
        "Initiate Google OAuth2 authentication. Returns a URL to open in your browser. After authorizing, the callback will save tokens automatically.",
      inputSchema: z.object({}),
      handler: async () => {
        if (auth.isAuthenticated()) {
          return textResult("Already authenticated with Google. Use kernel_google_status to check details.");
        }
        try {
          const authUrl = await auth.startCallbackServer();
          return textResult(
            `Open this URL in your browser to authorize Kernl:\n\n${authUrl}\n\nWaiting for callback on localhost...`,
          );
        } catch (err) {
          return errorResult(`Auth failed: ${String(err)}`);
        }
      },
    },

    {
      name: "kernel_google_sync",
      description:
        "Sync all Google data: contacts → CRM, other contacts → CRM, calendar → reminders, tasks → tasks, Gmail → CRM interactions. Requires prior authentication via kernel_google_auth.",
      inputSchema: z.object({}),
      handler: async () => {
        if (!auth.isAuthenticated()) {
          return errorResult("Not authenticated. Run kernel_google_auth first.");
        }
        try {
          const results: ImportResult[] = [];
          results.push(await importContacts(client, db, crmService));
          results.push(await importOtherContacts(client, db, crmService));
          results.push(await importCalendar(client, db, reminderService));
          results.push(await importTasks(client, db, taskService));
          results.push(await importGmail(client, db, crmService));
          return textResult(formatResults(results));
        } catch (err) {
          return errorResult(`Sync failed: ${String(err)}`);
        }
      },
    },

    {
      name: "kernel_google_sync_contacts",
      description: "Sync only Google Contacts → CRM contacts.",
      inputSchema: z.object({}),
      handler: async () => {
        if (!auth.isAuthenticated()) {
          return errorResult("Not authenticated. Run kernel_google_auth first.");
        }
        try {
          const result = await importContacts(client, db, crmService);
          return textResult(formatResult(result));
        } catch (err) {
          return errorResult(`Contacts sync failed: ${String(err)}`);
        }
      },
    },

    {
      name: "kernel_google_sync_calendar",
      description:
        "Sync only Google Calendar events (next 30 days) → reminders.",
      inputSchema: z.object({}),
      handler: async () => {
        if (!auth.isAuthenticated()) {
          return errorResult("Not authenticated. Run kernel_google_auth first.");
        }
        try {
          const result = await importCalendar(client, db, reminderService);
          return textResult(formatResult(result));
        } catch (err) {
          return errorResult(`Calendar sync failed: ${String(err)}`);
        }
      },
    },

    {
      name: "kernel_google_sync_tasks",
      description: "Sync only Google Tasks → tasks.",
      inputSchema: z.object({}),
      handler: async () => {
        if (!auth.isAuthenticated()) {
          return errorResult("Not authenticated. Run kernel_google_auth first.");
        }
        try {
          const result = await importTasks(client, db, taskService);
          return textResult(formatResult(result));
        } catch (err) {
          return errorResult(`Tasks sync failed: ${String(err)}`);
        }
      },
    },

    {
      name: "kernel_google_sync_gmail",
      description:
        "Scan Gmail (last 30 days) and auto-log email interactions with existing CRM contacts. Matches From/To addresses against contact emails.",
      inputSchema: z.object({}),
      handler: async () => {
        if (!auth.isAuthenticated()) {
          return errorResult("Not authenticated. Run kernel_google_auth first.");
        }
        try {
          const result = await importGmail(client, db, crmService);
          return textResult(formatResult(result));
        } catch (err) {
          return errorResult(`Gmail sync failed: ${String(err)}`);
        }
      },
    },

    {
      name: "kernel_google_sync_other_contacts",
      description:
        "Import Google 'Other Contacts' (auto-saved from email interactions) into CRM. Skips duplicates by email.",
      inputSchema: z.object({}),
      handler: async () => {
        if (!auth.isAuthenticated()) {
          return errorResult("Not authenticated. Run kernel_google_auth first.");
        }
        try {
          const result = await importOtherContacts(client, db, crmService);
          return textResult(formatResult(result));
        } catch (err) {
          return errorResult(`Other contacts sync failed: ${String(err)}`);
        }
      },
    },

    {
      name: "kernel_google_import_places",
      description:
        "Import saved places from a Google Takeout GeoJSON file into shopping stores. Provide the absolute path to Saved Places.json from Google Takeout.",
      inputSchema: z.object({
        file_path: z.string().describe("Absolute path to the Saved Places.json file from Google Takeout"),
      }),
      handler: async (args) => {
        const { file_path } = args as { file_path: string };
        try {
          const result = importTakeoutPlaces(file_path, db, shoppingService);
          return textResult(formatResult(result));
        } catch (err) {
          return errorResult(`Takeout import failed: ${String(err)}`);
        }
      },
    },

    {
      name: "kernel_google_status",
      description:
        "Show Google sync status: authentication state, last sync times, and item counts per source.",
      inputSchema: z.object({}),
      handler: async () => {
        const status = auth.getStatus();
        const metas = db
          .prepare("SELECT * FROM google_sync_meta ORDER BY source")
          .all() as SyncMeta[];

        const syncMapCounts = db
          .prepare("SELECT source, COUNT(*) as count FROM google_sync_map GROUP BY source")
          .all() as Array<{ source: string; count: number }>;

        const statusLabel = status === "connected"
          ? "connected ✅"
          : status === "needs_reauth"
            ? "⚠️ NEEDS RE-AUTH (token expired/revoked) — run kernel_google_auth"
            : "disconnected";
        let text = `Google Sync Status\n`;
        text += `  Connection: ${statusLabel}\n`;
        if (status === "needs_reauth") {
          const err = auth.lastAuthError();
          if (err) text += `  Last error: ${err}\n`;
        }
        text += `\n`;

        if (metas.length === 0) {
          text += "  No syncs performed yet.";
        } else {
          text += "Last sync:\n";
          for (const meta of metas) {
            const count = syncMapCounts.find((c) => c.source === meta.source)?.count ?? 0;
            text += `  ${meta.source}: ${meta.last_sync_at} (${count} total synced, ${meta.items_synced} last run)\n`;
          }
        }

        // Add full sync table counts
        try {
          const emailCount = (db.prepare("SELECT COUNT(*) as c FROM google_emails").get() as { c: number }).c;
          const threadCount = (db.prepare("SELECT COUNT(*) as c FROM google_email_threads").get() as { c: number }).c;
          const calCount = (db.prepare("SELECT COUNT(*) as c FROM google_calendar_events").get() as { c: number }).c;
          text += `\nFull sync storage:\n`;
          text += `  Emails: ${emailCount}\n  Threads: ${threadCount}\n  Calendar events: ${calCount}\n`;
        } catch { /* tables may not exist yet */ }

        return textResult(text);
      },
    },

    // ── New full sync tools ──────────────────────────

    {
      name: "kernel_google_sync_full",
      description:
        "Run full sync of all Google data: contacts + full emails (body, headers) + calendar events (with attendees). Stores everything in local SQLite. Also enriches Neo4j graph if available.",
      inputSchema: z.object({}),
      handler: async () => {
        if (!auth.isAuthenticated()) {
          return errorResult("Not authenticated. Run kernel_google_auth first.");
        }
        if (!syncService) {
          return errorResult("Sync service not initialized.");
        }
        try {
          const results = await syncService.syncAll();
          return textResult(formatResults(results));
        } catch (err) {
          return errorResult(`Full sync failed: ${String(err)}`);
        }
      },
    },

    {
      name: "kernel_google_sync_graph",
      description:
        "Build/refresh Neo4j graph from stored Google data. Creates Email, EmailThread, CalendarEvent nodes and SENT, RECEIVED, PART_OF, ATTENDS, ORGANIZED, EMAILED, MET_WITH relationships.",
      inputSchema: z.object({}),
      handler: async () => {
        if (!syncService) {
          return errorResult("Sync service not initialized.");
        }
        try {
          const result = await syncService.enrichGraph();
          const lines = [
            "Graph sync complete:",
            `  Email nodes: ${result.emailNodes}`,
            `  Thread nodes: ${result.threadNodes}`,
            `  Calendar event nodes: ${result.calendarNodes}`,
            `  SENT relationships: ${result.sentRels}`,
            `  RECEIVED relationships: ${result.receivedRels}`,
            `  PART_OF relationships: ${result.partOfRels}`,
            `  ORGANIZED relationships: ${result.organizedRels}`,
            `  ATTENDS relationships: ${result.attendsRels}`,
            `  EMAILED (derived): ${result.emailedRels}`,
            `  MET_WITH (derived): ${result.metWithRels}`,
          ];
          return textResult(lines.join("\n"));
        } catch (err) {
          return errorResult(`Graph sync failed: ${String(err)}`);
        }
      },
    },

    {
      name: "kernel_google_emails_search",
      description:
        "Search locally stored emails by subject/body text, sender email, and/or date range. Returns matching emails from the google_emails table.",
      inputSchema: z.object({
        query: z.string().optional().describe("Text to search in subject, body, or snippet"),
        from: z.string().optional().describe("Sender email address (partial match)"),
        date_from: z.string().optional().describe("Start date (ISO format)"),
        date_to: z.string().optional().describe("End date (ISO format)"),
        limit: z.number().optional().default(20).describe("Max results (default 20)"),
      }),
      handler: async (args) => {
        if (!syncService) {
          return errorResult("Sync service not initialized.");
        }
        const { query, from, date_from, date_to, limit } = args as {
          query?: string; from?: string; date_from?: string; date_to?: string; limit?: number;
        };
        try {
          const results = syncService.searchEmails({
            query, from, dateFrom: date_from, dateTo: date_to, limit,
          });
          if (results.length === 0) {
            return textResult("No emails found matching your criteria.");
          }
          const lines = results.map((e) =>
            `• ${e.date.split("T")[0]} | ${e.from_name || e.from_email} | ${e.subject}\n  ${e.snippet.slice(0, 100)}`,
          );
          return textResult(`Found ${results.length} email(s):\n\n${lines.join("\n\n")}`);
        } catch (err) {
          return errorResult(`Email search failed: ${String(err)}`);
        }
      },
    },
  ];
}
