import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EmailService } from "./email-service.js";
import type { CommsService } from "./service.js";
import type { EmailAnalysisService } from "./email-analysis-service.js";
import type { EmailTriageService } from "./email-triage-service.js";
import type { Notifier } from "../../../../../src/core/notify/notifier.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import type { EmailFolder } from "./types.js";
import { GoogleAuth } from "../../../integration/google-sync/_module/auth.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";

const VALID_FOLDERS = new Set<EmailFolder>([
  "inbox", "sent", "starred", "important", "drafts",
  "trash", "archived", "snoozed", "all",
]);

export function registerEmailRoutes(
  server: KernelHttpServer,
  emailService: EmailService,
  commsService?: CommsService | null,
  emailAnalysis?: EmailAnalysisService | null,
  notifier?: Notifier | null,
  config?: KernelConfig,
  triageService?: EmailTriageService | null,
): void {

  // ── List emails ────────────────────────────────
  server.get("/api/emails", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const folder = (url.searchParams.get("folder") ?? "inbox") as EmailFolder;
      if (!VALID_FOLDERS.has(folder)) {
        server.json(res, 400, { error: "Invalid folder" });
        return;
      }
      const result = emailService.listEmails({
        folder,
        query: url.searchParams.get("q") ?? undefined,
        label: url.searchParams.get("label") ?? undefined,
        from: url.searchParams.get("from") ?? undefined,
        dateFrom: url.searchParams.get("dateFrom") ?? undefined,
        dateTo: url.searchParams.get("dateTo") ?? undefined,
        page: Number(url.searchParams.get("page") ?? 1),
        pageSize: Number(url.searchParams.get("pageSize") ?? 50),
        accountId: url.searchParams.get("account_id") ?? undefined,
      });
      server.json(res, 200, result);
    } catch (err) {
      log.error("GET /api/emails failed", err);
      server.json(res, 500, { error: "Failed to list emails" });
    }
  });

  // ── Email detail ───────────────────────────────
  server.get("/api/emails/detail", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const gmailId = url.searchParams.get("gmail_id");
      if (!gmailId) { server.json(res, 400, { error: "Missing gmail_id" }); return; }
      const email = emailService.getEmail(gmailId);
      if (!email) { server.json(res, 404, { error: "Email not found" }); return; }
      // Auto mark as read
      emailService.markRead(gmailId);
      server.json(res, 200, email);
    } catch (err) {
      log.error("GET /api/emails/detail failed", err);
      server.json(res, 500, { error: "Failed to get email" });
    }
  });

  // ── Thread ─────────────────────────────────────
  server.get("/api/emails/thread", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const threadId = url.searchParams.get("thread_id");
      if (!threadId) { server.json(res, 400, { error: "Missing thread_id" }); return; }
      const thread = emailService.getThread(threadId);
      if (!thread) { server.json(res, 404, { error: "Thread not found" }); return; }
      server.json(res, 200, thread);
    } catch (err) {
      log.error("GET /api/emails/thread failed", err);
      server.json(res, 500, { error: "Failed to get thread" });
    }
  });

  // ── Counts (sidebar badges) ────────────────────
  server.get("/api/emails/counts", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const accountId = url.searchParams.get("account_id") ?? undefined;
      server.json(res, 200, emailService.getCounts(accountId));
    } catch (err) {
      log.error("GET /api/emails/counts failed", err);
      server.json(res, 500, { error: "Failed to get counts" });
    }
  });

  // ── Toggle star ────────────────────────────────
  server.post("/api/emails/star", async (req, res) => {
    try {
      const body = await server.parseBody<{ gmail_id: string }>(req);
      if (!body.gmail_id) { server.json(res, 400, { error: "Missing gmail_id" }); return; }
      const starred = emailService.toggleStar(body.gmail_id);
      server.json(res, 200, { starred });
    } catch (err) {
      log.error("POST /api/emails/star failed", err);
      server.json(res, 500, { error: "Failed to toggle star" });
    }
  });

  // ── Toggle read ────────────────────────────────
  server.post("/api/emails/read", async (req, res) => {
    try {
      const body = await server.parseBody<{ gmail_id: string }>(req);
      if (!body.gmail_id) { server.json(res, 400, { error: "Missing gmail_id" }); return; }
      const isRead = emailService.toggleRead(body.gmail_id);
      server.json(res, 200, { is_read: isRead });
    } catch (err) {
      log.error("POST /api/emails/read failed", err);
      server.json(res, 500, { error: "Failed to toggle read" });
    }
  });

  // ── Archive ────────────────────────────────────
  server.post("/api/emails/archive", async (req, res) => {
    try {
      const body = await server.parseBody<{ gmail_id: string }>(req);
      if (!body.gmail_id) { server.json(res, 400, { error: "Missing gmail_id" }); return; }
      emailService.archive(body.gmail_id);
      server.json(res, 200, { ok: true });
    } catch (err) {
      log.error("POST /api/emails/archive failed", err);
      server.json(res, 500, { error: "Failed to archive" });
    }
  });

  // ── Trash ──────────────────────────────────────
  server.post("/api/emails/trash", async (req, res) => {
    try {
      const body = await server.parseBody<{ gmail_id: string }>(req);
      if (!body.gmail_id) { server.json(res, 400, { error: "Missing gmail_id" }); return; }
      emailService.trash(body.gmail_id);
      server.json(res, 200, { ok: true });
    } catch (err) {
      log.error("POST /api/emails/trash failed", err);
      server.json(res, 500, { error: "Failed to trash" });
    }
  });

  // ── Restore ────────────────────────────────────
  server.post("/api/emails/restore", async (req, res) => {
    try {
      const body = await server.parseBody<{ gmail_id: string }>(req);
      if (!body.gmail_id) { server.json(res, 400, { error: "Missing gmail_id" }); return; }
      emailService.restore(body.gmail_id);
      server.json(res, 200, { ok: true });
    } catch (err) {
      log.error("POST /api/emails/restore failed", err);
      server.json(res, 500, { error: "Failed to restore" });
    }
  });

  // ── Important ──────────────────────────────────
  server.post("/api/emails/important", async (req, res) => {
    try {
      const body = await server.parseBody<{ gmail_id: string }>(req);
      if (!body.gmail_id) { server.json(res, 400, { error: "Missing gmail_id" }); return; }
      emailService.markImportant(body.gmail_id);
      server.json(res, 200, { ok: true });
    } catch (err) {
      log.error("POST /api/emails/important failed", err);
      server.json(res, 500, { error: "Failed to toggle important" });
    }
  });

  // ── Snooze ─────────────────────────────────────
  server.post("/api/emails/snooze", async (req, res) => {
    try {
      const body = await server.parseBody<{ gmail_id: string; until: string }>(req);
      if (!body.gmail_id || !body.until) { server.json(res, 400, { error: "Missing gmail_id or until" }); return; }
      emailService.snooze(body.gmail_id, body.until);
      server.json(res, 200, { ok: true });
    } catch (err) {
      log.error("POST /api/emails/snooze failed", err);
      server.json(res, 500, { error: "Failed to snooze" });
    }
  });

  // ── Add note ───────────────────────────────────
  server.post("/api/emails/note", async (req, res) => {
    try {
      const body = await server.parseBody<{ gmail_id: string; note: string }>(req);
      if (!body.gmail_id || !body.note) { server.json(res, 400, { error: "Missing gmail_id or note" }); return; }
      const action = emailService.addNote(body.gmail_id, body.note);
      server.json(res, 200, action);
    } catch (err) {
      log.error("POST /api/emails/note failed", err);
      server.json(res, 500, { error: "Failed to add note" });
    }
  });

  // ── Block sender ───────────────────────────────
  server.post("/api/emails/block", async (req, res) => {
    try {
      const body = await server.parseBody<{ email: string }>(req);
      if (!body.email) { server.json(res, 400, { error: "Missing email" }); return; }
      emailService.blockSender(body.email);
      server.json(res, 200, { ok: true });
    } catch (err) {
      log.error("POST /api/emails/block failed", err);
      server.json(res, 500, { error: "Failed to block sender" });
    }
  });

  // ── Link to task ───────────────────────────────
  server.post("/api/emails/link-task", async (req, res) => {
    try {
      const body = await server.parseBody<{ gmail_id: string; task_id: string }>(req);
      if (!body.gmail_id || !body.task_id) { server.json(res, 400, { error: "Missing gmail_id or task_id" }); return; }
      emailService.linkToTask(body.gmail_id, body.task_id);
      server.json(res, 200, { ok: true });
    } catch (err) {
      log.error("POST /api/emails/link-task failed", err);
      server.json(res, 500, { error: "Failed to link task" });
    }
  });

  // ── Link to contact ────────────────────────────
  server.post("/api/emails/link-contact", async (req, res) => {
    try {
      const body = await server.parseBody<{ gmail_id: string; contact_id: string }>(req);
      if (!body.gmail_id || !body.contact_id) { server.json(res, 400, { error: "Missing gmail_id or contact_id" }); return; }
      emailService.linkToContact(body.gmail_id, body.contact_id);
      server.json(res, 200, { ok: true });
    } catch (err) {
      log.error("POST /api/emails/link-contact failed", err);
      server.json(res, 500, { error: "Failed to link contact" });
    }
  });

  // ── Label management ───────────────────────────
  server.post("/api/emails/label", async (req, res) => {
    try {
      const body = await server.parseBody<{ gmail_id: string; label_id: string; action: "add" | "remove" }>(req);
      if (!body.gmail_id || !body.label_id) { server.json(res, 400, { error: "Missing gmail_id or label_id" }); return; }
      if (body.action === "remove") {
        emailService.removeLabelFromEmail(body.gmail_id, body.label_id);
      } else {
        emailService.addLabelToEmail(body.gmail_id, body.label_id);
      }
      server.json(res, 200, { ok: true });
    } catch (err) {
      log.error("POST /api/emails/label failed", err);
      server.json(res, 500, { error: "Failed to manage label" });
    }
  });

  server.get("/api/emails/labels", (_req, res) => {
    try {
      server.json(res, 200, emailService.listLabels());
    } catch (err) {
      log.error("GET /api/emails/labels failed", err);
      server.json(res, 500, { error: "Failed to list labels" });
    }
  });

  server.post("/api/emails/labels", async (req, res) => {
    try {
      const body = await server.parseBody<{ name: string; color?: string }>(req);
      if (!body.name) { server.json(res, 400, { error: "Missing name" }); return; }
      const label = emailService.createLabel(body.name, body.color);
      server.json(res, 200, label);
    } catch (err) {
      log.error("POST /api/emails/labels failed", err);
      server.json(res, 500, { error: "Failed to create label" });
    }
  });

  server.delete("/api/emails/labels", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string }>(req);
      if (!body.id) { server.json(res, 400, { error: "Missing id" }); return; }
      emailService.deleteLabel(body.id);
      server.json(res, 200, { ok: true });
    } catch (err) {
      log.error("DELETE /api/emails/labels failed", err);
      server.json(res, 500, { error: "Failed to delete label" });
    }
  });

  // ── AI Actions dispatcher ──────────────────────
  server.post("/api/emails/action", async (req, res) => {
    try {
      const body = await server.parseBody<{ gmail_id: string; action: string; params?: Record<string, unknown> }>(req);
      if (!body.gmail_id || !body.action) { server.json(res, 400, { error: "Missing gmail_id or action" }); return; }

      const email = emailService.getEmail(body.gmail_id);
      if (!email) { server.json(res, 404, { error: "Email not found" }); return; }

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
          server.json(res, 200, { ok: true, task_id: taskId, title: taskTitle });
          break;
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
          server.json(res, 200, { ok: true, reminder_id: remId, title: reminderTitle });
          break;
        }
        case "forward_channel": {
          if (notifier) {
            const channel = (body.params?.channel as string) ?? "all";
            const text = `**${email.subject}**\nFrom: ${email.from_name || email.from_email}\n\n${email.snippet}`;
            await notifier.send({ title: email.subject, body: text, channel, priority: "normal" });
          }
          server.json(res, 200, { ok: true });
          break;
        }
        default:
          server.json(res, 400, { error: `Unknown action: ${body.action}` });
      }
    } catch (err) {
      log.error("POST /api/emails/action failed", err);
      server.json(res, 500, { error: "Action failed" });
    }
  });

  // ── Email Triage ─────────────────────────────────

  if (triageService) {
    // Attention queue — emails needing response with AI drafts
    server.get("/api/emails/attention", (_req, res) => {
      try {
        const url = new URL((_req as any).url ?? "/", "http://localhost");
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const items = triageService.getAttentionQueue(limit);
        const stats = triageService.getTriageStats();
        server.json(res, 200, { items, stats });
      } catch (err) {
        log.error("GET /api/emails/attention failed", err);
        server.json(res, 500, { error: "Failed to get attention queue" });
      }
    });

    // Triage stats
    server.get("/api/emails/triage-stats", (_req, res) => {
      try {
        server.json(res, 200, triageService.getTriageStats());
      } catch (err) {
        log.error("GET /api/emails/triage-stats failed", err);
        server.json(res, 500, { error: "Failed to get triage stats" });
      }
    });

    // Approve a draft — send it
    server.post("/api/emails/approve-draft", async (req, res) => {
      try {
        const body = await server.parseBody<{ comm_id: string }>(req);
        if (!body.comm_id) { server.json(res, 400, { error: "Missing comm_id" }); return; }

        if (!commsService) { server.json(res, 500, { error: "Comms service not available" }); return; }

        // Send the draft
        const comm = await commsService.sendEmail(body.comm_id);
        server.json(res, 200, {
          ok: true,
          gmail_message_id: comm.gmail_message_id,
          sent_at: comm.sent_at,
        });
      } catch (err) {
        log.error("POST /api/emails/approve-draft failed", err);
        server.json(res, 500, { error: `Send failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    });

    // Dismiss a draft
    server.post("/api/emails/dismiss-draft", async (req, res) => {
      try {
        const body = await server.parseBody<{ gmail_id: string }>(req);
        if (!body.gmail_id) { server.json(res, 400, { error: "Missing gmail_id" }); return; }

        const db = (emailService as unknown as { db: SqliteDb }).db;

        // Get draft comm_id from google_emails
        const row = db.prepare(
          "SELECT draft_comm_id FROM google_emails WHERE gmail_id = ?"
        ).get(body.gmail_id) as { draft_comm_id: string } | undefined;

        if (row?.draft_comm_id) {
          // Delete the draft communication
          db.prepare("DELETE FROM communications WHERE id = ? AND status = 'draft'").run(row.draft_comm_id);
          // Clear the link
          db.prepare("UPDATE google_emails SET draft_comm_id = '', attention_needed = 0 WHERE gmail_id = ?").run(body.gmail_id);
        } else {
          // Just mark as not needing attention
          db.prepare("UPDATE google_emails SET attention_needed = 0 WHERE gmail_id = ?").run(body.gmail_id);
        }

        server.json(res, 200, { ok: true });
      } catch (err) {
        log.error("POST /api/emails/dismiss-draft failed", err);
        server.json(res, 500, { error: "Failed to dismiss" });
      }
    });

    // Edit draft body before sending
    server.post("/api/emails/edit-draft", async (req, res) => {
      try {
        const body = await server.parseBody<{ comm_id: string; body: string; body_html?: string }>(req);
        if (!body.comm_id || body.body === undefined) { server.json(res, 400, { error: "Missing comm_id or body" }); return; }

        if (!commsService) { server.json(res, 500, { error: "Comms service not available" }); return; }

        const comm = commsService.update(body.comm_id, {
          body: body.body,
          body_html: body.body_html,
        });
        if (!comm) { server.json(res, 404, { error: "Draft not found or not editable" }); return; }

        server.json(res, 200, { ok: true, body: comm.body });
      } catch (err) {
        log.error("POST /api/emails/edit-draft failed", err);
        server.json(res, 500, { error: "Failed to edit draft" });
      }
    });
  }

  // ── Email Accounts CRUD ─────────────────────────

  if (commsService) {
    const svc = commsService;

    server.get("/api/email-accounts", (_req, res) => {
      try {
        server.json(res, 200, svc.listAccounts());
      } catch (err) {
        log.error("GET /api/email-accounts failed", err);
        server.json(res, 500, { error: "Failed to list accounts" });
      }
    });

    server.post("/api/email-accounts", async (req, res) => {
      try {
        const body = await server.parseBody<{
          label: string; email: string;
          type?: "personal" | "work" | "transactional" | "marketing";
          provider?: "gmail" | "resend" | "imap_smtp";
          company?: string; signature?: string;
          provider_config?: Record<string, unknown>;
          is_default?: boolean;
        }>(req);
        if (!body.label || !body.email) { server.json(res, 400, { error: "Missing label or email" }); return; }
        const account = svc.addAccount(body);
        server.json(res, 200, account);
      } catch (err) {
        log.error("POST /api/email-accounts failed", err);
        server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    server.post("/api/email-accounts/update", async (req, res) => {
      try {
        const body = await server.parseBody<{
          id: string;
          label?: string; email?: string;
          type?: "personal" | "work" | "transactional" | "marketing";
          company?: string; signature?: string;
          provider_config?: Record<string, unknown> | string;
          is_default?: boolean;
        }>(req);
        if (!body.id) { server.json(res, 400, { error: "Missing id" }); return; }
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
        if (!account) { server.json(res, 404, { error: "Account not found" }); return; }
        server.json(res, 200, account);
      } catch (err) {
        log.error("POST /api/email-accounts/update failed", err);
        server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    server.post("/api/email-accounts/delete", async (req, res) => {
      try {
        const body = await server.parseBody<{ id: string }>(req);
        if (!body.id) { server.json(res, 400, { error: "Missing id" }); return; }
        const ok = svc.deleteAccount(body.id);
        if (!ok) { server.json(res, 404, { error: "Account not found" }); return; }
        server.json(res, 200, { ok: true });
      } catch (err) {
        log.error("POST /api/email-accounts/delete failed", err);
        server.json(res, 500, { error: "Failed to delete account" });
      }
    });

    server.post("/api/email-accounts/test", async (req, res) => {
      try {
        const body = await server.parseBody<{ id: string }>(req);
        if (!body.id) { server.json(res, 400, { error: "Missing id" }); return; }
        const result = await svc.testAccount(body.id);
        server.json(res, 200, result);
      } catch (err) {
        log.error("POST /api/email-accounts/test failed", err);
        server.json(res, 500, { error: err instanceof Error ? err.message : String(err), ok: false });
      }
    });

    // Google profile lookup — for the "Add Gmail account" flow in the dashboard.
    // Returns auth state + the logged-in user's email/name so the form can
    // autofill, or an auth URL if OAuth hasn't been completed yet.
    server.get("/api/email-accounts/google-profile", async (_req, res) => {
      if (!config) { server.json(res, 200, { authenticated: false, configured: false }); return; }
      const { clientId, clientSecret, callbackPort } = config.google;
      const configured = !!(clientId && clientSecret);
      if (!configured) {
        server.json(res, 200, {
          authenticated: false,
          configured: false,
          message: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env",
        });
        return;
      }

      const db = (emailService as unknown as { db: SqliteDb }).db;
      const auth = new GoogleAuth(db, clientId, clientSecret, callbackPort);
      if (!auth.isAuthenticated()) {
        server.json(res, 200, {
          authenticated: false,
          configured: true,
          status: "disconnected",
          needsReauth: false,
          authUrl: auth.getAuthUrlForDashboard(config.dashboard.port),
        });
        return;
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
        server.json(res, 200, {
          authenticated: true,
          configured: true,
          status: "connected",
          needsReauth: false,
          email: profile.emailAddress ?? "",
          name: "",
          picture: "",
        });
      } catch (err) {
        // getAccessToken() marks needs_reauth on a dead refresh token.
        const status = auth.getStatus();
        server.json(res, 200, {
          authenticated: false,
          configured: true,
          status,
          needsReauth: status === "needs_reauth",
          error: err instanceof Error ? err.message : String(err),
          authUrl: auth.getAuthUrlForDashboard(config.dashboard.port),
        });
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
  // Authentication: a shared secret can be required via COMMS_INBOUND_TOKEN.
  // When the env var is set, the request must carry the same value in
  // `X-Inbound-Token` (or a `?token=` query). When it's unset the endpoint is
  // open — fine for local dev, not for internet-exposed deployments.
  if (commsService) {
    const svc = commsService;
    server.post("/api/comms/inbound", async (req, res) => {
      try {
        const expectedToken = process.env.COMMS_INBOUND_TOKEN ?? "";
        if (expectedToken) {
          const headerToken = String(
            (req.headers?.["x-inbound-token"] ?? req.headers?.["X-Inbound-Token"] ?? "") as string,
          );
          const url = new URL(req.url ?? "/", "http://localhost");
          const queryToken = url.searchParams.get("token") ?? "";
          if (headerToken !== expectedToken && queryToken !== expectedToken) {
            server.json(res, 401, { error: "Unauthorized" });
            return;
          }
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
