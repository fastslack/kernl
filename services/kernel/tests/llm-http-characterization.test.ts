/**
 * Characterization tests for the two LLM HTTP paths.
 *
 *   - `LlmClient` (the `llm()` driver): OpenAI-compatible + Anthropic REST,
 *     the Claude Code SDK routing, intra-link retry, the health-ordered
 *     fallback chain, provider-health and call-log accounting.
 *   - The `ChatLlmProvider` adapters (chat + agents): OpenAI-compatible,
 *     Claude, LM Studio Responses, their 429 backoff and quota marking.
 *
 * They pin the exact wire format (URL, method, headers, body string — key
 * order included) and the retry/fallback decisions, so refactors of the LLM
 * layer can be checked for "no behaviour change visible to callers".
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { LlmClient, resetClaudeCodeSdkCache } from "../src/core/llm/client.js";
import {
  ChatClaudeProvider,
  ChatOpenAiProvider,
  ChatLmStudioProvider,
  clearProviderExhausted,
  initProviderStatus,
  isProviderExhausted,
} from "../src/core/llm/chat-adapters.js";
import { ChatClaudeCodeProvider } from "../src/core/llm/claude-code-adapter.js";
import * as providerHealth from "../src/core/llm/provider-health.js";
import * as callLog from "../src/core/llm/call-log.js";
import { setCredentialSource } from "../src/core/llm/credentials.js";

// ── Harness ──────────────────────────────────────────────────────────────

type Seen = { url: string; method: string; headers: Record<string, string>; body: string; hasSignal: boolean };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realRandom = Math.random;
const proto = ChatClaudeCodeProvider.prototype as unknown as {
  available: () => boolean;
  chatCompletion: (...a: unknown[]) => Promise<unknown>;
};
const realAvailable = proto.available;
const realSdkChat = proto.chatCompletion;

/** Stub fetch with a queue of replies (the last one repeats). */
function stubFetch(replies: Reply[]): Seen[] {
  const seen: Seen[] = [];
  let i = 0;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    seen.push({
      url: String(url),
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: String(init.body),
      hasSignal: !!init.signal,
    });
    const r = replies[Math.min(i++, replies.length - 1)];
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as unknown as typeof fetch;
  return seen;
}

/** Short sleeps (backoff) run immediately; their requested delay is recorded.
 *  Long timers (request timeouts) keep their real delay. */
let delays: number[] = [];
function fastTimers(): void {
  delays = [];
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (typeof ms === "number" && ms > 0 && ms <= 20_000) {
      delays.push(ms);
      return realSetTimeout(fn, 0, ...args);
    }
    return realSetTimeout(fn, ms, ...args);
  }) as unknown as typeof setTimeout;
}

let db: Database;
function callRows(): Array<Record<string, unknown>> {
  return db.prepare("SELECT slug, model, ok, input_tokens, output_tokens, error_kind, error_msg, caller FROM llm_call_log ORDER BY id").all() as Array<Record<string, unknown>>;
}

beforeEach(() => {
  setCredentialSource({ loadConfig: () => ({}), saveConfig: () => true });
  // The dev machine may have a `claude` binary on PATH — keep the SDK out
  // unless a test opts in.
  proto.available = () => false;
  resetClaudeCodeSdkCache();
  providerHealth._resetForTests();
  // Point quota persistence at a live DB: another suite may have left it on a
  // closed one, and markProviderExhausted writes through it.
  initProviderStatus(new Database(":memory:") as unknown as never);
  clearProviderExhausted();
  db = new Database(":memory:");
  callLog.attachDb(db as unknown as never);
  // Jitter factor = 0.85 + 0.5 * 0.3 = 1.0 exactly.
  Math.random = () => 0.5;
  fastTimers();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  Math.random = realRandom;
  proto.available = realAvailable;
  proto.chatCompletion = realSdkChat;
  resetClaudeCodeSdkCache();
  (globalThis as { __mtwLlmCallLogDb?: unknown }).__mtwLlmCallLogDb = null;
  providerHealth._resetForTests();
  clearProviderExhausted();
  setCredentialSource(null);
});

const okOpenAi = { body: { choices: [{ message: { content: "<think>hm</think>answer" } }], model: "gpt-4o-mini-2024", usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } } };
const okAnthropic = { body: { content: [{ type: "thinking", text: "x" }, { type: "text", text: "first" }, { type: "text", text: "second" }], model: "claude-x", usage: { input_tokens: 9, output_tokens: 4 } } };

// ── LlmClient: wire format ───────────────────────────────────────────────

describe("LlmClient OpenAI-compatible request", () => {
  it("sends the exact default OpenAI request and maps usage", async () => {
    const seen = stubFetch([okOpenAi]);
    const c = new LlmClient({ provider: "openai", apiKey: "sk-1", defaultModel: "gpt-4o-mini", maxRetries: 0 });
    const r = await c.chat({ system: "SYS", user: "hi", caller: "test:openai" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers).toEqual({ Authorization: "Bearer sk-1", "Content-Type": "application/json" });
    expect(Object.keys(seen[0].headers)).toEqual(["Authorization", "Content-Type"]);
    expect(seen[0].body).toBe(JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }],
      max_tokens: 2048,
    }));
    expect(seen[0].hasSignal).toBe(true);
    expect(r).toEqual({ text: "answer", model: "gpt-4o-mini-2024", provider: "openai", inputTokens: 11, outputTokens: 5 });
    expect(callRows()).toEqual([{ slug: "openai", model: "gpt-4o-mini-2024", ok: 1, input_tokens: 11, output_tokens: 5, error_kind: null, error_msg: null, caller: "test:openai" }]);
    expect(providerHealth.getHealth("openai").failures).toBe(0);
    expect(providerHealth.getHealth("openai").ewmaMs).toBeDefined();
  });

  it("vision + json + temperature + custom base URL + per-model quirks", async () => {
    const seen = stubFetch([okOpenAi]);
    const c = new LlmClient({
      provider: "custom", slug: "nvidia", apiKey: "nv", maxRetries: 0,
      baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
      defaultModel: "nvidia/nemotron-3-super-120b-a12b",
    });
    await c.chat({ user: "look", json: true, maxTokens: 99, imageBase64: "AAAA", imageMediaType: "image/png", caller: "chain-probe" });
    expect(seen[0].url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(seen[0].body).toBe(JSON.stringify({
      model: "nvidia/nemotron-3-super-120b-a12b",
      messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ] }],
      max_tokens: 99,
      response_format: { type: "json_object" },
      temperature: 1,
      top_p: 0.95,
      chat_template_kwargs: { force_nonempty_content: true },
    }));
  });

  it("caller temperature beats the quirk; model override wins over the default", async () => {
    const seen = stubFetch([okOpenAi]);
    const c = new LlmClient({ provider: "custom", slug: "nvidia", apiKey: "nv", baseUrl: "https://x.test/v1/chat/completions", defaultModel: "nvidia/nemotron-3-super-120b-a12b", maxRetries: 0 });
    await c.chat({ user: "u", temperature: 0.1, model: "nvidia/nemotron-3-super-120b-a12b" });
    const body = JSON.parse(seen[0].body);
    expect(body.temperature).toBe(0.1);
    expect(body.top_p).toBe(0.95);
  });

  it("maps an HTTP error to `LLM OpenAI <status>: <body>` and records the failure", async () => {
    stubFetch([{ status: 404, body: "no such thing" }]);
    const c = new LlmClient({ provider: "openai", apiKey: "k", defaultModel: "m", maxRetries: 0 });
    await expect(c.chat({ user: "u", caller: "t" })).rejects.toThrow("LLM OpenAI 404: no such thing");
    const rows = callRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: "openai", model: "m", ok: 0, error_kind: "transient", error_msg: "LLM OpenAI 404: no such thing", caller: "t" });
    expect(providerHealth.getHealth("openai").failures).toBe(1);
  });
});

describe("LlmClient Anthropic REST request", () => {
  it("sends the exact Anthropic request and maps the first text block + usage", async () => {
    const seen = stubFetch([okAnthropic]);
    const c = new LlmClient({ provider: "anthropic", apiKey: "sk-ant", defaultModel: "claude-haiku-4-5-20251001", maxRetries: 0 });
    const r = await c.chat({ system: "SYS", user: "hi", temperature: 0.3, caller: "test:anth" });
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers).toEqual({ "x-api-key": "sk-ant", "anthropic-version": "2023-06-01", "Content-Type": "application/json" });
    expect(seen[0].body).toBe(JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: "hi" }],
      system: "SYS",
      temperature: 0.3,
    }));
    expect(r).toEqual({ text: "first", model: "claude-x", provider: "anthropic", inputTokens: 9, outputTokens: 4 });
    expect(callRows()[0]).toMatchObject({ slug: "anthropic", model: "claude-x", ok: 1, input_tokens: 9, output_tokens: 4, caller: "test:anth" });
  });

  it("vision puts the image block before the text; baseUrl override is honoured", async () => {
    const seen = stubFetch([okAnthropic]);
    const c = new LlmClient({ provider: "anthropic", apiKey: "k", baseUrl: "https://proxy.test/v1/messages", defaultModel: "claude-x", maxRetries: 0 });
    await c.chat({ user: "what", imageBase64: "BBBB", imageMediaType: "image/jpeg" });
    expect(seen[0].url).toBe("https://proxy.test/v1/messages");
    expect(seen[0].body).toBe(JSON.stringify({
      model: "claude-x",
      max_tokens: 2048,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
        { type: "text", text: "what" },
      ] }],
    }));
  });

  it("maps an HTTP error to `LLM Anthropic <status>: <body>`", async () => {
    stubFetch([{ status: 400, body: "invalid request: bad" }]);
    const c = new LlmClient({ provider: "anthropic", apiKey: "k", defaultModel: "claude-x", maxRetries: 0 });
    await expect(c.chat({ user: "u" })).rejects.toThrow("LLM Anthropic 400: invalid request: bad");
  });
});

describe("LlmClient Claude Code SDK routing", () => {
  it("routes anthropic links through the SDK with caller tag llm-client and a Claude-ish model", async () => {
    proto.available = () => true;
    resetClaudeCodeSdkCache();
    const calls: unknown[][] = [];
    proto.chatCompletion = async (...a: unknown[]) => {
      calls.push(a);
      return { content: "sdk says", model: "sonnet", tokens_used: 42 };
    };
    const seen = stubFetch([okAnthropic]);
    const c = new LlmClient({ provider: "anthropic", slug: "claude-code", apiKey: "", defaultModel: "gpt-4o-mini", maxRetries: 0 });
    const r = await c.chat({ system: "S", user: "U", maxTokens: 10, temperature: 0.2, caller: "chain-probe" });
    expect(seen).toHaveLength(0);
    expect(calls).toEqual([[
      [{ role: "user", content: "U" }],
      { model: "sonnet", system: "S", max_tokens: 10, temperature: 0.2, caller: "llm-client" },
    ]]);
    expect(r).toEqual({ text: "sdk says", model: "sonnet", provider: "anthropic", outputTokens: 42 });
  });

  it("a logged-out SDK falls through to the REST API when the link has a key", async () => {
    proto.available = () => true;
    resetClaudeCodeSdkCache();
    proto.chatCompletion = async () => { throw new Error("Not logged in · Please run /login"); };
    const seen = stubFetch([okAnthropic]);
    const c = new LlmClient({ provider: "anthropic", apiKey: "sk-ant", defaultModel: "claude-x", maxRetries: 0 });
    const r = await c.chat({ user: "U", caller: "chain-probe" });
    expect(seen).toHaveLength(1);
    expect(r.text).toBe("first");
  });

  it("a logged-out SDK without a key raises a chainable 401", async () => {
    proto.available = () => true;
    resetClaudeCodeSdkCache();
    proto.chatCompletion = async () => { throw new Error("Not logged in"); };
    stubFetch([okOpenAi]);
    const c = new LlmClient({
      provider: "anthropic", slug: "claude-code", apiKey: "", defaultModel: "sonnet", maxRetries: 0,
      fallbackChain: [{ provider: "openai", apiKey: "k", defaultModel: "gpt-4o-mini", maxRetries: 0 }],
    });
    const r = await c.chat({ user: "U", caller: "chain-probe" });
    expect(r.provider).toBe("openai");
  });
});

// ── LlmClient: intra-link retry ──────────────────────────────────────────

describe("LlmClient retry within a link", () => {
  const onlyBackoff = () => delays.filter((d) => d !== 60_000);

  it("429 on the LAST link retries in place honouring Retry-After seconds", async () => {
    const seen = stubFetch([{ status: 429, body: "slow down", headers: { "retry-after": "3" } }, okOpenAi]);
    const c = new LlmClient({ provider: "openai", apiKey: "k", defaultModel: "m", maxRetries: 1 });
    const r = await c.chat({ user: "u" });
    expect(seen).toHaveLength(2);
    expect(onlyBackoff()).toEqual([3000]);
    expect(r.text).toBe("answer");
  });

  it("429 without hints backs off 2s × 2^attempt", async () => {
    const seen = stubFetch([{ status: 429, body: "x" }, { status: 429, body: "x" }, okOpenAi]);
    const c = new LlmClient({ provider: "openai", apiKey: "k", defaultModel: "m", maxRetries: 2 });
    await c.chat({ user: "u" });
    expect(seen).toHaveLength(3);
    expect(onlyBackoff()).toEqual([2000, 4000]);
  });

  it("Retry-After as an HTTP date, anthropic reset and x-ratelimit reset headers are honoured", async () => {
    const now = Date.now();
    const cases: Array<[Record<string, string>, (d: number) => boolean]> = [
      [{ "retry-after": new Date(now + 5000).toUTCString() }, (d) => d > 3000 && d <= 5000],
      [{ "anthropic-ratelimit-requests-reset": new Date(now + 4000).toISOString() }, (d) => d > 2500 && d <= 4000],
      [{ "x-ratelimit-reset-requests": "6s" }, (d) => d === 6000],
      // "750ms" is 750 milliseconds (it used to be read as 750 minutes and
      // land on the cap).
      [{ "x-ratelimit-reset-requests": "750ms" }, (d) => d === 750],
      [{ "x-ratelimit-reset-requests": "12.5s" }, (d) => d === 12_500],
      [{ "x-ratelimit-reset-tokens": "1m30s" }, (d) => d === 15_000], // capped at RATE_LIMIT_MAX_WAIT_MS
    ];
    for (const [headers, check] of cases) {
      delays = [];
      stubFetch([{ status: 429, body: "x", headers }, okOpenAi]);
      const c = new LlmClient({ provider: "openai", apiKey: "k", defaultModel: "m", maxRetries: 1 });
      await c.chat({ user: "u" });
      const b = onlyBackoff();
      expect(b).toHaveLength(1);
      expect(check(b[0])).toBe(true);
    }
  });

  it("5xx (503 / Anthropic 529) retries in place with a linear 1s step", async () => {
    const seen = stubFetch([{ status: 503, body: "busy" }, okOpenAi]);
    const c = new LlmClient({ provider: "openai", apiKey: "k", defaultModel: "m", maxRetries: 1 });
    await c.chat({ user: "u" });
    expect(seen).toHaveLength(2);
    expect(onlyBackoff()).toEqual([1000]);

    delays = [];
    const seen2 = stubFetch([{ status: 529, body: "overloaded", headers: { "retry-after": "9" } }, { status: 529, body: "overloaded" }, okAnthropic]);
    const a = new LlmClient({ provider: "anthropic", apiKey: "k", defaultModel: "claude-x", maxRetries: 2 });
    await a.chat({ user: "u" });
    expect(seen2).toHaveLength(3);
    expect(onlyBackoff()).toEqual([1000, 2000]);
  });

  it("429 with a fallback available fails over immediately and records retryAfter in health", async () => {
    const seen = stubFetch([{ status: 429, body: "rate limited", headers: { "retry-after": "20" } }, okAnthropic]);
    const c = new LlmClient({
      provider: "openai", apiKey: "k", defaultModel: "m", maxRetries: 3,
      fallbackChain: [{ provider: "anthropic", apiKey: "a", defaultModel: "claude-x", maxRetries: 0 }],
    });
    const r = await c.chat({ user: "u", caller: "t" });
    expect(seen.map((s) => s.url)).toEqual(["https://api.openai.com/v1/chat/completions", "https://api.anthropic.com/v1/messages"]);
    expect(onlyBackoff()).toEqual([]);
    expect(r.provider).toBe("anthropic");
    const h = providerHealth.getHealth("openai");
    expect(h.lastFailureKind).toBe("rate-limit");
    expect(h.blocked).toBe(true);
    expect(h.blockedFor!).toBeGreaterThan(19_000);
    expect(h.blockedFor!).toBeLessThanOrEqual(20_250);
    expect(callRows().map((r) => [r.slug, r.ok, r.error_kind])).toEqual([["openai", 0, "rate-limit"], ["anthropic", 1, null]]);
  });

  it("exhausted retries surface the last error", async () => {
    const seen = stubFetch([{ status: 500, body: "boom" }]);
    const c = new LlmClient({ provider: "openai", apiKey: "k", defaultModel: "m", maxRetries: 1 });
    await expect(c.chat({ user: "u" })).rejects.toThrow("LLM OpenAI 500: boom");
    expect(seen).toHaveLength(2);
  });
});

// ── LlmClient: fallback chain ────────────────────────────────────────────

describe("LlmClient fallback chain", () => {
  const link = (slug: string, extra: Record<string, unknown> = {}) => ({
    provider: "custom" as const, slug, apiKey: "k", baseUrl: `https://${slug}.test/v1/chat/completions`, defaultModel: `${slug}-m`, maxRetries: 0, ...extra,
  });

  it("walks links in configured order while healthy and skips links without credentials", async () => {
    const seen = stubFetch([{ status: 500, body: "a down" }, { status: 401, body: "unauthorized" }, okOpenAi]);
    const c = new LlmClient({ ...link("a"), fallbackChain: [link("b"), { provider: "openai", apiKey: "", defaultModel: "x" }, link("c")] });
    const r = await c.chat({ user: "u" });
    expect(seen.map((s) => s.url)).toEqual(["https://a.test/v1/chat/completions", "https://b.test/v1/chat/completions", "https://c.test/v1/chat/completions"]);
    expect(r.model).toBe("gpt-4o-mini-2024");
  });

  it("a 400 validation error is fatal — no fallback", async () => {
    const seen = stubFetch([{ status: 400, body: "invalid schema" }, okOpenAi]);
    const c = new LlmClient({ ...link("a"), fallbackChain: [link("b")] });
    await expect(c.chat({ user: "u" })).rejects.toThrow("LLM OpenAI 400: invalid schema");
    expect(seen).toHaveLength(1);
  });

  it("a non-chainable error (e.g. 418) stops the chain", async () => {
    const seen = stubFetch([{ status: 418, body: "teapot" }, okOpenAi]);
    const c = new LlmClient({ ...link("a"), fallbackChain: [link("b")] });
    await expect(c.chat({ user: "u" })).rejects.toThrow("LLM OpenAI 418: teapot");
    expect(seen).toHaveLength(1);
  });

  it("all links failing surfaces the LAST link's error", async () => {
    stubFetch([{ status: 500, body: "first" }, { status: 502, body: "second" }]);
    const c = new LlmClient({ ...link("a"), fallbackChain: [link("b")] });
    await expect(c.chat({ user: "u" })).rejects.toThrow("LLM OpenAI 502: second");
  });

  it("no usable link at all → `LLM: all chain links exhausted`", async () => {
    stubFetch([okOpenAi]);
    const c = new LlmClient({ provider: "openai", apiKey: "", defaultModel: "m" });
    await expect(c.chat({ user: "u" })).rejects.toThrow("LLM: all chain links exhausted");
  });

  it("health ordering: a blocked primary drops to the tail; faster healthy links go first", async () => {
    providerHealth.recordFailure("a", "transient"); // blocked
    providerHealth.recordSuccess("c", 100);
    providerHealth.recordSuccess("b", 900);
    const seen = stubFetch([{ status: 500, body: "x" }]);
    const c = new LlmClient({ ...link("a"), fallbackChain: [link("b"), link("c")] });
    await expect(c.chat({ user: "u" })).rejects.toThrow();
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["c.test", "b.test", "a.test"]);
  });

  it("duplicate slugs are each tried once, in order", async () => {
    const seen = stubFetch([{ status: 500, body: "x" }]);
    const c = new LlmClient({ ...link("a"), fallbackChain: [link("a", { defaultModel: "a-m2" }), link("b")] });
    await expect(c.chat({ user: "u" })).rejects.toThrow();
    expect(seen.map((s) => JSON.parse(s.body).model)).toEqual(["a-m", "a-m2", "b-m"]);
  });
});

// ── Adapters: wire format ────────────────────────────────────────────────

const tools = [{ name: "t1", description: "d1", input_schema: { type: "object", properties: { a: { type: "string" } } } }];

describe("ChatOpenAiProvider request", () => {
  it("sends the exact chat/completions request with tools and quirks", async () => {
    const seen = stubFetch([{ body: { choices: [{ message: { content: "<think>z</think>hi", tool_calls: [{ id: "c1", function: { name: "t1", arguments: "{\"a\":\"b\"}" } }] } }], model: "mm", usage: { total_tokens: 30, prompt_tokens: 20, completion_tokens: 10 } } }]);
    const p = new ChatOpenAiProvider("key", "https://integrate.api.nvidia.com/v1/", "nvidia/nemotron-3-super-120b-a12b", "nvidia");
    const r = await p.chatCompletion(
      [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "text", text: "calling" }, { type: "tool_use", id: "c0", name: "t1", input: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c0", content: "res", is_error: true }] },
      ],
      { system: "SYS", tools: tools as never, max_tokens: 50 },
    );
    expect(seen[0].url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer key" });
    expect(seen[0].hasSignal).toBe(true);
    expect(seen[0].body).toBe(JSON.stringify({
      model: "nvidia/nemotron-3-super-120b-a12b",
      max_tokens: 50,
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "q" },
        { role: "assistant", content: "calling", tool_calls: [{ id: "c0", type: "function", function: { name: "t1", arguments: "{\"a\":1}" } }] },
        { role: "tool", tool_call_id: "c0", content: "ERROR: res" },
      ],
      temperature: 1,
      top_p: 0.95,
      chat_template_kwargs: { force_nonempty_content: true },
      tools: [{ type: "function", function: { name: "t1", description: "d1", parameters: tools[0].input_schema } }],
      parallel_tool_calls: false,
    }));
    expect(r).toEqual({
      content: "hi", model: "mm", tokens_used: 30, input_tokens: 20, output_tokens: 10,
      tool_calls: [{ type: "tool_use", id: "c1", name: "t1", input: { a: "b" } }],
    });
  });

  it("errors as `<name> API error <status>: <body>`; 402 / 429 / quota mark the provider exhausted", async () => {
    stubFetch([{ status: 402, body: "pay up" }]);
    const p = new ChatOpenAiProvider("key", "https://api.openai.com/v1", "gpt-4o-mini", "openai");
    await expect(p.chatCompletion([{ role: "user", content: "q" }])).rejects.toThrow("openai API error 402: pay up");
    expect(isProviderExhausted("openai")).toBe(true);

    stubFetch([{ status: 500, body: "insufficient_quota" }]);
    const g = new ChatOpenAiProvider("key", "https://api.x.ai/v1", "grok", "grok");
    await expect(g.chatCompletion([{ role: "user", content: "q" }])).rejects.toThrow("grok API error 500: insufficient_quota");
    expect(isProviderExhausted("grok")).toBe(true);

    stubFetch([{ status: 500, body: "plain" }]);
    const n = new ChatOpenAiProvider("key", "https://n.test/v1", "m", "nvidia");
    await expect(n.chatCompletion([{ role: "user", content: "q" }])).rejects.toThrow("nvidia API error 500: plain");
    expect(isProviderExhausted("nvidia")).toBe(false);
  });
});

describe("ChatClaudeProvider request", () => {
  it("sends the exact messages request with tools; joins text blocks and sums usage", async () => {
    const seen = stubFetch([{ body: { content: [{ type: "text", text: "a" }, { type: "tool_use", id: "u1", name: "t1", input: { x: 1 } }, { type: "text", text: "b" }], model: "cm", usage: { input_tokens: 3, output_tokens: 4 }, stop_reason: "tool_use" } }]);
    const p = new ChatClaudeProvider("sk-ant");
    const r = await p.chatCompletion(
      [{ role: "system", content: "S1" }, { role: "user", content: "hello" }],
      { tools: tools as never, temperature: 0 },
    );
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0].headers).toEqual({ "Content-Type": "application/json", "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" });
    expect(seen[0].body).toBe(JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: "S1",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0,
      tools,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    }));
    expect(r).toEqual({ content: "ab", model: "cm", tokens_used: 7, tool_calls: [{ type: "tool_use", id: "u1", name: "t1", input: { x: 1 } }], stop_reason: "tool_use" });
  });

  it("errors as `Claude API error <status>: <body>`; credit balance marks exhausted", async () => {
    stubFetch([{ status: 400, body: "Your credit balance is too low" }]);
    const p = new ChatClaudeProvider("k");
    await expect(p.chatCompletion([{ role: "user", content: "q" }])).rejects.toThrow("Claude API error 400: Your credit balance is too low");
    expect(isProviderExhausted("claude")).toBe(true);
  });
});

describe("ChatLmStudioProvider request (Responses API)", () => {
  it("sends the exact /responses request", async () => {
    const seen = stubFetch([{ body: { output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "yo" }] }, { type: "function_call", call_id: "f1", name: "t1", arguments: "{}" }], model: "qwen", status: "completed", usage: { total_tokens: 12 } } }]);
    const p = new ChatLmStudioProvider("http://localhost:1234/v1/", "qwen");
    const r = await p.chatCompletion(
      [
        { role: "system", content: "INSTR" },
        { role: "user", content: [{ type: "text", text: "see" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QQ" } }] },
        { role: "assistant", content: [{ type: "tool_use", id: "f0", name: "t1", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "f0", content: "done" }] },
      ],
      { tools: tools as never },
    );
    expect(seen[0].url).toBe("http://localhost:1234/v1/responses");
    expect(seen[0].headers).toEqual({ "Content-Type": "application/json" });
    expect(seen[0].body).toBe(JSON.stringify({
      model: "qwen",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: "data:image/png;base64,QQ" }] },
        { type: "function_call", call_id: "f0", name: "t1", arguments: "{}" },
        { type: "function_call_output", call_id: "f0", output: "done" },
      ],
      max_output_tokens: 4096,
      instructions: "INSTR",
      tools: [{ type: "function", name: "t1", description: "d1", parameters: tools[0].input_schema }],
      parallel_tool_calls: false,
      tool_choice: "auto",
    }));
    expect(r).toEqual({ content: "yo", model: "qwen", tokens_used: 12, tool_calls: [{ type: "tool_use", id: "f1", name: "t1", input: {} }], stop_reason: "completed" });
  });

  it("truncates long input and retries a context overflow with shrunk input and no tools", async () => {
    const seen = stubFetch([{ status: 400, body: "n_keep exceeds context" }, { body: { output: [] } }]);
    const p = new ChatLmStudioProvider("http://localhost:1234/v1", "qwen");
    const big = "x".repeat(30_000);
    await p.chatCompletion([{ role: "user", content: "short" }, { role: "assistant", content: big }], { system: "s".repeat(20_000), tools: tools as never });
    expect(seen).toHaveLength(2);
    const b1 = JSON.parse(seen[0].body);
    expect(b1.instructions).toBe("s".repeat(14_400) + "\n[system prompt truncated]");
    expect(b1.input[1].content[0].text.length).toBe(24_000 - (14_400 + 26) - 5 + "\n[truncated]".length);
    const b2 = JSON.parse(seen[1].body);
    expect(b2.tools).toBeUndefined();
    expect(b2.input[1].content[0].text.length).toBe(1500);
  });

  it("errors as `LMStudio API error <status>: <body>`", async () => {
    stubFetch([{ status: 500, body: "crash" }]);
    const p = new ChatLmStudioProvider("http://localhost:1234/v1", "qwen");
    await expect(p.chatCompletion([{ role: "user", content: "q" }])).rejects.toThrow("LMStudio API error 500: crash");
  });
});

// ── Adapters: 429 backoff ────────────────────────────────────────────────

describe("adapter 429 backoff", () => {
  it("retries a 429 honouring numeric Retry-After and reports each wait", async () => {
    const seen = stubFetch([{ status: 429, body: "x", headers: { "retry-after": "2" } }, { body: { choices: [{ message: { content: "ok" } }] } }]);
    const waits: Array<[number, number]> = [];
    const p = new ChatOpenAiProvider("k", "https://o.test/v1", "m", "openai");
    const r = await p.chatCompletion([{ role: "user", content: "q" }], { onRateLimitWait: (ms, a) => waits.push([ms, a]) });
    expect(seen).toHaveLength(2);
    expect(seen[1].body).toBe(seen[0].body);
    expect(waits).toEqual([[2000, 1]]);
    expect(delays).toEqual([2000]);
    expect(r.content).toBe("ok");
    expect(isProviderExhausted("openai")).toBe(false);
  });

  it("without Retry-After waits 2s then 4s, gives up after 3 attempts and marks exhausted", async () => {
    const seen = stubFetch([{ status: 429, body: "limit" }]);
    const waits: number[] = [];
    const p = new ChatClaudeProvider("k");
    await expect(p.chatCompletion([{ role: "user", content: "q" }], { onRateLimitWait: (ms) => waits.push(ms) })).rejects.toThrow("Claude API error 429: limit");
    expect(seen).toHaveLength(3);
    expect(waits).toEqual([2000, 4000]);
    expect(delays).toEqual([2000, 4000]);
    expect(isProviderExhausted("claude")).toBe(true);
  });

  it("Retry-After: 0 retries immediately", async () => {
    const seen = stubFetch([{ status: 429, body: "x", headers: { "retry-after": "0" } }, { body: { output: [] } }]);
    const p = new ChatLmStudioProvider("http://localhost:1234/v1", "qwen");
    await p.chatCompletion([{ role: "user", content: "q" }]);
    expect(seen).toHaveLength(2);
  });

  it("503 and 529 are NOT retried in place by the adapters", async () => {
    const seen = stubFetch([{ status: 503, body: "busy", headers: { "retry-after": "1" } }]);
    const p = new ChatOpenAiProvider("k", "https://o.test/v1", "m", "openai");
    await expect(p.chatCompletion([{ role: "user", content: "q" }])).rejects.toThrow("openai API error 503: busy");
    expect(seen).toHaveLength(1);

    const seen2 = stubFetch([{ status: 529, body: "overloaded", headers: { "retry-after": "1" } }]);
    const c = new ChatClaudeProvider("k");
    await expect(c.chatCompletion([{ role: "user", content: "q" }])).rejects.toThrow("Claude API error 529: overloaded");
    expect(seen2).toHaveLength(1);
    expect(delays).toEqual([]);
  });
});
