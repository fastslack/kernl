/**
 * Agent-shaped google-sync tools.
 *
 * Legacy `googleSyncTools(...)` exposes 12 tools — one per sync target plus
 * status, search, full-sync, graph-sync. That's the classic anti-pattern
 * David's keynote calls out: separate tools for what is logically one verb
 * with a `target` parameter.
 *
 * This file collapses the surface into 3 agent-shaped intent verbs:
 *
 *   - `kernel_google_status`     — typed status snapshot (auth + per-source counts)
 *   - `kernel_google_sync_now`   — unified sync verb with `target` enum
 *   - `kernel_google_email_search` — local email search with structured output
 *
 * Each declares `tags` + `outputSchema`. The legacy 12 tools are not
 * removed — `[legacy]` nudges in their descriptions push the LLM toward
 * these new verbs.
 */
import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GoogleAuth } from "./auth.js";
import type { GoogleClient } from "./google-client.js";
import type { CrmService } from "../../../people/crm/_module/service.js";
import type { ReminderService } from "../../../productivity/reminders/_module/service.js";
import type { TaskService } from "../../../productivity/tasks/_module/service.js";
import type { GoogleSyncService } from "./sync-service.js";
import type { ImportResult, SyncMeta } from "../../../../../src/core/integrations/google-types.js";
import { errorResult, structuredResult, textResult } from "../../../../../src/core/helpers.js";
import { importContacts } from "./importers/contacts.js";
import { importCalendar } from "./importers/calendar.js";
import { importTasks } from "./importers/tasks.js";
import { importGmail } from "./importers/gmail.js";
import { importOtherContacts } from "./importers/other-contacts.js";

// ── Shared schemas ────────────────────────────────────────────

const ImportResultSchema = z.object({
  source: z.string(),
  imported: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(z.string()),
});

// ── Builder ───────────────────────────────────────────────────

export interface AgentGoogleToolsDeps {
  auth: GoogleAuth;
  client: GoogleClient;
  db: SqliteDb;
  crmService: CrmService;
  reminderService: ReminderService;
  taskService: TaskService;
  syncService?: GoogleSyncService;
}

export function agentGoogleSyncTools(deps: AgentGoogleToolsDeps): ToolDefinition[] {
  return [
    buildGoogleStatus(deps),
    buildGoogleSyncNow(deps),
    buildGoogleEmailSearch(deps),
  ];
}

// ── kernel_google_status ──────────────────────────────────────

const GoogleStatusOutput = z.object({
  authenticated: z.boolean(),
  sources: z.array(z.object({
    source: z.string(),
    last_sync_at: z.string(),
    items_last_run: z.number().int(),
    total_synced: z.number().int(),
  })),
  storage: z.object({
    emails: z.number().int(),
    threads: z.number().int(),
    calendar_events: z.number().int(),
  }),
});

function buildGoogleStatus(deps: AgentGoogleToolsDeps): ToolDefinition {
  const { auth, db } = deps;
  return {
    name: "kernel_google_overview",
    description:
      "Typed status snapshot of every Google sync source: authenticated state, last_sync_at + " +
      "items per source, and full-sync storage counts (emails / threads / calendar events). " +
      "Use this before kicking off a sync to decide what's stale.",
    inputSchema: z.object({}),
    outputSchema: GoogleStatusOutput,
    tags: ["google", "status", "sync", "snapshot"],
    async handler() {
      const authenticated = auth.isAuthenticated();

      const metas = (db
        .prepare("SELECT * FROM google_sync_meta ORDER BY source")
        .all() as SyncMeta[]) ?? [];

      const counts = db
        .prepare("SELECT source, COUNT(*) as count FROM google_sync_map GROUP BY source")
        .all() as Array<{ source: string; count: number }>;

      const sources = metas.map((m) => ({
        source: m.source,
        last_sync_at: m.last_sync_at,
        items_last_run: m.items_synced,
        total_synced: counts.find((c) => c.source === m.source)?.count ?? 0,
      }));

      let emails = 0, threads = 0, calendar_events = 0;
      try { emails = (db.prepare("SELECT COUNT(*) as c FROM google_emails").get() as { c: number }).c; } catch { /* no table */ }
      try { threads = (db.prepare("SELECT COUNT(*) as c FROM google_email_threads").get() as { c: number }).c; } catch { /* no table */ }
      try { calendar_events = (db.prepare("SELECT COUNT(*) as c FROM google_calendar_events").get() as { c: number }).c; } catch { /* no table */ }

      const out = { authenticated, sources, storage: { emails, threads, calendar_events } };

      const lines: string[] = [
        `Google Sync — ${authenticated ? "✓ authenticated" : "✗ not authenticated"}`,
      ];
      if (sources.length > 0) {
        lines.push("\n**Sources**:");
        for (const s of sources) {
          lines.push(`- ${s.source}: ${s.last_sync_at} · ${s.items_last_run} last run · ${s.total_synced} total synced`);
        }
      } else {
        lines.push("No syncs yet.");
      }
      lines.push(`\n**Storage**: emails=${emails} · threads=${threads} · calendar=${calendar_events}`);

      return { ...textResult(lines.join("\n")), structuredContent: out };
    },
  };
}

// ── kernel_google_sync_now ────────────────────────────────────

const GoogleSyncNowInput = z.object({
  target: z.enum([
    "all",
    "contacts",
    "other_contacts",
    "calendar",
    "tasks",
    "gmail",
    "full",
    "graph",
  ]).default("all").describe(
    "What to sync. 'all' runs the lightweight per-source importers. 'full' does the heavy " +
    "syncService.syncAll() (stores raw email bodies, headers, calendar attendees). 'graph' " +
    "rebuilds the Neo4j graph from the local store. Specific targets run a single importer.",
  ),
});

const GoogleSyncNowOutput = z.object({
  target: z.string(),
  total_imported: z.number().int(),
  results: z.array(ImportResultSchema),
});

function buildGoogleSyncNow(deps: AgentGoogleToolsDeps): ToolDefinition {
  const { auth, client, db, crmService, reminderService, taskService, syncService } = deps;
  return {
    name: "kernel_google_sync_now",
    description:
      "Unified Google sync verb. `target` selects what to sync (all / contacts / other_contacts / " +
      "calendar / tasks / gmail / full / graph). Replaces 8 separate kernel_google_sync_* tools — " +
      "the meta tools / code_run flows can pick a target via one entry point. Returns structured " +
      "ImportResult[] with imported/skipped/errors per source.",
    inputSchema: GoogleSyncNowInput,
    outputSchema: GoogleSyncNowOutput,
    tags: ["google", "sync", "import", "contacts", "calendar", "gmail", "tasks"],
    async handler(args) {
      const { target } = GoogleSyncNowInput.parse(args);
      if (!auth.isAuthenticated()) {
        return errorResult("Not authenticated. Run kernel_google_auth first.");
      }
      try {
        const results: ImportResult[] = [];
        switch (target) {
          case "all":
            results.push(await importContacts(client, db, crmService));
            results.push(await importOtherContacts(client, db, crmService));
            results.push(await importCalendar(client, db, reminderService));
            results.push(await importTasks(client, db, taskService));
            results.push(await importGmail(client, db, crmService));
            break;
          case "contacts":       results.push(await importContacts(client, db, crmService)); break;
          case "other_contacts": results.push(await importOtherContacts(client, db, crmService)); break;
          case "calendar":       results.push(await importCalendar(client, db, reminderService)); break;
          case "tasks":          results.push(await importTasks(client, db, taskService)); break;
          case "gmail":          results.push(await importGmail(client, db, crmService)); break;
          case "full":
            if (!syncService) return errorResult("syncService not initialized — full sync unavailable.");
            results.push(...(await syncService.syncAll()));
            break;
          case "graph":
            if (!syncService) return errorResult("syncService not initialized — graph enrich unavailable.");
            await syncService.enrichGraph();
            // 'graph' isn't part of the typed SyncSource union — synthesize a
            // pseudo-result so the tool's structured output stays uniform.
            results.push({ source: "graph" as ImportResult["source"], imported: 0, skipped: 0, errors: [] });
            break;
        }
        const total = results.reduce((acc, r) => acc + r.imported, 0);
        const out = {
          target,
          total_imported: total,
          results: results.map((r) => ({ source: String(r.source), imported: r.imported, skipped: r.skipped, errors: r.errors })),
        };

        const lines = [
          `Google sync (${target}) — ${total} imported across ${results.length} source(s):`,
          ...results.map((r) =>
            `- ${r.source}: ${r.imported} imported, ${r.skipped} skipped` +
            (r.errors.length > 0 ? ` · ${r.errors.length} error(s)` : ""),
          ),
        ];
        return { ...textResult(lines.join("\n")), structuredContent: out };
      } catch (err) {
        return errorResult(`google_sync_now(${target}) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ── kernel_google_email_search ────────────────────────────────

const GoogleEmailSearchInput = z.object({
  query: z.string().optional().describe("Text to find in subject / body / snippet."),
  from: z.string().optional().describe("Sender email (partial match)."),
  date_from: z.string().optional().describe("ISO datetime — lower bound."),
  date_to: z.string().optional().describe("ISO datetime — upper bound."),
  limit: z.number().int().min(1).max(100).default(20),
});

const GoogleEmailSearchOutput = z.object({
  total: z.number().int(),
  emails: z.array(z.object({
    gmail_id: z.string(),
    thread_id: z.string(),
    from_email: z.string(),
    from_name: z.string(),
    subject: z.string(),
    snippet: z.string(),
    date: z.string(),
  })),
});

function buildGoogleEmailSearch(deps: AgentGoogleToolsDeps): ToolDefinition {
  const { syncService } = deps;
  return {
    name: "kernel_google_email_search",
    description:
      "Search the LOCAL Google email store (populated by `kernel_google_sync_now({target:'full'})` or " +
      "the legacy full-sync tool). Filters: text query (subject/body/snippet), sender, date range. " +
      "For LIVE Gmail search use `kernel_email_search` instead — that one hits Gmail's API directly.",
    inputSchema: GoogleEmailSearchInput,
    outputSchema: GoogleEmailSearchOutput,
    tags: ["google", "email", "search", "inbox", "local"],
    async handler(args) {
      const { query, from, date_from, date_to, limit } = GoogleEmailSearchInput.parse(args);
      if (!syncService) return errorResult("syncService not initialized — local email search unavailable.");
      try {
        const results = syncService.searchEmails({ query, from, dateFrom: date_from, dateTo: date_to, limit });
        const out = { total: results.length, emails: results };
        if (results.length === 0) {
          return { ...textResult("No emails matched."), structuredContent: out };
        }
        const lines = [
          `Found ${results.length} email(s):`,
          ...results.map((e) =>
            `- ${e.date.split("T")[0]} · ${e.from_name || e.from_email} · ${e.subject}`,
          ),
        ];
        return { ...textResult(lines.join("\n")), structuredContent: out };
      } catch (err) {
        return errorResult(`google_email_search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
