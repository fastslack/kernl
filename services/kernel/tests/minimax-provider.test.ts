import { describe, it, expect, afterEach } from "bun:test";
import { createCatalogProvider } from "../src/core/llm/providers/openai-compatible-provider.js";

describe("minimax provider", () => {
  const prev = { ...process.env };
  afterEach(() => { process.env = { ...prev }; });

  it("is ready with a configured key and takes its form from the catalog", async () => {
    const p = createCatalogProvider("minimax")();
    p.configure({ apiKey: "explicit-key", defaultModel: "MiniMax-M2.7" });
    await p.start();
    expect(p.slug).toBe("minimax");
    expect(p.isReady()).toBe(true);
    expect(p.getConfigSchema().map((f) => f.key)).toEqual(["apiKey", "defaultModel", "region"]);
  });

  it("never falls back to the environment", async () => {
    process.env.MINIMAX_API_KEY = "env-key";
    const p = createCatalogProvider("minimax")();
    p.configure({});
    await p.start();
    expect(p.isReady()).toBe(false);
  });
});
