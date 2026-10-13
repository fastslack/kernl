import { describe, it, expect, afterEach } from "bun:test";
import { createCatalogProvider, registerBuiltinLlmProviders } from "../src/core/llm/providers/index.js";
import { LlmProviderRegistry } from "../src/core/llm/provider-registry.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("catalog providers", () => {
  it("registers all 20 catalog slugs", () => {
    const reg = new LlmProviderRegistry();
    registerBuiltinLlmProviders(reg);
    expect(reg.getAvailableSlugs().sort()).toEqual([
      "cerebras", "claude", "claude-code", "deepseek", "fireworks", "gemini", "grok", "groq",
      "lmstudio", "minimax", "mistral", "moonshot", "nvidia", "ollama", "openai", "openai-compatible",
      "openrouter", "qwen", "together", "zai",
    ]);
  });

  it("lists models from an API that answers a bare array (Together)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ id: "zai-org/GLM-5.3", type: "chat" }, { id: "openai/gpt-oss-120b", type: "chat" }]), { status: 200 })
    ) as unknown as typeof fetch;
    const p = createCatalogProvider("together")();
    p.configure({ apiKey: "k" });
    await p.start();
    expect(await p.listModels!()).toEqual(["openai/gpt-oss-120b", "zai-org/GLM-5.3"]);
  });

  it("an OpenAI-compatible server offers an optional key", () => {
    const f = createCatalogProvider("openai-compatible")().getConfigSchema();
    expect(f.map((x) => x.key)).toEqual(["apiKey", "baseUrl", "defaultModel"]);
    expect(f[0].required).toBe(false);
  });

  it("refuses kinds it does not implement", () => {
    expect(() => createCatalogProvider("claude")).toThrow();
  });

  it("lists Gemini models without the models/ prefix, with a bearer key", async () => {
    let auth = "";
    globalThis.fetch = (async (url: unknown, init: any) => {
      auth = init.headers.Authorization;
      expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models");
      return new Response(JSON.stringify({ data: [{ id: "models/gemini-3.8-flash" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = createCatalogProvider("gemini")();
    p.configure({ apiKey: "AQ.key" });
    await p.start();
    expect(await p.listModels!()).toEqual(["gemini-3.8-flash"]);
    expect(auth).toBe("Bearer AQ.key");
  });

  it("Ollama needs no key and sends no Authorization when listing", async () => {
    let headers: Record<string, string> = { x: "y" };
    globalThis.fetch = (async (_u: unknown, init: any) => {
      headers = init.headers;
      return new Response(JSON.stringify({ data: [{ id: "qwen3" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = createCatalogProvider("ollama")();
    p.configure({ baseUrl: "http://host.docker.internal:11434/v1" });
    await p.start();
    expect(p.isReady()).toBe(true);
    expect(await p.listModels!()).toEqual(["qwen3"]);
    expect(headers.Authorization).toBeUndefined();
  });

  it("derives the config form from the catalog", () => {
    const keys = (slug: string) => createCatalogProvider(slug)().getConfigSchema().map((f) => f.key);
    expect(keys("nvidia")).toEqual(["apiKey", "defaultModel"]);
    expect(keys("openai")).toEqual(["apiKey", "baseUrl", "defaultModel"]);
    expect(keys("minimax")).toEqual(["apiKey", "defaultModel", "region"]);
    expect(keys("ollama")).toEqual(["baseUrl", "defaultModel"]);
  });

  it("keeps each provider's real capabilities", () => {
    expect(createCatalogProvider("grok")().capabilities).toMatchObject({ thinking: true, contextWindow: 256_000, tools: true });
    expect(createCatalogProvider("openai")().capabilities).toMatchObject({ vision: true, contextWindow: 128_000 });
    expect(createCatalogProvider("ollama")().capabilities.contextWindow).toBe(32_000);
  });
});
