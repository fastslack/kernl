/**
 * Forgiving coercion of tool arguments an LLM got slightly wrong.
 *
 * The kernel already rescued `"7"` where a number was wanted and `"true"` where
 * a boolean was. It did not rescue `"[5, 8, 4]"` where an ARRAY was wanted, and
 * that gap had teeth: some agent executors serialise nested arguments before
 * the call reaches the tool, so every array and object parameter in the kernel
 * failed for those agents with `Expected array, received string`.
 *
 * That failure is unrecoverable from the agent's side. It cannot see how its
 * arguments were serialised, the error names the value it thinks it sent, and
 * every retry fails identically — which is exactly what happened to a drawing
 * agent that could create a scene but never put an object in one.
 *
 * The line this holds: only strings that actually parse as JSON of the expected
 * shape are rescued. A hallucinated enum, a missing field or a number out of
 * range still throws, because the agent needs to see those and fix them.
 */
import { describe, it, expect } from "bun:test";
import { coerceCommonZodIssues } from "../src/server.js";

type Issue = { code: string; path: (string | number)[]; expected?: string; received?: string };

const typeIssue = (path: (string | number)[], expected: string): Issue => ({
  code: "invalid_type",
  path,
  expected,
  received: "string",
});

describe("numbers and booleans", () => {
  it("still parses a numeric string", () => {
    expect(coerceCommonZodIssues({ n: "7" }, [typeIssue(["n"], "number")])).toEqual({ n: 7 });
  });

  it("still parses a boolean string", () => {
    expect(coerceCommonZodIssues({ b: "true" }, [typeIssue(["b"], "boolean")])).toEqual({ b: true });
  });

  it("gives up on a number that is not one", () => {
    expect(coerceCommonZodIssues({ n: "soon" }, [typeIssue(["n"], "number")])).toBeNull();
  });
});

describe("arrays arriving as JSON strings", () => {
  it("parses the vector an agent sent as text", () => {
    expect(coerceCommonZodIssues({ at: "[5, 8, 4]" }, [typeIssue(["at"], "array")])).toEqual({
      at: [5, 8, 4],
    });
  });

  it("handles the whitespace a model leaves in", () => {
    expect(coerceCommonZodIssues({ size: "  [3, 2.5, 0.1]  " }, [typeIssue(["size"], "array")])).toEqual({
      size: [3, 2.5, 0.1],
    });
  });

  it("parses an array of objects", () => {
    const args = { keys: '[{"t":0,"value":[0,0,0]},{"t":1,"value":[0,360,0]}]' };
    expect(coerceCommonZodIssues(args, [typeIssue(["keys"], "array")])).toEqual({
      keys: [
        { t: 0, value: [0, 0, 0] },
        { t: 1, value: [0, 360, 0] },
      ],
    });
  });

  it("refuses a string that parses to something that is not an array", () => {
    // Handing an object to a slot that wants a list would swap one confusing
    // error for another, further from the cause.
    expect(coerceCommonZodIssues({ at: '{"x":1}' }, [typeIssue(["at"], "array")])).toBeNull();
  });

  it("leaves prose alone", () => {
    expect(coerceCommonZodIssues({ at: "up and to the left" }, [typeIssue(["at"], "array")])).toBeNull();
  });

  it("leaves a string that only looks like it starts a list", () => {
    expect(coerceCommonZodIssues({ at: "[unclosed" }, [typeIssue(["at"], "array")])).toBeNull();
  });
});

describe("objects arriving as JSON strings", () => {
  it("parses the material an agent sent as text", () => {
    const args = { material: '{"color": "#ffffff", "roughness": 0.3}' };
    expect(coerceCommonZodIssues(args, [typeIssue(["material"], "object")])).toEqual({
      material: { color: "#ffffff", roughness: 0.3 },
    });
  });

  it("refuses a string that parses to an array", () => {
    expect(coerceCommonZodIssues({ material: "[1,2]" }, [typeIssue(["material"], "object")])).toBeNull();
  });

  it("refuses a bare JSON null", () => {
    // `JSON.parse("null")` is an object by typeof and would sail through a
    // careless check, then fail deeper where the cause is harder to see.
    expect(coerceCommonZodIssues({ material: "null" }, [typeIssue(["material"], "object")])).toBeNull();
  });
});

describe("mixed and nested", () => {
  it("fixes a nested field without disturbing its siblings", () => {
    const args = { piece_id: "p1", place: { rel: "on", of: "table" }, at: "[1,2,3]" };
    expect(coerceCommonZodIssues(args, [typeIssue(["at"], "array")])).toEqual({
      piece_id: "p1",
      place: { rel: "on", of: "table" },
      at: [1, 2, 3],
    });
  });

  it("reaches a field inside a nested object", () => {
    const args = { track: { property: "rotation", keys: "[{\"t\":0},{\"t\":1}]" } };
    expect(coerceCommonZodIssues(args, [typeIssue(["track", "keys"], "array")])).toEqual({
      track: { property: "rotation", keys: [{ t: 0 }, { t: 1 }] },
    });
  });

  it("fixes several arguments in one pass", () => {
    const args = { at: "[0,1,0]", size: "[2,2,2]", material: '{"color":"#fff"}' };
    const out = coerceCommonZodIssues(args, [
      typeIssue(["at"], "array"),
      typeIssue(["size"], "array"),
      typeIssue(["material"], "object"),
    ]);
    expect(out).toEqual({ at: [0, 1, 0], size: [2, 2, 2], material: { color: "#fff" } });
  });

  it("does not mutate what the caller passed in", () => {
    const args = { at: "[1,2,3]" };
    coerceCommonZodIssues(args, [typeIssue(["at"], "array")]);
    expect(args.at).toBe("[1,2,3]");
  });
});

describe("what stays broken on purpose", () => {
  it("does not touch an invented enum value", () => {
    const issues: Issue[] = [{ code: "invalid_enum_value", path: ["shape"], received: "dodecahedron" }];
    expect(coerceCommonZodIssues({ shape: "dodecahedron" }, issues)).toBeNull();
  });

  it("does not invent a missing required field", () => {
    expect(coerceCommonZodIssues({}, [{ code: "invalid_type", path: ["id"], expected: "string", received: "undefined" }])).toBeNull();
  });

  it("ignores an issue with no path", () => {
    expect(coerceCommonZodIssues({ a: "[1]" }, [{ code: "invalid_type", path: [], expected: "array", received: "string" }])).toBeNull();
  });

  it("returns null for arguments that are not an object at all", () => {
    expect(coerceCommonZodIssues("nope", [typeIssue(["at"], "array")])).toBeNull();
    expect(coerceCommonZodIssues(null, [typeIssue(["at"], "array")])).toBeNull();
  });
});
