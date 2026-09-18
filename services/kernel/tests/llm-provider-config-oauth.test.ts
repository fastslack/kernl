/**
 * PUT /api/llm-providers/:slug/config must never let a raw request plant an
 * `oauthToken` — no UI exposes that field, `applyClaudeCodeTransition` is the
 * only writer, and a legacy token has to survive a config save (it is only
 * retired once the CLI has its own session).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { registerLlmProviderRoutes } from "../src/core/llm/provider-routes.js";
import type { LlmProviderRegistry } from "../src/core/llm/provider-registry.js";
import type { ModelBlocklist } from "../src/core/llm/model-blocklist.js";

let store: Record<string, Record<string, unknown>>;
let server: KernelHttpServer;
let base: string;

function makeRegistry(): LlmProviderRegistry {
  return {
    loadConfig: (slug: string) => ({ ...(store[slug] ?? {}) }),
    saveConfig: (slug: string, cfg: Record<string, unknown>) => { store[slug] = { ...cfg }; return true; },
    getConfigSchema: () => [],
    getProvider: () => undefined,
    stopProvider: async () => true,
    startProvider: async () => true,
    getStatuses: () => [],
    lastStartError: null,
  } as unknown as LlmProviderRegistry;
}

beforeEach(async () => {
  store = {};
  server = new KernelHttpServer({ config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig });
  registerLlmProviderRoutes(server, makeRegistry(), {} as unknown as ModelBlocklist);
  expect(await server.start()).toBe(true);
  const addr = server.nodeServer!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterEach(async () => { await server.stop(); });

const put = (slug: string, config: Record<string, unknown>) =>
  fetch(`${base}/api/llm-providers/${slug}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config }),
  });

describe("PUT /api/llm-providers/:slug/config never accepts oauthToken", () => {
  it("keeps the previously stored legacy token, ignoring the injected one", async () => {
    store["claude-code"] = { oauthToken: "sk-ant-oat01-legacy", connectedAt: "t" };
    const r = await put("claude-code", { oauthToken: "sk-ant-oat01-injected", defaultModel: "sonnet" });
    expect(r.status).toBe(200);
    expect(store["claude-code"].oauthToken).toBe("sk-ant-oat01-legacy");
    expect(store["claude-code"].defaultModel).toBe("sonnet");
  });

  it("stores no token at all when none was stored, even if one is injected", async () => {
    const r = await put("claude-code", { oauthToken: "sk-ant-oat01-injected" });
    expect(r.status).toBe(200);
    expect(store["claude-code"].oauthToken).toBeUndefined();
    expect(JSON.stringify(store["claude-code"])).not.toContain("sk-ant-oat01-injected");
  });

  it("never persists the injected token under any other provider slug either", async () => {
    const r = await put("groq", { oauthToken: "sk-ant-oat01-injected", apiKey: "gsk_x" });
    expect(r.status).toBe(200);
    expect(store["groq"].oauthToken).toBeUndefined();
    expect(store["groq"].apiKey).toBe("gsk_x");
  });
});
