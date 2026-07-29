import { describe, it, expect, afterEach } from "bun:test";
import { createMinimaxProvider } from "../src/core/llm/providers/minimax-provider.js";

describe("minimax provider", () => {
  const prev = { ...process.env };
  afterEach(() => { process.env = { ...prev }; });

  it("uses explicit config, exposes expected schema, ready with a key", async () => {
    process.env.MINIMAX_API_KEY = "env-key";
    process.env.MINIMAX_DEFAULT_MODEL = "MiniMax-Text-01";
    const p = createMinimaxProvider();
    p.configure({ apiKey: "explicit-key", defaultModel: "MiniMax-M2" });
    await p.start();
    expect(p.slug).toBe("minimax");
    expect(p.isReady()).toBe(true);
    const schema = p.getConfigSchema();
    expect(schema.map((f) => f.key)).toEqual(["apiKey", "baseUrl", "defaultModel"]);
  });

  it("falls back to env key when config has none", () => {
    process.env.MINIMAX_API_KEY = "env-key";
    delete process.env.MINIMAX_DEFAULT_MODEL;
    const p = createMinimaxProvider();
    p.configure({});
    expect(p.getStatus().slug).toBe("minimax");
  });

  it("not ready without any key", async () => {
    delete process.env.MINIMAX_API_KEY;
    const p = createMinimaxProvider();
    p.configure({});
    await p.start();
    expect(p.isReady()).toBe(false);
  });
});
