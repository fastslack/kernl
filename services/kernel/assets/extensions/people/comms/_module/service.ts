import { existsSync, mkdirSync, copyFileSync, statSync, unlinkSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import { GoogleClient } from "../../../integration/google-sync/_module/google-client.js";
import type { GoogleAuth } from "../../../integration/google-sync/_module/auth.js";
import type {
  Communication, CommAttachment, CommChannel, CommStatus, CommDirection, InboxMessage,
  EmailAccount, EmailTemplate, EmailCampaign, CampaignRecipient,
} from "./types.js";
import type { EmailProvider } from "./providers/types.js";
import { GmailProvider } from "./providers/gmail-provider.js";
import { ResendProvider } from "./providers/resend-provider.js";
import { ImapSmtpProvider, type ImapSmtpConfig } from "./providers/imap-smtp-provider.js";
import { renderTemplate, detectTemplateVariables } from "./template-engine.js";
import { sanitizeUserHtml } from "../../../../../src/core/sanitize-html.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import {
  quoteBody,
  parseMetadata,
} from "./gmail-helpers.js";
import { log } from "../../../../../src/core/logger.js";
import type { Notifier } from "../../../../../src/core/notify/notifier.js";

const ATTACHMENTS_DIR = "./data/attachments";

const MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".zip": "application/zip",
  ".html": "text/html",
};

function guessMime(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

export class CommsService {
  private providers = new Map<string, EmailProvider>();
  private legacyGmailProvider: GmailProvider | null = null;
  private notifier: Notifier | null = null;
  private googleAuth: GoogleAuth | null = null;
  private resendFallbackKey = "";

  constructor(
    private db: SqliteDb,
    private events: EventBus,
  ) {}

  /** Set the notifier for WhatsApp/messaging channel sends */
  setNotifier(notifier: Notifier): void {
    this.notifier = notifier;
  }

  /** Register a provider for a specific email account */
  registerProvider(accountId: string, provider: EmailProvider): void {
    this.providers.set(accountId, provider);
    log.info(`Comms: registered ${provider.name} provider for account ${accountId}`);
  }

  /** Unregister a provider (e.g., on account delete/edit) */
  unregisterProvider(accountId: string): void {
    this.providers.delete(accountId);
  }

  /** Backward compat: register a Gmail provider without an account */
  setGoogleClient(client: GoogleClient): void {
    this.legacyGmailProvider = new GmailProvider(client);
  }

  /**
   * Stash provider-construction dependencies so new accounts can register
   * providers on-the-fly (e.g., right after POST /api/email-accounts).
   */
  setProviderContext(ctx: { googleAuth?: GoogleAuth | null; resendFallbackKey?: string }): void {
    if (ctx.googleAuth !== undefined) this.googleAuth = ctx.googleAuth;
    if (ctx.resendFallbackKey !== undefined) this.resendFallbackKey = ctx.resendFallbackKey;
  }

  /**
   * Construct and register the provider for an account using its stored config
   * plus the shared provider context (Google OAuth, Resend fallback key). Called
   * at module init and after account create/update so providers work without
   * a server restart.
   */
  registerAccountProvider(accountId: string): { ok: boolean; reason?: string } {
    const account = this.getAccount(accountId);
    if (!account) return { ok: false, reason: "Account not found" };

    const rawConfig = (() => {
      try { return JSON.parse(account.provider_config || "{}") as Record<string, unknown>; }
      catch { return {}; }
    })();

    if (account.provider === "gmail") {
      if (!this.googleAuth) return { ok: false, reason: "Google OAuth not configured (set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)" };
      if (!this.googleAuth.isAuthenticated()) return { ok: false, reason: "Google not authenticated — run the OAuth flow first" };
      const client = new GoogleClient(this.googleAuth);
      this.registerProvider(account.id, new GmailProvider(client));
      return { ok: true };
    }

    if (account.provider === "resend") {
      const key = (rawConfig.api_key as string) || this.resendFallbackKey;
      if (!key) return { ok: false, reason: "No Resend API key (set api_key in provider_config or RESEND_API_KEY)" };
      this.registerProvider(account.id, new ResendProvider(key, account.email));
      return { ok: true };
    }

    if (account.provider === "imap_smtp") {
      const cfg = rawConfig as unknown as ImapSmtpConfig;
      if (!cfg.imap_host || !cfg.smtp_host || !cfg.user || !cfg.pass) {
        return { ok: false, reason: "Incomplete IMAP/SMTP config (imap_host, smtp_host, user, pass required)" };
      }
      this.registerProvider(account.id, new ImapSmtpProvider(cfg, account.email));
      return { ok: true };
    }

    return { ok: false, reason: `Unsupported provider: ${account.provider}` };
  }

  /** Get the provider for a specific account, or the legacy fallback */
  getProvider(accountId?: string | null): EmailProvider | null {
    if (accountId) {
      return this.providers.get(accountId) ?? null;
    }
    // Try default account
    const defaultId = this.getDefaultAccountId();
    if (defaultId) {
      return this.providers.get(defaultId) ?? null;
    }
    // Legacy fallback
    return this.legacyGmailProvider;
  }

  // ── Create ──────────────────────────────────────────

  create(input: {
    channel?: CommChannel;
    direction?: "inbound" | "outbound";
    subject?: string;
    body?: string;
    body_html?: string;
    contact_id?: string;
    task_id?: string;
    account_id?: string;
    in_reply_to?: string;
    recipients_to?: string;
    recipients_cc?: string;
    recipients_bcc?: string;
  }): Communication {
    const now = isoNow();
    const id = newId();

    // Auto-complete recipients from contact email
    let recipientsTo = input.recipients_to ?? "";
    if (!recipientsTo && input.contact_id) {
      const contact = this.db
        .prepare("SELECT email FROM contacts WHERE id = ?")
        .get(input.contact_id) as { email: string } | undefined;
      if (contact && contact.email) {
        recipientsTo = contact.email;
      }
    }

    // If replying, inherit thread_id from parent
    let threadId = "";
    if (input.in_reply_to) {
      const parent = this.db
        .prepare("SELECT thread_id, id FROM communications WHERE id = ?")
        .get(input.in_reply_to) as { thread_id: string; id: string } | undefined;
      if (parent) {
        threadId = parent.thread_id || parent.id;
      }
    }
    if (!threadId) threadId = id;

    // Resolve account_id: use provided, or fall back to default. Coerce ""→default
    // (agents pass "" for "none"; ?? wouldn't catch it → invalid FK value).
    const accountId = (input.account_id || this.getDefaultAccountId()) || null;

    const comm: Communication = {
      id,
      channel: input.channel ?? "email",
      direction: input.direction ?? "outbound",
      status: "draft",
      subject: input.subject ?? "",
      body: input.body ?? "",
      body_html: sanitizeUserHtml(input.body_html ?? ""),
      contact_id: input.contact_id || null,
      task_id: input.task_id || null,
      account_id: accountId,
      thread_id: threadId,
      in_reply_to: input.in_reply_to ?? "",
      recipients_to: recipientsTo,
      recipients_cc: input.recipients_cc ?? "",
      recipients_bcc: input.recipients_bcc ?? "",
      gmail_message_id: "",
      gmail_thread_id: "",
      scheduled_at: null,
      sent_at: null,
      error_message: "",
      metadata: "{}",
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO communications
         (id, channel, direction, status, subject, body, body_html,
          contact_id, task_id, account_id, thread_id, in_reply_to,
          recipients_to, recipients_cc, recipients_bcc,
          gmail_message_id, gmail_thread_id,
          scheduled_at, sent_at, error_message, metadata,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        comm.id, comm.channel, comm.direction, comm.status,
        comm.subject, comm.body, comm.body_html,
        comm.contact_id, comm.task_id, comm.account_id, comm.thread_id, comm.in_reply_to,
        comm.recipients_to, comm.recipients_cc, comm.recipients_bcc,
        comm.gmail_message_id, comm.gmail_thread_id,
        comm.scheduled_at, comm.sent_at, comm.error_message, comm.metadata,
        comm.created_at, comm.updated_at,
      );

    return comm;
  }

  // ── Update ──────────────────────────────────────────

  /**
   * Persist a structured classification block on an inbound email's metadata.
   * Writes to `metadata.classification` (JSON), leaves `body`/`status`/etc
   * untouched so it bypasses the draft-only guard of `update()`.
   *
   * Used by the rich-classification agent to tag emails with provenance,
   * importance, action_required, stakeholder_id, topic_tags. Idempotent —
   * re-classifying overwrites the previous classification block.
   */
  setClassification(
    id: string,
    payload: {
      provenance?: "vendor" | "client" | "personal" | "automated" | "unknown";
      importance?: "critical" | "high" | "normal" | "low";
      action_required?: "reply" | "read" | "file" | "escalate" | "schedule" | "none";
      stakeholder_id?: string;
      topic_tags?: string[];
      rationale?: string;
    },
  ): boolean {
    const existing = this.getById(id);
    if (!existing) return false;
    const now = isoNow();
    const block = {
      provenance: payload.provenance ?? "unknown",
      importance: payload.importance ?? "normal",
      action_required: payload.action_required ?? "none",
      stakeholder_id: payload.stakeholder_id ?? "",
      topic_tags: payload.topic_tags ?? [],
      rationale: payload.rationale ?? "",
      classified_at: now,
    };
    const result = this.db
      .prepare(
        `UPDATE communications
         SET metadata = json_set(metadata, '$.classification', json(?)),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(block), now, id);
    return (result as { changes?: number }).changes ? true : false;
  }

  update(
    id: string,
    changes: Partial<
      Pick<
        Communication,
        "subject" | "body" | "body_html" | "status" | "recipients_to" | "recipients_cc" | "recipients_bcc" | "scheduled_at" | "contact_id" | "task_id" | "account_id"
      >
    >,
  ): Communication | null {
    const existing = this.getById(id);
    if (!existing) return null;

    // Only allow editing drafts and failed
    if (!["draft", "failed"].includes(existing.status) && !changes.status) {
      return null;
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        // Sanitize HTML at the only edit gate so we can't store raw scripts.
        // body is plain text; only body_html goes through the sanitizer.
        params.push(key === "body_html" ? sanitizeUserHtml(String(value)) : value);
      }
    }

    if (sets.length === 0) return existing;

    const now = isoNow();
    sets.push("updated_at = ?");
    params.push(now);
    params.push(id);

    this.db
      .prepare(`UPDATE communications SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    return this.getById(id)!;
  }

  // ── Get ─────────────────────────────────────────────

  getById(id: string): Communication | null {
    return (
      (this.db
        .prepare("SELECT * FROM communications WHERE id = ?")
        .get(id) as Communication | undefined) ?? null
    );
  }

  getWithDetails(id: string): {
    comm: Communication;
    attachments: CommAttachment[];
    contact: { name: string; email: string } | null;
    task: { title: string } | null;
    account: { email: string; label: string } | null;
  } | null {
    const comm = this.getById(id);
    if (!comm) return null;

    // Resolve the sending/owning account so the UI can show the "from" address.
    let account: { email: string; label: string } | null = null;
    if (comm.account_id) {
      account = (this.db
        .prepare("SELECT email, label FROM email_accounts WHERE id = ?")
        .get(comm.account_id) as { email: string; label: string } | undefined) ?? null;
    }

    const attachments = this.db
      .prepare("SELECT * FROM comm_attachments WHERE comm_id = ? ORDER BY created_at")
      .all(id) as CommAttachment[];

    let contact: { name: string; email: string } | null = null;
    if (comm.contact_id) {
      contact = (this.db
        .prepare("SELECT name, email FROM contacts WHERE id = ?")
        .get(comm.contact_id) as { name: string; email: string } | undefined) ?? null;
    }

    let task: { title: string } | null = null;
    if (comm.task_id) {
      task = (this.db
        .prepare("SELECT title FROM tasks WHERE id = ?")
        .get(comm.task_id) as { title: string } | undefined) ?? null;
    }

    return { comm, attachments, contact, task, account };
  }

  // ── List ────────────────────────────────────────────

  list(filters?: {
    channel?: CommChannel;
    status?: CommStatus;
    direction?: CommDirection;
    contact_id?: string;
    task_id?: string;
    account_id?: string;
    limit?: number;
  }): Communication[] {
    let sql = "SELECT * FROM communications WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.channel) {
      sql += " AND channel = ?";
      params.push(filters.channel);
    }
    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters?.direction) {
      sql += " AND direction = ?";
      params.push(filters.direction);
    }
    if (filters?.contact_id) {
      sql += " AND contact_id = ?";
      params.push(filters.contact_id);
    }
    if (filters?.task_id) {
      sql += " AND task_id = ?";
      params.push(filters.task_id);
    }
    if (filters?.account_id) {
      sql += " AND account_id = ?";
      params.push(filters.account_id);
    }

    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(filters?.limit ?? 50);

    return this.db.prepare(sql).all(...params) as Communication[];
  }

  // ── Attachments ─────────────────────────────────────

  attach(commId: string, filePath: string): CommAttachment | null {
    const comm = this.getById(commId);
    if (!comm) return null;
    if (!["draft", "failed"].includes(comm.status)) return null;

    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stats = statSync(filePath);
    const filename = basename(filePath);
    const mimeType = guessMime(filename);

    const destDir = join(ATTACHMENTS_DIR, commId);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }

    const storedPath = join(destDir, filename);
    copyFileSync(filePath, storedPath);

    const now = isoNow();
    const attachment: CommAttachment = {
      id: newId(),
      comm_id: commId,
      filename,
      original_path: filePath,
      stored_path: storedPath,
      mime_type: mimeType,
      size_bytes: stats.size,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO comm_attachments (id, comm_id, filename, original_path, stored_path, mime_type, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attachment.id, attachment.comm_id, attachment.filename,
        attachment.original_path, attachment.stored_path, attachment.mime_type,
        attachment.size_bytes, attachment.created_at,
      );

    return attachment;
  }

  removeAttachment(attachmentId: string): boolean {
    const att = this.db
      .prepare("SELECT * FROM comm_attachments WHERE id = ?")
      .get(attachmentId) as CommAttachment | undefined;
    if (!att) return false;

    // Remove file if exists
    if (att.stored_path && existsSync(att.stored_path)) {
      unlinkSync(att.stored_path);
    }

    this.db.prepare("DELETE FROM comm_attachments WHERE id = ?").run(attachmentId);

    // Clean up empty directory
    const destDir = join(ATTACHMENTS_DIR, att.comm_id);
    if (existsSync(destDir)) {
      try {
        const remaining = this.db
          .prepare("SELECT COUNT(*) AS c FROM comm_attachments WHERE comm_id = ?")
          .get(att.comm_id) as { c: number };
        if (remaining.c === 0) {
          rmSync(destDir, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup errors
      }
    }

    return true;
  }

  getAttachment(id: string): CommAttachment | null {
    return (this.db.prepare("SELECT * FROM comm_attachments WHERE id = ?").get(id) as CommAttachment | undefined) ?? null;
  }

  getAttachments(commId: string): CommAttachment[] {
    return this.db
      .prepare("SELECT * FROM comm_attachments WHERE comm_id = ? ORDER BY created_at")
      .all(commId) as CommAttachment[];
  }

  // ── Thread ──────────────────────────────────────────

  getThread(threadId: string): Communication[] {
    return this.db
      .prepare(
        "SELECT * FROM communications WHERE thread_id = ? ORDER BY created_at ASC",
      )
      .all(threadId) as Communication[];
  }

  // ── Send Email ──────────────────────────────────────

  async sendEmail(id: string): Promise<Communication> {
    const comm = this.getById(id);
    if (!comm) throw new Error(`Communication not found: ${id}`);
    if (comm.channel !== "email") throw new Error("Only email channel is supported for sending");
    if (!["draft", "ready", "failed"].includes(comm.status)) {
      throw new Error(`Cannot send communication with status: ${comm.status}`);
    }
    if (!comm.recipients_to) throw new Error("No recipients specified");

    const provider = this.getProvider(comm.account_id);
    if (!provider) throw new Error("No email provider configured. Add an email account or authenticate with Google first.");
    if (!provider.capabilities.send) throw new Error(`Provider ${provider.name} does not support sending`);

    // Mark as sending
    this.db
      .prepare("UPDATE communications SET status = 'sending', updated_at = ? WHERE id = ?")
      .run(isoNow(), id);

    try {
      const meta = parseMetadata(comm.metadata);
      const mimeReplyTo = meta.reply_to_message_id || undefined;
      const attachments = this.getAttachments(id);

      const result = await provider.send({
        to: comm.recipients_to,
        cc: comm.recipients_cc || undefined,
        bcc: comm.recipients_bcc || undefined,
        subject: comm.subject,
        body: comm.body,
        bodyHtml: comm.body_html || undefined,
        inReplyTo: mimeReplyTo,
        threadId: comm.gmail_thread_id || undefined,
        attachments: attachments.map((a) => ({
          filename: a.filename,
          mimeType: a.mime_type,
          path: a.stored_path,
        })),
      });

      const now = isoNow();
      this.db
        .prepare(
          `UPDATE communications
           SET status = 'sent', sent_at = ?, gmail_message_id = ?, gmail_thread_id = ?, error_message = '', updated_at = ?
           WHERE id = ?`,
        )
        .run(now, result.messageId, result.threadId, now, id);

      if (comm.contact_id) {
        await this.events.emit("contact.interaction", {
          contactId: comm.contact_id,
          type: "email",
          summary: `Sent: ${comm.subject}`,
        });
      }

      log.info(`Email sent via ${provider.name}: ${id}`);
      return this.getById(id)!;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.db
        .prepare(
          "UPDATE communications SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
        )
        .run(errorMsg, isoNow(), id);

      log.error(`Email send failed: ${id}`, err);
      throw err;
    }
  }

  // ── Send WhatsApp ──────────────────────────────────

  async sendWhatsApp(id: string): Promise<Communication> {
    const comm = this.getById(id);
    if (!comm) throw new Error(`Communication not found: ${id}`);
    if (comm.channel !== "whatsapp") throw new Error("Communication is not a WhatsApp message");
    if (!["draft", "ready", "failed"].includes(comm.status)) {
      throw new Error(`Cannot send communication with status: ${comm.status}`);
    }
    if (!comm.recipients_to) throw new Error("No recipient phone number specified in recipients_to");
    if (!this.notifier) throw new Error("WhatsApp not available — notifier not configured");

    const registry = this.notifier.getRegistry();
    const waProvider = registry.getProvider("whatsapp");
    if (!waProvider?.isReady()) throw new Error("WhatsApp provider not connected. Check WHATSAPP_ENABLED and QR pairing.");
    if (!waProvider.sendTo) throw new Error("WhatsApp provider does not support sendTo");

    // Mark as sending
    this.db
      .prepare("UPDATE communications SET status = 'sending', updated_at = ? WHERE id = ?")
      .run(isoNow(), id);

    try {
      // Build JID from phone number (strip spaces/dashes, ensure @s.whatsapp.net)
      const phone = comm.recipients_to.replace(/[\s\-\+\(\)]/g, "");
      const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;

      const success = await waProvider.sendTo(jid, {
        title: comm.subject || "",
        body: comm.body || "",
      });

      if (!success) throw new Error("WhatsApp provider returned false — message not delivered");

      const now = isoNow();
      this.db
        .prepare(
          `UPDATE communications
           SET status = 'sent', sent_at = ?, error_message = '', updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, id);

      if (comm.contact_id) {
        await this.events.emit("contact.interaction", {
          contactId: comm.contact_id,
          type: "whatsapp",
          summary: `WhatsApp: ${(comm.body || "").slice(0, 80)}`,
        });
      }

      log.info(`WhatsApp sent: ${id} → ${jid}`);
      return this.getById(id)!;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.db
        .prepare(
          "UPDATE communications SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
        )
        .run(errorMsg, isoNow(), id);

      log.error(`WhatsApp send failed: ${id}`, err);
      throw err;
    }
  }

  // ── Search Inbox ──────────────────────────────────

  async searchInbox(query: string, maxResults = 10, accountId?: string): Promise<InboxMessage[]> {
    const provider = this.getProvider(accountId);
    if (!provider) throw new Error("No email provider configured. Add an email account or authenticate with Google first.");
    if (!provider.capabilities.searchInbox) throw new Error(`Provider ${provider.name} does not support inbox search`);

    return provider.searchInbox(query, maxResults);
  }

  // ── Fetch Email ───────────────────────────────────

  async fetchEmail(gmailMessageId: string, accountId?: string): Promise<Communication> {
    const provider = this.getProvider(accountId);
    if (!provider) throw new Error("No email provider configured. Add an email account or authenticate with Google first.");
    if (!provider.capabilities.fetchEmail) throw new Error(`Provider ${provider.name} does not support fetching emails`);

    // Dedup PER ACCOUNT: the same Message-ID legitimately exists once per
    // mailbox (e.g. an email sent from one kernel account TO another shows up
    // as outbound on the sender and inbound on the receiver). Deduping globally
    // would drop the inbound copy and the receiving agent would never see it.
    const dedupAccountId = accountId ?? this.getDefaultAccountId();
    const existing = this.db
      .prepare("SELECT * FROM communications WHERE gmail_message_id = ? AND account_id IS ?")
      .get(gmailMessageId, dedupAccountId ?? null) as Communication | undefined;
    if (existing) return existing;

    const fetched = await provider.fetchEmail(gmailMessageId);

    // Try to match sender to a CRM contact
    let contactId: string | null = null;
    if (fetched.from) {
      const contact = this.db
        .prepare("SELECT id FROM contacts WHERE LOWER(email) = ?")
        .get(fetched.from) as { id: string } | undefined;
      if (contact) contactId = contact.id;
    }

    const now = isoNow();
    const id = newId();
    const meta = JSON.stringify({
      from: fetched.from,
      from_name: fetched.fromName,
      message_id_header: fetched.messageIdHeader,
    });

    const comm: Communication = {
      id,
      channel: "email",
      direction: "inbound",
      status: "archived",
      subject: fetched.subject,
      body: fetched.body,
      body_html: sanitizeUserHtml(fetched.bodyHtml),
      contact_id: contactId,
      task_id: null,
      account_id: accountId ?? this.getDefaultAccountId(),
      thread_id: id,
      in_reply_to: "",
      recipients_to: fetched.to,
      recipients_cc: fetched.cc,
      recipients_bcc: "",
      gmail_message_id: gmailMessageId,
      gmail_thread_id: fetched.threadId,
      scheduled_at: null,
      sent_at: fetched.date,
      error_message: "",
      metadata: meta,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO communications
         (id, channel, direction, status, subject, body, body_html,
          contact_id, task_id, account_id, thread_id, in_reply_to,
          recipients_to, recipients_cc, recipients_bcc,
          gmail_message_id, gmail_thread_id,
          scheduled_at, sent_at, error_message, metadata,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        comm.id, comm.channel, comm.direction, comm.status,
        comm.subject, comm.body, comm.body_html,
        comm.contact_id, comm.task_id, comm.account_id, comm.thread_id, comm.in_reply_to,
        comm.recipients_to, comm.recipients_cc, comm.recipients_bcc,
        comm.gmail_message_id, comm.gmail_thread_id,
        comm.scheduled_at, comm.sent_at, comm.error_message, comm.metadata,
        comm.created_at, comm.updated_at,
      );

    log.info(`Fetched email: ${gmailMessageId} → ${id} (from: ${fetched.from})`);
    return comm;
  }

  // ── Ingest Inbound (generic — webhook, IMAP fetcher, any source) ───
  //
  // One entry point for "an email arrived from outside". Dedups on
  // message_id_header (falls back to a synthetic key if not present) so
  // retries from webhook providers (Mailgun/Sendgrid/Resend inbound) don't
  // create duplicates. Emits `comms:mail:received` for every NEW row so the
  // 3D dashboard can fire the truck + reception animation.

  ingestInboundRaw(input: {
    from: string;
    from_name?: string;
    to?: string;
    cc?: string;
    subject?: string;
    body?: string;
    body_html?: string;
    message_id_header?: string;
    received_at?: string;
    source?: string;        // "webhook:mailgun" | "imap" | "custom" — stored in metadata
    account_id?: string | null;
    raw_headers?: Record<string, string>;
  }): { comm: Communication; isNew: boolean } {
    const messageIdKey = (input.message_id_header ?? "").trim();
    const sourceTag = input.source ?? "webhook";

    // Dedup key: prefer real Message-ID, else a synthetic hash so retries with
    // identical body + sender coalesce.
    const dedupKey = messageIdKey
      ? `extid:${messageIdKey}`
      : `synth:${input.from}:${(input.subject ?? "").slice(0, 80)}:${(input.body ?? "").slice(0, 120).length}`;

    const existing = this.db
      .prepare("SELECT * FROM communications WHERE gmail_message_id = ?")
      .get(dedupKey) as Communication | undefined;
    if (existing) {
      return { comm: existing, isNew: false };
    }

    // CRM match on sender address
    let contactId: string | null = null;
    const fromAddr = (input.from || "").toLowerCase().trim();
    if (fromAddr) {
      const contact = this.db
        .prepare("SELECT id FROM contacts WHERE LOWER(email) = ?")
        .get(fromAddr) as { id: string } | undefined;
      if (contact) contactId = contact.id;
    }

    const now = isoNow();
    const id = newId();
    const accountId = input.account_id ?? this.getDefaultAccountId() ?? null;
    const meta = JSON.stringify({
      from: input.from,
      from_name: input.from_name ?? "",
      message_id_header: messageIdKey,
      source: sourceTag,
      raw_headers: input.raw_headers ?? {},
    });

    const comm: Communication = {
      id,
      channel: "email",
      direction: "inbound",
      status: "archived",
      subject: input.subject ?? "(no subject)",
      body: input.body ?? "",
      body_html: sanitizeUserHtml(input.body_html ?? ""),
      contact_id: contactId,
      task_id: null,
      account_id: accountId,
      thread_id: id,
      in_reply_to: "",
      recipients_to: input.to ?? "",
      recipients_cc: input.cc ?? "",
      recipients_bcc: "",
      gmail_message_id: dedupKey,
      gmail_thread_id: "",
      scheduled_at: null,
      sent_at: input.received_at ?? now,
      error_message: "",
      metadata: meta,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO communications
         (id, channel, direction, status, subject, body, body_html,
          contact_id, task_id, account_id, thread_id, in_reply_to,
          recipients_to, recipients_cc, recipients_bcc,
          gmail_message_id, gmail_thread_id,
          scheduled_at, sent_at, error_message, metadata,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        comm.id, comm.channel, comm.direction, comm.status,
        comm.subject, comm.body, comm.body_html,
        comm.contact_id, comm.task_id, comm.account_id, comm.thread_id, comm.in_reply_to,
        comm.recipients_to, comm.recipients_cc, comm.recipients_bcc,
        comm.gmail_message_id, comm.gmail_thread_id,
        comm.scheduled_at, comm.sent_at, comm.error_message, comm.metadata,
        comm.created_at, comm.updated_at,
      );

    log.info(`Comms: ingested inbound ${sourceTag} email from ${input.from} → ${id}`);

    // Signal for the 3D dashboard: truck + reception animation.
    this.events.emit("comms:mail:received" as any, {
      count: 1,
      source: sourceTag,
      comm_id: id,
      account_id: accountId,
      from: input.from,
      subject: comm.subject,
      ts: now,
    });

    return { comm, isNew: true };
  }

  // ── Create Reply ──────────────────────────────────

  createReply(
    commId: string,
    options?: {
      body?: string;
      include_quote?: boolean;
      cc?: string;
      reply_all?: boolean;
    },
  ): Communication {
    const parent = this.getById(commId);
    if (!parent) throw new Error(`Communication not found: ${commId}`);

    const parentMeta = parseMetadata(parent.metadata);
    const includeQuote = options?.include_quote !== false;

    // Determine reply recipients based on parent direction
    let recipientsTo: string;
    if (parent.direction === "inbound") {
      // Replying to someone who sent us email → send back to them
      recipientsTo = parentMeta.from || "";
      if (!recipientsTo && parent.contact_id) {
        const contact = this.db
          .prepare("SELECT email FROM contacts WHERE id = ?")
          .get(parent.contact_id) as { email: string } | undefined;
        if (contact?.email) recipientsTo = contact.email;
      }
    } else {
      // Following up on an email we sent → send to same recipients
      recipientsTo = parent.recipients_to;
    }

    // CC: use provided, or if reply_all, include original CC
    let recipientsCc = options?.cc ?? "";
    if (options?.reply_all && parent.recipients_cc) {
      recipientsCc = recipientsCc
        ? `${recipientsCc}, ${parent.recipients_cc}`
        : parent.recipients_cc;
    }

    // Subject: add Re: if not already present
    let subject = parent.subject;
    if (subject && !/^Re:\s/i.test(subject)) {
      subject = `Re: ${subject}`;
    }

    // Build body with optional quoting
    let body = options?.body ?? "";
    if (includeQuote && parent.body) {
      const senderName = parentMeta.from_name || parentMeta.from || "sender";
      const dateStr = parent.sent_at?.split("T")[0] ?? parent.created_at.split("T")[0];
      const quoted = quoteBody(parent.body, senderName, dateStr);
      body = body ? `${body}\n\n${quoted}` : quoted;
    }

    // Metadata for proper MIME threading
    const meta = JSON.stringify({
      reply_to_message_id: parentMeta.message_id_header || "",
      quoted_text: parent.body?.slice(0, 2000) || "",
    });

    const now = isoNow();
    const id = newId();

    // Inherit thread and gmail threading
    const threadId = parent.thread_id || parent.id;

    const comm: Communication = {
      id,
      channel: "email",
      direction: "outbound",
      status: "draft",
      subject,
      body,
      body_html: "",
      contact_id: parent.contact_id,
      task_id: parent.task_id,
      account_id: parent.account_id,
      thread_id: threadId,
      in_reply_to: parent.id,
      recipients_to: recipientsTo,
      recipients_cc: recipientsCc,
      recipients_bcc: "",
      gmail_message_id: "",
      gmail_thread_id: parent.gmail_thread_id,
      scheduled_at: null,
      sent_at: null,
      error_message: "",
      metadata: meta,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO communications
         (id, channel, direction, status, subject, body, body_html,
          contact_id, task_id, account_id, thread_id, in_reply_to,
          recipients_to, recipients_cc, recipients_bcc,
          gmail_message_id, gmail_thread_id,
          scheduled_at, sent_at, error_message, metadata,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        comm.id, comm.channel, comm.direction, comm.status,
        comm.subject, comm.body, comm.body_html,
        comm.contact_id, comm.task_id, comm.account_id, comm.thread_id, comm.in_reply_to,
        comm.recipients_to, comm.recipients_cc, comm.recipients_bcc,
        comm.gmail_message_id, comm.gmail_thread_id,
        comm.scheduled_at, comm.sent_at, comm.error_message, comm.metadata,
        comm.created_at, comm.updated_at,
      );

    return comm;
  }

  // ── Email Accounts ─────────────────────────────────

  addAccount(input: {
    label: string;
    email: string;
    type?: "personal" | "work" | "transactional" | "marketing";
    provider?: "gmail" | "resend" | "imap_smtp";
    company?: string;
    signature?: string;
    provider_config?: Record<string, unknown>;
    is_default?: boolean;
  }): EmailAccount {
    const now = isoNow();
    const id = newId();

    // If setting as default, clear other defaults first
    if (input.is_default) {
      this.db.prepare("UPDATE email_accounts SET is_default = 0").run();
    }

    // If this is the first account, make it default
    const count = (this.db.prepare("SELECT COUNT(*) AS c FROM email_accounts").get() as { c: number }).c;
    const isDefault = input.is_default || count === 0 ? 1 : 0;

    const account: EmailAccount = {
      id,
      label: input.label,
      email: input.email,
      type: input.type ?? "personal",
      provider: input.provider ?? "gmail",
      company: input.company ?? "",
      signature: input.signature ?? "",
      provider_config: JSON.stringify(input.provider_config ?? {}),
      is_default: isDefault,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO email_accounts
         (id, label, email, type, provider, company, signature, provider_config, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        account.id, account.label, account.email, account.type, account.provider,
        account.company, account.signature, account.provider_config, account.is_default,
        account.created_at, account.updated_at,
      );

    // Best-effort provider registration so the account is usable immediately.
    // Silent failure is OK here — test_account / the UI will surface the reason.
    this.registerAccountProvider(account.id);

    // Backfill legacy google_emails rows (imported before any account existed)
    // so the new Gmail account immediately shows its history.
    if (account.provider === "gmail") {
      const rows = this.backfillLegacyEmails();
      if (rows > 0) log.info(`Comms: backfilled ${rows} legacy email(s) → account ${account.label}`);
    }

    return account;
  }

  listAccounts(): EmailAccount[] {
    return this.db
      .prepare("SELECT * FROM email_accounts ORDER BY is_default DESC, label ASC")
      .all() as EmailAccount[];
  }

  getAccount(id: string): EmailAccount | null {
    return (this.db
      .prepare("SELECT * FROM email_accounts WHERE id = ?")
      .get(id) as EmailAccount | undefined) ?? null;
  }

  getAccountByEmail(email: string): EmailAccount | null {
    return (this.db
      .prepare("SELECT * FROM email_accounts WHERE email = ?")
      .get(email) as EmailAccount | undefined) ?? null;
  }

  updateAccount(
    id: string,
    changes: Partial<Pick<EmailAccount, "label" | "email" | "type" | "company" | "signature" | "provider_config" | "is_default">>,
  ): EmailAccount | null {
    const existing = this.getAccount(id);
    if (!existing) return null;

    // If setting as default, clear other defaults
    if (changes.is_default === 1) {
      this.db.prepare("UPDATE email_accounts SET is_default = 0").run();
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        params.push(value);
      }
    }

    if (sets.length === 0) return existing;

    sets.push("updated_at = ?");
    params.push(isoNow());
    params.push(id);

    this.db
      .prepare(`UPDATE email_accounts SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    // Re-register provider in case credentials (provider_config) or email changed.
    this.registerAccountProvider(id);

    return this.getAccount(id)!;
  }

  deleteAccount(id: string): boolean {
    const existing = this.getAccount(id);
    if (!existing) return false;

    this.unregisterProvider(id);

    // Unlink communications from this account
    this.db.prepare("UPDATE communications SET account_id = NULL WHERE account_id = ?").run(id);
    this.db.prepare("DELETE FROM email_accounts WHERE id = ?").run(id);

    // If deleted the default, promote another one
    if (existing.is_default) {
      const next = this.db.prepare("SELECT id FROM email_accounts LIMIT 1").get() as { id: string } | undefined;
      if (next) {
        this.db.prepare("UPDATE email_accounts SET is_default = 1 WHERE id = ?").run(next.id);
      }
    }

    return true;
  }

  private getDefaultAccountId(): string | null {
    try {
      const account = this.db
        .prepare("SELECT id FROM email_accounts WHERE is_default = 1 LIMIT 1")
        .get() as { id: string } | undefined;
      return account?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Backfill emails with a NULL/empty account_id. If there's exactly one
   * gmail account, assign all legacy emails to it. Safe to re-run.
   * Returns the number of rows updated.
   */
  backfillLegacyEmails(): number {
    try {
      const gmailAccounts = this.db
        .prepare("SELECT id FROM email_accounts WHERE provider = 'gmail' ORDER BY is_default DESC, created_at ASC")
        .all() as Array<{ id: string }>;
      if (gmailAccounts.length !== 1) return 0;

      const targetId = gmailAccounts[0].id;
      const result = this.db
        .prepare("UPDATE google_emails SET account_id = ? WHERE account_id IS NULL OR account_id = ''")
        .run(targetId);
      return result.changes;
    } catch {
      return 0;
    }
  }

  /**
   * Probe an account's provider to confirm credentials work. Gmail = check auth;
   * Resend = send a test API call; IMAP/SMTP = verify both protocols.
   */
  async testAccount(accountId: string): Promise<{
    ok: boolean;
    provider: string;
    details: Record<string, unknown>;
  }> {
    const account = this.getAccount(accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);

    if (account.provider === "imap_smtp") {
      const { ImapSmtpProvider } = await import("./providers/imap-smtp-provider.js");
      const config = JSON.parse(account.provider_config || "{}");
      const provider = new ImapSmtpProvider(config, account.email);
      const result = await provider.verify();
      return {
        ok: result.imap && result.smtp,
        provider: "imap_smtp",
        details: { imap: result.imap, smtp: result.smtp, error: result.error ?? "" },
      };
    }

    if (account.provider === "gmail") {
      const provider = this.getProvider(accountId);
      if (!provider) return { ok: false, provider: "gmail", details: { error: "Gmail provider not registered (OAuth not completed?)" } };
      try {
        await provider.searchInbox("in:inbox", 1);
        return { ok: true, provider: "gmail", details: {} };
      } catch (err) {
        return { ok: false, provider: "gmail", details: { error: err instanceof Error ? err.message : String(err) } };
      }
    }

    if (account.provider === "resend") {
      const config = JSON.parse(account.provider_config || "{}") as { api_key?: string };
      const key = config.api_key;
      if (!key) return { ok: false, provider: "resend", details: { error: "No api_key in provider_config" } };
      try {
        const response = await fetch("https://api.resend.com/domains", {
          headers: { Authorization: `Bearer ${key}` },
        });
        return {
          ok: response.ok,
          provider: "resend",
          details: response.ok ? {} : { error: `Resend responded ${response.status}` },
        };
      } catch (err) {
        return { ok: false, provider: "resend", details: { error: err instanceof Error ? err.message : String(err) } };
      }
    }

    return { ok: false, provider: account.provider, details: { error: `Unsupported provider: ${account.provider}` } };
  }

  // ── Templates ──────────────────────────────────

  createTemplate(input: {
    name: string;
    subject?: string;
    body?: string;
    body_html?: string;
    category?: string;
    account_id?: string;
  }): EmailTemplate {
    const now = isoNow();
    const id = newId();
    const subject = input.subject ?? "";
    const body = input.body ?? "";
    const bodyHtml = input.body_html ?? "";
    const variables = JSON.stringify(detectTemplateVariables(subject, body, bodyHtml));

    const template: EmailTemplate = {
      id,
      name: input.name,
      subject,
      body,
      body_html: bodyHtml,
      category: input.category ?? "general",
      variables,
      account_id: input.account_id ?? null,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO email_templates
         (id, name, subject, body, body_html, category, variables, account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        template.id, template.name, template.subject, template.body, template.body_html,
        template.category, template.variables, template.account_id,
        template.created_at, template.updated_at,
      );

    return template;
  }

  listTemplates(category?: string): EmailTemplate[] {
    if (category) {
      return this.db
        .prepare("SELECT * FROM email_templates WHERE category = ? ORDER BY name")
        .all(category) as EmailTemplate[];
    }
    return this.db
      .prepare("SELECT * FROM email_templates ORDER BY name")
      .all() as EmailTemplate[];
  }

  getTemplate(id: string): EmailTemplate | null {
    return (this.db
      .prepare("SELECT * FROM email_templates WHERE id = ?")
      .get(id) as EmailTemplate | undefined) ?? null;
  }

  updateTemplate(
    id: string,
    changes: Partial<Pick<EmailTemplate, "name" | "subject" | "body" | "body_html" | "category" | "account_id">>,
  ): EmailTemplate | null {
    const existing = this.getTemplate(id);
    if (!existing) return null;

    const sets: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        params.push(value);
      }
    }

    if (sets.length === 0) return existing;

    // Re-detect variables if subject/body changed
    const newSubject = changes.subject ?? existing.subject;
    const newBody = changes.body ?? existing.body;
    const newBodyHtml = changes.body_html ?? existing.body_html;
    sets.push("variables = ?");
    params.push(JSON.stringify(detectTemplateVariables(newSubject, newBody, newBodyHtml)));

    sets.push("updated_at = ?");
    params.push(isoNow());
    params.push(id);

    this.db
      .prepare(`UPDATE email_templates SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    return this.getTemplate(id)!;
  }

  deleteTemplate(id: string): boolean {
    const result = this.db.prepare("DELETE FROM email_templates WHERE id = ?").run(id);
    return result.changes > 0;
  }

  previewTemplate(
    templateId: string,
    context: Record<string, string>,
  ): { subject: string; body: string; bodyHtml: string } | null {
    const template = this.getTemplate(templateId);
    if (!template) return null;

    return {
      subject: renderTemplate(template.subject, context),
      body: renderTemplate(template.body, context),
      bodyHtml: template.body_html ? renderTemplate(template.body_html, context) : "",
    };
  }

  // ── Campaigns ──────────────────────────────────

  createCampaign(input: {
    name: string;
    template_id?: string;
    account_id?: string;
    subject_override?: string;
    scheduled_at?: string;
  }): EmailCampaign {
    const now = isoNow();
    const id = newId();
    const accountId = input.account_id ?? this.getDefaultAccountId();

    const campaign: EmailCampaign = {
      id,
      name: input.name,
      template_id: input.template_id ?? null,
      account_id: accountId,
      status: "draft",
      subject_override: input.subject_override ?? "",
      total_recipients: 0,
      sent_count: 0,
      failed_count: 0,
      scheduled_at: input.scheduled_at ?? null,
      started_at: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO email_campaigns
         (id, name, template_id, account_id, status, subject_override,
          total_recipients, sent_count, failed_count,
          scheduled_at, started_at, completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        campaign.id, campaign.name, campaign.template_id, campaign.account_id,
        campaign.status, campaign.subject_override,
        campaign.total_recipients, campaign.sent_count, campaign.failed_count,
        campaign.scheduled_at, campaign.started_at, campaign.completed_at,
        campaign.created_at, campaign.updated_at,
      );

    return campaign;
  }

  listCampaigns(status?: string): EmailCampaign[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM email_campaigns WHERE status = ? ORDER BY created_at DESC")
        .all(status) as EmailCampaign[];
    }
    return this.db
      .prepare("SELECT * FROM email_campaigns ORDER BY created_at DESC")
      .all() as EmailCampaign[];
  }

  getCampaign(id: string): EmailCampaign | null {
    return (this.db
      .prepare("SELECT * FROM email_campaigns WHERE id = ?")
      .get(id) as EmailCampaign | undefined) ?? null;
  }

  getCampaignRecipients(campaignId: string): CampaignRecipient[] {
    return this.db
      .prepare("SELECT * FROM campaign_recipients WHERE campaign_id = ? ORDER BY created_at")
      .all(campaignId) as CampaignRecipient[];
  }

  addRecipients(
    campaignId: string,
    recipients: Array<{
      email: string;
      name?: string;
      contact_id?: string;
      variables?: Record<string, string>;
    }>,
  ): { added: number; skipped: number } {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
    if (campaign.status !== "draft") throw new Error("Can only add recipients to draft campaigns");

    const now = isoNow();
    let added = 0;
    let skipped = 0;

    const insert = this.db.prepare(
      `INSERT INTO campaign_recipients
       (id, campaign_id, contact_id, email, name, variables, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );

    const existing = this.db.prepare(
      "SELECT id FROM campaign_recipients WHERE campaign_id = ? AND email = ?",
    );

    for (const r of recipients) {
      // Skip duplicates
      if (existing.get(campaignId, r.email)) {
        skipped++;
        continue;
      }

      insert.run(
        newId(), campaignId, r.contact_id ?? null, r.email,
        r.name ?? "", JSON.stringify(r.variables ?? {}), now,
      );
      added++;
    }

    // Update total
    const total = (this.db
      .prepare("SELECT COUNT(*) AS c FROM campaign_recipients WHERE campaign_id = ?")
      .get(campaignId) as { c: number }).c;
    this.db
      .prepare("UPDATE email_campaigns SET total_recipients = ?, updated_at = ? WHERE id = ?")
      .run(total, isoNow(), campaignId);

    return { added, skipped };
  }

  addRecipientsFromContacts(
    campaignId: string,
    filters?: { relationship?: string; company?: string; has_email?: boolean },
  ): { added: number; skipped: number } {
    let sql = "SELECT id, name, email, company FROM contacts WHERE email <> ''";
    const params: unknown[] = [];

    if (filters?.relationship) {
      sql += " AND relationship = ?";
      params.push(filters.relationship);
    }
    if (filters?.company) {
      sql += " AND company = ?";
      params.push(filters.company);
    }

    const contacts = this.db.prepare(sql).all(...params) as Array<{
      id: string; name: string; email: string; company: string;
    }>;

    const recipients = contacts.map((c) => ({
      email: c.email,
      name: c.name,
      contact_id: c.id,
      variables: { company: c.company },
    }));

    return this.addRecipients(campaignId, recipients);
  }

  async sendCampaign(campaignId: string): Promise<{
    sent: number;
    failed: number;
    total: number;
  }> {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
    if (!["draft", "paused"].includes(campaign.status)) {
      throw new Error(`Cannot send campaign with status: ${campaign.status}`);
    }

    const provider = this.getProvider(campaign.account_id);
    if (!provider) throw new Error("No email provider configured for this campaign");
    if (!provider.capabilities.send) throw new Error(`Provider ${provider.name} does not support sending`);

    // Get template if linked
    let template: EmailTemplate | null = null;
    if (campaign.template_id) {
      template = this.getTemplate(campaign.template_id);
      if (!template) throw new Error(`Template not found: ${campaign.template_id}`);
    }

    const subject = campaign.subject_override || template?.subject || "";
    const body = template?.body || "";
    const bodyHtml = template?.body_html || "";

    if (!subject) throw new Error("No subject: set subject_override on campaign or use a template with subject");

    // Mark as sending
    this.db
      .prepare("UPDATE email_campaigns SET status = 'sending', started_at = ?, updated_at = ? WHERE id = ?")
      .run(isoNow(), isoNow(), campaignId);

    // Get pending recipients
    const recipients = this.db
      .prepare("SELECT * FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending'")
      .all(campaignId) as CampaignRecipient[];

    let sentCount = campaign.sent_count;
    let failedCount = campaign.failed_count;

    for (const recipient of recipients) {
      const customVars = JSON.parse(recipient.variables || "{}") as Record<string, string>;
      const context = {
        name: recipient.name,
        email: recipient.email,
        ...customVars,
      };

      const renderedSubject = renderTemplate(subject, context);
      const renderedBody = renderTemplate(body, context);
      const renderedHtml = bodyHtml ? renderTemplate(bodyHtml, context) : undefined;

      try {
        const result = await provider.send({
          to: recipient.email,
          subject: renderedSubject,
          body: renderedBody,
          bodyHtml: renderedHtml,
        });

        // Create communication record
        const comm = this.create({
          channel: "email",
          subject: renderedSubject,
          body: renderedBody,
          body_html: renderedHtml,
          recipients_to: recipient.email,
          contact_id: recipient.contact_id ?? undefined,
          account_id: campaign.account_id ?? undefined,
        });

        // Mark comm as sent
        this.db
          .prepare(
            "UPDATE communications SET status = 'sent', sent_at = ?, gmail_message_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(isoNow(), result.messageId, isoNow(), comm.id);

        // Update recipient
        this.db
          .prepare(
            "UPDATE campaign_recipients SET status = 'sent', comm_id = ?, sent_at = ? WHERE id = ?",
          )
          .run(comm.id, isoNow(), recipient.id);

        sentCount++;

        // Emit CRM event
        if (recipient.contact_id) {
          await this.events.emit("contact.interaction", {
            contactId: recipient.contact_id,
            type: "email",
            summary: `Campaign "${campaign.name}": ${renderedSubject}`,
          });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.db
          .prepare(
            "UPDATE campaign_recipients SET status = 'failed', error_message = ? WHERE id = ?",
          )
          .run(errorMsg, recipient.id);
        failedCount++;
        log.warn(`Campaign ${campaignId}: failed to send to ${recipient.email}: ${errorMsg}`);
      }
    }

    // Update campaign counts and status
    const now = isoNow();
    const allDone = sentCount + failedCount >= campaign.total_recipients;
    this.db
      .prepare(
        `UPDATE email_campaigns
         SET sent_count = ?, failed_count = ?, status = ?,
             completed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        sentCount, failedCount,
        allDone ? "sent" : "sending",
        allDone ? now : null,
        now, campaignId,
      );

    return { sent: sentCount, failed: failedCount, total: campaign.total_recipients };
  }
}
