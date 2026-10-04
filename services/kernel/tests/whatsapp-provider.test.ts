/**
 * WhatsApp provider over mtw-request: link/status/chats calls, error reading
 * (`payload.data.message`), phone normalization, auto-config on first link and
 * group allowlist entries. The MtwConnection is a fake — no network.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { NotificationRegistry } from "../src/core/notify/registry.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { marketplaceMigrations } from "../src/modules/marketplace/migrations.js";
import { normalizeWhatsAppPhone } from "../src/modules/dashboard/operations.js";
import {
  WhatsAppProvider,
  setMtwConnection,
  normalizePhone,
} from "../assets/extensions/channels/whatsapp/_module/whatsapp-provider.js";

type Reply = { type: string; payload: unknown };

interface Sent { action: string; payload: unknown }

function fakeConn() {
  const sent: Sent[] = [];
  const channels = new Map<string, (msg: unknown) => unknown>();
  let next: Reply = { type: "response", payload: { kind: "Json", data: { ok: true } } };
  const conn = {
    connected: true,
    sent,
    channels,
    reply(r: Reply) { next = r; },
    async request(msg: { metadata?: { action?: string }; payload: { data?: unknown } }) {
      sent.push({ action: msg.metadata?.action ?? "", payload: msg.payload?.data });
      return next;
    },
    onChannel(name: string, cb: (msg: unknown) => unknown) {
      channels.set(name, cb);
      return () => channels.delete(name);
    },
    send() {},
    async push(name: string, data: unknown) {
      await channels.get(name)?.({ type: "event", payload: { kind: "Json", data } });
    },
  };
  return conn;
}

describe("WhatsAppProvider over mtw-request", () => {
  let conn: ReturnType<typeof fakeConn>;
  let provider: WhatsAppProvider;

  beforeEach(async () => {
    conn = fakeConn();
    setMtwConnection(conn as never);
    provider = new WhatsAppProvider();
    provider.configure({});
    await provider.start();
    conn.sent.length = 0; // start() seeds the session with one whatsapp.status call
  });

  afterEach(async () => {
    await provider.stop();
    setMtwConnection(null);
  });

  it("readErrorMessage reads data.message", async () => {
    conn.reply({
      type: "error",
      payload: { kind: "Json", data: { code: 503, message: "not_connected: whatsapp bridge is not connected" } },
    });
    const res = await provider.linkQr();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_connected: whatsapp bridge is not connected");
    expect(conn.sent[0].action).toBe("whatsapp.link_qr");
  });

  it("linkPhone normalizes and forwards", async () => {
    const res = await provider.linkPhone("+54 9 11 2345-6789");
    expect(res.ok).toBe(true);
    expect(conn.sent).toEqual([{ action: "whatsapp.link_phone", payload: { phone: "5491123456789" } }]);

    conn.sent.length = 0;
    const bad = await provider.linkPhone("abc");
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("invalid_phone");
    expect(conn.sent.length).toBe(0);
  });

  it("readError turns a numeric code plus a token message into the token", async () => {
    conn.reply({ type: "error", payload: { kind: "Json", data: { code: 400, message: "invalid_phone: bad number" } } });
    const res = await provider.linkQr();
    expect(res.code).toBe("invalid_phone");

    conn.reply({ type: "error", payload: { kind: "Json", data: { code: 503, message: "Bridge Down" } } });
    expect((await provider.linkQr()).code).toBe("503");

    conn.reply({ type: "error", payload: { kind: "Json", data: { code: "custom", message: "not_connected: x" } } });
    expect((await provider.linkQr()).code).toBe("custom");
  });

  it("normalizePhone accepts 8-15 digits not starting with 0", () => {
    expect(normalizePhone("+54 9 11 2345-6789")).toBe("5491123456789");
    expect(normalizePhone("12")).toBeNull();
    expect(normalizePhone("0123456789")).toBeNull();
    expect(normalizePhone("1234567890123456")).toBeNull();
  });

  it("listChats returns items", async () => {
    conn.reply({
      type: "response",
      payload: { kind: "Json", data: { items: [{ jid: "g@g.us", name: "Familia", is_group: true, last_ts: 0 }] } },
    });
    const res = await provider.listChats(10);
    expect(res.ok).toBe(true);
    expect(res.items).toEqual([{ jid: "g@g.us", name: "Familia", is_group: true, last_ts: 0 }]);
    expect(conn.sent[0]).toEqual({ action: "whatsapp.list_chats", payload: { limit: 10 } });
  });

  it("listChats surfaces bridge errors", async () => {
    conn.reply({ type: "error", payload: { kind: "Json", data: { code: 502, message: "not_connected: no session" } } });
    const res = await provider.listChats();
    expect(res).toEqual({ ok: false, items: [], error: "not_connected: no session" });
  });

  it("status merges bridge data with the local phone number", async () => {
    await conn.push("whatsapp:status", { state: "connected", jid: "5491123456789:12@s.whatsapp.net" });
    conn.reply({
      type: "response",
      payload: { kind: "Json", data: { bridge_connected: true, state: "connected", mode: null, jid: "5491123456789:12@s.whatsapp.net" } },
    });
    const st = await provider.status();
    expect(st.bridge_connected).toBe(true);
    expect(st.state).toBe("connected");
    expect(st.phoneNumber).toBe("5491123456789");

    conn.reply({ type: "error", payload: { kind: "Json", data: { code: 504, message: "timeout" } } });
    expect(await provider.status()).toEqual({ bridge_connected: false, state: "unknown" });
  });

  it("pairing channel stores the code; connected clears it", async () => {
    await conn.push("whatsapp:pairing", { code: "ABCD-EFGH", expires_at: 1234 });
    conn.reply({ type: "response", payload: { kind: "Json", data: { bridge_connected: true, state: "linking" } } });
    const st = await provider.status();
    expect(st.pairing_code).toBe("ABCD-EFGH");
    expect(st.pairing_expires_at).toBe(1234);

    await conn.push("whatsapp:status", { state: "connected", jid: "5491123456789@s.whatsapp.net" });
    const st2 = await provider.status();
    expect(st2.pairing_code).toBeUndefined();
  });

  it("auto-config on connected fills only empty fields", async () => {
    const calls: Record<string, unknown>[] = [];
    provider.setConfigPersister((patch) => { calls.push(patch); });

    provider.configure({ allowedNumbers: "", defaultChat: "" });
    await conn.push("whatsapp:status", { state: "connected", jid: "5491123456789:12@s.whatsapp.net" });
    expect(calls).toEqual([{ defaultChat: "5491123456789@s.whatsapp.net", allowedNumbers: "5491123456789" }]);

    provider.configure({ allowedNumbers: "34600000000", defaultChat: "34600000000@s.whatsapp.net" });
    await conn.push("whatsapp:status", { state: "connected", jid: "5491123456789:12@s.whatsapp.net" });
    expect(calls.length).toBe(1);
  });

  it("group allowlist entries match the chat", async () => {
    const got: unknown[] = [];
    provider.setInboundHandler((m) => { got.push(m); });
    provider.configure({ allowedNumbers: "123456@g.us" });
    await conn.push("whatsapp:inbound", {
      id: "m1", from: "123456@g.us", chat: "123456@g.us", is_group: true,
      author: "5490000000000@s.whatsapp.net", timestamp: 0, text: "hola", attachments: [],
    });
    expect(got.length).toBe(1);

    await conn.push("whatsapp:inbound", {
      id: "m2", from: "999@g.us", chat: "999@g.us", is_group: true,
      author: "5490000000000@s.whatsapp.net", timestamp: 0, text: "hola", attachments: [],
    });
    expect(got.length).toBe(1);
  });

  it("author numbers still match exactly", async () => {
    const got: unknown[] = [];
    provider.setInboundHandler((m) => { got.push(m); });
    provider.configure({ allowedNumbers: "5491123456789" });
    await conn.push("whatsapp:inbound", {
      id: "m1", from: "5491123456789@s.whatsapp.net", chat: "5491123456789@s.whatsapp.net", is_group: false,
      author: "5491123456789:3@s.whatsapp.net", timestamp: 0, text: "hola", attachments: [],
    });
    await conn.push("whatsapp:inbound", {
      id: "m2", from: "549112345678@s.whatsapp.net", chat: "549112345678@s.whatsapp.net", is_group: false,
      author: "549112345678@s.whatsapp.net", timestamp: 0, text: "hola", attachments: [],
    });
    expect(got.length).toBe(1);
  });

  describe("own number and the office", () => {
    const own = "5491123456789";
    const msg = (o: Record<string, unknown>) => ({
      id: "m", from: "x", chat: `${own}@s.whatsapp.net`, is_group: false,
      author: `${own}@s.whatsapp.net`, timestamp: 0, text: "hola", attachments: [], ...o,
    });
    let got: unknown[];

    beforeEach(async () => {
      got = [];
      provider.setInboundHandler((m) => { got.push(m); });
      provider.configure({ allowedNumbers: `${own},34600000000` });
      await conn.push("whatsapp:status", { state: "connected", jid: `${own}:12@s.whatsapp.net` });
    });

    it("drops what the user types to a contact", async () => {
      await conn.push("whatsapp:inbound", msg({ chat: "34600000000@s.whatsapp.net", from_me: true }));
      await conn.push("whatsapp:inbound", msg({ chat: "34600000000@s.whatsapp.net" })); // no from_me on the wire
      expect(got.length).toBe(0);
    });

    it("drops from_me in a foreign chat even when the author is not the own number", async () => {
      await conn.push("whatsapp:inbound", msg({ chat: "34600000000@s.whatsapp.net", author: "1234@lid", from_me: true }));
      expect(got.length).toBe(0);
    });

    it("delivers the self-chat", async () => {
      await conn.push("whatsapp:inbound", msg({ from_me: true }));
      expect(got.length).toBe(1);
    });

    it("a phone author with a LID sender_alt matches the allowlist on the phone", async () => {
      await conn.push("whatsapp:inbound", msg({
        chat: "34600000000@s.whatsapp.net", author: "34600000000@s.whatsapp.net", sender_alt: "112233445566@lid",
      }));
      await conn.push("whatsapp:inbound", msg({
        chat: "34611111111@s.whatsapp.net", author: "34611111111@s.whatsapp.net", sender_alt: "665544332211@lid",
      }));
      expect(got.length).toBe(1);
    });

    it("own phone author with own LID sender_alt in a foreign chat is dropped without from_me", async () => {
      await conn.push("whatsapp:inbound", msg({
        chat: "34600000000@s.whatsapp.net", author: `${own}@s.whatsapp.net`, sender_alt: "998877@lid",
      }));
      expect(got.length).toBe(0);
    });

    it("a LID author with no phone address only passes through '*'", async () => {
      await conn.push("whatsapp:inbound", msg({ chat: "34600000000@s.whatsapp.net", author: "112233@lid" }));
      expect(got.length).toBe(0);
      provider.configure({ allowedNumbers: "*" });
      await conn.push("whatsapp:inbound", msg({ chat: "34600000000@s.whatsapp.net", author: "112233@lid" }));
      expect(got.length).toBe(1);
    });

    it("matches the allowlist on sender_alt when the author is a lid", async () => {
      await conn.push("whatsapp:inbound", msg({
        chat: "34600000000@s.whatsapp.net", author: "998877@lid", sender_alt: "34600000000@s.whatsapp.net",
      }));
      await conn.push("whatsapp:inbound", msg({
        chat: "34611111111@s.whatsapp.net", author: "112233@lid", sender_alt: "34611111111@s.whatsapp.net",
      }));
      expect(got.length).toBe(1);
    });
  });

  describe("own LID", () => {
    const own = "5491123456789";
    const lid = "99887766@lid";
    const msg = (o: Record<string, unknown>) => ({
      id: "m", from: "x", chat: lid, is_group: false,
      author: lid, timestamp: 0, text: "hola", attachments: [], ...o,
    });
    let got: unknown[];

    const link = async (withLid: boolean) => {
      got = [];
      provider.setInboundHandler((m) => { got.push(m); });
      provider.configure({ allowedNumbers: `${own},34600000000` });
      await conn.push("whatsapp:status", {
        state: "connected", jid: `${own}:12@s.whatsapp.net`, ...(withLid ? { lid } : {}),
      });
    };

    it("delivers the self-chat addressed by LID", async () => {
      await link(true);
      await conn.push("whatsapp:inbound", msg({}));
      await conn.push("whatsapp:inbound", msg({ from_me: true, author: `${own}@s.whatsapp.net` }));
      expect(got.length).toBe(2);
    });

    it("drops what the own LID writes in another chat", async () => {
      await link(true);
      await conn.push("whatsapp:inbound", msg({ chat: "34600000000@s.whatsapp.net" }));
      expect(got.length).toBe(0);
    });

    it("own LID as sender_alt of the own phone author in another chat is dropped", async () => {
      await link(true);
      await conn.push("whatsapp:inbound", msg({
        chat: "34600000000@s.whatsapp.net", author: `${own}@s.whatsapp.net`, sender_alt: lid,
      }));
      await conn.push("whatsapp:inbound", msg({
        chat: "34600000000@s.whatsapp.net", author: "123123@lid", sender_alt: `${own}@s.whatsapp.net`,
      }));
      expect(got.length).toBe(0);
    });

    it("forgets the LID when the state leaves connected", async () => {
      await link(true);
      await conn.push("whatsapp:status", { state: "disconnected" });
      await conn.push("whatsapp:status", { state: "connected", jid: `${own}:12@s.whatsapp.net` });
      await conn.push("whatsapp:inbound", msg({}));
      expect(got.length).toBe(0); // lid author no longer recognized, not in the allowlist
    });

    it("without a LID the old behaviour holds", async () => {
      await link(false);
      // A LID chat cannot be told apart from a contact's: author LID unknown, not allowed.
      await conn.push("whatsapp:inbound", msg({}));
      await conn.push("whatsapp:inbound", msg({ chat: "34600000000@s.whatsapp.net", author: `${own}@s.whatsapp.net` }));
      expect(got.length).toBe(0);
      await conn.push("whatsapp:inbound", msg({ chat: `${own}@s.whatsapp.net`, author: `${own}@s.whatsapp.net` }));
      await conn.push("whatsapp:inbound", msg({ chat: "34600000000@s.whatsapp.net", author: "34600000000@s.whatsapp.net" }));
      expect(got.length).toBe(2);
    });

    it("status and start() carry the LID", async () => {
      conn.reply({
        type: "response",
        payload: { kind: "Json", data: { bridge_connected: true, state: "connected", jid: `${own}@s.whatsapp.net`, lid } },
      });
      expect((await provider.status()).lid).toBe(lid);

      const p2 = new WhatsAppProvider();
      p2.configure({ allowedNumbers: own });
      await p2.start();
      const seen: unknown[] = [];
      p2.setInboundHandler((m) => { seen.push(m); });
      // fakeConn keeps one handler per channel: the newest provider gets the push.
      await conn.push("whatsapp:inbound", msg({}));
      expect(seen.length).toBe(1);
      await p2.stop();
    });
  });

  describe("auto-config against the stored channel config", () => {
    let db: InstanceType<typeof Database>;
    let registry: NotificationRegistry;

    const seed = (cfg: Record<string, unknown>) => {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO marketplace_items (id, type, slug, name, status, package_data, created_at, updated_at) VALUES ('whatsapp', 'channel', 'whatsapp', 'WhatsApp', 'active', ?, ?, ?)",
      ).run(JSON.stringify(cfg), now, now);
    };
    const inbound = (author: string) => ({
      id: "m", from: author, chat: author, is_group: false,
      author, timestamp: 0, text: "hola", attachments: [],
    });

    beforeEach(() => {
      db = new Database(":memory:");
      runMigrations(db as never, "marketplace", marketplaceMigrations);
      registry = new NotificationRegistry();
      registry.setDb(db as never);
      // Wired the way bootstrap/mtw.ts wires it.
      provider.setConfigPersister((patch) => registry.fillEmptyConfig("whatsapp", patch));
    });

    it("stored values set in Settings survive a link even when memory is stale", async () => {
      seed({ allowedNumbers: "34600000000", defaultChat: "34600000000@s.whatsapp.net" });
      provider.configure({ allowedNumbers: "", defaultChat: "" }); // loaded before Settings saved
      await conn.push("whatsapp:status", { state: "connected", jid: "5491123456789:12@s.whatsapp.net" });
      await Bun.sleep(0);

      expect(registry.loadConfig("whatsapp")).toEqual({
        allowedNumbers: "34600000000",
        defaultChat: "34600000000@s.whatsapp.net",
      });

      // Memory now follows the stored config, not the linked number.
      conn.sent.length = 0;
      await provider.sendNotification({ title: "", body: "x" });
      expect((conn.sent[0].payload as { to: string }).to).toBe("34600000000@s.whatsapp.net");
      const got: unknown[] = [];
      provider.setInboundHandler((m) => { got.push(m); });
      await conn.push("whatsapp:inbound", inbound("5491123456789@s.whatsapp.net"));
      await conn.push("whatsapp:inbound", inbound("34600000000@s.whatsapp.net"));
      expect(got.length).toBe(1);
    });

    it("empty stored fields get the linked number", async () => {
      seed({ allowedNumbers: "", defaultChat: "" });
      provider.configure({});
      await conn.push("whatsapp:status", { state: "connected", jid: "5491123456789:12@s.whatsapp.net" });
      await Bun.sleep(0);
      expect(registry.loadConfig("whatsapp")).toEqual({
        allowedNumbers: "5491123456789",
        defaultChat: "5491123456789@s.whatsapp.net",
      });
    });

    it("only the empty stored field is filled", async () => {
      seed({ allowedNumbers: "34600000000", defaultChat: "" });
      provider.configure({});
      await conn.push("whatsapp:status", { state: "connected", jid: "5491123456789@s.whatsapp.net" });
      await Bun.sleep(0);
      expect(registry.loadConfig("whatsapp")).toEqual({
        allowedNumbers: "34600000000",
        defaultChat: "5491123456789@s.whatsapp.net",
      });
    });

    it("a failed save throws so the provider does not report success", () => {
      // No marketplace row: nothing to update.
      expect(() => registry.fillEmptyConfig("whatsapp", { defaultChat: "1@s.whatsapp.net" })).toThrow();
    });
  });
});

describe("phone rule: provider and dashboard operations agree", () => {
  const table: Array<[string, string | null]> = [
    ["abc", null],
    ["", null],
    ["+54 9 11 2345-6789", "5491123456789"],
    ["(34) 600-000-000", "34600000000"],
    ["0123456789", null],
    ["1234567", null],          // 7 digits
    ["12345678", "12345678"],   // 8 digits
    ["123456789012345", "123456789012345"], // 15 digits
    ["1234567890123456", null], // 16 digits
    ["54a9b11c23456789", null],
    ["54911abc6789", null],
    ["+54 (9) 11 2345-6789", "5491123456789"],
    ["54.9.11.2345.6789", "5491123456789"],
  ];
  for (const [input, expected] of table) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(normalizePhone(input)).toBe(expected);
      expect(normalizeWhatsAppPhone(input)).toBe(expected);
    });
  }
});

describe("start() seeds the session from whatsapp.status", () => {
  afterEach(() => setMtwConnection(null));

  it("a linked bridge makes the provider ready without any channel message", async () => {
    const conn = fakeConn();
    conn.reply({
      type: "response",
      payload: { kind: "Json", data: { bridge_connected: true, state: "connected", jid: "5491123456789:3@s.whatsapp.net" } },
    });
    setMtwConnection(conn as never);
    const p = new WhatsAppProvider();
    p.configure({});
    await p.start();
    expect(conn.sent[0].action).toBe("whatsapp.status");
    expect(p.isReady()).toBe(true);
    expect(p.getStatus().info?.phoneNumber).toBe("5491123456789");
    await p.stop();
  });

  it("an unlinked bridge leaves it not ready", async () => {
    const conn = fakeConn();
    conn.reply({ type: "response", payload: { kind: "Json", data: { bridge_connected: true, state: "idle" } } });
    setMtwConnection(conn as never);
    const p = new WhatsAppProvider();
    await p.start();
    expect(p.isReady()).toBe(false);
    await p.stop();
  });
});
