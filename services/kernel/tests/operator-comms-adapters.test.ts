import { describe, it, expect } from "bun:test";
import { buildAdapters } from "../src/core/operator-comms/adapters.js";

describe("buildAdapters", () => {
  it("telegram sends buttons to the default chat; others notify; dashboard is skipped", async () => {
    const calls: unknown[] = [];
    const telegram = {
      id: "telegram", capabilities: ["notify", "receive", "buttons"], isReady: () => true,
      getDefaultChatId: () => 42,
      getTransport: () => ({ send: async (chat: number, text: string, o: unknown) => { calls.push([chat, text, o]); return 9; }, editMessage: async () => {} }),
      sendNotification: async () => true,
    };
    const wa = { id: "whatsapp", capabilities: ["notify", "receive"], isReady: () => true, sendNotification: async (p: unknown) => { calls.push(p); return true; } };
    const dash = { id: "dashboard", capabilities: ["notify"], isReady: () => true, sendNotification: async () => true };
    const adapters = buildAdapters({ list: () => [telegram, wa, dash] } as never);
    expect(adapters.map((a) => a.id)).toEqual(["telegram", "whatsapp"]);
    const ref = await adapters[0].send({ text: "hola", buttons: [[{ text: "A", data: "oq:x:0" }]] });
    expect(ref).toEqual({ target: "42", messageId: "9" });
    expect(calls[0]).toEqual([42, "hola", { parseMode: null, buttons: [[{ text: "A", callbackData: "oq:x:0" }]] }]);
    expect(await adapters[1].send({ text: "t\ncuerpo" })).toEqual({ target: "default", messageId: "" });
  });

  const tg = (chat: number | null, calls: unknown[]) => ({
    id: "telegram", capabilities: ["notify", "receive"], isReady: () => true,
    getDefaultChatId: () => chat,
    getTransport: () => ({
      send: async (...a: unknown[]) => { calls.push(["send", ...a]); return 5; },
      editMessage: async (...a: unknown[]) => { calls.push(["edit", ...a]); },
    }),
    sendNotification: async (p: unknown) => { calls.push(["notify", p]); return true; },
  });

  it("sends plain text (no parse mode) so _ and * cannot break the message", async () => {
    const calls: unknown[][] = [];
    const [a] = buildAdapters({ list: () => [tg(7, calls)] } as never);
    await a.send({ text: "merge_hold *x* web#2588:web-3-c", buttons: [[{ text: "A", data: "oq:x:0" }]] });
    const opts = calls[0][3] as { parseMode?: unknown };
    expect(opts.parseMode).toBeNull();
  });

  it("edits with no parse mode", async () => {
    const calls: unknown[][] = [];
    const [a] = buildAdapters({ list: () => [tg(7, calls)] } as never);
    await a.edit!({ target: "7", messageId: "5" }, "a_b *c*");
    expect(calls[0]).toEqual(["edit", 7, 5, "a_b *c*", null]);
  });

  it("telegram without a default chat degrades to notify-only", async () => {
    const calls: unknown[][] = [];
    const [a] = buildAdapters({ list: () => [tg(null, calls)] } as never);
    expect(a.buttons).toBe(false);
    expect(a.edit).toBeUndefined();
    expect(await a.send({ text: "solo" })).toEqual({ target: "default", messageId: "" });
    expect(calls[0]).toEqual(["notify", { title: "solo", body: undefined, silent: undefined }]);
  });
});
