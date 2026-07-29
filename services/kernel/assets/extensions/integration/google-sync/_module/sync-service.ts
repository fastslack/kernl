import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { GoogleAuth } from "./auth.js";
import type { GoogleClient } from "./google-client.js";
import type { CrmService } from "../../../people/crm/_module/service.js";
import type { ReminderService } from "../../../productivity/reminders/_module/service.js";
import type { TaskService } from "../../../productivity/tasks/_module/service.js";
import type { ShoppingService } from "../../../home/shopping/_module/service.js";
import type { ImportResult } from "../../../../../src/core/integrations/google-types.js";
import { importContacts } from "./importers/contacts.js";
import { importOtherContacts } from "./importers/other-contacts.js";
import { importCalendar } from "./importers/calendar.js";
import { importTasks } from "./importers/tasks.js";
import { importGmail } from "./importers/gmail.js";
import { importGmailFull } from "./importers/gmail-full.js";
import { importCalendarFull } from "./importers/calendar-full.js";
import { GoogleGraphSync, type GraphSyncResult } from "./graph-sync.js";
import { log } from "../../../../../src/core/logger.js";

export class GoogleSyncService {
  private graphSync: GoogleGraphSync;

  constructor(
    private auth: GoogleAuth,
    private client: GoogleClient,
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
    private crmService: CrmService,
    private reminderService: ReminderService,
    private taskService: TaskService,
    private shoppingService: ShoppingService,
  ) {
    // graphSync gates internally on the active driver's `cypher` capability,
    // so we always instantiate it. Toggling backends in /extensions takes
    // effect on the next syncAll() invocation without restarting.
    this.graphSync = new GoogleGraphSync(db, getGraph);
  }

  isAuthenticated(): boolean {
    return this.auth.isAuthenticated();
  }

  // ── Legacy importers (backward compatible) ──────

  async syncContacts(): Promise<ImportResult> {
    return importContacts(this.client, this.db, this.crmService);
  }

  async syncOtherContacts(): Promise<ImportResult> {
    return importOtherContacts(this.client, this.db, this.crmService);
  }

  async syncCalendar(): Promise<ImportResult> {
    return importCalendar(this.client, this.db, this.reminderService);
  }

  async syncTasks(): Promise<ImportResult> {
    return importTasks(this.client, this.db, this.taskService);
  }

  async syncGmail(): Promise<ImportResult> {
    return importGmail(this.client, this.db, this.crmService);
  }

  // ── New full importers ──────────────────────────

  async syncGmailFull(): Promise<ImportResult> {
    return importGmailFull(this.client, this.db, this.crmService);
  }

  async syncCalendarFull(): Promise<ImportResult> {
    return importCalendarFull(this.client, this.db);
  }

  // ── Graph enrichment ────────────────────────────

  async enrichGraph(): Promise<GraphSyncResult> {
    // graphSync.syncAll() returns an empty result if the active driver lacks
    // cypher — callers can detect "graph backend off" by inspecting the
    // returned counts rather than catching an exception.
    return this.graphSync.syncAll();
  }

  async createConstraints(): Promise<void> {
    await this.graphSync.createConstraints();
  }

  // ── Sync all ────────────────────────────────────

  async syncAll(): Promise<ImportResult[]> {
    const results: ImportResult[] = [];

    log.info("Starting full Google sync...");

    // Contacts first (CRM needed for email matching)
    results.push(await this.syncContacts());
    results.push(await this.syncOtherContacts());

    // Full Gmail (stores complete emails)
    results.push(await this.syncGmailFull());

    // Full Calendar (stores events with attendees)
    results.push(await this.syncCalendarFull());

    // Legacy importers for reminders/tasks
    results.push(await this.syncCalendar());
    results.push(await this.syncTasks());

    // Graph enrichment runs unconditionally — if the active driver lacks
    // cypher (e.g. running on `noop`), it returns an empty result and logs.
    try {
      await this.graphSync.syncAll();
      log.info("Graph enrichment completed after full sync");
    } catch (err) {
      log.warn(`Graph enrichment failed: ${err}`);
    }

    const total = results.reduce((sum, r) => sum + r.imported, 0);
    log.info(`Full Google sync complete: ${total} total items imported`);

    return results;
  }

  // ── Email search (local SQLite) ─────────────────

  searchEmails(opts: {
    query?: string;
    from?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  }): Array<{
    gmail_id: string;
    from_email: string;
    from_name: string;
    subject: string;
    snippet: string;
    date: string;
    thread_id: string;
  }> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.query) {
      conditions.push("(subject LIKE ? OR body_text LIKE ? OR snippet LIKE ?)");
      const like = `%${opts.query}%`;
      params.push(like, like, like);
    }
    if (opts.from) {
      conditions.push("from_email LIKE ?");
      params.push(`%${opts.from}%`);
    }
    if (opts.dateFrom) {
      conditions.push("date >= ?");
      params.push(opts.dateFrom);
    }
    if (opts.dateTo) {
      conditions.push("date <= ?");
      params.push(opts.dateTo);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 20;

    return this.db.prepare(
      `SELECT gmail_id, from_email, from_name, subject, snippet, date, thread_id
       FROM google_emails ${where}
       ORDER BY date DESC LIMIT ?`,
    ).all(...params, limit) as any[];
  }
}
