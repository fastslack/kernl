import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { registerConnectRoutes, detectLocalServer, type ChainLink } from "../src/core/llm/connect-routes.js";
import { setCredentialSource } from "../src/core/llm/credentials.js";
import { getCatalogEntry } from "../src/core/llm/provider-catalog.js";
import type { ChatLlmProvider } from "../src/core/llm/chat-adapters.js";

let store: Record<string, Record<string, unknown>>;
let chain: ChainLink[];
let changed: string[];
let started: string[];
let overrides: Array<Record<string, unknown>>;
let reply: (model?: string) => Promise<any>;
let server: KernelHttpServer;
let base: string;

const toolReply = (model = "m") => ({ content: "", model, tokens_used: 1, tool_calls: [{ type: "tool_use", id: "1", name: "kernl_connect_echo", input: { word: "ok" } }] });

beforeEach(async () => {
  store = {}; chain = []; changed = []; started = []; overrides = [];
  reply = async (model) => toolReply(model);
  setCredentialSource({ loadConfig: (s) => ({ ...(store[s] ?? {}) }), saveConfig: (s, c) => { store[s] = { ...c }; return true; } });
  server = new KernelHttpServer({ config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig });
  registerConnectRoutes(server, {
    registry: { startProvider: async (s) => { started.push(s); return true; }, stopProvider: async () => true },
    getChain: () => chain,
    setChain: (c) => { chain = c; },
    onChanged: (slug) => { changed.push(slug); },
    buildAdapter: (_slug, o) => {
      overrides.push({ ...o });
      return { name: "fake", available: () => true, chatCompletion: (_m: unknown, opts: any) => reply(opts?.model) } as unknown as ChatLlmProvider;
    },
    detectLocal: async () => ({ found: true, baseUrl: "http://host.docker.internal:11434/v1", models: ["qwen3"] }),
    detectClaudeSession: () => true,
    now: () => "2026-09-15T00:00:00.000Z",
    timeoutMs: () => 500,
  });
  expect(await server.start()).toBe(true);
  const addr = server.nodeServer!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterEach(async () => { await server.stop(); setCredentialSource(null); });

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("connect routes", () => {
  it("GET /api/llm/catalog lists the 12 providers with state, never the raw key", async () => {
    store.nvidia = { apiKey: "nvapi-1234567890abcd", connectedAt: "t" };
    chain = [{ provider: "nim", model: "" }];
    const body = await (await fetch(`${base}/api/llm/catalog`)).json() as any;
    expect(body.providers).toHaveLength(12);
    const nv = body.providers.find((p: any) => p.slug === "nvidia");
    expect(nv).toMatchObject({ recommended: true, connected: true, model: "nvidia/nemotron-3-super-120b-a12b" });
    expect(nv.keyMasked).not.toContain("1234567890");
    expect(body.chain).toEqual([{ provider: "nvidia", model: "" }]);
    expect(JSON.stringify(body)).not.toContain("nvapi-1234567890abcd");
  });

  it("test uses the pasted key and saves nothing", async () => {
    const r = await (await post("/api/llm-providers/groq/test", { apiKey: "gsk_new" })).json() as any;
    expect(r.ok).toBe(true);
    expect(overrides[0].apiKey).toBe("gsk_new");
    expect(store.groq).toBeUndefined();
  });

  it("test without any key answers auth without calling the model", async () => {
    let called = false;
    reply = async () => { called = true; return toolReply(); };
    const r = await (await post("/api/llm-providers/groq/test")).json() as any;
    expect(r.error.code).toBe("auth");
    expect(called).toBe(false);
  });

  it("connect saves, starts, appends to the chain and reloads", async () => {
    chain = [{ provider: "claude-code", model: "" }];
    const r = await (await post("/api/llm-providers/nvidia/connect", { apiKey: "nvapi-k" })).json() as any;
    expect(r.ok).toBe(true);
    expect(store.nvidia).toMatchObject({ apiKey: "nvapi-k", connectedAt: "2026-09-15T00:00:00.000Z", lastTestOk: true });
    expect(started).toEqual(["nvidia"]);
    expect(chain).toEqual([{ provider: "claude-code", model: "" }, { provider: "nvidia", model: "" }]);
    expect(changed).toEqual(["nvidia"]);
    expect(r.chain).toEqual(chain);
  });

  it("a failed connect changes nothing", async () => {
    reply = async () => { throw new Error("nvidia API error 401: Unauthorized"); };
    const r = await (await post("/api/llm-providers/nvidia/connect", { apiKey: "bad" })).json() as any;
    expect(r.error.code).toBe("auth");
    expect(store.nvidia).toBeUndefined();
    expect(chain).toEqual([]);
    expect(changed).toEqual([]);
  });

  it("a vanished model switches to the next catalog candidate", async () => {
    const entry = getCatalogEntry("nvidia")!;
    reply = async (model) => {
      if (model === entry.models.fast) return toolReply(model);
      throw new Error("nvidia API error 404: model not found");
    };
    const r = await (await post("/api/llm-providers/nvidia/connect", { apiKey: "k", model: "gone/model" })).json() as any;
    expect(r.ok).toBe(true);
    expect(r.switchedModel).toBe(entry.models.fast);
    expect(store.nvidia.defaultModel).toBe(entry.models.fast);
  });

  it("detect finds a local server and refuses cloud providers", async () => {
    const r = await (await post("/api/llm-providers/ollama/detect")).json() as any;
    expect(r).toMatchObject({ found: true, models: ["qwen3"] });
    expect((await post("/api/llm-providers/nvidia/detect")).status).toBe(400);
  });

  it("detect connects Claude Code when the CLI has a session", async () => {
    const r = await (await post("/api/llm-providers/claude-code/detect")).json() as any;
    expect(r.session).toBe(true);
    expect(store["claude-code"].connectedAt).toBeDefined();
    expect(chain).toEqual([{ provider: "claude-code", model: "" }]);
  });

  it("a repeat detect of an already-connected Claude Code changes nothing and does not re-fire onChanged", async () => {
    await post("/api/llm-providers/claude-code/detect");
    expect(changed).toEqual(["claude-code"]);
    const r = await (await post("/api/llm-providers/claude-code/detect")).json() as any;
    expect(r.session).toBe(true);
    expect(chain).toEqual([{ provider: "claude-code", model: "" }]);
    expect(changed).toEqual(["claude-code"]);
  });

  it("DELETE removes the key and the chain link", async () => {
    store.groq = { apiKey: "gsk_1", connectedAt: "t" };
    chain = [{ provider: "groq", model: "" }, { provider: "nvidia", model: "" }];
    const r = await fetch(`${base}/api/llm-providers/groq/connection`, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(store.groq).toEqual({});
    expect(chain).toEqual([{ provider: "nvidia", model: "" }]);
  });

  it("PUT /api/llm/chain validates providers", async () => {
    const bad = await fetch(`${base}/api/llm/chain`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ links: [{ provider: "nope", model: "" }] }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/api/llm/chain`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ links: [{ provider: "xai", model: "grok-4.3" }] }) });
    expect(ok.status).toBe(200);
    expect(chain).toEqual([{ provider: "grok", model: "grok-4.3" }]);
  });
});

describe("detectLocalServer", () => {
  it("tries each host and returns the first that answers, chat models only", async () => {
    setCredentialSource({ loadConfig: () => ({}), saveConfig: () => true });
    const tried: string[] = [];
    const fakeFetch = (async (url: unknown) => {
      tried.push(String(url));
      if (String(url).includes("host.docker.internal")) {
        return new Response(JSON.stringify({ data: [{ id: "qwen3" }, { id: "nomic-embed-text" }] }), { status: 200 });
      }
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await detectLocalServer(getCatalogEntry("ollama")!, fakeFetch);
    expect(r).toEqual({ found: true, baseUrl: "http://host.docker.internal:11434/v1", models: ["qwen3"] });
    expect(tried[0]).toBe("http://localhost:11434/v1/models");
    setCredentialSource(null);
  });
});
