import { describe, it, expect } from "bun:test";
import { collapseRepeats } from "./collapse-repeats.js";

const id = (s: string) => s;
const shape = (xs: string[]) => collapseRepeats(xs, id).map((r) => `${r.item}×${r.count}`);

describe("collapseRepeats", () => {
  it("returns nothing for an empty list", () => {
    expect(collapseRepeats([], id)).toEqual([]);
  });

  it("keeps single items as runs of one", () => {
    expect(collapseRepeats(["a", "b", "c"], id)).toEqual([
      { item: "a", count: 1, items: ["a"] },
      { item: "b", count: 1, items: ["b"] },
      { item: "c", count: 1, items: ["c"] },
    ]);
  });

  it("folds a run into one entry that still carries every item", () => {
    const calls = Array.from({ length: 25 }, (_, n) => ({ name: "kernel_career_liveness", n }));
    const out = collapseRepeats(calls, (c) => c.name);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(25);
    expect(out[0].item).toBe(calls[0]);
    expect(out[0].items).toEqual(calls);
  });

  it("only merges neighbours: A A B A gives A×2, B, A", () => {
    expect(shape(["a", "a", "b", "a"])).toEqual(["a×2", "b×1", "a×1"]);
  });

  it("keeps the original order inside and across runs", () => {
    const xs = [{ k: "x", n: 1 }, { k: "x", n: 2 }, { k: "y", n: 3 }, { k: "y", n: 4 }, { k: "x", n: 5 }];
    const out = collapseRepeats(xs, (t) => t.k);
    expect(out.map((r) => r.items.map((t) => t.n))).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("passes the index so a caller can keep some items apart", () => {
    const xs = ["text", "text", "tool", "tool"];
    const out = collapseRepeats(xs, (t, i) => (t === "text" ? `text:${i}` : t));
    expect(out.map((r) => r.count)).toEqual([1, 1, 2]);
  });
});
