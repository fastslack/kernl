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
import type { KernelHttpServer, SqliteDb, EventBus } from "@kernl/extension-sdk";
import type { CommsService } from "./service.js";
import { commsOperations } from "./dashboard-operations.js";

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
  // ── Operations shared with the WS RPC (dashboard-operations.ts) ──
  // The dashboard reaches these through rpcOrCall, WS first and HTTP when
  // the bridge is down, so both roads run the same function.
  const op = commsOperations(commsService, events);
  server.operation("GET", "/api/dashboard/comms/detail", op["comms.detail"]);
  server.operation("PUT", "/api/dashboard/comms/update", op["comms.update"]);
  server.operation("GET", "/api/dashboard/comms/campaign", op["comms.campaign"]);
  server.operation("POST", "/api/dashboard/comms/create", op["comms.create"]);
  server.operation("POST", "/api/dashboard/comms/send", op["comms.send"]);
  server.operation("GET", "/api/dashboard/comms/thread", op["comms.thread"]);
  server.operation("GET", "/api/dashboard/comms/search", op["comms.search"]);

  // ── Accounts ────────────────────────────────────────────────
  server.route("GET", "/api/dashboard/comms/accounts", () => commsService.listAccounts());

  // ── Templates ───────────────────────────────────────────────
  server.route("GET", "/api/dashboard/comms/templates", ({ query }) =>
    commsService.listTemplates(query.get("category") ?? undefined));

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
