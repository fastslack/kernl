import { describe, it, expect } from "bun:test";
import { retiredLearnings } from "../src/modules/agents/learning-diff.js";

// The LIVE feed used to say only "learning_deactivated" — the kernel sent a
// count worked out by arithmetic, never which lessons went. This pins the list.
const l = (id: string, content: string, confidence = 0.1, type = "insight") =>
  ({ id, content, confidence, type }) as never;

describe("retiredLearnings", () => {
  it("returns the lessons that were active before the cleanup and are gone after it", () => {
    const before = [l("a", "keep"), l("b", "drop me", 0.12, "avoid"), l("c", "drop me too")];
    const after = [l("a", "keep"), l("new", "just learned")];
    expect(retiredLearnings(before, after)).toEqual([
      { id: "b", type: "avoid", content: "drop me", confidence: 0.12 },
      { id: "c", type: "insight", content: "drop me too", confidence: 0.1 },
    ]);
  });

  it("is empty when nothing was retired, even if a lesson was added", () => {
    expect(retiredLearnings([l("a", "x")], [l("a", "x"), l("b", "new")])).toEqual([]);
  });
});
