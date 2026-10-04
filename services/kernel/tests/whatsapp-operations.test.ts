/**
 * The channels.whatsapp.* dashboard operations: validation happens before the
 * provider is reached, and each op maps onto the provider call it fronts.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { Notifier } from "../src/core/notify/notifier.js";
import { dashboardOperations } from "../src/modules/dashboard/operations.js";
import { HttpError } from "../src/sdk/http-error.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { marketplaceMigrations } from "../src/modules/marketplace/migrations.js";
import { seedBundledChannels } from "../src/modules/marketplace/seeders.js";

describe("channels.whatsapp operations", () => {
  let calls: Array<[string, unknown]>;
  let ops: ReturnType<typeof dashboardOperations>;

  beforeEach(() => {
    calls = [];
    const provider = {
      linkQr: async () => { calls.push(["linkQr", null]); return { ok: true }; },
      linkPhone: async (p: string) => { calls.push(["linkPhone", p]); return { ok: true }; },
      linkCancel: async () => { calls.push(["linkCancel", null]); return { ok: true }; },
      listChats: async (n?: number) => { calls.push(["listChats", n]); return { ok: true, items: [] }; },
      status: async () => { calls.push(["status", null]); return { bridge_connected: true, state: "idle" }; },
      logout: async () => { calls.push(["logout", null]); return { ok: true }; },
    };
    const registry = { getProvider: (id: string) => (id === "whatsapp" ? provider : undefined) };
    const notifier = { getRegistry: () => registry } as unknown as Notifier;
    ops = dashboardOperations({
      db: new Database(":memory:") as never,
      readChannel: (() => null) as never,
      getGraph: () => null,
      notifier,
    });
  });

  const expectHttp = async (p: unknown, status: number, message: string) => {
    let err: unknown;
    try { await p; } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    expect((err as Error).message).toBe(message);
  };

  it("phone link with an invalid number is a 400 invalid_phone, provider untouched", async () => {
    await expectHttp(ops["channels.whatsapp.link"]({ mode: "phone", phone: "12" }), 400, "invalid_phone");
    expect(calls).toEqual([]);
  });

  it("phone link with letters is a 400 invalid_phone, provider untouched", async () => {
    await expectHttp(ops["channels.whatsapp.link"]({ mode: "phone", phone: "54911abc6789" }), 400, "invalid_phone");
    await expectHttp(ops["channels.whatsapp.link"]({ mode: "phone", phone: "54911abc23456789" }), 400, "invalid_phone");
    expect(calls).toEqual([]);
  });

  it("parentheses and dots are separators", async () => {
    await ops["channels.whatsapp.link"]({ mode: "phone", phone: "+54 (9) 11 2345-6789" });
    await ops["channels.whatsapp.link"]({ mode: "phone", phone: "54.9.11.2345.6789" });
    expect(calls).toEqual([["linkPhone", "5491123456789"], ["linkPhone", "5491123456789"]]);
  });

  it("status carries the platform", async () => {
    const st = await ops["channels.whatsapp.status"]({});
    expect(st).toEqual({ bridge_connected: true, state: "idle", platform: process.platform });
  });

  it("phone link forwards the normalized number", async () => {
    await ops["channels.whatsapp.link"]({ mode: "phone", phone: "+54 9 11 2345-6789" });
    expect(calls).toEqual([["linkPhone", "5491123456789"]]);
  });

  it("qr link calls linkQr", async () => {
    const res = await ops["channels.whatsapp.link"]({ mode: "qr" });
    expect(res).toEqual({ ok: true });
    expect(calls).toEqual([["linkQr", null]]);
  });

  it("unknown mode is a 400", async () => {
    await expectHttp(ops["channels.whatsapp.link"]({ mode: "fax" }), 400, "invalid_mode");
    expect(calls).toEqual([]);
  });

  it("cancel, chats, status and logout reach the provider", async () => {
    await ops["channels.whatsapp.link_cancel"]({});
    await ops["channels.whatsapp.chats"]({ limit: 5 });
    await ops["channels.whatsapp.status"]({});
    await ops["channels.whatsapp.logout"]({});
    expect(calls.map((c) => c[0])).toEqual(["linkCancel", "listChats", "status", "logout"]);
    expect(calls[1][1]).toBe(5);
  });
});

describe("channels.config.save reaches the running provider", () => {
  it("reconfigures the running provider with the saved config", async () => {
    const store: Record<string, Record<string, unknown>> = { whatsapp: { allowedNumbers: "", defaultChat: "" } };
    const configured: Record<string, unknown>[] = [];
    const provider = { configure: (c: Record<string, unknown>) => { configured.push(c); } };
    const registry = {
      getConfigSchema: () => [{ key: "allowedNumbers", type: "textarea" }, { key: "defaultChat", type: "text" }],
      loadConfig: (id: string) => store[id] ?? null,
      saveConfig: (id: string, cfg: Record<string, unknown>) => { store[id] = cfg; return true; },
      getProvider: (id: string) => (id === "whatsapp" ? provider : undefined),
    };
    const ops = dashboardOperations({
      db: new Database(":memory:") as never,
      readChannel: (() => null) as never,
      getGraph: () => null,
      notifier: { getRegistry: () => registry } as unknown as Notifier,
    });
    const cfg = { allowedNumbers: "34600000000", defaultChat: "34600000000@s.whatsapp.net" };
    await ops["channels.config.save"]({ id: "whatsapp", config: cfg });
    expect(store.whatsapp).toEqual(cfg);
    expect(configured).toEqual([cfg]);
  });

  it("a channel that is not running is only saved", async () => {
    const store: Record<string, Record<string, unknown>> = {};
    const registry = {
      getConfigSchema: () => [],
      loadConfig: () => null,
      saveConfig: (id: string, cfg: Record<string, unknown>) => { store[id] = cfg; return true; },
      getProvider: () => undefined,
    };
    const ops = dashboardOperations({
      db: new Database(":memory:") as never,
      readChannel: (() => null) as never,
      getGraph: () => null,
      notifier: { getRegistry: () => registry } as unknown as Notifier,
    });
    expect(await ops["channels.config.save"]({ id: "tg", config: { chatId: "1" } })).toEqual({ success: true });
    expect(store.tg).toEqual({ chatId: "1" });
  });
});

describe("WhatsApp that is not running yet", () => {
  const realPlatform = process.platform;
  afterEach(() => Object.defineProperty(process, "platform", { value: realPlatform }));

  const setup = (startOk = true) => {
    const db = new Database(":memory:");
    runMigrations(db as never, "marketplace", marketplaceMigrations);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO marketplace_items (id, type, slug, name, status, created_at, updated_at) VALUES ('w', 'channel', 'whatsapp', 'WhatsApp', 'available', ?, ?)",
    ).run(now, now);
    const calls: string[] = [];
    const provider = {
      linkQr: async () => { calls.push("linkQr"); return { ok: true }; },
      linkPhone: async () => { calls.push("linkPhone"); return { ok: true }; },
      status: async () => ({ bridge_connected: true, state: "idle" }),
    };
    let started = false;
    const registry = {
      getProvider: (id: string) => (id === "whatsapp" && started ? provider : undefined),
      startProvider: async (id: string) => {
        calls.push(`start:${id}`);
        started = startOk;
        return startOk;
      },
      lastStartError: startOk ? null : "boom",
    };
    const ops = dashboardOperations({
      db: db as never,
      readChannel: (() => null) as never,
      getGraph: () => null,
      notifier: { getRegistry: () => registry } as unknown as Notifier,
    });
    const status = () => (db.prepare("SELECT status FROM marketplace_items WHERE slug = 'whatsapp'").get() as { status: string }).status;
    return { ops, calls, status };
  };

  it("status answers inactive instead of a 404", async () => {
    const { ops } = setup();
    expect(await ops["channels.whatsapp.status"]({})).toEqual({
      bridge_connected: false, state: "inactive", platform: process.platform,
    });
  });

  it("linking activates and starts the channel first", async () => {
    const { ops, calls, status } = setup();
    expect(await ops["channels.whatsapp.link"]({ mode: "qr" })).toEqual({ ok: true });
    expect(calls).toEqual(["start:whatsapp", "linkQr"]);
    expect(status()).toBe("active");
  });

  it("a channel that fails to start is a 400 and the link is not sent", async () => {
    const { ops, calls } = setup(false);
    let err: unknown;
    try { await ops["channels.whatsapp.link"]({ mode: "phone", phone: "5491123456789" }); } catch (e) { err = e; }
    expect((err as HttpError).status).toBe(400);
    expect(calls).toEqual(["start:whatsapp"]);
  });

  it("Windows asks the provider like any platform", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { ops } = setup();
    await ops["channels.whatsapp.link"]({ mode: "qr" }); // starts the channel: the provider is registered
    expect(await ops["channels.whatsapp.status"]({})).toEqual({
      bridge_connected: true, state: "idle", platform: "win32",
    });
  });
});

describe("seeding the WhatsApp channel", () => {
  const fresh = () => {
    const db = new Database(":memory:");
    runMigrations(db as never, "marketplace", marketplaceMigrations);
    return db;
  };
  const statusOf = (db: InstanceType<typeof Database>, slug: string) =>
    (db.prepare("SELECT status FROM marketplace_items WHERE slug = ?").get(slug) as { status: string }).status;

  it("a fresh install gets it active", () => {
    const db = fresh();
    seedBundledChannels(db as never);
    expect(statusOf(db, "whatsapp")).toBe("active");
    expect(statusOf(db, "slack")).toBe("available");
  });

  it("a channel the user stopped stays stopped on the next boot", () => {
    const db = fresh();
    seedBundledChannels(db as never);
    db.prepare("UPDATE marketplace_items SET status = 'installed' WHERE slug = 'whatsapp'").run();
    seedBundledChannels(db as never);
    expect(statusOf(db, "whatsapp")).toBe("installed");
  });
});
