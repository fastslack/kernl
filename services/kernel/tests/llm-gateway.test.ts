/**
 * llm() hands the HTTP leg of a call to mtwRequest (mtw-ai `llm.complete`)
 * and keeps every decision: the request it sends, the errors it raises, the
 * retries and failover, the call log. With no broker, a broker without the
 * tool, or LLM_GATEWAY=off, it calls the provider itself.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { LlmClient, resetClaudeCodeSdkCache } from "../src/core/llm/client.js";
import { setLlmGateway, type LlmGatewayTransport } from "../src/core/llm/gateway.js";
import { ChatClaudeCodeProvider } from "../src/core/llm/claude-code-adapter.js";
import * as providerHealth from "../src/core/llm/provider-health.js";
import * as callLog from "../src/core/llm/call-log.js";
import { setCredentialSource } from "../src/core/llm/credentials.js";

class FakeBroker implements LlmGatewayTransport {
  connected = true;
  calls: Array<{ tool: string; args: Record<string, any>; timeoutMs?: number }> = [];
  constructor(private replies: Array<unknown | Error>) {}
  isConnected() { return this.connected; }
  async call(tool: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }) {
    this.calls.push({ tool, args: args as Record<string, any>, timeoutMs: opts?.timeoutMs });
    const r = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  }
}

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realRandom = Math.random;
const proto = ChatClaudeCodeProvider.prototype as unknown as { available: () => boolean };
const realAvailable = proto.available;
let fetched: string[] = [];
let delays: number[] = [];
let db: Database;

function stubFetch(): void {
  fetched = [];
  globalThis.fetch = (async (url: unknown) => {
    fetched.push(String(url));
    return new Response(JSON.stringify({ choices: [{ message: { content: "from fetch" } }], model: "m", usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
}

const rows = () => db.prepare("SELECT slug, model, ok, input_tokens, output_tokens, error_kind, caller FROM llm_call_log ORDER BY id").all();
const okReply = (text = "<think>hm</think>answer", usage: Record<string, number> = { input_tokens: 11, output_tokens: 5 }) =>
  ({ ok: true, text, model: "gpt-4o-mini-2024", usage });

beforeEach(() => {
  setCredentialSource({ loadConfig: () => ({}), saveConfig: () => true });
  proto.available = () => false;
  resetClaudeCodeSdkCache();
  providerHealth._resetForTests();
  db = new Database(":memory:");
  callLog.attachDb(db as unknown as never);
  Math.random = () => 0.5; // jitter factor exactly 1
  delays = [];
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (typeof ms === "number" && ms > 0 && ms <= 20_000) { delays.push(ms); return realSetTimeout(fn, 0, ...args); }
    return realSetTimeout(fn, ms, ...args);
  }) as unknown as typeof setTimeout;
  stubFetch();
  delete process.env.LLM_GATEWAY;
});

afterEach(() => {
  setLlmGateway(null);
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  Math.random = realRandom;
  proto.available = realAvailable;
  resetClaudeCodeSdkCache();
  (globalThis as { __mtwLlmCallLogDb?: unknown }).__mtwLlmCallLogDb = null;
  providerHealth._resetForTests();
  setCredentialSource(null);
  delete process.env.LLM_GATEWAY;
});

const openai = (extra: Record<string, unknown> = {}) =>
  new LlmClient({ provider: "openai", apiKey: "sk-1", defaultModel: "gpt-4o-mini", maxRetries: 0, ...extra } as never);

describe("llm() through mtwRequest", () => {
  it("sends the link, the key and the body fields it built, and maps the answer", async () => {
    const broker = new FakeBroker([okReply()]);
    setLlmGateway(broker);
    const r = await openai().chat({ system: "SYS", user: "hi", caller: "test:gw" });
    expect(fetched).toEqual([]);
    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0].tool).toBe("llm.complete");
    expect(broker.calls[0].args).toEqual({
      wire: "openai",
      url: "https://api.openai.com/v1/chat/completions",
      api_key: "sk-1",
      model: "gpt-4o-mini",
      system: "SYS",
      user: "hi",
      // Quirks and parameter names are still decided here.
      params: { max_completion_tokens: 2048 },
      timeout_ms: 60_000,
    });
    expect(broker.calls[0].timeoutMs).toBe(65_000);
    expect(r).toEqual({ text: "answer", model: "gpt-4o-mini-2024", provider: "openai", inputTokens: 11, outputTokens: 5 });
    expect(rows()).toEqual([{ slug: "openai", model: "gpt-4o-mini-2024", ok: 1, input_tokens: 11, output_tokens: 5, error_kind: null, caller: "test:gw" }]);
  });

  it("carries images and the Anthropic cache counts", async () => {
    const broker = new FakeBroker([{ ok: true, text: "seen", model: "claude-x", usage: { input_tokens: 9, output_tokens: 4, cache_read_tokens: 7, cache_write_tokens: 2 } }]);
    setLlmGateway(broker);
    const c = new LlmClient({ provider: "anthropic", apiKey: "ak", defaultModel: "claude-x", maxRetries: 0 } as never);
    const r = await c.chat({ user: "look", system: "S", temperature: 0.2, imageBase64: "AAAA", imageMediaType: "image/png" });
    expect(broker.calls[0].args).toMatchObject({
      wire: "anthropic", api_key: "ak", model: "claude-x", system: "S", user: "look",
      image: { media_type: "image/png", data: "AAAA" },
      params: { max_tokens: 2048, temperature: 0.2 },
    });
    expect(r).toEqual({ text: "seen", model: "claude-x", provider: "anthropic", inputTokens: 9, outputTokens: 4, cacheReadTokens: 7, cacheWriteTokens: 2 });
  });

  it("a 429 on the last link waits for Retry-After and tries again", async () => {
    const broker = new FakeBroker([
      { ok: false, kind: "http", status: 429, message: "slow down", headers: { "retry-after": "7" } },
      okReply("ok"),
    ]);
    setLlmGateway(broker);
    const r = await openai({ maxRetries: 1 }).chat({ user: "u" });
    expect(r.text).toBe("ok");
    expect(broker.calls).toHaveLength(2);
    expect(delays).toContain(7000);
  });

  it("a provider error is raised as the driver's own and fails over to the next link", async () => {
    const broker = new FakeBroker([
      { ok: false, kind: "http", status: 401, message: "bad key" },
      okReply("second"),
    ]);
    setLlmGateway(broker);
    const c = openai({
      fallbackChain: [{ provider: "custom", slug: "groq", apiKey: "gk", baseUrl: "https://api.groq.com/openai/v1/chat/completions", defaultModel: "llama", maxRetries: 0 }],
    });
    const r = await c.chat({ user: "u", caller: "test:failover" });
    expect(r.text).toBe("second");
    expect(broker.calls.map((x) => x.args.url)).toEqual([
      "https://api.openai.com/v1/chat/completions",
      "https://api.groq.com/openai/v1/chat/completions",
    ]);
    const log = rows() as Array<{ slug: string; ok: number; error_kind: string | null }>;
    expect(log.map((x) => [x.slug, x.ok])).toEqual([["openai", 0], ["groq", 1]]);
    expect(log[0].error_kind).toBe(providerHealth.classifyError(new Error("LLM OpenAI 401: bad key")));
  });

  it("timeouts read like the driver's own", async () => {
    setLlmGateway(new FakeBroker([{ ok: false, kind: "timeout", message: "no response in 60000ms" }]));
    await expect(openai().chat({ user: "u" })).rejects.toThrow("LLM OpenAI timeout: no response in 60000ms");
  });

  it("a socket lost mid-call is a network error, retried like one", async () => {
    const broker = new FakeBroker([new Error("RustBridge: connection closed"), okReply("again")]);
    setLlmGateway(broker);
    const r = await openai({ maxRetries: 1 }).chat({ user: "u" });
    expect(r.text).toBe("again");
    expect(broker.calls).toHaveLength(2);
    expect(fetched).toEqual([]);
  });
});

describe("llm() without mtwRequest", () => {
  it("calls the provider itself when the bridge is down", async () => {
    const broker = new FakeBroker([okReply()]);
    broker.connected = false;
    setLlmGateway(broker);
    expect((await openai().chat({ user: "u" })).text).toBe("from fetch");
    expect(broker.calls).toHaveLength(0);
    expect(fetched).toEqual(["https://api.openai.com/v1/chat/completions"]);
  });

  it("calls the provider itself on a broker without llm.complete, and stops asking", async () => {
    const broker = new FakeBroker([new Error("tool not found: llm.complete")]);
    setLlmGateway(broker);
    expect((await openai().chat({ user: "u" })).text).toBe("from fetch");
    expect((await openai().chat({ user: "u" })).text).toBe("from fetch");
    expect(broker.calls).toHaveLength(1);
    expect(fetched).toHaveLength(2);
  });

  it("a bridge that drops before sending is not an error", async () => {
    setLlmGateway(new FakeBroker([new Error("RustBridge: not connected (tool=llm.complete)")]));
    expect((await openai().chat({ user: "u" })).text).toBe("from fetch");
  });

  it("LLM_GATEWAY=off keeps every call in the kernel", async () => {
    process.env.LLM_GATEWAY = "off";
    const broker = new FakeBroker([okReply()]);
    setLlmGateway(broker);
    expect((await openai().chat({ user: "u" })).text).toBe("from fetch");
    expect(broker.calls).toHaveLength(0);
  });

  it("a request too large for one frame is made here", async () => {
    const broker = new FakeBroker([okReply()]);
    setLlmGateway(broker);
    await openai().chat({ user: "u", imageBase64: "A".repeat(9 * 1024 * 1024), imageMediaType: "image/png" });
    expect(broker.calls).toHaveLength(0);
    expect(fetched).toHaveLength(1);
  });
});
