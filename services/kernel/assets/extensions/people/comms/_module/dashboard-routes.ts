/**
 * HTTP routes for the dashboard's communications surface (compose, threads,
 * search, attachments). Owned by the comms module — registered via
 * getDashboardDescriptor.registerRoutes.
 *
 * The "dashboard-" prefix on the file name disambiguates from the existing
 * `email-routes.ts` that handles inbound IMAP / send via Gmail.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { CommsService } from "./service.js";

export function registerCommsDashboardRoutes(
  server: KernelHttpServer,
  db: SqliteDb,
  commsService: CommsService,
  events: EventBus,
): void {
  // ── Comms detail ────────────────────────────────────────────
  server.get("/api/dashboard/comms/detail", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const id = url.searchParams.get("id") ?? "";
    if (!id.trim()) { server.json(res, 400, { error: "Missing query parameter 'id'" }); return; }
    const detail = commsService.getWithDetails(id.trim());
    if (!detail) { server.json(res, 404, { error: "Communication not found" }); return; }
    server.json(res, 200, detail);
  });

  // ── Update ───────────────────────────────────────────────────
  server.put("/api/dashboard/comms/update", async (req, res) => {
    try {
      const body = await server.parseBody<Record<string, unknown>>(req);
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) { server.json(res, 400, { error: "Missing 'id' in body" }); return; }
      const changes: Record<string, unknown> = {};
      for (const key of [
        "subject", "body", "body_html", "status",
        "recipients_to", "recipients_cc", "recipients_bcc",
        "contact_id", "task_id",
      ]) {
        if (key in body && body[key] !== undefined) changes[key] = body[key];
      }
      const updated = commsService.update(id, changes);
      if (!updated) { server.json(res, 400, { error: "Cannot update (not found or not editable)" }); return; }
      events.emit("data.changed", { module: "comms", action: "update" });
      server.json(res, 200, updated);
    } catch (err) {
      server.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Campaign detail ─────────────────────────────────────────
  server.get("/api/dashboard/comms/campaign", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const id = url.searchParams.get("id") ?? "";
    if (!id.trim()) { server.json(res, 400, { error: "Missing query parameter 'id'" }); return; }
    const campaign = commsService.getCampaign(id.trim());
    if (!campaign) { server.json(res, 404, { error: "Campaign not found" }); return; }
    const recipients = commsService.getCampaignRecipients(id.trim());
    server.json(res, 200, { ...campaign, recipients });
  });

  // ── Accounts ────────────────────────────────────────────────
  server.get("/api/dashboard/comms/accounts", (_req, res) => {
    server.json(res, 200, commsService.listAccounts());
  });

  // ── Templates ───────────────────────────────────────────────
  server.get("/api/dashboard/comms/templates", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const category = url.searchParams.get("category") ?? undefined;
    server.json(res, 200, commsService.listTemplates(category));
  });

  // ── Create ──────────────────────────────────────────────────
  server.post("/api/dashboard/comms/create", async (req, res) => {
    try {
      const body = await server.parseBody<Record<string, unknown>>(req);
      const input: Record<string, unknown> = {};
      for (const key of [
        "channel", "subject", "body", "body_html",
        "recipients_to", "recipients_cc", "recipients_bcc",
        "contact_id", "account_id",
      ]) {
        if (key in body && typeof body[key] === "string") input[key] = body[key];
      }
      const comm = commsService.create(input as Parameters<typeof commsService.create>[0]);
      events.emit("data.changed", { module: "comms", action: "create" });
      server.json(res, 200, comm);
    } catch (err) {
      server.json(res, 400, { error: err instanceof Error ? err.message : "Bad request" });
    }
  });

  // ── Send ────────────────────────────────────────────────────
  server.post("/api/dashboard/comms/send", async (req, res) => {
    try {
      const body = await server.parseBody<{ id?: string }>(req);
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) { server.json(res, 400, { error: "Missing 'id' in body" }); return; }
      const result = await commsService.sendEmail(id);
      server.json(res, 200, result);
    } catch (err) {
      server.json(res, 400, { error: err instanceof Error ? err.message : "Send failed" });
    }
  });

  // ── Thread (with contact-name enrichment in a single JOIN) ──
  server.get("/api/dashboard/comms/thread", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const threadId = url.searchParams.get("thread_id") ?? "";
    if (!threadId.trim()) { server.json(res, 400, { error: "Missing query parameter 'thread_id'" }); return; }
    const messages = commsService.getThread(threadId.trim());
    const contactIds = [...new Set(messages.map((m) => m.contact_id).filter(Boolean))];
    const contactNameMap = new Map<string, string>();
    if (contactIds.length > 0) {
      try {
        const placeholders = contactIds.map(() => "?").join(",");
        const rows = db.prepare(
          `SELECT id, name FROM contacts WHERE id IN (${placeholders})`,
        ).all(...contactIds) as { id: string; name: string }[];
        for (const row of rows) contactNameMap.set(row.id, row.name);
      } catch { /* contacts table may not exist */ }
    }
    server.json(res, 200, messages.map((m) => ({
      ...m,
      contact_name: (m.contact_id && contactNameMap.get(m.contact_id)) || "",
    })));
  });

  // ── Search ──────────────────────────────────────────────────
  server.get("/api/dashboard/comms/search", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = url.searchParams.get("q") ?? "";
    const channel = url.searchParams.get("channel") ?? "";
    const status = url.searchParams.get("status") ?? "";
    const direction = url.searchParams.get("direction") ?? "";
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 50);

    const conditions: string[] = [];
    const params: string[] = [];
    if (q.trim()) {
      const like = `%${q.trim()}%`;
      conditions.push("(c.subject LIKE ? OR c.body LIKE ? OR c.recipients_to LIKE ?)");
      params.push(like, like, like);
    }
    if (channel)   { conditions.push("c.channel = ?");   params.push(channel); }
    if (status)    { conditions.push("c.status = ?");    params.push(status); }
    if (direction) { conditions.push("c.direction = ?"); params.push(direction); }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const results = db.prepare(
      `SELECT c.id, c.channel, c.subject, c.direction, c.status, c.recipients_to,
              COALESCE(ct.name, '') as contact_name,
              COALESCE(c.sent_at, c.updated_at) as updated_at
       FROM communications c
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       ${where}
       ORDER BY c.updated_at DESC LIMIT ?`,
    ).all(...params, limit);
    server.json(res, 200, results);
  });

  // ── Contact autocomplete (compose UI) ───────────────────────
  server.get("/api/dashboard/comms/contacts", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = url.searchParams.get("q") ?? "";
    if (!q.trim()) { server.json(res, 200, []); return; }
    try {
      const like = `%${q.trim()}%`;
      const results = db.prepare(
        `SELECT id, name, email FROM contacts
         WHERE (name LIKE ? OR email LIKE ?) AND email <> ''
         LIMIT 10`,
      ).all(like, like);
      server.json(res, 200, results);
    } catch {
      server.json(res, 200, []);
    }
  });

  // ── Serve attachment file (sandboxed read) ──────────────────
  server.get("/api/attachments", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const id = url.searchParams.get("id") ?? "";
    if (!id.trim()) { server.json(res, 400, { error: "Missing query parameter 'id'" }); return; }
    const att = commsService.getAttachment(id.trim());
    if (!att || !att.stored_path || !existsSync(att.stored_path)) {
      server.json(res, 404, { error: "Attachment not found" });
      return;
    }
    try {
      const buf = readFileSync(att.stored_path);
      res.writeHead(200, {
        "Content-Type": att.mime_type,
        "Content-Length": buf.length,
        "Content-Disposition": `inline; filename="${basename(att.filename)}"`,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "private, max-age=3600",
      });
      res.end(buf);
    } catch {
      server.json(res, 500, { error: "Failed to read attachment" });
    }
  });
}
