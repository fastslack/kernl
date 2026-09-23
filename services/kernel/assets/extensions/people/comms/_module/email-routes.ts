import {
  type KernelHttpServer,
  type SqliteDb,
  type Notifier,
  type KernelConfig,
  HttpError,
  isHttpError,
  newId,
  isoNow,
  log,
} from "@kernl/extension-sdk";
import { timingSafeEqual } from "node:crypto";
import type { EmailService } from "./email-service.js";
import type { CommsService } from "./service.js";
import type { EmailAnalysisService } from "./email-analysis-service.js";
import type { EmailTriageService } from "./email-triage-service.js";
import type { EmailFolder } from "./types.js";
import { GoogleAuth } from "../../../integration/google-sync/_module/auth.js";

const VALID_FOLDERS = new Set<EmailFolder>([
  "inbox", "sent", "starred", "important", "drafts",
  "trash", "archived", "snoozed", "all",
]);

const errorMessage = (err: unknown) => err instanceof Error ? err.message : String(err);

export function registerEmailRoutes(
  server: KernelHttpServer,
  emailService: EmailService,
  commsService?: CommsService | null,
  emailAnalysis?: EmailAnalysisService | null,
  notifier?: Notifier | null,
  config?: KernelConfig,
  triageService?: EmailTriageService | null,
): void {
  /**
   * `server.route` with this file's failure contract: anything thrown but a
   * deliberate HttpError is logged as "<METHOD> <path> failed" and answered
   * 500 with `failure` — a fixed message, or a body built from the error —
   * instead of the raw error.
   */
  const route = <B = Record<string, never>>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    failure: string | ((err: unknown) => { error: string } & Record<string, unknown>),
    fn: (ctx: { query: URLSearchParams; body: B }) => unknown,
  ) =>
    server.route<B>(method, path, async (ctx) => {
      try {
        return await fn(ctx);
      } catch (err) {
        if (isHttpError(err)) throw err;
        log.error(`${method} ${path} failed`, err);
        const body = typeof failure === "string" ? { error: failure } : failure(err);
        throw new HttpError(500, body.error, body);
      }
    });

  /** The request's `gmail_id`, 400 when missing. */
  const requireGmailId = (body: { gmail_id?: string }): string => {
    if (!body.gmail_id) throw new HttpError(400, "Missing gmail_id");
    return body.gmail_id;
  };

  // ── List emails ────────────────────────────────
  route("GET", "/api/emails", "Failed to list emails", ({ query }) => {
    const folder = (query.get("folder") ?? "inbox") as EmailFolder;
    if (!VALID_FOLDERS.has(folder)) throw new HttpError(400, "Invalid folder");
    return emailService.listEmails({
      folder,
      query: query.get("q") ?? undefined,
      label: query.get("label") ?? undefined,
      from: query.get("from") ?? undefined,
      dateFrom: query.get("dateFrom") ?? undefined,
      dateTo: query.get("dateTo") ?? undefined,
      page: Number(query.get("page") ?? 1),
      pageSize: Number(query.get("pageSize") ?? 50),
      accountId: query.get("account_id") ?? undefined,
    });
  });

  // ── Email detail ───────────────────────────────
  route("GET", "/api/emails/detail", "Failed to get email", ({ query }) => {
    const gmailId = query.get("gmail_id");
    if (!gmailId) throw new HttpError(400, "Missing gmail_id");
    const email = emailService.getEmail(gmailId);
    if (!email) throw new HttpError(404, "Email not found");
    // Auto mark as read
    emailService.markRead(gmailId);
    return email;
  });

  // ── Thread ─────────────────────────────────────
  route("GET", "/api/emails/thread", "Failed to get thread", ({ query }) => {
    const threadId = query.get("thread_id");
    if (!threadId) throw new HttpError(400, "Missing thread_id");
    const thread = emailService.getThread(threadId);
    if (!thread) throw new HttpError(404, "Thread not found");
    return thread;
  });

  // ── Counts (sidebar badges) ────────────────────
  route("GET", "/api/emails/counts", "Failed to get counts", ({ query }) =>
    emailService.getCounts(query.get("account_id") ?? undefined));

  // ── Toggle star ────────────────────────────────
  route<{ gmail_id: string }>("POST", "/api/emails/star", "Failed to toggle star", ({ body }) =>
    ({ starred: emailService.toggleStar(requireGmailId(body)) }));

  // ── Toggle read ────────────────────────────────
  route<{ gmail_id: string }>("POST", "/api/emails/read", "Failed to toggle read", ({ body }) =>
    ({ is_read: emailService.toggleRead(requireGmailId(body)) }));

  // ── Archive ────────────────────────────────────
  route<{ gmail_id: string }>("POST", "/api/emails/archive", "Failed to archive", ({ body }) => {
    emailService.archive(requireGmailId(body));
    return { ok: true };
  });

  // ── Trash ──────────────────────────────────────
  route<{ gmail_id: string }>("POST", "/api/emails/trash", "Failed to trash", ({ body }) => {
    emailService.trash(requireGmailId(body));
    return { ok: true };
  });

  // ── Restore ────────────────────────────────────
  route<{ gmail_id: string }>("POST", "/api/emails/restore", "Failed to restore", ({ body }) => {
    emailService.restore(requireGmailId(body));
    return { ok: true };
  });

  // ── Important ──────────────────────────────────
  route<{ gmail_id: string }>("POST", "/api/emails/important", "Failed to toggle important", ({ body }) => {
    emailService.markImportant(requireGmailId(body));
    return { ok: true };
  });

  // ── Snooze ─────────────────────────────────────
  route<{ gmail_id: string; until: string }>("POST", "/api/emails/snooze", "Failed to snooze", ({ body }) => {
    if (!body.gmail_id || !body.until) throw new HttpError(400, "Missing gmail_id or until");
    emailService.snooze(body.gmail_id, body.until);
    return { ok: true };
  });

  // ── Add note ───────────────────────────────────
  route<{ gmail_id: string; note: string }>("POST", "/api/emails/note", "Failed to add note", ({ body }) => {
    if (!body.gmail_id || !body.note) throw new HttpError(400, "Missing gmail_id or note");
    return emailService.addNote(body.gmail_id, body.note);
  });

  // ── Block sender ───────────────────────────────
  route<{ email: string }>("POST", "/api/emails/block", "Failed to block sender", ({ body }) => {
    if (!body.email) throw new HttpError(400, "Missing email");
    emailService.blockSender(body.email);
    return { ok: true };
  });

  // ── Link to task ───────────────────────────────
  route<{ gmail_id: string; task_id: string }>("POST", "/api/emails/link-task", "Failed to link task", ({ body }) => {
    if (!body.gmail_id || !body.task_id) throw new HttpError(400, "Missing gmail_id or task_id");
    emailService.linkToTask(body.gmail_id, body.task_id);
    return { ok: true };
  });

  // ── Link to contact ────────────────────────────
  route<{ gmail_id: string; contact_id: string }>("POST", "/api/emails/link-contact", "Failed to link contact", ({ body }) => {
    if (!body.gmail_id || !body.contact_id) throw new HttpError(400, "Missing gmail_id or contact_id");
    emailService.linkToContact(body.gmail_id, body.contact_id);
    return { ok: true };
  });

  // ── Label management ───────────────────────────
  route<{ gmail_id: string; label_id: string; action: "add" | "remove" }>(
    "POST", "/api/emails/label", "Failed to manage label", ({ body }) => {
      if (!body.gmail_id || !body.label_id) throw new HttpError(400, "Missing gmail_id or label_id");
      if (body.action === "remove") {
        emailService.removeLabelFromEmail(body.gmail_id, body.label_id);
      } else {
        emailService.addLabelToEmail(body.gmail_id, body.label_id);
      }
      return { ok: true };
    },
  );

  route("GET", "/api/emails/labels", "Failed to list labels", () => emailService.listLabels());

  route<{ name: string; color?: string }>("POST", "/api/emails/labels", "Failed to create label", ({ body }) => {
    if (!body.name) throw new HttpError(400, "Missing name");
    return emailService.createLabel(body.name, body.color);
  });

  route<{ id: string }>("DELETE", "/api/emails/labels", "Failed to delete label", ({ body }) => {
    if (!body.id) throw new HttpError(400, "Missing id");
    emailService.deleteLabel(body.id);
    return { ok: true };
  });

  // ── AI Actions dispatcher ──────────────────────
  route<{ gmail_id: string; action: string; params?: Record<string, unknown> }>(
    "POST", "/api/emails/action", "Action failed", async ({ body }) => {
      if (!body.gmail_id || !body.action) throw new HttpError(400, "Missing gmail_id or action");

      const email = emailService.getEmail(body.gmail_id);
      if (!email) throw new HttpError(404, "Email not found");

      switch (body.action) {
        case "create_task": {
          const taskTitle = email.subject || "Task from email";
          const taskDesc = `From: ${email.from_name || email.from_email}\nDate: ${email.date}\n\n${email.snippet}`;
          const taskId = newId();
          const now = isoNow();
          const db = (emailService as unknown as { db: SqliteDb }).db;
          db.prepare(
            `INSERT INTO tasks (id, title, description, status, priority, context, created_at, updated_at) VALUES (?, ?, ?, 'todo', 'medium', '', ?, ?)`
          ).run(taskId, taskTitle, taskDesc, now, now);
          emailService.linkToTask(body.gmail_id, taskId);
          return { ok: true, task_id: taskId, title: taskTitle };
        }
        case "create_reminder": {
          const reminderTitle = `Follow up: ${email.subject}`;
          const triggerAt = body.params?.trigger_at as string ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
          const remId = newId();
          const now2 = isoNow();
          const db2 = (emailService as unknown as { db: SqliteDb }).db;
          db2.prepare(
            `INSERT INTO reminders (id, title, body, trigger_at, status, repeat, notify_mattermost, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 'none', 1, ?, ?)`
          ).run(remId, reminderTitle, `Email from ${email.from_name || email.from_email}`, triggerAt, now2, now2);
          return { ok: true, reminder_id: remId, title: reminderTitle };
        }
        case "forward_channel": {
          if (notifier) {
            const channel = (body.params?.channel as string) ?? "all";
            const text = `**${email.subject}**\nFrom: ${email.from_name || email.from_email}\n\n${email.snippet}`;
            await notifier.send({ title: email.subject, body: text, channel, priority: "normal" });
          }
          return { ok: true };
        }
        default:
          throw new HttpError(400, `Unknown action: ${body.action}`);
      }
    },
  );

  // ── Email Triage ─────────────────────────────────

  if (triageService) {
    // Attention queue — emails needing response with AI drafts
    route("GET", "/api/emails/attention", "Failed to get attention queue", ({ query }) => {
      const limit = Number(query.get("limit") ?? 50);
      const items = triageService.getAttentionQueue(limit);
      const stats = triageService.getTriageStats();
      return { items, stats };
    });

    // Triage stats
    route("GET", "/api/emails/triage-stats", "Failed to get triage stats", () => triageService.getTriageStats());

    // Approve a draft — send it
    route<{ comm_id: string }>(
      "POST", "/api/emails/approve-draft", (err) => ({ error: `Send failed: ${errorMessage(err)}` }), async ({ body }) => {
        if (!body.comm_id) throw new HttpError(400, "Missing comm_id");

        if (!commsService) throw new HttpError(500, "Comms service not available");

        // Send the draft
        const comm = await commsService.sendEmail(body.comm_id);
        return {
          ok: true,
          gmail_message_id: comm.gmail_message_id,
          sent_at: comm.sent_at,
        };
      },
    );

    // Dismiss a draft
    route<{ gmail_id: string }>("POST", "/api/emails/dismiss-draft", "Failed to dismiss", ({ body }) => {
      const gmailId = requireGmailId(body);

      const db = (emailService as unknown as { db: SqliteDb }).db;

      // Get draft comm_id from google_emails
      const row = db.prepare(
        "SELECT draft_comm_id FROM google_emails WHERE gmail_id = ?"
      ).get(gmailId) as { draft_comm_id: string } | undefined;

      if (row?.draft_comm_id) {
        // Delete the draft communication
        db.prepare("DELETE FROM communications WHERE id = ? AND status = 'draft'").run(row.draft_comm_id);
        // Clear the link
        db.prepare("UPDATE google_emails SET draft_comm_id = '', attention_needed = 0 WHERE gmail_id = ?").run(gmailId);
      } else {
        // Just mark as not needing attention
        db.prepare("UPDATE google_emails SET attention_needed = 0 WHERE gmail_id = ?").run(gmailId);
      }

      return { ok: true };
    });

    // Edit draft body before sending
    route<{ comm_id: string; body: string; body_html?: string }>(
      "POST", "/api/emails/edit-draft", "Failed to edit draft", ({ body }) => {
        if (!body.comm_id || body.body === undefined) throw new HttpError(400, "Missing comm_id or body");

        if (!commsService) throw new HttpError(500, "Comms service not available");

        const comm = commsService.update(body.comm_id, {
          body: body.body,
          body_html: body.body_html,
        });
        if (!comm) throw new HttpError(404, "Draft not found or not editable");

        return { ok: true, body: comm.body };
      },
    );
  }

  // ── Email Accounts CRUD ─────────────────────────

  if (commsService) {
    const svc = commsService;
    const withMessage = (err: unknown) => ({ error: errorMessage(err) });

    route("GET", "/api/email-accounts", "Failed to list accounts", () => svc.listAccounts());

    route<{
      label: string; email: string;
      type?: "personal" | "work" | "transactional" | "marketing";
      provider?: "gmail" | "resend" | "imap_smtp";
      company?: string; signature?: string;
      provider_config?: Record<string, unknown>;
      is_default?: boolean;
    }>("POST", "/api/email-accounts", withMessage, ({ body }) => {
      if (!body.label || !body.email) throw new HttpError(400, "Missing label or email");
      return svc.addAccount(body);
    });

    route<{
      id: string;
      label?: string; email?: string;
      type?: "personal" | "work" | "transactional" | "marketing";
      company?: string; signature?: string;
      provider_config?: Record<string, unknown> | string;
      is_default?: boolean;
    }>("POST", "/api/email-accounts/update", withMessage, ({ body }) => {
      if (!body.id) throw new HttpError(400, "Missing id");
      const changes: Record<string, unknown> = {};
      if (body.label !== undefined) changes.label = body.label;
      if (body.email !== undefined) changes.email = body.email;
      if (body.type !== undefined) changes.type = body.type;
      if (body.company !== undefined) changes.company = body.company;
      if (body.signature !== undefined) changes.signature = body.signature;
      if (body.provider_config !== undefined) {
        changes.provider_config = typeof body.provider_config === "string"
          ? body.provider_config
          : JSON.stringify(body.provider_config);
      }
      if (body.is_default !== undefined) changes.is_default = body.is_default ? 1 : 0;

      const account = svc.updateAccount(body.id, changes as Parameters<typeof svc.updateAccount>[1]);
      if (!account) throw new HttpError(404, "Account not found");
      return account;
    });

    route<{ id: string }>("POST", "/api/email-accounts/delete", "Failed to delete account", ({ body }) => {
      if (!body.id) throw new HttpError(400, "Missing id");
      if (!svc.deleteAccount(body.id)) throw new HttpError(404, "Account not found");
      return { ok: true };
    });

    route<{ id: string }>(
      "POST", "/api/email-accounts/test", (err) => ({ error: errorMessage(err), ok: false }), ({ body }) => {
        if (!body.id) throw new HttpError(400, "Missing id");
        return svc.testAccount(body.id);
      },
    );

    // Google profile lookup — for the "Add Gmail account" flow in the dashboard.
    // Returns auth state + the logged-in user's email/name so the form can
    // autofill, or an auth URL if OAuth hasn't been completed yet.
    server.route("GET", "/api/email-accounts/google-profile", async () => {
      if (!config) return { authenticated: false, configured: false };
      const { clientId, clientSecret, callbackPort } = config.google;
      const configured = !!(clientId && clientSecret);
      if (!configured) {
        return {
          authenticated: false,
          configured: false,
          message: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env",
        };
      }

      const db = (emailService as unknown as { db: SqliteDb }).db;
      const auth = new GoogleAuth(db, clientId, clientSecret, callbackPort);
      if (!auth.isAuthenticated()) {
        return {
          authenticated: false,
          configured: true,
          status: "disconnected",
          needsReauth: false,
          authUrl: auth.getAuthUrlForDashboard(config.dashboard.port),
        };
      }

      try {
        const token = await auth.getAccessToken();
        // Use Gmail's own profile endpoint — works with the gmail.readonly scope
        // we already request, so no re-auth is needed.
        const profileRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!profileRes.ok) throw new Error(`Gmail profile ${profileRes.status}`);
        const profile = await profileRes.json() as { emailAddress?: string };
        return {
          authenticated: true,
          configured: true,
          status: "connected",
          needsReauth: false,
          email: profile.emailAddress ?? "",
          name: "",
          picture: "",
        };
      } catch (err) {
        // getAccessToken() marks needs_reauth on a dead refresh token.
        const status = auth.getStatus();
        return {
          authenticated: false,
          configured: true,
          status,
          needsReauth: status === "needs_reauth",
          error: errorMessage(err),
          authUrl: auth.getAuthUrlForDashboard(config.dashboard.port),
        };
      }
    });
  }

  // ── Generic inbound webhook ────────────────────────────────────────
  //
  // POST /api/comms/inbound
  // Accepts any email from any external source (self-hosted mail server,
  // Mailgun/Sendgrid/Resend "receive" webhooks, custom IMAP relays, etc.).
  //
  // Body (application/json):
  //   {
  //     from:              "alice@example.com",           // required
  //     from_name?:        "Alice",
  //     to?:               "me@example.com",
  //     cc?:               "",
  //     subject?:          "Hello",
  //     body?:             "plain text",
  //     body_html?:        "<p>html</p>",
  //     message_id_header?: "<abc@mx>",                    // used for dedup
  //     received_at?:      "2026-04-19T10:00:00Z",
  //     source?:           "webhook:mailgun" | "resend" | "custom",
  //     account_id?:       null,                           // inbox this was addressed to
  //     raw_headers?:      { ... }
  //   }
  //
  // Authentication: fails closed. The endpoint answers 503 until
  // COMMS_INBOUND_TOKEN is set, and then every request must carry the same
  // value in the `X-Inbound-Token` header (compared in constant time). The
  // token is not accepted as a `?token=` query: URLs end up in access logs.
  //
  // Stays a raw handler: it checks the token before reading the body, so an
  // unauthenticated caller gets 401 without the server parsing its payload.
  if (commsService) {
    const svc = commsService;
    server.post("/api/comms/inbound", async (req, res) => {
      try {
        const expectedToken = process.env.COMMS_INBOUND_TOKEN ?? "";
        if (!expectedToken) {
          server.json(res, 503, {
            error: "Inbound email is disabled until COMMS_INBOUND_TOKEN is set",
          });
          return;
        }
        const header = req.headers?.["x-inbound-token"];
        const headerToken = String((Array.isArray(header) ? header[0] : header) ?? "");
        if (!inboundTokenMatches(headerToken, expectedToken)) {
          server.json(res, 401, { error: "Unauthorized" });
          return;
        }

        const body = await server.parseBody<{
          from?: string;
          from_name?: string;
          to?: string;
          cc?: string;
          subject?: string;
          body?: string;
          body_html?: string;
          message_id_header?: string;
          received_at?: string;
          source?: string;
          account_id?: string | null;
          raw_headers?: Record<string, string>;
        }>(req);

        if (!body?.from) {
          server.json(res, 400, { error: "Missing 'from' field" });
          return;
        }

        const result = svc.ingestInboundRaw({
          from: body.from,
          from_name: body.from_name,
          to: body.to,
          cc: body.cc,
          subject: body.subject,
          body: body.body,
          body_html: body.body_html,
          message_id_header: body.message_id_header,
          received_at: body.received_at,
          source: body.source ?? "webhook",
          account_id: body.account_id ?? null,
          raw_headers: body.raw_headers,
        });

        server.json(res, 200, {
          ok: true,
          comm_id: result.comm.id,
          is_new: result.isNew,
        });
      } catch (err) {
        log.error("POST /api/comms/inbound failed", err);
        server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  }
}

/** Constant-time comparison of the inbound token (timingSafeEqual needs equal lengths). */
export function inboundTokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
