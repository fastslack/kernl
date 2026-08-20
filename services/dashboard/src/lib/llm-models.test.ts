import { describe, it, expect } from "bun:test";
import { modelIds, selectableModels } from "./llm-models.js";

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

describe("selectableModels", () => {
  it("offers only what is loaded when the runtime knows", () => {
    const r = selectableModels([
      { id: "deepseek-ocr", loaded: false },
      { id: "qwen/qwen3.8-27b", loaded: true },
      { id: "llama-3.2-3b-mlx", loaded: false },
    ]);
    expect(r.ids).toEqual(["qwen/qwen3.8-27b"]);
  });

  it("auto-picks the single loaded model", () => {
    const r = selectableModels([{ id: "a", loaded: true }, { id: "b", loaded: false }]);
    expect(r.auto).toBe("a");
  });

  it("leaves the choice alone when two are loaded", () => {
    const r = selectableModels([{ id: "a", loaded: true }, { id: "b", loaded: true }]);
    expect(r.ids).toEqual(["a", "b"]);
    expect(r.auto).toBeNull();
  });

  it("shows everything when the runtime cannot say — every cloud provider", () => {
    const r = selectableModels([{ id: "gpt-x", traits: { chat: true } }, "claude-y"]);
    expect(r.ids).toEqual(["gpt-x", "claude-y"]);
    expect(r.auto).toBeNull();
  });

  it("does not strand the user with an empty picker when nothing is loaded", () => {
    const r = selectableModels([{ id: "a", loaded: false }, { id: "b", loaded: false }]);
    expect(r.ids).toEqual(["a", "b"]);
    expect(r.auto).toBeNull();
  });
});
