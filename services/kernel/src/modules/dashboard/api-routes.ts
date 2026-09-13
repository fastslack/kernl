import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { KernelHttpServer } from "../../core/http-server.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import { formatUptime } from "./format.js";
import type { SystemRegistry } from "../../core/system-registry.js";
import type { LifeService } from "../../core/types/extensions/index.js";
import type { KernelConfig } from "../../core/config.js";
// Per-module routes were moved into their respective modules:
//   tasks, reminders, chat       → modules/<name>/api-routes.ts (built-in)
//   comms (compose, threads)     → modules/comms/dashboard-routes.ts
//   email-suggestions            → modules/comms/email-suggestions-routes.ts
//   api-registry                 → modules/api-registry/api-routes.ts
//   graph-intel (analytics)      → modules/graph-intel/api-routes.ts
//   rss-registry, rss-reader     → extensions own their api-routes.ts
// Each module registers its routes via getDashboardDescriptor.registerRoutes,
// which the DashboardRegistry calls during bootstrap.
import { log } from "../../core/logger.js";
import { getGlobalPiiFilter } from "../../core/pii-filter.js";
import {
  // Core KPI composers — dashboard página principal
  queryKpis,
  queryFullDashboard,
  type DashboardChannelReader,
  // Cross-module aggregators — they don't belong to any single module
  queryAgenda,
  queryCrossModuleIntel,
  queryCalendar,
  querySystemTimeline,
  // Dashboard-internal query kept under its legacy kebab-case URL
  // (`/web-intel`). See the comment below where it is registered.
  queryWebIntel,
  // Every extension-owned section (tasks, crm, reminders, shopping, issues,
  // comms, finance, notes, events, …) is a channel in `DashboardRegistry` —
  // `registerAllRoutes()` serves it at `/api/dashboard/<channel_name>`.
} from "./api.js";
import type { Notifier } from "../../core/notify/notifier.js";
import type { EventBus } from "../../core/event-bus.js";

// ── Domain route modules ──────────────────────────
// (All domain routes are now self-registered via their extension's
//  getDashboardDescriptor().registerRoutes. This dashboard module only
//  serves cross-cutting routes like /api/dashboard/agenda and life/notifs.)

const startedAt = Date.now();

export function registerDashboardRoutes(
  server: KernelHttpServer,
  db: SqliteDb,
  /** Reads extension-owned channels — backed by `DashboardRegistry` at bootstrap. */
  readChannel: DashboardChannelReader,
  getGraph: () => GraphDriver | null,
  lifeService?: LifeService | null,
  sysRegistry?: SystemRegistry,
  config?: KernelConfig,
  notifier?: Notifier | null,
  events?: EventBus,
): void {
  // Email-analysis suggestion routes are now self-registered by the comms
  // extension via its `getDashboardDescriptor().registerRoutes` hook.

  server.get("/api/health", (_req, res) => {
    server.json(res, 200, {
      status: "ok",
      uptimeMs: Date.now() - startedAt,
      uptimeFormatted: formatUptime(Date.now() - startedAt),
      timezone: config?.timezone ?? process.env.TIMEZONE ?? "UTC",
      _debug_tz: { env: process.env.TIMEZONE, configTz: config?.timezone, lifeTz: config?.life?.timezone },
      services: {
        sqlite: true,
        graph: !!getGraph()?.capabilities.cypher,
        dashboard: true,
      },
    });
  });

  // ── Prometheus metrics ───────────────────────────
  server.get("/api/metrics", (_req, res) => {
    const uptime = (Date.now() - startedAt) / 1000;
    const mem = process.memoryUsage();

    const lines: string[] = [
      "# HELP kernl_uptime_seconds Server uptime in seconds",
      "# TYPE kernl_uptime_seconds gauge",
      `kernl_uptime_seconds ${uptime.toFixed(1)}`,
      "",
      "# HELP kernl_memory_rss_bytes Resident set size in bytes",
      "# TYPE kernl_memory_rss_bytes gauge",
      `kernl_memory_rss_bytes ${mem.rss}`,
      "",
      "# HELP kernl_memory_heap_used_bytes Heap used in bytes",
      "# TYPE kernl_memory_heap_used_bytes gauge",
      `kernl_memory_heap_used_bytes ${mem.heapUsed}`,
      "",
      "# HELP kernl_graph_available Active graph driver status (1 = ready for cypher)",
      "# TYPE kernl_graph_available gauge",
      `kernl_graph_available ${getGraph()?.capabilities.cypher ? 1 : 0}`,
    ];

    // Module-level counts (graceful if tables don't exist)
    try {
      const taskCount = (db.prepare("SELECT COUNT(*) as c FROM tasks").get() as {c: number}).c;
      lines.push("", "# HELP kernl_tasks_total Total tasks", "# TYPE kernl_tasks_total gauge", `kernl_tasks_total ${taskCount}`);

      const contactCount = (db.prepare("SELECT COUNT(*) as c FROM contacts").get() as {c: number}).c;
      lines.push("", "# HELP kernl_contacts_total Total contacts", "# TYPE kernl_contacts_total gauge", `kernl_contacts_total ${contactCount}`);

      const reminderCount = (db.prepare("SELECT COUNT(*) as c FROM reminders WHERE status='active'").get() as {c: number}).c;
      lines.push("", "# HELP kernl_reminders_active Active reminders", "# TYPE kernl_reminders_active gauge", `kernl_reminders_active ${reminderCount}`);
    } catch { /* tables may not exist */ }

    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(lines.join("\n") + "\n");
  });

  // ── Photo upload (mobile capture) ──────────────
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
  const ALLOWED_MIME_TYPES: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
  };

  function detectMimeType(buf: Buffer): string | null {
    if (buf[0] === 0xFF && buf[1] === 0xD8) return "image/jpeg";
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "image/webp";
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "application/pdf";
    return null;
  }

  server.post("/api/upload", async (req, res) => {
    try {
      const body = await server.parseBody<{ photo?: string; filename?: string }>(req);
      if (!body.photo || typeof body.photo !== "string") {
        server.json(res, 400, { error: "Missing 'photo' (base64 string)" });
        return;
      }
      const buf = Buffer.from(body.photo, "base64");

      // Size check
      if (buf.length > MAX_UPLOAD_BYTES) {
        server.json(res, 400, { error: `File too large (${(buf.length / 1024 / 1024).toFixed(1)} MB). Max allowed: 10 MB` });
        return;
      }

      // MIME type validation via magic bytes
      const mime = detectMimeType(buf);
      if (!mime || !ALLOWED_MIME_TYPES[mime]) {
        server.json(res, 400, { error: `Unsupported file type. Allowed: ${Object.keys(ALLOWED_MIME_TYPES).join(", ")}` });
        return;
      }

      const ext = ALLOWED_MIME_TYPES[mime];
      const destName = `${crypto.randomUUID()}${ext}`;
      const uploadsDir = resolve("./data/uploads");
      mkdirSync(uploadsDir, { recursive: true });
      const destPath = resolve(uploadsDir, destName);
      await fsWriteFile(destPath, buf);
      log.info(`Photo uploaded: ${destPath} (${buf.length} bytes, ${mime})`);
      server.json(res, 200, { path: destPath, filename: destName, size: buf.length, mimeType: mime });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Upload failed", err);
      server.json(res, 500, { error: msg });
    }
  });

  // ── Route helpers ─────────────────────────────────
  // Eliminates repeated 7-line route handlers for dashboard query endpoints.

  /** Register a GET route that always returns data (query never returns null). */
  function directRoute(path: string, queryFn: (db: SqliteDb) => unknown): void {
    server.get(path, (req, res) => {
      server.json(res, 200, queryFn(db), req);
    });
  }

  /** Register a GET route for a nullable query — returns { available: false } when null. */
  function nullableRoute(path: string, queryFn: (db: SqliteDb) => object | null): void {
    server.get(path, (req, res) => {
      const data = queryFn(db);
      if (data === null) {
        server.json(res, 200, { available: false }, req);
        return;
      }
      server.json(res, 200, { available: true, ...(data as Record<string, unknown>) }, req);
    });
  }

  // ── Direct query routes (never null) ──
  // `/api/dashboard/{tasks,crm,reminders,shopping}` are channels registered by
  // their extensions; DashboardRegistry.registerAllRoutes() serves them.
  server.get("/api/dashboard", async (req, res) => {
    server.json(res, 200, await queryFullDashboard(db, readChannel), req);
  });
  directRoute("/api/dashboard/kpis", queryKpis);

  // ── Delegated domain routes ──────────────────────
  // Moved to extensions:
  //   shopping/_module/routes.ts   → assets/extensions/shopping
  //   crm/_module/routes.ts        → assets/extensions/crm
  //   training/_module/routes.ts   → assets/extensions/training
  //   events/_module/routes.ts     → assets/extensions/events
  //   news/_module/routes.ts       → assets/extensions/news
  // Each extension registers via getDashboardDescriptor().registerRoutes.



  // Cross-module aggregators — se quedan centralizados en dashboard
  directRoute("/api/dashboard/agenda", queryAgenda);
  nullableRoute("/api/dashboard/cross-intel", queryCrossModuleIntel);

  // Migrados a self-registering modules (DashboardRegistry auto-genera
  // /api/dashboard/<channel_name>). Reads the module's `channels[]` to
  // el nombre exacto:
  //   notes, meals, goals, vehicles, documents, health, training, nutrition,
  //   chat, events, issues, comms, subscriptions, finance → nombre kebab
  //   home      → channel "house"
  //   web-intel → channel "webIntel"
  //   time-tracking → channel "timeTracking"
  //
  // Legacy kebab-case aliases kept here because the historical frontend
  // consumes them. TODO: align the channel name with the module path and
  // remover estos aliases.
  // home: removed — extracted as an extension; its "home"/"house" channels are
  // auto-registra el DashboardRegistry.
  nullableRoute("/api/dashboard/web-intel", queryWebIntel);
  // time-tracking is an extension: this alias reads its `timeTracking` channel
  // instead of importing its query, with the same `{ available }` envelope.
  server.get("/api/dashboard/time-tracking", async (req, res) => {
    const data = await readChannel("timeTracking");
    server.json(res, 200, data ? { available: true, ...(data as Record<string, unknown>) } : { available: false }, req);
  });

  // files: migrated to extension. Its /api/files/* routes are registered by
  // the extension itself via DashboardRegistry/self-registering modules.

  // health, training, nutrition, web-intel, chat, events: migrados a
  // self-registering modules (DashboardRegistry).



  // ── PII filter status ──────────────────────────
  server.get("/api/pii/status", (_req, res) => {
    const filter = getGlobalPiiFilter();
    const cfg = filter.getConfig();
    server.json(res, 200, {
      enabled: cfg.enabled,
      redactEmails: cfg.redactEmails,
      redactPhones: cfg.redactPhones,
      redactCreditCards: cfg.redactCreditCards,
      redactIbans: cfg.redactIbans,
      redactNames: cfg.redactNames,
      placeholder: cfg.placeholder,
      knownNamesCount: cfg.knownNames.size,
    });
  });

  server.post("/api/pii/detect", async (req, res) => {
    try {
      const body = await server.parseBody<{ text: string }>(req);
      if (!body.text) { server.json(res, 400, { error: "text required" }); return; }
      const filter = getGlobalPiiFilter();
      const result = filter.detect(body.text);
      server.json(res, 200, result);
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : "Error" });
    }
  });


  server.get("/api/dashboard/life", async (req, res) => {
    if (!lifeService) {
      server.json(res, 200, { generatedAt: new Date().toISOString(), error: "Life service not available" }, req);
      return;
    }
    try {
      const data = await lifeService.getLifeData();
      server.json(res, 200, data, req);
    } catch (err) {
      log.error("Life data failed", err);
      server.json(res, 200, { generatedAt: new Date().toISOString(), error: "Unavailable" }, req);
    }
  });


  // ── Calendar ──────────────────────────────────
  server.get("/api/dashboard/calendar", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const startParam = url.searchParams.get("start") ?? new Date().toISOString().split("T")[0];
    const dayCount = Math.min(parseInt(url.searchParams.get("days") ?? "150", 10) || 150, 365);
    server.json(res, 200, queryCalendar(db, startParam, dayCount, sysRegistry), req);
  });

  // ── System Timeline (Agenda view) ──────────────
  server.get("/api/dashboard/system-timeline", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const startParam = url.searchParams.get("start") ?? new Date().toISOString().split("T")[0];
    const dayCount = Math.min(parseInt(url.searchParams.get("days") ?? "150", 10) || 150, 365);
    server.json(res, 200, querySystemTimeline(db, startParam, dayCount, sysRegistry), req);
  });


  // ── System Agenda ──────────────────────────────
  server.get("/api/dashboard/system-agenda", (_req, res) => {
    if (!sysRegistry) {
      server.json(res, 200, { available: false });
      return;
    }
    server.json(res, 200, {
      available: true,
      processes: sysRegistry.list(),
      stats: sysRegistry.getStats(),
      uptimeMs: Date.now() - startedAt,
      uptimeFormatted: formatUptime(Date.now() - startedAt),
    });
  });


  // ── Notification API ────────────────────────────────────────────

  /** GET /api/notifications — list notifications */
  server.get("/api/notifications", (req, res) => {
    if (!notifier) {
      server.json(res, 200, { notifications: [], unread: 0 });
      return;
    }
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      const unreadOnly = url.searchParams.get("unread") === "1";
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      const notifications = notifier.getNotifications({ unreadOnly, limit });
      const unread = notifier.getUnreadCount();
      server.json(res, 200, { notifications, unread });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  /** POST /api/notifications/read — mark one or all as read */
  server.post("/api/notifications/read", async (req, res) => {
    if (!notifier) {
      server.json(res, 400, { error: "Notifications not configured" });
      return;
    }
    try {
      const body = await server.parseBody<{ id?: string }>(req);
      if (body.id) {
        notifier.markRead(body.id);
      } else {
        notifier.markAllRead();
      }
      events?.emit("data.changed", { module: "notifications", action: "read" });
      server.json(res, 200, { success: true, unread: notifier.getUnreadCount() });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  /** DELETE /api/notifications/:id — delete a notification */
  server.delete("/api/notifications", async (req, res) => {
    if (!notifier) {
      server.json(res, 400, { error: "Notifications not configured" });
      return;
    }
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      const id = url.searchParams.get("id");
      if (id) {
        notifier.deleteNotification(id);
      } else {
        notifier.purgeOld(30);
      }
      events?.emit("data.changed", { module: "notifications", action: "delete" });
      server.json(res, 200, { success: true, unread: notifier.getUnreadCount() });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Channel Management ──────────────────────────────────

  const registry = notifier?.getRegistry();

  /** GET /api/channels — list all channel providers with status */
  server.get("/api/channels", (_req, res) => {
    if (!registry) return server.json(res, 503, { error: "Registry not available" });
    const statuses = registry.getStatuses();
    server.json(res, 200, { channels: statuses });
  });

  /** GET /api/channels/:id/schema — get config form schema for a channel */
  server.get("/api/channels/schema", (req, res) => {
    if (!registry) return server.json(res, 503, { error: "Registry not available" });
    const url = new URL(req.url ?? "", "http://localhost");
    const id = url.searchParams.get("id");
    if (!id) return server.json(res, 400, { error: "Missing ?id= parameter" });
    const schema = registry.getConfigSchema(id);
    if (!schema) return server.json(res, 404, { error: `No provider "${id}"` });
    const config2 = registry.loadConfig(id) ?? {};
    server.json(res, 200, { id, schema, config: config2 });
  });

  /** PUT /api/channels/config — save config for a channel */
  server.post("/api/channels/config", async (req, res) => {
    if (!registry) return server.json(res, 503, { error: "Registry not available" });
    try {
      const body = await server.parseBody<{ id: string; config: Record<string, unknown> }>(req);
      if (!body.id || !body.config) return server.json(res, 400, { error: "Missing id or config" });
      const saved = registry.saveConfig(body.id, body.config);
      if (!saved) return server.json(res, 404, { error: `Channel "${body.id}" not found in marketplace` });
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  /** POST /api/channels/start — start a channel provider */
  server.post("/api/channels/start", async (req, res) => {
    if (!registry) return server.json(res, 503, { error: "Registry not available" });
    try {
      const body = await server.parseBody<{ id: string }>(req);
      if (!body.id) return server.json(res, 400, { error: "Missing id" });
      // Also update marketplace status to 'active'
      db.prepare("UPDATE marketplace_items SET status = 'active', updated_at = ? WHERE slug = ? AND type = 'channel'")
        .run(new Date().toISOString(), body.id);
      const ok = await registry.startProvider(body.id);
      if (!ok) {
        return server.json(res, 400, {
          error: `Failed to start "${body.id}"`,
          detail: registry.lastStartError || "Unknown error — check server logs",
        });
      }
      server.json(res, 200, { success: true, status: registry.getProvider(body.id)?.getStatus() });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  /** POST /api/channels/stop — stop a channel provider */
  server.post("/api/channels/stop", async (req, res) => {
    if (!registry) return server.json(res, 503, { error: "Registry not available" });
    try {
      const body = await server.parseBody<{ id: string }>(req);
      if (!body.id) return server.json(res, 400, { error: "Missing id" });
      // Also update marketplace status to 'installed' (not active)
      db.prepare("UPDATE marketplace_items SET status = 'installed', updated_at = ? WHERE slug = ? AND type = 'channel'")
        .run(new Date().toISOString(), body.id);
      const ok = await registry.stopProvider(body.id);
      server.json(res, 200, { success: true, stopped: ok });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  /** POST /api/channels/test — send a test notification through a channel */
  server.post("/api/channels/test", async (req, res) => {
    if (!registry) return server.json(res, 503, { error: "Registry not available" });
    try {
      const body = await server.parseBody<{ id: string }>(req);
      if (!body.id) return server.json(res, 400, { error: "Missing id" });
      const provider = registry.getProvider(body.id);
      if (!provider?.isReady()) return server.json(res, 400, { error: `Provider "${body.id}" not running` });
      let ok: boolean;
      if (provider.sendTest) {
        ok = await provider.sendTest();
      } else {
        ok = await provider.sendNotification({ title: `Kernl test — ${provider.name}`, body: "Channel working!" });
      }
      server.json(res, 200, { success: ok });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  /** GET /api/channels/qr — get QR code for WhatsApp pairing */
  server.get("/api/channels/qr", (_req, res) => {
    if (!registry) return server.json(res, 503, { error: "Registry not available" });
    const provider = registry.getProvider("whatsapp") as any;
    if (!provider) return server.json(res, 404, { error: "WhatsApp provider not registered" });
    const qr = provider.getQr?.() ?? null;
    const status = provider.getStatus?.() ?? {};
    server.json(res, 200, {
      qr,
      connected: status.connected ?? false,
      phoneNumber: status.info?.phoneNumber ?? null,
      error: status.error ?? null,
    });
  });

  /** POST /api/channels/whatsapp/send — send a WhatsApp message (for testing from dashboard) */
  server.post("/api/channels/whatsapp/send", async (req, res) => {
    if (!registry) return server.json(res, 503, { error: "Registry not available" });
    try {
      const body = await server.parseBody<{ phone: string; message: string }>(req);
      if (!body.phone || !body.message) return server.json(res, 400, { error: "Missing phone or message" });
      const provider = registry.getProvider("whatsapp") as any;
      if (!provider?.isReady()) return server.json(res, 400, { error: "WhatsApp not connected" });
      const phone = body.phone.replace(/[\s\-\+\(\)]/g, "");
      const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
      const ok = await provider.sendTo(jid, { title: "", body: body.message });
      server.json(res, 200, { success: ok, jid });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── GDPR Data Export ──────────────────────────────
  server.get("/api/data/export", (_req, res) => {
    const data: Record<string, unknown> = {};

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_migration%'"
    ).all() as Array<{name: string}>;

    for (const t of tables) {
      try {
        data[t.name] = db.prepare(`SELECT * FROM "${t.name}"`).all();
      } catch { /* skip if error */ }
    }

    server.json(res, 200, {
      exported_at: new Date().toISOString(),
      format: "kernl-export-v1",
      tables: Object.keys(data).length,
      data,
    });
  });

  // ── GDPR Data Purge ───────────────────────────────
  server.delete("/api/data/purge", async (req, res) => {
    const body = await server.parseBody<{confirm?: string}>(req);
    if (body.confirm !== "DELETE_ALL_DATA") {
      server.json(res, 400, { error: 'Send {"confirm":"DELETE_ALL_DATA"} to confirm' }, req);
      return;
    }

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_migration%'"
    ).all() as Array<{name: string}>;

    let deleted = 0;
    for (const t of tables) {
      try {
        const r = db.prepare(`DELETE FROM "${t.name}"`).run();
        deleted += r.changes;
      } catch { /* skip system tables */ }
    }

    server.json(res, 200, { purged: true, tables: tables.length, rowsDeleted: deleted }, req);
  });
}
