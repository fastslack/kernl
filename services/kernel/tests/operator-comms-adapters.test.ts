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
    expect(calls[0]).toEqual([42, "hola", { buttons: [[{ text: "A", callbackData: "oq:x:0" }]] }]);
    expect(await adapters[1].send({ text: "t\ncuerpo" })).toEqual({ target: "default", messageId: "" });
  });
});
