// src/lib/panels/rows.test.ts
import { describe, it, expect } from "bun:test";
import { selectPath, toRows, joinRows, groupBy } from "./rows.js";

describe("rows", () => {
  const ledger = { issues: { "web#1": { state: "ready" }, "api#2": { state: "working" } } };
  it("turns a map into rows with key", () => {
    expect(toRows(selectPath(ledger, "$.issues"))).toEqual([{ key: "web#1", state: "ready" }, { key: "api#2", state: "working" }]);
    expect(toRows([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(toRows(null)).toEqual([]);
  });
  it("joins another source by key", () => {
    const rows = joinRows([{ key: "web#1" }], [{ key: "web#1", text: "a" }, { key: "x", text: "b" }], "key");
    expect(rows[0]._joined).toEqual([{ key: "web#1", text: "a" }]);
  });
  it("groups in the declared order, with unknown values last", () => {
    const g = groupBy([{ s: "b" }, { s: "a" }, { s: "z" }], "s", ["a", "b"]);
    expect(g.map((c) => c.column)).toEqual(["a", "b", "z"]);
  });
});
