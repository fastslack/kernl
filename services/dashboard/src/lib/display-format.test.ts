/**
 * These four formatters were copied between AgentWorld3D and TriggeringSection
 * — the second file said so in a comment. Now there is one definition, and
 * these are the cases both surfaces depend on.
 */

import { describe, it, expect } from "bun:test";
import { fmtRelTime, fmtTokens, fmtClock, triggerColor, ellipsize } from "./display-format.js";

describe("fmtRelTime", () => {
  it("shows an em dash when there is no timestamp", () => {
    expect(fmtRelTime()).toBe("—");
    expect(fmtRelTime("")).toBe("—");
  });

  it("returns the input unchanged when it isn't a date", () => {
    expect(fmtRelTime("not-a-date")).toBe("not-a-date");
  });

  it("counts backwards in the largest unit that fits", () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect(fmtRelTime(ago(5_000))).toBe("5s ago");
    expect(fmtRelTime(ago(120_000))).toBe("2m ago");
    expect(fmtRelTime(ago(7_200_000))).toBe("2h ago");
    expect(fmtRelTime(ago(172_800_000))).toBe("2d ago");
  });

  it("says 'in' for a future timestamp", () => {
    const ahead = new Date(Date.now() + 120_000).toISOString();
    expect(fmtRelTime(ahead)).toBe("in 2m");
  });
});

describe("fmtTokens", () => {
  it("prints small counts verbatim and zero for nothing", () => {
    expect(fmtTokens()).toBe("0");
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
  });

  it("switches to thousands at 1000", () => {
    expect(fmtTokens(1000)).toBe("1.0k");
    expect(fmtTokens(15_400)).toBe("15.4k");
  });
});

describe("fmtClock", () => {
  it("is empty when there is no timestamp", () => {
    expect(fmtClock(undefined)).toBe("");
    expect(fmtClock("")).toBe("");
  });

  it("does not produce a clock for junk input", () => {
    // `new Date("nonsense").toLocaleTimeString()` returns "Invalid Date"
    // rather than throwing, so the try/catch never fires. What matters to
    // the caller is that it isn't rendered as a time.
    expect(fmtClock("nonsense")).not.toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("renders 24h HH:MM:SS", () => {
    expect(fmtClock("2026-09-12T15:04:05Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("triggerColor", () => {
  it("gives each trigger type its own accent", () => {
    const seen = new Set(["manual", "chain", "schedule", "event"].map(triggerColor));
    expect(seen.size).toBe(4);
  });

  it("falls back to grey for anything unknown", () => {
    expect(triggerColor("wat")).toBe("#8a8fa8");
  });
});

describe("ellipsize", () => {
  it("collapses whitespace", () => {
    expect(ellipsize("a   b\n c", 40)).toBe("a b c");
  });

  it("clips with an ellipsis and never exceeds the budget", () => {
    const out = ellipsize("abcdefghij", 5);
    expect(out).toBe("abcd…");
    expect(out.length).toBe(5);
  });

  it("leaves short strings alone and handles empty input", () => {
    expect(ellipsize("short", 40)).toBe("short");
    expect(ellipsize("", 10)).toBe("");
  });
});
