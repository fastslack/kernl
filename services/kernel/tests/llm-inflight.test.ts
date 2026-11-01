import { describe, it, expect, afterEach } from "bun:test";
import { beginLlmCall, listInFlight, clearInFlight, trackLlmCall } from "../src/sdk/llm-inflight.js";
import { LlmClient } from "../src/core/llm/client.js";
import { claudeModelMatches } from "../src/sdk/claude-limits.js";
import { instrumentProvider } from "../src/core/llm/chat-instrumentation.js";
import { attachInFlight } from "../src/core/llm/chain-status.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-provider.js";

afterEach(clearInFlight);

describe("in-flight LLM call registry", () => {
  it("lists a call between begin and end", () => {
    const end = beginLlmCall({ slug: "openai", model: "gpt-4o-mini", caller: "test" });
    const calls = listInFlight();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ slug: "openai", model: "gpt-4o-mini", caller: "test" });
    expect(calls[0].startedAt).toBeLessThanOrEqual(Date.now());
    end();
    expect(listInFlight()).toHaveLength(0);
  });

  it("ending twice is harmless and only removes its own entry", () => {
    const a = beginLlmCall({ slug: "grok", model: "m" });
    const b = beginLlmCall({ slug: "grok", model: "m" });
    a(); a();
    expect(listInFlight()).toHaveLength(1);
    b();
    expect(listInFlight()).toHaveLength(0);
  });

  it("an instrumented provider is in flight while it runs and leaves the registry when it throws", async () => {
    let seen = -1;
    const provider = {
      name: "openai",
      async chatCompletion() {
        seen = listInFlight().length;
        throw new Error("boom");
      },
    } as unknown as ChatLlmProvider;
    instrumentProvider(provider);
    await expect(provider.chatCompletion([{ role: "user", content: "hi" }], { model: "gpt-x", caller: "unit" })).rejects.toThrow("boom");
    expect(seen).toBe(1);
    expect(listInFlight()).toHaveLength(0);
  });
});

describe("one call is counted once, by the outermost layer", () => {
  it("a tracked call nested in another is not registered again", async () => {
    let inner = -1;
    await trackLlmCall({ slug: "openai", model: "a", caller: "outer" }, async () => {
      await trackLlmCall({ slug: "openai", model: "a", caller: "inner" }, async () => {
        const end = beginLlmCall({ slug: "openai", model: "a" });
        inner = listInFlight().length;
        end();
      });
    });
    expect(inner).toBe(1);
    expect(listInFlight()).toHaveLength(0);
  });

  it("parallel calls each count", async () => {
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = () => trackLlmCall({ slug: "grok" }, async () => { peak = Math.max(peak, listInFlight().length); await gate; });
    const both = Promise.all([run(), run()]);
    await Promise.resolve();
    release();
    await both;
    expect(peak).toBe(2);
    expect(listInFlight()).toHaveLength(0);
  });

  it("the llm() driver registers the link's slug and the model it tries", async () => {
    const realFetch = globalThis.fetch;
    let during: ReturnType<typeof listInFlight> = [];
    globalThis.fetch = (async () => {
      during = listInFlight();
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], model: "gpt-4o-mini" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const c = new LlmClient({ provider: "openai", apiKey: "sk-1", defaultModel: "gpt-4o-mini", maxRetries: 0 });
      await c.chat({ system: "S", user: "hi", caller: "test:driver" });
    } finally { globalThis.fetch = realFetch; }
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ slug: "openai", model: "gpt-4o-mini", caller: "test:driver" });
    expect(listInFlight()).toHaveLength(0);
  });

  it("the driver's Claude Code route through an instrumented adapter is still one call", async () => {
    const provider = {
      name: "claude_code",
      async chatCompletion() { return { content: "x", model: "sonnet", tokens_used: 1, seen: listInFlight().length }; },
    } as unknown as ChatLlmProvider;
    instrumentProvider(provider);
    const r = await trackLlmCall({ slug: "claude_code", model: "sonnet", caller: "outer" }, () =>
      provider.chatCompletion([{ role: "user", content: "hi" }], { caller: "llm-client" }));
    expect((r as unknown as { seen: number }).seen).toBe(1);
  });
});

describe("chain links carry their calls in flight", () => {
  const links = [
    { slug: "claude_code", model: "sonnet" },
    { slug: "openai", model: "" },
    { slug: "openai", model: "gpt-5" },
  ];

  it("matches by slug and model, normalising the legacy alias", () => {
    const out = attachInFlight(links, [
      { id: "1", slug: "claude-code", model: "sonnet", caller: "chat", startedAt: 10 },
      { id: "2", slug: "openai", model: "gpt-5", caller: "agent:x", startedAt: 20 },
    ]);
    expect(out[0]).toEqual([{ caller: "chat", startedAt: 10 }]);
    expect(out[1]).toEqual([]);
    expect(out[2]).toEqual([{ caller: "agent:x", startedAt: 20 }]);
  });

  it("a call on a model no link names lands on the slug's link with no model", () => {
    const out = attachInFlight(links, [
      { id: "1", slug: "openai", model: "gpt-4o-mini", startedAt: 5 },
      { id: "2", slug: "openai", model: undefined, caller: "x", startedAt: 6 },
    ]);
    expect(out[1].map((c) => c.startedAt)).toEqual([5, 6]);
    expect(out[2]).toEqual([]);
  });

  it("falls back to the first link of the slug when none is model-less, and drops other providers", () => {
    const out = attachInFlight([{ slug: "claude_code", model: "sonnet" }], [
      { id: "1", slug: "claude-code", model: "claude-opus-4", startedAt: 1 },
      { id: "2", slug: "nvidia", model: "x", startedAt: 2 },
    ]);
    expect(out[0]).toEqual([{ caller: undefined, startedAt: 1 }]);
  });

  it("a gpt-5 link does not take a gpt-5-mini call", () => {
    const out = attachInFlight([{ slug: "openai", model: "gpt-5" }, { slug: "openai", model: "gpt-5-mini" }], [
      { id: "1", slug: "openai", model: "gpt-5-mini", startedAt: 1 },
    ]);
    expect(out[0]).toEqual([]);
    expect(out[1]).toHaveLength(1);
  });

  it("a sonnet link takes claude-sonnet-5-5 calls and not claude-opus-5-5 ones", () => {
    const out = attachInFlight([{ slug: "claude_code", model: "sonnet" }, { slug: "claude_code", model: "opus" }], [
      { id: "1", slug: "claude-code", model: "claude-sonnet-5-5", startedAt: 1 },
      { id: "2", slug: "claude-code", model: "claude-opus-5-5", startedAt: 2 },
    ]);
    expect(out[0].map((c) => c.startedAt)).toEqual([1]);
    expect(out[1].map((c) => c.startedAt)).toEqual([2]);
  });

  it("an exact link wins over the family alias", () => {
    const out = attachInFlight([{ slug: "claude-code", model: "sonnet" }, { slug: "claude-code", model: "claude-sonnet-5-5" }], [
      { id: "1", slug: "claude-code", model: "claude-sonnet-5-5", startedAt: 1 },
    ]);
    expect(out[0]).toEqual([]);
    expect(out[1]).toHaveLength(1);
  });

  it("the alias rule is the one claude-limits uses", () => {
    expect(claudeModelMatches("sonnet", "claude-sonnet-5-5")).toBe(true);
    expect(claudeModelMatches("sonnet", "sonnet")).toBe(true);
    expect(claudeModelMatches("sonnet", "claude-opus-5-5")).toBe(false);
    expect(claudeModelMatches("gpt-5", "gpt-5-mini")).toBe(false);
    expect(claudeModelMatches("claude-sonnet", "claude-sonnet-5-5")).toBe(false);
  });

  it("the chain lists the oldest call first", () => {
    const out = attachInFlight([{ slug: "grok", model: "" }], [
      { id: "b", slug: "grok", model: "a", startedAt: 30 },
      { id: "a", slug: "grok", model: "a", startedAt: 10 },
    ]);
    expect(out[0].map((c) => c.startedAt)).toEqual([10, 30]);
  });
});
