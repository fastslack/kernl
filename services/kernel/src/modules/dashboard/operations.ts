/**
 * Dashboard operations the dashboard reaches over both the WS RPC and HTTP:
 * the cross-module aggregators, server health, the PII status, notifications
 * and notification channels.
 *
 * The dashboard calls each of these through `rpcOrCall`, so the RPC action
 * and the HTTP route are the same request by two roads and have to answer
 * alike. They used to be written twice and had drifted: `pii.status` and
 * `dashboard.systemAgenda` answered different fields per road, the timeline
 * read `date`/`limit` over RPC and `start`/`days` over HTTP, the HTTP purge
 * ignored `daysOld`, and every RPC failure came back as a resolved
 * `{ error }` instead of an error. Now rpc-actions.ts exposes this map as is
 * and api-routes.ts binds each entry to its path; where the two disagreed,
 * the fuller behaviour won.
 */

import type { Operation } from "../../sdk/args.js";
import { pickArgs } from "../../sdk/args.js";
import { HttpError } from "../../sdk/http-error.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import type { SystemRegistry } from "../../core/system-registry.js";
import type { KernelConfig } from "../../core/config.js";
import type { Notifier } from "../../core/notify/notifier.js";
import type { EventBus } from "../../core/event-bus.js";
import { getGlobalPiiFilter } from "../../core/pii-filter.js";
import { formatUptime } from "./format.js";
import {
  queryKpis,
  queryFullDashboard,
  queryAgenda,
  queryCrossModuleIntel,
  querySystemTimeline,
  queryCalendar,
  type DashboardChannelReader,
} from "./api.js";
import type { CalendarSource } from "../../core/types.js";

export interface DashboardOperationDeps {
  db: SqliteDb;
  /** Reads extension-owned channels — backed by `DashboardRegistry` at bootstrap. */
  readChannel: DashboardChannelReader;
  getGraph: () => GraphDriver | null;
  systemRegistry?: SystemRegistry | null;
  /**
   * Calendar sources the modules register (`DashboardRegistry.getCalendarSources()`),
   * read per call so a module registered later still shows up.
   */
  calendarSources?: () => readonly CalendarSource[];
  config?: KernelConfig | null;
  notifier?: Notifier | null;
  events?: EventBus | null;
}

/** Process start as the dashboard reports it (health, system agenda, metrics). */
export const startedAt = Date.now();

const today = () => new Date().toISOString().split("T")[0];

/**
 * What the settings page sees in place of a stored channel secret (any schema
 * field of type "password"). It shows it as the placeholder and sends back only
 * what the user typed, so an empty value, or this mask echoed back, on save
 * means "keep the stored secret".
 */
export const CHANNEL_SECRET_MASK = "••••••••";

const secretKeysOf = (schema: ReadonlyArray<{ key: string; type: string }>): string[] =>
  schema.filter((f) => f.type === "password").map((f) => f.key);

/**
 * `start` (defaults to today) and `days` clamped to 365, 150 when absent.
 * `date`/`limit` are the names the RPC used to read, still taken.
 */
export function dateRange(input: Record<string, unknown>): [string, number] {
  const a = pickArgs(input, { start: "string", date: "string", days: "number", limit: "number" });
  const days = a.days ?? a.limit;
  return [a.start || a.date || today(), Math.min(days && days > 0 ? Math.floor(days) : 150, 365)];
}

export function dashboardOperations(deps: DashboardOperationDeps): Record<string, Operation> {
  const { db, readChannel, getGraph, systemRegistry, calendarSources, config, notifier, events } = deps;

  const required = (input: Record<string, unknown>, key: string, message = `${key} required`): string => {
    const value = typeof input[key] === "string" ? (input[key] as string) : "";
    if (!value) throw new HttpError(400, message);
    return value;
  };
  const requireNotifier = (): Notifier => {
    if (!notifier) throw new HttpError(400, "Notifications not configured");
    return notifier;
  };
  const requireRegistry = () => {
    const registry = notifier?.getRegistry();
    if (!registry) throw new HttpError(503, "Registry not available");
    return registry;
  };
  const unread = (n: Notifier) => ({ success: true, unread: n.getUnreadCount() });

  return {
    // ── Cross-module aggregators (no extension owns these) ──
    "dashboard.full": () => queryFullDashboard(db, readChannel),
    "dashboard.kpis": () => queryKpis(db),
    "dashboard.agenda": () => queryAgenda(db),
    "dashboard.crossIntel": () => {
      const data = queryCrossModuleIntel(db);
      return data ? { available: true, ...data } : { available: false };
    },
    // Every module's calendar entries (its `calendarSources`) plus the core's.
    // It used to be the events extension's RPC, calling into this module.
    "dashboard.calendar": (input) => {
      const [start, days] = dateRange(input);
      return queryCalendar(db, start, days, systemRegistry ?? undefined, calendarSources?.() ?? []);
    },
    "dashboard.systemTimeline": (input) => {
      const [start, days] = dateRange(input);
      return querySystemTimeline(db, start, days, systemRegistry ?? undefined);
    },
    "dashboard.systemAgenda": () => {
      if (!systemRegistry) return { available: false };
      return {
        available: true,
        processes: systemRegistry.list(),
        stats: systemRegistry.getStats(),
        uptimeMs: Date.now() - startedAt,
        uptimeFormatted: formatUptime(Date.now() - startedAt),
      };
    },

    // ── Server ──
    "server.health": () => ({
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
    }),

    // ── PII filter ──
    // Every field either road used to answer. `knownNames`/`knownNamesCount`
    // are the same count under the name each road had.
    "pii.status": () => {
      const filter = getGlobalPiiFilter();
      const cfg = filter.getConfig();
      return {
        enabled: filter.isEnabled(),
        redactEmails: cfg.redactEmails,
        redactPhones: cfg.redactPhones,
        redactCreditCards: cfg.redactCreditCards,
        redactIbans: cfg.redactIbans,
        redactIps: cfg.redactIps,
        redactNames: cfg.redactNames,
        redactAddresses: cfg.redactAddresses,
        placeholder: cfg.placeholder,
        knownNames: cfg.knownNames.size,
        knownNamesCount: cfg.knownNames.size,
        customPatterns: cfg.customPatterns.length,
      };
    },

    // ── Notifications ──
    "notifications.list": (input) => {
      if (!notifier) return { notifications: [], unread: 0 };
      // `unreadOnly` is the RPC's name, `?unread=1` the query string's.
      const unreadOnly = input.unreadOnly === true || input.unread === "1" || input.unread === true;
      const limit = pickArgs(input, { limit: "number" }).limit ?? 50;
      return { notifications: notifier.getNotifications({ unreadOnly, limit }), unread: notifier.getUnreadCount() };
    },
    "notifications.markRead": (input) => {
      const n = requireNotifier();
      n.markRead(required(input, "id"));
      events?.emit("data.changed", { module: "notifications", action: "read" });
      return unread(n);
    },
    "notifications.markAllRead": () => {
      const n = requireNotifier();
      n.markAllRead();
      events?.emit("data.changed", { module: "notifications", action: "read" });
      return unread(n);
    },
    "notifications.delete": (input) => {
      const n = requireNotifier();
      n.deleteNotification(required(input, "id"));
      events?.emit("data.changed", { module: "notifications", action: "delete" });
      return unread(n);
    },
    "notifications.deleteOld": (input) => {
      const n = requireNotifier();
      n.purgeOld(pickArgs(input, { daysOld: "number" }).daysOld ?? 30);
      events?.emit("data.changed", { module: "notifications", action: "delete" });
      return unread(n);
    },

    // ── Channels ──
    "channels.list": () => ({ channels: requireRegistry().getStatuses() }),
    "channels.schema": (input) => {
      const reg = requireRegistry();
      const id = required(input, "id", "Missing id parameter");
      const schema = reg.getConfigSchema(id);
      if (!schema) throw new HttpError(404, `No provider "${id}"`);
      // Secrets leave masked; channels.config.save merges them back.
      const config: Record<string, unknown> = { ...(reg.loadConfig(id) ?? {}) };
      for (const key of secretKeysOf(schema)) {
        if (typeof config[key] === "string" && config[key]) config[key] = CHANNEL_SECRET_MASK;
      }
      return { id, schema, config };
    },
    "channels.config.save": (input) => {
      const reg = requireRegistry();
      const { id, config: cfg } = pickArgs(input, { id: "string", config: "object" });
      if (!id || !cfg) throw new HttpError(400, "Missing id or config");
      // saveConfig replaces wholesale, so a secret left blank or still masked
      // takes the stored value instead of wiping it (or storing the mask).
      const stored = reg.loadConfig(id) ?? {};
      const next: Record<string, unknown> = { ...cfg };
      for (const key of secretKeysOf(reg.getConfigSchema(id) ?? [])) {
        const incoming = next[key];
        const keep = typeof incoming !== "string" || incoming === "" || incoming === CHANNEL_SECRET_MASK;
        if (keep && typeof stored[key] === "string" && stored[key]) next[key] = stored[key];
        else if (incoming === CHANNEL_SECRET_MASK) delete next[key];
      }
      if (!reg.saveConfig(id, next)) throw new HttpError(404, `Channel "${id}" not found in marketplace`);
      return { success: true };
    },
    "channels.test": async (input) => {
      const reg = requireRegistry();
      const id = required(input, "id", "Missing id");
      const provider = reg.getProvider(id);
      if (!provider?.isReady()) throw new HttpError(400, `Provider "${id}" not running`);
      const ok = provider.sendTest
        ? await provider.sendTest()
        : await provider.sendNotification({ title: `Kernl test — ${provider.name}`, body: "Channel working!" });
      return { success: ok };
    },
    "channels.start": async (input) => {
      const reg = requireRegistry();
      const id = required(input, "id", "Missing id");
      // Also update marketplace status to 'active'
      db.prepare("UPDATE marketplace_items SET status = 'active', updated_at = ? WHERE slug = ? AND type = 'channel'")
        .run(new Date().toISOString(), id);
      if (!(await reg.startProvider(id))) {
        const error = `Failed to start "${id}"`;
        throw new HttpError(400, error, { error, detail: reg.lastStartError || "Unknown error — check server logs" });
      }
      return { success: true, status: reg.getProvider(id)?.getStatus() };
    },
    "channels.stop": async (input) => {
      const reg = requireRegistry();
      const id = required(input, "id", "Missing id");
      // Also update marketplace status to 'installed' (not active)
      db.prepare("UPDATE marketplace_items SET status = 'installed', updated_at = ? WHERE slug = ? AND type = 'channel'")
        .run(new Date().toISOString(), id);
      return { success: true, stopped: await reg.stopProvider(id) };
    },
    "channels.qr": () => {
      const provider = requireRegistry().getProvider("whatsapp") as any;
      if (!provider) throw new HttpError(404, "WhatsApp provider not registered");
      const status = provider.getStatus?.() ?? {};
      return {
        qr: provider.getQr?.() ?? null,
        connected: status.connected ?? false,
        phoneNumber: status.info?.phoneNumber ?? null,
        error: status.error ?? null,
      };
    },
    "channels.whatsapp.send": async (input) => {
      const reg = requireRegistry();
      const { phone, message } = pickArgs(input, { phone: "string", message: "string" });
      if (!phone || !message) throw new HttpError(400, "Missing phone or message");
      const provider = reg.getProvider("whatsapp") as any;
      if (!provider?.isReady()) throw new HttpError(400, "WhatsApp not connected");
      const cleaned = phone.replace(/[\s\-\+\(\)]/g, "");
      const jid = cleaned.includes("@") ? cleaned : `${cleaned}@s.whatsapp.net`;
      const ok = await provider.sendTo(jid, { title: "", body: message });
      return { success: ok, jid };
    },
  };
}
