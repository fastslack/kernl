import { describe, it, expect } from "bun:test";
import { parseAnswerBody } from "../src/modules/agents/api-routes.js";

describe("parseAnswerBody", () => {
  it("takes the new choice shape", () => {
    expect(parseAnswerBody({ choice: { kind: "task" } })).toEqual({ kind: "task" });
    expect(parseAnswerBody({ choice: { kind: "done", note: "ok" } })).toEqual({ kind: "done", note: "ok" });
    expect(parseAnswerBody({ choice: { kind: "option", index: 2 } })).toEqual({ kind: "option", index: 2 });
  });
  it("maps the old body", () => {
    expect(parseAnswerBody({ selected_index: 1, selected_option: "B" })).toEqual({ kind: "option", index: 1 });
    expect(parseAnswerBody({ selected_index: -1, selected_option: "texto libre" })).toEqual({ kind: "free", text: "texto libre" });
  });
  it("rejects garbage", () => {
    expect(parseAnswerBody({ choice: { kind: "option", index: "x" } })).toBeNull();
    expect(parseAnswerBody({})).toBeNull();
  });
});
