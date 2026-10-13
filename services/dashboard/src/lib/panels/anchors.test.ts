import { describe, it, expect } from "bun:test";
import { anchorMap } from "./anchors.js";

describe("anchorMap", () => {
  it("maps each office to the view its wall board opens", () => {
    const m = anchorMap([
      { flowId: "a", anchors: [{ object: "wall-board", view: "issues" }] },
      { flowId: "b", anchors: [{ object: "desk", view: "x" }] },
      { flowId: "c", anchors: [] },
    ]);
    expect([...m.entries()]).toEqual([["a", "issues"]]);
  });
});
