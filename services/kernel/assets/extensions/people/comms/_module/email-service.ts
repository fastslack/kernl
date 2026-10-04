import { type SqliteDb, type EventBus, newId, isoNow } from "@kernl/extension-sdk";
import type {
  EmailAction, EmailLabel, EmailListItem, EmailDetail,
  ThreadDetail, EmailCounts, EmailFolder, EmailCategory,
} from "./types.js";
import { readFetchStatus, type FetchStatus } from "./fetch-status.js";

export interface AccountSyncStatus {
  account_id: string;
  email: string;
  label: string;
  provider: string;
  /** Messages Kernl already holds for this account (every folder). */
  stored: number;
  /** IMAP only: the fetcher's last word on this account; null = never reached it. */
  fetch: FetchStatus | null;
}

/**
 * IMAP accounts don't go through the Google sync: comms:inbox-fetch stores
 * their mail in `communications`. This projects those rows onto the
 * google_emails columns the mail view reads, so both kinds of account share
 * one code path. Ids carry the `comm:` prefix — they can never collide with a
 * Gmail id, and the write paths (star, read) use it to route back here.
 */
export const COMM_MAIL_PREFIX = "comm:";
const GMAIL_SOURCE = "google_emails";
const COMM_SOURCE = `(
  SELECT 'comm:' || c.id AS gmail_id,
         'comm:' || COALESCE(NULLIF(c.gmail_thread_id, ''), NULLIF(c.thread_id, ''), c.id) AS thread_id,
         COALESCE(json_extract(c.metadata, '$.from'), '') AS from_email,
         COALESCE(json_extract(c.metadata, '$.from_name'), '') AS from_name,
         COALESCE(c.recipients_to, '') AS to_emails,
         COALESCE(c.recipients_cc, '') AS cc_emails,
         c.subject,
         substr(COALESCE(c.body, ''), 1, 240) AS snippet,
         COALESCE(c.body, '') AS body_text,
         COALESCE(c.body_html, '') AS body_html,
         COALESCE(NULLIF(c.sent_at, ''), c.created_at) AS date,
         COALESCE(json_extract(c.metadata, '$.mail.is_read'), 0) AS is_read,
         COALESCE(json_extract(c.metadata, '$.mail.is_starred'), 0) AS is_starred,
         0 AS has_attachments,
         CASE c.direction WHEN 'inbound' THEN '["INBOX"]' ELSE '["SENT"]' END AS labels,
         length(COALESCE(c.body, '')) AS size_bytes,
         c.account_id,
         COALESCE(json_extract(c.metadata, '$.triage.urgency'), '') AS urgency,
         COALESCE(json_extract(c.metadata, '$.triage.attention_needed'), -1) AS attention_needed,
         COALESCE(json_extract(c.metadata, '$.triage.summary'), '') AS ai_summary,
         '' AS draft_comm_id
  FROM communications c
  JOIN email_accounts a ON a.id = c.account_id AND a.provider = 'imap_smtp'
  WHERE c.channel = 'email'
    AND (c.direction = 'inbound' OR c.status = 'sent')
)`;

/** The Gmail label behind each inbox tab but Primary. */
const CATEGORY_LABELS: Record<Exclude<EmailCategory, "primary">, string> = {
  updates: "CATEGORY_UPDATES",
  promotions: "CATEGORY_PROMOTIONS",
  social: "CATEGORY_SOCIAL",
  forums: "CATEGORY_FORUMS",
};
export const EMAIL_CATEGORIES: EmailCategory[] = ["primary", "updates", "promotions", "social", "forums"];

/**
 * SQL for one tab. Primary is the absence of the other four labels, the way
 * Gmail draws it — so IMAP mail, which carries no category, lands there.
 */
function categoryClause(category: EmailCategory): string {
  if (category === "primary") {
    return Object.values(CATEGORY_LABELS).map((l) => `e.labels NOT LIKE '%"${l}"%'`).join(" AND ");
  }
  return `e.labels LIKE '%"${CATEGORY_LABELS[category]}"%'`;
}

export class EmailService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
  ) {}

  // ── Sources ────────────────────────────────────────

  /** google_emails belongs to the google-sync extension, which may not be installed. */
  private hasTable(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  }

  /** The sources holding an account's mail — both of them for the all-accounts view. */
  private sourcesFor(accountId?: string): string[] {
    const sources: string[] = [];
    let provider: string | undefined;
    if (accountId) {
      provider = (this.db.prepare("SELECT provider FROM email_accounts WHERE id = ?").get(accountId) as
        { provider: string } | undefined)?.provider;
    }
    if (provider !== "imap_smtp" && this.hasTable(GMAIL_SOURCE)) sources.push(GMAIL_SOURCE);
    if ((!accountId || provider === "imap_smtp") && this.hasTable("communications")) sources.push(COMM_SOURCE);
    return sources;
  }

  private sourceForId(id: string): string {
    return id.startsWith(COMM_MAIL_PREFIX) ? COMM_SOURCE : GMAIL_SOURCE;
  }

  /** Flip or set one of the view flags an IMAP row keeps in metadata.mail. */
  private setCommFlag(gmailId: string, flag: "is_read" | "is_starred", value?: number): boolean {
    const id = gmailId.slice(COMM_MAIL_PREFIX.length);
    const row = this.db.prepare(
      `SELECT COALESCE(json_extract(metadata, '$.mail.${flag}'), 0) AS v FROM communications WHERE id = ?`
    ).get(id) as { v: number } | undefined;
    if (!row) return false;
    const next = value ?? (row.v ? 0 : 1);
    this.db.prepare(
      `UPDATE communications SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.mail.${flag}', ?) WHERE id = ?`
    ).run(next, id);
    return !!next;
  }

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
    category?: EmailCategory;
  } = {}): { emails: EmailListItem[]; total: number; page: number; pageSize: number } {
    const folder = opts.folder ?? "inbox";
    const page = opts.page ?? 1;
    const pageSize = opts.pageSize ?? 50;
    const offset = (page - 1) * pageSize;

    const { where, params } = this.buildFolderClause(folder, opts);
    const sources = this.sourcesFor(opts.accountId);

    // Each source is paged on its own up to this page's end, then merged by
    // date: correct for any page, and the Gmail query stays index-friendly.
    let total = 0;
    let merged: EmailListItem[] = [];
    for (const src of sources) {
      total += this.countThreads(src, where, params);
      merged = merged.concat(this.listThreads(src, where, params, offset + pageSize, 0));
    }
    if (sources.length > 1) merged.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const emails = merged.slice(offset, offset + pageSize);
    return { emails, total, page, pageSize };
  }

  private actionJoins(where: string): string {
    return `${where.includes("ea.") ? "LEFT JOIN email_actions ea ON ea.gmail_id = e.gmail_id" : ""}
      ${where.includes("el_link") ? "LEFT JOIN email_actions el_link ON el_link.gmail_id = e.gmail_id AND el_link.action_type = 'label'" : ""}`;
  }

  private countThreads(src: string, where: string, params: unknown[]): number {
    const sql = `
      SELECT COUNT(DISTINCT e.thread_id) as cnt
      FROM ${src} e
      ${this.actionJoins(where)}
      WHERE ${where}
    `;
    return (this.db.prepare(sql).get(...params) as { cnt: number })?.cnt ?? 0;
  }

  /** Thread-grouped: latest message per thread. */
  private listThreads(src: string, where: string, params: unknown[], limit: number, offset: number): EmailListItem[] {
    const sql = `
      SELECT e.gmail_id, e.thread_id, e.from_email, e.from_name, e.to_emails,
             e.subject, e.snippet, e.date, e.is_read, e.is_starred, e.has_attachments, e.labels,
             e.account_id,
             (SELECT COUNT(*) FROM ${src} e2 WHERE e2.thread_id = e.thread_id) as message_count,
             c.name as contact_name,
             e.urgency, e.attention_needed, e.ai_summary, e.draft_comm_id
      FROM ${src} e
      LEFT JOIN contacts c ON c.email = e.from_email AND c.email <> ''
      ${this.actionJoins(where)}
      WHERE ${where}
      AND e.date = (
        SELECT MAX(e3.date) FROM ${src} e3 WHERE e3.thread_id = e.thread_id
      )
      GROUP BY e.thread_id
      ORDER BY e.date DESC
      LIMIT ? OFFSET ?
    `;
    return this.db.prepare(sql).all(...params, limit, offset) as EmailListItem[];
  }

  private buildFolderClause(folder: EmailFolder, opts: {
    query?: string; label?: string; from?: string;
    dateFrom?: string; dateTo?: string; accountId?: string;
    category?: EmailCategory;
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
    if (opts.category) conditions.push(`(${categoryClause(opts.category)})`);

    return { where: conditions.length ? conditions.join(" AND ") : "1=1", params };
  }

  // ── Single email / Thread ──────────────────────────

  getEmail(gmailId: string): EmailDetail | null {
    const row = this.db.prepare(`
      SELECT * FROM ${this.sourceForId(gmailId)} e WHERE e.gmail_id = ?
    `).get(gmailId) as (Record<string, unknown> & { gmail_id: string }) | undefined;
    if (!row) return null;

    return this.enrichEmail(row);
  }

  getThread(threadId: string): ThreadDetail | null {
    const rows = this.db.prepare(`
      SELECT * FROM ${this.sourceForId(threadId)} e WHERE e.thread_id = ? ORDER BY e.date ASC
    `).all(threadId) as Array<Record<string, unknown> & { gmail_id: string; subject: string }>;
    if (!rows.length) return null;

    return {
      thread_id: threadId,
      subject: rows[0].subject,
      messages: rows.map((r) => this.enrichEmail(r)),
    };
  }

  /** Record a Gmail message's HTML once fetched ('' = it has none, so it is never fetched again). */
  saveGmailHtml(gmailId: string, html: string): void {
    this.db.prepare(`UPDATE google_emails SET body_html = ? WHERE gmail_id = ?`).run(html, gmailId);
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
      body_html: row.body_html == null ? null : String(row.body_html),
      account_id: String(row.account_id ?? ""),
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
    const sources = this.sourcesFor(accountId);

    const totalInbox = this.countQuery(sources,
      `WHERE e.labels LIKE '%"INBOX"%'
       AND NOT EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type IN ('archive','trash'))${accFilter}`,
      p,
    );
    const unread = this.countQuery(sources,
      `WHERE e.labels LIKE '%"INBOX"%' AND e.is_read = 0
       AND NOT EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type IN ('archive','trash'))${accFilter}`,
      p,
    );
    const starred = this.countQuery(sources, `WHERE e.is_starred = 1${accFilter}`, p);
    const sent = this.countQuery(sources, `WHERE e.labels LIKE '%"SENT"%'${accFilter}`, p);
    const drafts = this.countQuery(sources, `WHERE e.labels LIKE '%"DRAFT"%'${accFilter}`, p);
    const trash = this.countQuery(sources,
      `WHERE EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type = 'trash')${accFilter}`,
      p,
    );
    const archived = this.countQuery(sources,
      `WHERE EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type = 'archive')
       AND NOT EXISTS (SELECT 1 FROM email_actions ea2 WHERE ea2.gmail_id = e.gmail_id AND ea2.action_type = 'trash')${accFilter}`,
      p,
    );
    const snoozed = this.countQuery(sources,
      `WHERE EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type = 'snooze' AND ea.value > datetime('now'))${accFilter}`,
      p,
    );
    const important = this.countQuery(sources,
      `WHERE EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type = 'important')${accFilter}`,
      p,
    );

    const attention = this.countQuery(sources, `WHERE e.attention_needed = 1${accFilter}`, p);

    const categories = {} as EmailCounts["categories"];
    for (const c of EMAIL_CATEGORIES) {
      const inCategory = `WHERE e.labels LIKE '%"INBOX"%' AND (${categoryClause(c)})
       AND NOT EXISTS (SELECT 1 FROM email_actions ea WHERE ea.gmail_id = e.gmail_id AND ea.action_type IN ('archive','trash'))${accFilter}`;
      categories[c] = {
        total: this.countQuery(sources, inCategory, p),
        unread: this.countQuery(sources, `${inCategory} AND e.is_read = 0`, p),
      };
    }

    return { inbox: totalInbox, unread, starred, sent, drafts, trash, archived, snoozed, important, attention, categories };
  }

  /** Per account: how much mail Kernl holds and, for IMAP, where the fetcher stands. */
  getSyncStatus(): AccountSyncStatus[] {
    const accounts = this.db.prepare(
      "SELECT id, email, label, provider FROM email_accounts ORDER BY is_default DESC, label ASC"
    ).all() as Array<{ id: string; email: string; label: string; provider: string }>;
    return accounts.map((a) => ({
      account_id: a.id,
      email: a.email,
      label: a.label,
      provider: a.provider,
      stored: this.countQuery(this.sourcesFor(a.id), "WHERE e.account_id = ?", [a.id]),
      fetch: a.provider === "imap_smtp" ? readFetchStatus(this.db, a.id) : null,
    }));
  }

  /** `SELECT COUNT(*)` with the same filter over every source, summed. */
  private countQuery(sources: string[], where: string, params: unknown[] = []): number {
    let n = 0;
    for (const src of sources) {
      try {
        n += (this.db.prepare(`SELECT COUNT(*) as cnt FROM ${src} e ${where}`).get(...params) as { cnt: number })?.cnt ?? 0;
      } catch {
        // a source whose table is mid-migration counts as empty
      }
    }
    return n;
  }

  // ── Actions ────────────────────────────────────────

  toggleStar(gmailId: string): boolean {
    if (gmailId.startsWith(COMM_MAIL_PREFIX)) return this.setCommFlag(gmailId, "is_starred");
    const row = this.db.prepare(`SELECT is_starred FROM google_emails WHERE gmail_id = ?`).get(gmailId) as { is_starred: number } | undefined;
    if (!row) return false;
    const next = row.is_starred ? 0 : 1;
    this.db.prepare(`UPDATE google_emails SET is_starred = ? WHERE gmail_id = ?`).run(next, gmailId);
    return !!next;
  }

  toggleRead(gmailId: string): boolean {
    if (gmailId.startsWith(COMM_MAIL_PREFIX)) return this.setCommFlag(gmailId, "is_read");
    const row = this.db.prepare(`SELECT is_read FROM google_emails WHERE gmail_id = ?`).get(gmailId) as { is_read: number } | undefined;
    if (!row) return false;
    const next = row.is_read ? 0 : 1;
    this.db.prepare(`UPDATE google_emails SET is_read = ? WHERE gmail_id = ?`).run(next, gmailId);
    return !!next;
  }

  markRead(gmailId: string): void {
    if (gmailId.startsWith(COMM_MAIL_PREFIX)) {
      this.setCommFlag(gmailId, "is_read", 1);
      return;
    }
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
