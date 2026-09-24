import { describe, it, expect } from "bun:test";
import { parseJsonCompletion, extractJsonValue } from "../src/core/llm/parse-json-completion.js";

describe("extractJsonValue", () => {
  it("finds the object inside surrounding prose", () => {
    expect(extractJsonValue('Sure! Here it is: {"a":1} — hope that helps'))
      .toBe('{"a":1}');
  });

  it("keeps braces that live inside strings", () => {
    // The naive first-{ to last-} slice gets this wrong the moment a value
    // contains a brace, which every agent prompt in this codebase can.
    const src = '{"prompt":"emit {json} only","n":2}';
    expect(extractJsonValue(`noise ${src} noise`)).toBe(src);
  });

  it("is not fooled by an escaped quote", () => {
    const src = '{"q":"he said \\"hi\\"","n":1}';
    expect(extractJsonValue(src)).toBe(src);
  });

  it("skips an unterminated opener and finds the real object after it", () => {
    expect(extractJsonValue('a { broken, then {"ok":true}')).toBe('{"ok":true}');
  });

  it("handles arrays", () => {
    expect(extractJsonValue("here: [1,2,3]")).toBe("[1,2,3]");
  });

  it("returns null when there is nothing to find", () => {
    expect(extractJsonValue("no json here")).toBeNull();
  });
});

describe("parseJsonCompletion", () => {
  it("parses a clean reply unchanged", () => {
    expect(parseJsonCompletion<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses a fenced reply", () => {
    expect(parseJsonCompletion<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("recovers an object a model wrapped in prose", () => {
    expect(parseJsonCompletion<{ a: number }>('Here you go:\n{"a":1}\nLet me know!')).toEqual({ a: 1 });
  });

  it("reports what came back instead of a parser error", () => {
    // "Unexpected token I in JSON at position 0" names nothing the operator
    // can act on; the reply itself does.
    expect(() => parseJsonCompletion("I cannot help with that."))
      .toThrow(/did not return JSON.*I cannot help with that/s);
  });

  it("says so when the reply was empty", () => {
    expect(() => parseJsonCompletion("")).toThrow(/\(nothing\)/);
  });
});
