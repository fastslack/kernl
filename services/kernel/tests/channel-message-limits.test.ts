/**
 * Discord rejects a message over 2000 characters and Telegram one over 4096.
 * An agent's reply routinely runs longer, and the transports used to send it
 * as one message, so the platform refused it and the reply was lost whole.
 * They now split it; these tests drive the real transports against fake
 * clients and look at what would have gone over the wire.
 */

import { describe, it, expect } from "bun:test";
import { DiscordTransport } from "../assets/extensions/channels/discord/_module/discord-transport.js";
import { TelegramTransport } from "../assets/extensions/channels/telegram/_module/telegram-transport.js";
import { DiscordProvider } from "../assets/extensions/channels/discord/_module/discord-provider.js";

const long = (n: number) => Array.from({ length: n }, (_, i) => `paragraph ${i} ${"lorem ipsum ".repeat(8)}`).join("\n\n");

describe("DiscordTransport", () => {
  function connected() {
    const sent: Array<{ content: string; components?: unknown[]; reply?: unknown }> = [];
    const channel = {
      isTextBased: () => true,
      send: async (opts: (typeof sent)[number]) => { sent.push(opts); return { id: `m${sent.length}` }; },
    };
    const t = new DiscordTransport({ enabled: true, botToken: "x", allowedUsers: [], allowedGuilds: [], allowedChannels: [] });
    Object.assign(t as object, {
      client: { channels: { fetch: async () => channel } },
      connected: true,
      authenticated: true,
    });
    return { t, sent };
  }

  it("splits a long reply into messages Discord accepts, buttons on the last", async () => {
    const { t, sent } = connected();
    const id = await t.send("c1", { text: long(60), buttons: [[{ text: "OK", callbackData: "ok" }]] });
    expect(sent.length).toBeGreaterThan(1);
    for (const m of sent) expect(m.content.length).toBeLessThanOrEqual(2000);
    expect(sent.slice(0, -1).every((m) => !m.components)).toBe(true);
    expect(sent.at(-1)!.components).toHaveLength(1);
    expect(id).toBe(`m${sent.length}`);
  });

  it("sends a short reply as one message", async () => {
    const { t, sent } = connected();
    await t.send("c1", { text: "hi" });
    expect(sent).toEqual([{ content: "hi" }]);
  });
});

describe("TelegramTransport", () => {
  it("splits a long send into messages Telegram accepts, replying with the first", async () => {
    const t = new TelegramTransport({ enabled: true, botToken: "1:x", allowedUserIds: [], defaultChatId: null });
    const sent: Array<{ text: string; opts: { reply_parameters?: unknown } }> = [];
    Object.assign((t as unknown as { bot: { api: object } }).bot.api, {
      sendMessage: async (_chat: number, text: string, opts: (typeof sent)[number]["opts"]) => {
        sent.push({ text, opts });
        return { message_id: sent.length };
      },
    });
    const id = await t.send(7, long(120), { replyToMessageId: 42 });
    expect(sent.length).toBeGreaterThan(1);
    for (const m of sent) expect(m.text.length).toBeLessThanOrEqual(4096);
    expect(sent[0].opts.reply_parameters).toEqual({ message_id: 42 });
    expect(sent.slice(1).every((m) => m.opts.reply_parameters === undefined)).toBe(true);
    expect(id).toBe(sent.length);
  });
});

describe("DiscordProvider (TransportNotificationProvider)", () => {
  it("validates and reports its config like before", () => {
    const p = new DiscordProvider();
    expect(p.validateConfig({})).toEqual({ valid: false, errors: ["botToken is required"] });
    expect(p.validateConfig({ botToken: "t" })).toEqual({ valid: true });
    p.configure({ botToken: "t" });
    expect(p.getStatus()).toMatchObject({ id: "discord", name: "Discord", connected: false, enabled: true });
  });
});
