import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type {
  EmailAction, EmailLabel, EmailListItem, EmailDetail,
  ThreadDetail, EmailCounts, EmailFolder,
} from "./types.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

export class EmailService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
  ) {}

  // ── List & Search ──────────────────────────────────

  listEmails(opts: {
    folder?: EmailFolder;
    query?: string;
    label?: string;
    from?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    pageSize?: number;
    accountId?: string;
  } = {}): { emails: EmailListItem[]; total: number; page: number; pageSize: number } {
    const folder = opts.folder ?? "inbox";
    const page = opts.page ?? 1;
    const pageSize = opts.pageSize ?? 50;
    const offset = (page - 1) * pageSize;

    const { where, params } = this.buildFolderClause(folder, opts);

    const countSql = `
      SELECT COUNT(DISTINCT e.thread_id) as cnt
      FROM google_emails e
      ${where.includes("ea.") ? "LEFT JOIN email_actions ea ON ea.gmail_id = e.gmail_id" : ""}
      ${where.includes("el_link") ? "LEFT JOIN email_actions el_link ON el_link.gmail_id = e.gmail_id AND el_link.action_type = 'label'" : ""}
      WHERE ${where}
    `;
    const total = (this.db.prepare(countSql).get(...params) as { cnt: number })?.cnt ?? 0;

    // Thread-grouped: latest message per thread
    const sql = `
      SELECT e.gmail_id, e.thread_id, e.from_email, e.from_name, e.to_emails,
             e.subject, e.snippet, e.date, e.is_read, e.is_starred, e.has_attachments, e.labels,
             e.account_id,
             (SELECT COUNT(*) FROM google_emails e2 WHERE e2.thread_id = e.thread_id) as message_count,
             c.name as contact_name,
             e.urgency, e.attention_needed, e.ai_summary, e.draft_comm_id
      FROM google_emails e
      LEFT JOIN contacts c ON c.email = e.from_email AND c.email <> ''
      ${where.includes("ea.") ? "LEFT JOIN email_actions ea ON ea.gmail_id = e.gmail_id" : ""}
      ${where.includes("el_link") ? "LEFT JOIN email_actions el_link ON el_link.gmail_id = e.gmail_id AND el_link.action_type = 'label'" : ""}
      WHERE ${where}
      AND e.date = (
        SELECT MAX(e3.date) FROM google_emails e3 WHERE e3.thread_id = e.thread_id
      )
      GROUP BY e.thread_id
      ORDER BY e.date DESC
      LIMIT ? OFFSET ?
    `;

    const emails = this.db.prepare(sql).all(...params, pageSize, offset) as EmailListItem[];
    return { emails, total, page, pageSize };
  }

  private buildFolderClause(folder: EmailFolder, opts: {
    query?: string; label?: string; from?: string;
    dateFrom?: string; dateTo?: string; accountId?: string;
  }): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    switch (folder) {
      case "inbox":
        conditions.push("e.labels LIKE '%\"INBOX\"%'");
        conditions.push("NOT EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type IN ('archive','trash'))");
        break;
      case "sent":
        conditions.push("e.labels LIKE '%\"SENT\"%'");
        break;
      case "starred":
        conditions.push("e.is_starred = 1");
        break;
      case "important":
        conditions.push("EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type = 'important')");
        break;
      case "drafts":
        conditions.push("e.labels LIKE '%\"DRAFT\"%'");
        break;
      case "trash":
        conditions.push("EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type = 'trash')");
        break;
      case "archived":
        conditions.push("EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type = 'archive')");
        conditions.push("NOT EXISTS (SELECT 1 FROM email_actions ea2 WHERE ea2.gmail_id = e.gmail_id AND ea2.action_type = 'trash')");
        break;
      case "snoozed":
        conditions.push("EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type = 'snooze' AND ea.value > datetime('now'))");
        break;
      case "all":
        conditions.push("NOT EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type = 'trash')");
        break;
    }

    if (opts.query) {
      conditions.push("(e.subject LIKE ? OR e.from_name LIKE ? OR e.from_email LIKE ? OR e.snippet LIKE ?)");
      const q = `%${opts.query}%`;
      params.push(q, q, q, q);
    }
    if (opts.from) {
      conditions.push("(e.from_email LIKE ? OR e.from_name LIKE ?)");
      params.push(`%${opts.from}%`, `%${opts.from}%`);
    }
    if (opts.dateFrom) {
      conditions.push("e.date >= ?");
      params.push(opts.dateFrom);
    }
    if (opts.dateTo) {
      conditions.push("e.date <= ?");
      params.push(opts.dateTo);
    }
    if (opts.label) {
      conditions.push("EXISTS (SELECT 1 FROM email_actions el_link WHERE el_link.gmail_id = e.gmail_id AND el_link.action_type = 'label' AND el_link.value = ?)");
      params.push(opts.label);
    }
    if (opts.accountId) {
      conditions.push("e.account_id = ?");
      params.push(opts.accountId);
    }

    return { where: conditions.length ? conditions.join(" AND ") : "1=1", params };
  }

  // ── Single email / Thread ──────────────────────────

  getEmail(gmailId: string): EmailDetail | null {
    const row = this.db.prepare(`
      SELECT * FROM google_emails WHERE gmail_id = ?
    `).get(gmailId) as (Record<string, unknown> & { gmail_id: string }) | undefined;
    if (!row) return null;

    return this.enrichEmail(row);
  }

  getThread(threadId: string): ThreadDetail | null {
    const rows = this.db.prepare(`
      SELECT * FROM google_emails WHERE thread_id = ? ORDER BY date ASC
    `).all(threadId) as Array<Record<string, unknown> & { gmail_id: string; subject: string }>;
    if (!rows.length) return null;

    return {
      thread_id: threadId,
      subject: rows[0].subject,
      messages: rows.map((r) => this.enrichEmail(r)),
    };
  }

  private enrichEmail(row: Record<string, unknown> & { gmail_id: string }): EmailDetail {
    const actions = this.db.prepare(
      `SELECT * FROM email_actions WHERE gmail_id = ? ORDER BY created_at DESC`
    ).all(row.gmail_id) as EmailAction[];

    // Labels linked via actions
    const labelIds = actions
      .filter((a) => a.action_type === "label")
      .map((a) => a.value);
    const email_labels = labelIds.length
      ? (this.db.prepare(
          `SELECT * FROM email_labels WHERE id IN (${labelIds.map(() => "?").join(",")})`
        ).all(...labelIds) as EmailLabel[])
      : [];

    // Linked tasks
    const taskIds = actions
      .filter((a) => a.action_type === "link_task")
      .map((a) => a.value);
    const linked_tasks = taskIds.length
      ? (this.db.prepare(
          `SELECT id, title, status FROM tasks WHERE id IN (${taskIds.map(() => "?").join(",")})`
        ).all(...taskIds) as Array<{ id: string; title: string; status: string }>)
      : [];

    // Linked contacts
    const contactIds = actions
      .filter((a) => a.action_type === "link_contact")
      .map((a) => a.value);
    const linked_contacts = contactIds.length
      ? (this.db.prepare(
          `SELECT id, name, email FROM contacts WHERE id IN (${contactIds.map(() => "?").join(",")})`
        ).all(...contactIds) as Array<{ id: string; name: string; email: string }>)
      : [];

    return {
      gmail_id: String(row.gmail_id),
      thread_id: String(row.thread_id ?? ""),
      from_email: String(row.from_email ?? ""),
      from_name: String(row.from_name ?? ""),
      to_emails: String(row.to_emails ?? ""),
      cc_emails: String(row.cc_emails ?? ""),
      subject: String(row.subject ?? ""),
      snippet: String(row.snippet ?? ""),
      body_text: String(row.body_text ?? ""),
      date: String(row.date ?? ""),
      is_read: Number(row.is_read ?? 0),
      is_starred: Number(row.is_starred ?? 0),
      has_attachments: Number(row.has_attachments ?? 0),
      labels: String(row.labels ?? ""),
      size_bytes: Number(row.size_bytes ?? 0),
      actions,
      email_labels,
      linked_tasks,
      linked_contacts,
      urgency: String(row.urgency ?? ""),
      attention_needed: Number(row.attention_needed ?? -1),
      ai_summary: String(row.ai_summary ?? ""),
      draft_comm_id: String(row.draft_comm_id ?? ""),
    };
  }

  // ── Counts ─────────────────────────────────────────

  getCounts(accountId?: string): EmailCounts {
    const accFilter = accountId ? " AND e.account_id = ?" : "";
    const p: unknown[] = accountId ? [accountId] : [];

    const totalInbox = this.countQuery(
      `SELECT COUNT(*) as cnt FROM google_emails e
       WHERE e.labels LIKE '%"INBOX"%'
       AND NOT EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type IN ('archive','trash'))${accFilter}`,
      p,
    );
    const unread = this.countQuery(
      `SELECT COUNT(*) as cnt FROM google_emails e
       WHERE e.labels LIKE '%"INBOX"%' AND e.is_read = 0
       AND NOT EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type IN ('archive','trash'))${accFilter}`,
      p,
    );
    const starred = this.countQuery(
      `SELECT COUNT(*) as cnt FROM google_emails e WHERE e.is_starred = 1${accFilter}`,
      p,
    );
    const sent = this.countQuery(
      `SELECT COUNT(*) as cnt FROM google_emails e WHERE e.labels LIKE '%"SENT"%'${accFilter}`,
      p,
    );
    const drafts = this.countQuery(
      `SELECT COUNT(*) as cnt FROM google_emails e WHERE e.labels LIKE '%"DRAFT"%'${accFilter}`,
      p,
    );
    const trash = this.countQuery(
      `SELECT COUNT(*) as cnt FROM google_emails e
       WHERE EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type = 'trash')${accFilter}`,
      p,
    );
    const archived = this.countQuery(
      `SELECT COUNT(*) as cnt FROM google_emails e
       WHERE EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type = 'archive')
       AND NOT EXISTS (SELECT 1 FROM email_actions ea2 WHERE ea2.gmail_id = e.gmail_id AND ea2.action_type = 'trash')${accFilter}`,
      p,
    );
    const snoozed = this.countQuery(
      `SELECT COUNT(*) as cnt FROM google_emails e
       WHERE EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type = 'snooze' AND ea.value > datetime('now'))${accFilter}`,
      p,
    );
    const important = this.countQuery(
      `SELECT COUNT(*) as cnt FROM google_emails e
       WHERE EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type = 'important')${accFilter}`,
      p,
    );

    const attention = this.countQuery(
      `SELECT COUNT(*) as cnt FROM google_emails e WHERE e.attention_needed = 1${accFilter}`,
      p,
    );

    return { inbox: totalInbox, unread, starred, sent, drafts, trash, archived, snoozed, important, attention };
  }

  private countQuery(sql: string, params: unknown[] = []): number {
    try {
      return (this.db.prepare(sql).get(...params) as { cnt: number })?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  // ── Actions ────────────────────────────────────────

  toggleStar(gmailId: string): boolean {
    const row = this.db.prepare(`SELECT is_starred FROM google_emails WHERE gmail_id = ?`).get(gmailId) as { is_starred: number } | undefined;
    if (!row) return false;
    const next = row.is_starred ? 0 : 1;
    this.db.prepare(`UPDATE google_emails SET is_starred = ? WHERE gmail_id = ?`).run(next, gmailId);
    return !!next;
  }

  toggleRead(gmailId: string): boolean {
    const row = this.db.prepare(`SELECT is_read FROM google_emails WHERE gmail_id = ?`).get(gmailId) as { is_read: number } | undefined;
    if (!row) return false;
    const next = row.is_read ? 0 : 1;
    this.db.prepare(`UPDATE google_emails SET is_read = ? WHERE gmail_id = ?`).run(next, gmailId);
    return !!next;
  }

  markRead(gmailId: string): void {
    this.db.prepare(`UPDATE google_emails SET is_read = 1 WHERE gmail_id = ?`).run(gmailId);
  }

  archive(gmailId: string): void {
    this.removeAction(gmailId, "archive");
    this.addAction(gmailId, "archive");
  }

  trash(gmailId: string): void {
    this.removeAction(gmailId, "trash");
    this.addAction(gmailId, "trash");
  }

  restore(gmailId: string): void {
    this.db.prepare(
      `DELETE FROM email_actions WHERE gmail_id = ? AND action_type IN ('trash','archive')`
    ).run(gmailId);
  }

  markImportant(gmailId: string): void {
    const exists = this.db.prepare(
      `SELECT 1 FROM email_actions WHERE gmail_id = ? AND action_type = 'important'`
    ).get(gmailId);
    if (exists) {
      this.removeAction(gmailId, "important");
    } else {
      this.addAction(gmailId, "important");
    }
  }

  snooze(gmailId: string, until: string): void {
    this.removeAction(gmailId, "snooze");
    this.addAction(gmailId, "snooze", until);
  }

  // ── Notes ──────────────────────────────────────────

  addNote(gmailId: string, note: string): EmailAction {
    return this.addAction(gmailId, "note", note);
  }

  getNotes(gmailId: string): EmailAction[] {
    return this.db.prepare(
      `SELECT * FROM email_actions WHERE gmail_id = ? AND action_type = 'note' ORDER BY created_at DESC`
    ).all(gmailId) as EmailAction[];
  }

  // ── Block sender ───────────────────────────────────

  blockSender(email: string): void {
    const existing = this.db.prepare(
      `SELECT 1 FROM email_actions WHERE action_type = 'block_sender' AND value = ?`
    ).get(email);
    if (!existing) {
      this.db.prepare(
        `INSERT INTO email_actions (id, gmail_id, action_type, value, created_at) VALUES (?, '', 'block_sender', ?, ?)`
      ).run(newId(), email, isoNow());
    }
  }

  isBlocked(email: string): boolean {
    return !!this.db.prepare(
      `SELECT 1 FROM email_actions WHERE action_type = 'block_sender' AND value = ?`
    ).get(email);
  }

  // ── Labels ─────────────────────────────────────────

  createLabel(name: string, color?: string): EmailLabel {
    const id = newId();
    const now = isoNow();
    this.db.prepare(
      `INSERT INTO email_labels (id, name, color, created_at) VALUES (?, ?, ?, ?)`
    ).run(id, name, color ?? "#666", now);
    return { id, name, color: color ?? "#666", created_at: now };
  }

  listLabels(): EmailLabel[] {
    return this.db.prepare(`SELECT * FROM email_labels ORDER BY name`).all() as EmailLabel[];
  }

  deleteLabel(id: string): boolean {
    const changes = this.db.prepare(`DELETE FROM email_labels WHERE id = ?`).run(id).changes;
    if (changes) {
      this.db.prepare(`DELETE FROM email_actions WHERE action_type = 'label' AND value = ?`).run(id);
    }
    return changes > 0;
  }

  addLabelToEmail(gmailId: string, labelId: string): void {
    const exists = this.db.prepare(
      `SELECT 1 FROM email_actions WHERE gmail_id = ? AND action_type = 'label' AND value = ?`
    ).get(gmailId, labelId);
    if (!exists) {
      this.addAction(gmailId, "label", labelId);
    }
  }

  removeLabelFromEmail(gmailId: string, labelId: string): void {
    this.db.prepare(
      `DELETE FROM email_actions WHERE gmail_id = ? AND action_type = 'label' AND value = ?`
    ).run(gmailId, labelId);
  }

  getEmailLabels(gmailId: string): EmailLabel[] {
    return this.db.prepare(`
      SELECT el.* FROM email_labels el
      INNER JOIN email_actions ea ON ea.value = el.id AND ea.action_type = 'label'
      WHERE ea.gmail_id = ?
    `).all(gmailId) as EmailLabel[];
  }

  // ── Linking ────────────────────────────────────────

  linkToTask(gmailId: string, taskId: string): void {
    const exists = this.db.prepare(
      `SELECT 1 FROM email_actions WHERE gmail_id = ? AND action_type = 'link_task' AND value = ?`
    ).get(gmailId, taskId);
    if (!exists) {
      this.addAction(gmailId, "link_task", taskId);
    }
  }

  linkToContact(gmailId: string, contactId: string): void {
    const exists = this.db.prepare(
      `SELECT 1 FROM email_actions WHERE gmail_id = ? AND action_type = 'link_contact' AND value = ?`
    ).get(gmailId, contactId);
    if (!exists) {
      this.addAction(gmailId, "link_contact", contactId);
    }
  }

  getLinkedItems(gmailId: string): { tasks: Array<{ id: string; title: string; status: string }>; contacts: Array<{ id: string; name: string; email: string }> } {
    const actions = this.db.prepare(
      `SELECT action_type, value FROM email_actions WHERE gmail_id = ? AND action_type IN ('link_task','link_contact')`
    ).all(gmailId) as Array<{ action_type: string; value: string }>;

    const taskIds = actions.filter((a) => a.action_type === "link_task").map((a) => a.value);
    const contactIds = actions.filter((a) => a.action_type === "link_contact").map((a) => a.value);

    const tasks = taskIds.length
      ? (this.db.prepare(
          `SELECT id, title, status FROM tasks WHERE id IN (${taskIds.map(() => "?").join(",")})`
        ).all(...taskIds) as Array<{ id: string; title: string; status: string }>)
      : [];

    const contacts = contactIds.length
      ? (this.db.prepare(
          `SELECT id, name, email FROM contacts WHERE id IN (${contactIds.map(() => "?").join(",")})`
        ).all(...contactIds) as Array<{ id: string; name: string; email: string }>)
      : [];

    return { tasks, contacts };
  }

  // ── Helpers ────────────────────────────────────────

  private addAction(gmailId: string, type: string, value = ""): EmailAction {
    const id = newId();
    const now = isoNow();
    this.db.prepare(
      `INSERT INTO email_actions (id, gmail_id, action_type, value, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(id, gmailId, type, value, now);
    return { id, gmail_id: gmailId, action_type: type as EmailAction["action_type"], value, created_at: now };
  }

  private removeAction(gmailId: string, type: string): void {
    this.db.prepare(
      `DELETE FROM email_actions WHERE gmail_id = ? AND action_type = ?`
    ).run(gmailId, type);
  }
}
