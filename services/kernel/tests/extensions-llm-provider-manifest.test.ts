import { describe, it, expect } from "bun:test";
import { parseManifest, checkTypeConsistency } from "../src/modules/extensions/schema.js";

const base = {
  $schema: "kernl://extension/v1",
  id: "com.kernl.llm.minimax",
  slug: "minimax",
  name: "MiniMax",
  version: "1.0.0",
  type: "llm-provider",
  description: "MiniMax provider.",
  author: "Kernl",
  license: "MIT",
  category: "ai",
};

describe("llm-provider manifest", () => {
  it("parses a built-in llm-provider with no backend.entry, no consistency errors", () => {
    const m = { ...base, built_in: true };
    const parsed = parseManifest(m);
    expect(parsed.type).toBe("llm-provider");
    expect(checkTypeConsistency(parsed)).toEqual([]);
  });

  it("flags a non-built-in llm-provider without backend.entry", () => {
    const parsed = parseManifest(base);
    expect(checkTypeConsistency(parsed)).toEqual([
      expect.stringMatching(/backend\.entry/),
    ]);
  });

  it("accepts a non-built-in llm-provider with backend.entry", () => {
    const m = { ...base, backend: { entry: "backend/entry.js" } };
    const parsed = parseManifest(m);
    expect(checkTypeConsistency(parsed)).toEqual([]);
  });
});
