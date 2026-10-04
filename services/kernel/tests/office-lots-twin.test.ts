import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The lot geometry lives twice on purpose: the kernel may not import extension
// code (tests/extension-boundary.test.ts) and the dashboard image only receives
// assets/extensions/_shared. Both must compute the same lots, so the two files
// stay byte-identical — edit one, copy it over the other.
const KERNEL = resolve(import.meta.dirname, "../src/modules/agents/office-lots.ts");
const SHARED = resolve(import.meta.dirname, "../assets/extensions/_shared/office-lots.ts");

describe("office lot geometry twins", () => {
  it("the kernel's copy and the dashboard's copy are identical", () => {
    expect(readFileSync(KERNEL, "utf-8")).toBe(readFileSync(SHARED, "utf-8"));
  });
});
