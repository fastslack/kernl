import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HttpError, type KernelHttpServer } from "../../core/http-server.js";
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

  server.route("GET", "/api/health", () => ({
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
  }));

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

  // The photo arrives base64-encoded inside a JSON body, so the helper's JSON
  // parsing (and its 10 MB cap) is exactly what this route did by hand.
  server.route<{ photo?: string; filename?: string }>("POST", "/api/upload", async ({ body }) => {
    if (!body.photo || typeof body.photo !== "string") {
      throw new HttpError(400, "Missing 'photo' (base64 string)");
    }
    const buf = Buffer.from(body.photo, "base64");

    // Size check
    if (buf.length > MAX_UPLOAD_BYTES) {
      throw new HttpError(400, `File too large (${(buf.length / 1024 / 1024).toFixed(1)} MB). Max allowed: 10 MB`);
    }

    // MIME type validation via magic bytes
    const mime = detectMimeType(buf);
    if (!mime || !ALLOWED_MIME_TYPES[mime]) {
      throw new HttpError(400, `Unsupported file type. Allowed: ${Object.keys(ALLOWED_MIME_TYPES).join(", ")}`);
    }

    const ext = ALLOWED_MIME_TYPES[mime];
    const destName = `${crypto.randomUUID()}${ext}`;
    const uploadsDir = resolve("./data/uploads");
    mkdirSync(uploadsDir, { recursive: true });
    const destPath = resolve(uploadsDir, destName);
    await fsWriteFile(destPath, buf);
    log.info(`Photo uploaded: ${destPath} (${buf.length} bytes, ${mime})`);
    return { path: destPath, filename: destName, size: buf.length, mimeType: mime };
  });

  // ── Route helpers ─────────────────────────────────
  // Eliminates repeated 7-line route handlers for dashboard query endpoints.

  /** Register a GET route that always returns data (query never returns null). */
  function directRoute(path: string, queryFn: (db: SqliteDb) => unknown): void {
    server.route("GET", path, () => queryFn(db));
  }

  /** Register a GET route for a nullable query — returns { available: false } when null. */
  function nullableRoute(path: string, queryFn: (db: SqliteDb) => object | null): void {
    server.route("GET", path, () => {
      const data = queryFn(db);
      if (data === null) return { available: false };
      return { available: true, ...(data as Record<string, unknown>) };
    });
  }

  // ── Direct query routes (never null) ──
  // `/api/dashboard/{tasks,crm,reminders,shopping}` are channels registered by
  // their extensions; DashboardRegistry.registerAllRoutes() serves them.
  server.route("GET", "/api/dashboard", () => queryFullDashboard(db, readChannel));
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
  server.route("GET", "/api/dashboard/time-tracking", async () => {
    const data = await readChannel("timeTracking");
    return data ? { available: true, ...(data as Record<string, unknown>) } : { available: false };
  });

  // files: migrated to extension. Its /api/files/* routes are registered by
  // the extension itself via DashboardRegistry/self-registering modules.

  // health, training, nutrition, web-intel, chat, events: migrados a
  // self-registering modules (DashboardRegistry).



  // ── PII filter status ──────────────────────────
  server.route("GET", "/api/pii/status", () => {
    const filter = getGlobalPiiFilter();
    const cfg = filter.getConfig();
    return {
      enabled: cfg.enabled,
      redactEmails: cfg.redactEmails,
      redactPhones: cfg.redactPhones,
      redactCreditCards: cfg.redactCreditCards,
      redactIbans: cfg.redactIbans,
      redactNames: cfg.redactNames,
      placeholder: cfg.placeholder,
      knownNamesCount: cfg.knownNames.size,
    };
  });

  server.route<{ text: string }>("POST", "/api/pii/detect", ({ body }) => {
    if (!body.text) throw new HttpError(400, "text required");
    const filter = getGlobalPiiFilter();
    return filter.detect(body.text);
  });


  server.route("GET", "/api/dashboard/life", async () => {
    if (!lifeService) {
      return { generatedAt: new Date().toISOString(), error: "Life service not available" };
    }
    try {
      return await lifeService.getLifeData();
    } catch (err) {
      log.error("Life data failed", err);
      return { generatedAt: new Date().toISOString(), error: "Unavailable" };
    }
  });


  /** `?start=` (defaults to today) and `?days=` clamped to 365, 150 when absent or not a number. */
  const dateRange = (query: URLSearchParams): [string, number] => [
    query.get("start") ?? new Date().toISOString().split("T")[0],
    Math.min(parseInt(query.get("days") ?? "150", 10) || 150, 365),
  ];

  // ── Calendar ──────────────────────────────────
  server.route("GET", "/api/dashboard/calendar", ({ query }) => {
    const [startParam, dayCount] = dateRange(query);
    return queryCalendar(db, startParam, dayCount, sysRegistry);
  });

  // ── System Timeline (Agenda view) ──────────────
  server.route("GET", "/api/dashboard/system-timeline", ({ query }) => {
    const [startParam, dayCount] = dateRange(query);
    return querySystemTimeline(db, startParam, dayCount, sysRegistry);
  });


  // ── System Agenda ──────────────────────────────
  server.route("GET", "/api/dashboard/system-agenda", () => {
    if (!sysRegistry) return { available: false };
    return {
      available: true,
      processes: sysRegistry.list(),
      stats: sysRegistry.getStats(),
      uptimeMs: Date.now() - startedAt,
      uptimeFormatted: formatUptime(Date.now() - startedAt),
    };
  });


  // ── Notification API ────────────────────────────────────────────

  const requireNotifier = (): Notifier => {
    if (!notifier) throw new HttpError(400, "Notifications not configured");
    return notifier;
  };

  /** GET /api/notifications — list notifications */
  server.route("GET", "/api/notifications", ({ query }) => {
    if (!notifier) return { notifications: [], unread: 0 };
    const unreadOnly = query.get("unread") === "1";
    const limit = parseInt(query.get("limit") ?? "50", 10);
    const notifications = notifier.getNotifications({ unreadOnly, limit });
    const unread = notifier.getUnreadCount();
    return { notifications, unread };
  });

  /**
   * POST /api/notifications/read — mark one or all as read. Without an id this
   * marks every notification read, so an empty body must not reach it: only
   * an explicit `{}` means "all".
   */
  server.route<{ id?: string }>("POST", "/api/notifications/read", ({ body }) => {
    const n = requireNotifier();
    if (body.id) {
      n.markRead(body.id);
    } else {
      n.markAllRead();
    }
    events?.emit("data.changed", { module: "notifications", action: "read" });
    return { success: true, unread: n.getUnreadCount() };
  }, { requireBody: true });

  /** DELETE /api/notifications?id= — delete a notification (no id: purge those older than 30 days) */
  server.route("DELETE", "/api/notifications", ({ query }) => {
    const n = requireNotifier();
    const id = query.get("id");
    if (id) {
      n.deleteNotification(id);
    } else {
      n.purgeOld(30);
    }
    events?.emit("data.changed", { module: "notifications", action: "delete" });
    return { success: true, unread: n.getUnreadCount() };
  });

  // ── Channel Management ──────────────────────────────────

  const registry = notifier?.getRegistry();

  const requireRegistry = () => {
    if (!registry) throw new HttpError(503, "Registry not available");
    return registry;
  };

  /** GET /api/channels — list all channel providers with status */
  server.route("GET", "/api/channels", () => ({ channels: requireRegistry().getStatuses() }));

  /** GET /api/channels/schema?id= — get config form schema for a channel */
  server.route("GET", "/api/channels/schema", ({ query }) => {
    const reg = requireRegistry();
    const id = query.get("id");
    if (!id) throw new HttpError(400, "Missing ?id= parameter");
    const schema = reg.getConfigSchema(id);
    if (!schema) throw new HttpError(404, `No provider "${id}"`);
    const config2 = reg.loadConfig(id) ?? {};
    return { id, schema, config: config2 };
  });

  /** POST /api/channels/config — save config for a channel */
  server.route<{ id: string; config: Record<string, unknown> }>("POST", "/api/channels/config", ({ body }) => {
    const reg = requireRegistry();
    if (!body.id || !body.config) throw new HttpError(400, "Missing id or config");
    const saved = reg.saveConfig(body.id, body.config);
    if (!saved) throw new HttpError(404, `Channel "${body.id}" not found in marketplace`);
    return { success: true };
  });

  /** POST /api/channels/start — start a channel provider */
  server.route<{ id: string }>("POST", "/api/channels/start", async ({ body }) => {
    const reg = requireRegistry();
    if (!body.id) throw new HttpError(400, "Missing id");
    // Also update marketplace status to 'active'
    db.prepare("UPDATE marketplace_items SET status = 'active', updated_at = ? WHERE slug = ? AND type = 'channel'")
      .run(new Date().toISOString(), body.id);
    const ok = await reg.startProvider(body.id);
    if (!ok) {
      const error = `Failed to start "${body.id}"`;
      throw new HttpError(400, error, {
        error,
        detail: reg.lastStartError || "Unknown error — check server logs",
      });
    }
    return { success: true, status: reg.getProvider(body.id)?.getStatus() };
  });

  /** POST /api/channels/stop — stop a channel provider */
  server.route<{ id: string }>("POST", "/api/channels/stop", async ({ body }) => {
    const reg = requireRegistry();
    if (!body.id) throw new HttpError(400, "Missing id");
    // Also update marketplace status to 'installed' (not active)
    db.prepare("UPDATE marketplace_items SET status = 'installed', updated_at = ? WHERE slug = ? AND type = 'channel'")
      .run(new Date().toISOString(), body.id);
    const ok = await reg.stopProvider(body.id);
    return { success: true, stopped: ok };
  });

  /** POST /api/channels/test — send a test notification through a channel */
  server.route<{ id: string }>("POST", "/api/channels/test", async ({ body }) => {
    const reg = requireRegistry();
    if (!body.id) throw new HttpError(400, "Missing id");
    const provider = reg.getProvider(body.id);
    if (!provider?.isReady()) throw new HttpError(400, `Provider "${body.id}" not running`);
    let ok: boolean;
    if (provider.sendTest) {
      ok = await provider.sendTest();
    } else {
      ok = await provider.sendNotification({ title: `Kernl test — ${provider.name}`, body: "Channel working!" });
    }
    return { success: ok };
  });

  /** GET /api/channels/qr — get QR code for WhatsApp pairing */
  server.route("GET", "/api/channels/qr", () => {
    const provider = requireRegistry().getProvider("whatsapp") as any;
    if (!provider) throw new HttpError(404, "WhatsApp provider not registered");
    const qr = provider.getQr?.() ?? null;
    const status = provider.getStatus?.() ?? {};
    return {
      qr,
      connected: status.connected ?? false,
      phoneNumber: status.info?.phoneNumber ?? null,
      error: status.error ?? null,
    };
  });

  /** POST /api/channels/whatsapp/send — send a WhatsApp message (for testing from dashboard) */
  server.route<{ phone: string; message: string }>("POST", "/api/channels/whatsapp/send", async ({ body }) => {
    const reg = requireRegistry();
    if (!body.phone || !body.message) throw new HttpError(400, "Missing phone or message");
    const provider = reg.getProvider("whatsapp") as any;
    if (!provider?.isReady()) throw new HttpError(400, "WhatsApp not connected");
    const phone = body.phone.replace(/[\s\-\+\(\)]/g, "");
    const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
    const ok = await provider.sendTo(jid, { title: "", body: body.message });
    return { success: ok, jid };
  });

  const userTables = () => db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_migration%'"
  ).all() as Array<{name: string}>;

  // ── GDPR Data Export ──────────────────────────────
  server.route("GET", "/api/data/export", () => {
    const data: Record<string, unknown> = {};

    for (const t of userTables()) {
      try {
        data[t.name] = db.prepare(`SELECT * FROM "${t.name}"`).all();
      } catch { /* skip if error */ }
    }

    return {
      exported_at: new Date().toISOString(),
      format: "kernl-export-v1",
      tables: Object.keys(data).length,
      data,
    };
  });

  // ── GDPR Data Purge ───────────────────────────────
  server.route<{confirm?: string}>("DELETE", "/api/data/purge", ({ body }) => {
    if (body.confirm !== "DELETE_ALL_DATA") {
      throw new HttpError(400, 'Send {"confirm":"DELETE_ALL_DATA"} to confirm');
    }

    const tables = userTables();

    let deleted = 0;
    for (const t of tables) {
      try {
        const r = db.prepare(`DELETE FROM "${t.name}"`).run();
        deleted += r.changes;
      } catch { /* skip system tables */ }
    }

    return { purged: true, tables: tables.length, rowsDeleted: deleted };
  });
}
