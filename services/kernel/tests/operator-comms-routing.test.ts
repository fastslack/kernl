import { describe, it, expect } from "bun:test";
import { wireMessageRouting } from "../src/core/message-routing.js";

/** How message routing hands operator answers to the driver. */
describe("operator answers through message routing", () => {
  const wire = () => {
    let onMessage: ((t: string, c: { userId: string; chatId: string }) => Promise<{ text: string; parseMode?: unknown }>) | null = null;
    let onCallback: ((d: string, c: { userId: string; chatId: string }) => Promise<{ text: string; parseMode?: unknown }>) | null = null;
    let ircMessage: ((m: { text: string; context: Record<string, string> }) => Promise<{ text: string }>) | null = null;
    const telegram = {
      onMessage: (h: typeof onMessage) => { onMessage = h; },
      onCallback: (h: typeof onCallback) => { onCallback = h; },
      send: async () => 1,
      editMessage: async () => {},
    };
    const irc = { onMessage: (h: typeof ircMessage) => { ircMessage = h; } };
    const codes: Array<[string, string]> = [];
    const operatorComms = {
      handleCallback: async (d: string) => (d === "oq:bad" ? "Botón inválido." : "✓ Resuelta: A\nweb_merge *x*?"),
      tryCodeReply: async (text: string, platform: string) => { codes.push([text, platform]); return platform === "irc" ? null : "✓ Resuelta: A\n?"; },
    };
    wireMessageRouting({
      notificationRegistry: { getProvider: (id: string) => (id === "telegram" ? { getTransport: () => telegram } : id === "irc" ? { getTransport: () => irc } : undefined) } as never,
      orchestrator: { handleMessage: async (t: string) => ({ text: `eco: ${t}` }), handleCallback: async () => ({ text: "" }) } as never,
      rateLimiter: { consume: () => ({ allowed: true, resetAt: new Date() }) } as never,
      pairingManager: { isApproved: () => true } as never,
      agentService: null,
      agentExecutor: null,
      operatorComms: operatorComms as never,
    });
    return { onMessage: () => onMessage!, onCallback: () => onCallback!, ircMessage: () => ircMessage!, codes };
  };

  it("a button reply is plain text (the question may hold _ or *)", async () => {
    const w = wire();
    expect(await w.onCallback()("oq:x", { userId: "1", chatId: "1" })).toEqual({ text: "✓ Resuelta: A\nweb_merge *x*?", parseMode: null });
    expect((await w.onCallback()("oq:bad", { userId: "1", chatId: "1" })).text).toBe("Botón inválido.");
  });

  it("each code reply says which platform it came from; a refused one falls through", async () => {
    const w = wire();
    expect(await w.onMessage()("Q1 1", { userId: "1", chatId: "1" })).toEqual({ text: "✓ Resuelta: A\n?", parseMode: null });
    const viaIrc = await w.ircMessage()({ text: "Q1 1", context: { platform: "irc", userId: "u", chatId: "#c" } });
    expect(viaIrc.text).toBe("eco: Q1 1");
    expect(w.codes).toEqual([["Q1 1", "telegram"], ["Q1 1", "irc"]]);
  });
});
