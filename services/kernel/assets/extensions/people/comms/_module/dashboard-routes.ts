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
import { HttpError, isHttpError, type KernelHttpServer, type SqliteDb, type EventBus } from "@kernl/extension-sdk";
import type { CommsService } from "./service.js";

/** Attachment types safe to render from the kernel's origin: none can run script. */
const INLINE_ATTACHMENT_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "application/pdf", "text/plain",
]);

export function registerCommsDashboardRoutes(
  server: KernelHttpServer,
  db: SqliteDb,
  commsService: CommsService,
  events: EventBus,
): void {
  /** A required, trimmed query parameter — 400 when missing or blank. */
  const requireQuery = (query: URLSearchParams, name: string): string => {
    const value = (query.get(name) ?? "").trim();
    if (!value) throw new HttpError(400, `Missing query parameter '${name}'`);
    return value;
  };

  /**
   * Runs `fn`, answering any failure but a deliberate HttpError 400 with the
   * error's message (`fallback` when what was thrown isn't an Error).
   */
  const asBadRequest = async <T>(fallback: (err: unknown) => string, fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (isHttpError(err)) throw err;
      throw new HttpError(400, err instanceof Error ? err.message : fallback(err));
    }
  };

  // ── Comms detail ────────────────────────────────────────────
  server.route("GET", "/api/dashboard/comms/detail", ({ query }) => {
    const detail = commsService.getWithDetails(requireQuery(query, "id"));
    if (!detail) throw new HttpError(404, "Communication not found");
    return detail;
  });

  // ── Update ───────────────────────────────────────────────────
  server.route<Record<string, unknown>>("PUT", "/api/dashboard/comms/update", ({ body }) => asBadRequest(String, () => {
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) throw new HttpError(400, "Missing 'id' in body");
    const changes: Record<string, unknown> = {};
    for (const key of [
      "subject", "body", "body_html", "status",
      "recipients_to", "recipients_cc", "recipients_bcc",
      "contact_id", "task_id",
    ]) {
      if (key in body && body[key] !== undefined) changes[key] = body[key];
    }
    const updated = commsService.update(id, changes);
    if (!updated) throw new HttpError(400, "Cannot update (not found or not editable)");
    events.emit("data.changed", { module: "comms", action: "update" });
    return updated;
  }));

  // ── Campaign detail ─────────────────────────────────────────
  server.route("GET", "/api/dashboard/comms/campaign", ({ query }) => {
    const id = requireQuery(query, "id");
    const campaign = commsService.getCampaign(id);
    if (!campaign) throw new HttpError(404, "Campaign not found");
    const recipients = commsService.getCampaignRecipients(id);
    return { ...campaign, recipients };
  });

  // ── Accounts ────────────────────────────────────────────────
  server.route("GET", "/api/dashboard/comms/accounts", () => commsService.listAccounts());

  // ── Templates ───────────────────────────────────────────────
  server.route("GET", "/api/dashboard/comms/templates", ({ query }) =>
    commsService.listTemplates(query.get("category") ?? undefined));

  // ── Create ──────────────────────────────────────────────────
  server.route<Record<string, unknown>>("POST", "/api/dashboard/comms/create", ({ body }) => asBadRequest(() => "Bad request", () => {
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
    return comm;
  }));

  // ── Send ────────────────────────────────────────────────────
  server.route<{ id?: string }>("POST", "/api/dashboard/comms/send", ({ body }) => asBadRequest(() => "Send failed", () => {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) throw new HttpError(400, "Missing 'id' in body");
    return commsService.sendEmail(id);
  }));

  // ── Thread (with contact-name enrichment in a single JOIN) ──
  server.route("GET", "/api/dashboard/comms/thread", ({ query }) => {
    const messages = commsService.getThread(requireQuery(query, "thread_id"));
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
    return messages.map((m) => ({
      ...m,
      contact_name: (m.contact_id && contactNameMap.get(m.contact_id)) || "",
    }));
  });

  // ── Search ──────────────────────────────────────────────────
  server.route("GET", "/api/dashboard/comms/search", ({ query }) => {
    const q = query.get("q") ?? "";
    const channel = query.get("channel") ?? "";
    const status = query.get("status") ?? "";
    const direction = query.get("direction") ?? "";
    const limit = Math.min(parseInt(query.get("limit") ?? "20", 10) || 20, 50);

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
    return db.prepare(
      `SELECT c.id, c.channel, c.subject, c.direction, c.status, c.recipients_to,
              COALESCE(ct.name, '') as contact_name,
              COALESCE(c.sent_at, c.updated_at) as updated_at
       FROM communications c
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       ${where}
       ORDER BY c.updated_at DESC LIMIT ?`,
    ).all(...params, limit);
  });

  // ── Contact autocomplete (compose UI) ───────────────────────
  server.route("GET", "/api/dashboard/comms/contacts", ({ query }) => {
    const q = query.get("q") ?? "";
    if (!q.trim()) return [];
    try {
      const like = `%${q.trim()}%`;
      return db.prepare(
        `SELECT id, name, email FROM contacts
         WHERE (name LIKE ? OR email LIKE ?) AND email <> ''
         LIMIT 10`,
      ).all(like, like);
    } catch {
      return [];
    }
  });

  // ── Serve attachment file (sandboxed read) ──────────────────
  // Stays a raw handler: it answers with the file's bytes and custom headers.
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
      // The MIME type and the name come from the email, i.e. from whoever sent
      // it. Served inline from the kernel's origin, an HTML or SVG attachment
      // would run its scripts as the dashboard. Only types that cannot carry
      // script preview inline; everything else is a download. (A sandbox CSP
      // would do it too, but Chrome then refuses to render PDFs.) The name is
      // quoted, so a `"` or a line break in it would break the header.
      const inline = INLINE_ATTACHMENT_TYPES.has(att.mime_type.toLowerCase());
      const filename = basename(att.filename).replace(/["\\\r\n]/g, "_");
      res.writeHead(200, {
        "Content-Type": inline ? att.mime_type : "application/octet-stream",
        "Content-Length": buf.length,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
        ...server.corsHeaders(req),
      });
      res.end(buf);
    } catch {
      server.json(res, 500, { error: "Failed to read attachment" });
    }
  });
}
