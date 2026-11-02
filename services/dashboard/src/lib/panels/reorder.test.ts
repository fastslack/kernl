import { describe, it, expect } from "bun:test";
import { moveKey, moveOf, glyphOf, actionGlyph } from "./reorder.js";

/**
 * Moving rows right in a panel list: the office stores the move as a record and applies it on its next pass,
 * so the list shows the new order at once and keeps it until the office catches up.
 */
describe("moveKey", () => {
  const order = ["a", "b", "c", "d"];
  it("puts a key at a 0-based index, clamped", () => {
    expect(moveKey(order, "d", 1)).toEqual(["a", "d", "b", "c"]);
    expect(moveKey(order, "a", 9)).toEqual(["b", "c", "d", "a"]);
    expect(moveKey(order, "c", -3)).toEqual(["c", "a", "b", "d"]);
  });
  it("leaves the list alone for an unknown key", () => {
    expect(moveKey(order, "z", 0)).toEqual(order);
  });
});

describe("moveOf", () => {
  it("reads the move a record action stands for from its key template", () => {
    expect(moveOf("first:{{key}}")).toBe("first");
    expect(moveOf("up:{{key}}")).toBe("up");
    expect(moveOf("down:{{key}}")).toBe("down");
    expect(moveOf("last:{{key}}")).toBe("last");
    expect(moveOf("continuo-on")).toBeNull();
    expect(moveOf(undefined)).toBeNull();
  });
  it("gives pause and resume their own symbol, and nothing to other actions", () => {
    expect(actionGlyph("pause:{{key}}")).toBe("⏸");
    expect(actionGlyph("resume:{{key}}")).toBe("▶");
    expect(actionGlyph("up:{{key}}")).toBe("↑");
    expect(actionGlyph("continuo-on")).toBeNull();
  });
  it("gives each move its arrow", () => {
    expect(["first", "up", "down", "last"].map((m) => glyphOf(m as never))).toEqual(["⤒", "↑", "↓", "⤓"]);
  });
});
