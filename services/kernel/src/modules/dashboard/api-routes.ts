import { mkdirSync } from "node:fs";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { resolve } from "node:path";
import crypto from "node:crypto";
import { HttpError, type KernelHttpServer, type RouteMethod } from "../../core/http-server.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
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
  type DashboardChannelReader,
  // Cross-module aggregators (KPIs, agenda, cross-intel, timeline) are
  // operations shared with the WS RPC: see operations.ts.
  queryCalendar,
  // Dashboard-internal query kept under its legacy kebab-case URL
  // (`/web-intel`). See the comment below where it is registered.
  queryWebIntel,
  // Every extension-owned section (tasks, crm, reminders, shopping, issues,
  // comms, finance, notes, events, …) is a channel in `DashboardRegistry` —
  // `registerAllRoutes()` serves it at `/api/dashboard/<channel_name>`.
} from "./api.js";
import type { Notifier } from "../../core/notify/notifier.js";
import type { EventBus } from "../../core/event-bus.js";
import { dashboardOperations, dateRange, startedAt } from "./operations.js";

// ── Domain route modules ──────────────────────────
// (All domain routes are now self-registered via their extension's
//  getDashboardDescriptor().registerRoutes. This dashboard module only
//  serves cross-cutting routes like /api/dashboard/agenda and life/notifs.)

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

  // ── Direct query routes (never null) ──
  // `/api/dashboard/{tasks,crm,reminders,shopping}` are channels registered by
  // their extensions; DashboardRegistry.registerAllRoutes() serves them.

  // ── Delegated domain routes ──────────────────────
  // Moved to extensions:
  //   shopping/_module/routes.ts   → assets/extensions/shopping
  //   crm/_module/routes.ts        → assets/extensions/crm
  //   training/_module/routes.ts   → assets/extensions/training
  //   events/_module/routes.ts     → assets/extensions/events
  //   news/_module/routes.ts       → assets/extensions/news
  // Each extension registers via getDashboardDescriptor().registerRoutes.



  // Cross-module aggregators (/api/dashboard, kpis, agenda, cross-intel) are
  // operations shared with the WS RPC — bound at the end of this function.

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
  server.route("GET", "/api/dashboard/web-intel", () => {
    const data = queryWebIntel(db);
    return data ? { available: true, ...data } : { available: false };
  });
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


  // ── Calendar ──────────────────────────────────
  // `?start=` (defaults to today) and `?days=` clamped to 365, 150 when absent.
  // The `dashboard.calendar` RPC belongs to the events extension.
  server.route("GET", "/api/dashboard/calendar", ({ query }) => {
    const [startParam, dayCount] = dateRange(Object.fromEntries(query));
    return queryCalendar(db, startParam, dayCount, sysRegistry);
  });

  // ── Operations shared with the WS RPC (operations.ts) ─────────
  // The dashboard reaches these through rpcOrCall, WS first and HTTP when
  // the bridge is down, so both roads run the same function.
  const op = dashboardOperations({ db, readChannel, getGraph, systemRegistry: sysRegistry, config, notifier, events });
  const bind = ([method, path, name]: [RouteMethod, string, string]) => server.operation(method, path, op[name]);
  ([
    ["GET", "/api/health", "server.health"],
    ["GET", "/api/dashboard", "dashboard.full"],
    ["GET", "/api/dashboard/kpis", "dashboard.kpis"],
    ["GET", "/api/dashboard/agenda", "dashboard.agenda"],
    ["GET", "/api/dashboard/cross-intel", "dashboard.crossIntel"],
    ["GET", "/api/dashboard/system-timeline", "dashboard.systemTimeline"],
    ["GET", "/api/dashboard/system-agenda", "dashboard.systemAgenda"],
    ["GET", "/api/pii/status", "pii.status"],
    ["GET", "/api/notifications", "notifications.list"],
    ["GET", "/api/channels", "channels.list"],
    ["GET", "/api/channels/schema", "channels.schema"],
    ["POST", "/api/channels/config", "channels.config.save"],
    ["POST", "/api/channels/start", "channels.start"],
    ["POST", "/api/channels/stop", "channels.stop"],
    ["POST", "/api/channels/test", "channels.test"],
    ["GET", "/api/channels/qr", "channels.qr"],
    ["POST", "/api/channels/whatsapp/send", "channels.whatsapp.send"],
  ] as Array<[RouteMethod, string, string]>).forEach(bind);

  /**
   * POST /api/notifications/read — mark one (`{ id }`) or all (`{}`) as read.
   * Without an id this marks every notification read, so an empty body must
   * not reach it: only an explicit `{}` means "all". An id that is there but
   * not a usable string is a 400, never "all".
   */
  server.operation("POST", "/api/notifications/read", (input) =>
    input.id === undefined ? op["notifications.markAllRead"](input) : op["notifications.markRead"](input),
    { requireBody: true });

  /** DELETE /api/notifications?id= — delete one; no id: purge those older than `?daysOld=` (30). */
  server.operation("DELETE", "/api/notifications", (input) =>
    input.id === undefined ? op["notifications.deleteOld"](input) : op["notifications.delete"](input));

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
