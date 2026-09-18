import { describe, it, expect, afterEach } from "bun:test";
import { createCatalogProvider, registerBuiltinLlmProviders } from "../src/core/llm/providers/index.js";
import { LlmProviderRegistry } from "../src/core/llm/provider-registry.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("catalog providers", () => {
  it("registers all 12 catalog slugs", () => {
    const reg = new LlmProviderRegistry();
    registerBuiltinLlmProviders(reg);
    expect(reg.getAvailableSlugs().sort()).toEqual([
      "claude", "claude-code", "deepseek", "gemini", "grok", "groq",
      "lmstudio", "minimax", "nvidia", "ollama", "openai", "openrouter",
    ]);
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
