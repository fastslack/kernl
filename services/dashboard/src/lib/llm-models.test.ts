import { describe, it, expect } from "bun:test";
import { modelIds } from "./llm-models.js";

describe("modelIds", () => {
  it("reads the shape the endpoint actually returns", () => {
    // Captured from /api/llm-providers/claude-code/models — these rendered as
    // "[object Object]" in every model picker.
    const raw = [
      { id: "claude-opus-4-7", traits: { chat: true, vision: true } },
      { id: "claude-haiku-4-5", traits: { chat: true, fast: true } },
    ];
    expect(modelIds(raw)).toEqual(["claude-opus-4-7", "claude-haiku-4-5"]);
  });

  it("still accepts providers that return bare strings", () => {
    expect(modelIds(["gpt-4o-mini", "gpt-4o"])).toEqual(["gpt-4o-mini", "gpt-4o"]);
  });

  it("drops entries with no usable id instead of rendering blanks", () => {
    expect(modelIds([{ traits: {} }, "", null, { id: "" }, { id: "ok" }])).toEqual(["ok"]);
  });

  it("returns nothing for a missing or malformed payload", () => {
    expect(modelIds(undefined)).toEqual([]);
    expect(modelIds({ models: [] })).toEqual([]);
  });
});
