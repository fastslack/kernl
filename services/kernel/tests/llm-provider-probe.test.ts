import { describe, it, expect } from "bun:test";
import { probeAdapter } from "../src/core/llm/provider-probe.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-adapters.js";

const fake = (chat: ChatLlmProvider["chatCompletion"], extra: Record<string, unknown> = {}) =>
  ({ name: "fake", available: () => true, chatCompletion: chat, ...extra }) as unknown as ChatLlmProvider;

describe("probeAdapter", () => {
  it("ok when the tool is called", async () => {
    const r = await probeAdapter(fake(async () => ({
      content: "", model: "m", tokens_used: 1,
      tool_calls: [{ type: "tool_use", id: "1", name: "kernl_connect_echo", input: { word: "ok" } }],
    })), { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: true, toolCall: true, model: "m" });
  });

  it("no_tools when it answers in prose", async () => {
    const r = await probeAdapter(fake(async () => ({ content: "ok!", model: "m", tokens_used: 1 })), { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("no_tools");
  });

  it("a single-turn provider only has to answer", async () => {
    const r = await probeAdapter(
      fake(async (_m, o) => { expect(o?.tools).toBeUndefined(); return { content: "ok", model: "cc", tokens_used: 1 }; }, { supportsToolLoop: false }),
      { timeoutMs: 1000 },
    );
    expect(r).toMatchObject({ ok: true, toolCall: false });
  });

  it("timeout", async () => {
    const r = await probeAdapter(fake(() => new Promise(() => {})), { timeoutMs: 20 });
    expect(r.error?.code).toBe("timeout");
  });

  it("classifies thrown errors, unreachable for local", async () => {
    const r = await probeAdapter(fake(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:11434"); }), { timeoutMs: 1000, local: true });
    expect(r.error?.code).toBe("unreachable");
  });

  it("missing credentials never reach the network", async () => {
    let called = false;
    const r = await probeAdapter({ name: "x", available: () => false, chatCompletion: async () => { called = true; throw new Error(); } } as unknown as ChatLlmProvider, { timeoutMs: 10 });
    expect(called).toBe(false);
    expect(r.error?.code).toBe("auth");
  });
});
