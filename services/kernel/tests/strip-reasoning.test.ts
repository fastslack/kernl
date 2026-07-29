import { describe, it, expect } from "bun:test";
import { stripReasoning } from "../src/core/llm/strip-reasoning.js";

describe("stripReasoning", () => {
  it("removes a closed <think> block and keeps the answer", () => {
    const r = stripReasoning('<think>\nThe user wants {score: 5}. So...\n</think>\n{"score":5}');
    expect(r).toBe('{"score":5}');
  });

  it("does not let braces inside <think> hijack JSON extraction", () => {
    const raw = '<think>supposed to call foo({a:1}) but {b}</think> {"outcome":"success"}';
    const cleaned = stripReasoning(raw);
    const obj = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
    expect(obj.outcome).toBe("success");
  });

  it("drops a dangling unclosed opener (truncated output)", () => {
    expect(stripReasoning("<think>ran out of tokens mid-thought")).toBe("");
  });

  it("handles Kimi-style ◁think▷ markers", () => {
    expect(stripReasoning("◁think▷reasoning◁/think▷answer")).toBe("answer");
  });

  it("passes through plain text unchanged", () => {
    expect(stripReasoning('{"score":3}')).toBe('{"score":3}');
  });
});
