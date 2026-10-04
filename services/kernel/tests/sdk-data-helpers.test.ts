/**
 * buildPatch replaces the hand-written `if (x !== undefined) sets.push(…)`
 * ladders of partial UPDATEs; safeJson / jsonArray / jsonObject replace the
 * try { JSON.parse } catch fallbacks around TEXT columns holding JSON.
 */

import { describe, it, expect } from "bun:test";
import { buildPatch } from "../src/sdk/query-helpers.js";
import { safeJson, jsonArray, jsonObject } from "../src/sdk/helpers.js";

describe("buildPatch", () => {
  const spec = {
    name: "text",
    tools: "json",
    active: "bool",
    skills: { column: "skills_json", to: (v: string[]) => JSON.stringify(v) },
    chain: { to: (v: unknown[]) => (v.length ? JSON.stringify(v) : "") },
  } as const;

  it("sets only the provided fields, in spec order, converted", () => {
    expect(buildPatch({ active: false, name: "A", skills: ["x"], chain: [] }, spec)).toEqual({
      sets: ["name = ?", "active = ?", "skills_json = ?", "chain = ?"],
      params: ["A", 0, '["x"]', ""],
    });
  });

  it("skips undefined but keeps null and falsy values", () => {
    expect(buildPatch({ name: undefined, tools: null, active: 0 }, spec)).toEqual({
      sets: ["tools = ?", "active = ?"],
      params: ["null", 0],
    });
  });

  it("never lets a key outside the spec reach the SQL", () => {
    expect(buildPatch({ "name = 'x'; --": "evil", role: "manager" }, spec)).toEqual({ sets: [], params: [] });
  });
});

describe("JSON column helpers", () => {
  it("safeJson falls back on empty, malformed or wrong-shaped input", () => {
    expect(safeJson('{"a":1}', {})).toEqual({ a: 1 });
    expect(safeJson("", 7)).toBe(7);
    expect(safeJson(null, 7)).toBe(7);
    expect(safeJson("{nope", 7)).toBe(7);
    expect(safeJson("[1]", "x", (v): v is string => typeof v === "string")).toBe("x");
  });

  it("jsonArray and jsonObject accept only their shape", () => {
    expect(jsonArray('["a","b"]')).toEqual(["a", "b"]);
    expect(jsonArray('{"a":1}')).toEqual([]);
    expect(jsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(jsonObject("[1]")).toEqual({});
    expect(jsonObject("null")).toEqual({});
  });
});
