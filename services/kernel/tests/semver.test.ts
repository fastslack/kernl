import { describe, it, expect } from "bun:test";
import { compareSemver, isNewer } from "../src/core/semver.js";

describe("compareSemver", () => {
  it("orders by major, minor, patch", () => {
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemver("1.3.0", "1.2.9")).toBe(1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });
  it("tolerates leading v and missing components", () => {
    expect(compareSemver("v1.2.0", "1.2.0")).toBe(0);
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
    expect(compareSemver("1", "1.0.1")).toBe(-1);
  });
  it("ignores pre-release/build suffixes (numeric core only)", () => {
    expect(compareSemver("1.2.3-beta.1", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.4-rc1", "1.2.3")).toBe(1);
  });
  it("isNewer is strict greater-than", () => {
    expect(isNewer("1.1.0", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("0.9.0", "1.0.0")).toBe(false);
  });
});
