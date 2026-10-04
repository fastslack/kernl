/**
 * clamp / clampInt / sleep replace local copies that used to live in several
 * extensions (cinema routes, triage, google-sync, agent-advanced) and in the
 * brain module. These pin the exact semantics those copies had, so a future
 * "improvement" here cannot silently change a query-string default.
 */

import { describe, it, expect } from "bun:test";
import { clamp, clampInt, sleep } from "../src/sdk/helpers.js";
import * as sdk from "../src/sdk/index.js";

describe("clamp", () => {
  it("bounds to [min, max] without rounding", () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-3, 1, 10)).toBe(1);
    expect(clamp(42, 1, 10)).toBe(10);
    expect(clamp(2.5, 1, 10)).toBe(2.5);
    expect(clamp(1, 1, 1)).toBe(1);
  });

  it("lets NaN through (callers that need a fallback handle it first)", () => {
    expect(clamp(NaN, 1, 10)).toBeNaN();
  });
});

describe("clampInt", () => {
  it("parses and bounds an integer query param", () => {
    expect(clampInt("25", 60, 1, 500)).toBe(25);
    expect(clampInt("9999", 60, 1, 500)).toBe(500);
    expect(clampInt("0", 60, 1, 500)).toBe(1);
    expect(clampInt("-5", 0, 0, 100)).toBe(0);
    expect(clampInt("12abc", 60, 1, 500)).toBe(12);
    expect(clampInt("7.9", 60, 1, 500)).toBe(7);
  });

  it("returns the fallback, unclamped, for missing or non-numeric input", () => {
    expect(clampInt(null, 60, 1, 500)).toBe(60);
    expect(clampInt(undefined, 60, 1, 500)).toBe(60);
    expect(clampInt("", 60, 1, 500)).toBe(60);
    expect(clampInt("abc", 60, 1, 500)).toBe(60);
    expect(clampInt(null, 0, 1, 500)).toBe(0);
  });
});

describe("sleep", () => {
  it("resolves to undefined after roughly the requested delay", async () => {
    const start = Date.now();
    const value = await sleep(20);
    expect(value).toBeUndefined();
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});

describe("SDK barrel", () => {
  it("exports the helpers extensions import", () => {
    expect(sdk.clamp).toBe(clamp);
    expect(sdk.clampInt).toBe(clampInt);
    expect(sdk.sleep).toBe(sleep);
    expect(typeof sdk.formatCents).toBe("function");
    expect(typeof sdk.extractErrorMessage).toBe("function");
  });
});
