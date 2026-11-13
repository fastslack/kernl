import { describe, it, expect } from "bun:test";
import { project2d, groupsOf, nameGroup } from "../src/modules/agents/services/learning-constellation.js";

describe("the constellation's geometry", () => {
  it("projects alike vectors near each other and apart from the rest, inside [-1, 1]", () => {
    const pts = project2d([[1, 0, 0], [0.98, 0.05, 0], [0, 0, 1], [0.02, 0, 0.97]]);
    const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    expect(d(pts[0], pts[1])).toBeLessThan(d(pts[0], pts[2]));
    expect(d(pts[2], pts[3])).toBeLessThan(d(pts[1], pts[3]));
    for (const p of pts) for (const c of p) expect(Math.abs(c)).toBeLessThanOrEqual(1);
  });

  it("groups stars linked to each other, largest group first", () => {
    const g = groupsOf(["a", "b", "c", "x", "y"], [{ a: "a", b: "b", s: 0.9 }, { a: "b", b: "c", s: 0.8 }, { a: "x", b: "y", s: 0.7 }]);
    expect(g.get("a")).toBe(g.get("c"));
    expect(g.get("x")).toBe(g.get("y"));
    expect(g.get("a")).toBe(0);
    expect(g.get("x")).not.toBe(g.get("a"));
  });

  it("names a group by the words that set it apart", () => {
    const all = new Map([["email", 2], ["address", 2], ["contact", 3], ["timeout", 1]]);
    expect(nameGroup(["Check the email address", "[auto] The email address may be old"], all, 6)).toBe("email · address");
  });
});
