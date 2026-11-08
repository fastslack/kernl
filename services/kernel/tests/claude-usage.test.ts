import { describe, it, expect } from "bun:test";
import { parseClaudeUsage } from "../src/core/llm/claude-usage.js";

// The shape the CLI's /usage control request returned on 2026-11-05 (trimmed).
const LIVE = {
  subscription_type: "team",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 100, resets_at: "2026-11-05T07:00:00.264503+00:00" },
    seven_day: { utilization: 91, resets_at: "2026-11-07T03:00:00.264561+00:00" },
    seven_day_opus: null,
    limits: [
      { kind: "session", group: "session", percent: 100, severity: "critical", resets_at: "2026-11-05T07:00:00.264503+00:00", scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 91, severity: "critical", resets_at: "2026-11-07T03:00:00.264561+00:00", scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 13, severity: "normal", resets_at: "2026-11-07T03:00:00.264701+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
    ],
  },
};

describe("parseClaudeUsage", () => {
  it("reads the 5-hour window, the week and each model's own week", () => {
    const u = parseClaudeUsage(LIVE);
    expect(u.plan).toBe("team");
    expect(u.windows).toEqual([
      { key: "session", pct: 100, severity: "critical", resetsAt: "2026-11-05T07:00:00.264Z", blocking: true },
      { key: "weekly", pct: 91, severity: "critical", resetsAt: "2026-11-07T03:00:00.264Z", blocking: false },
      { key: "model", model: "Fable", pct: 13, severity: "normal", resetsAt: "2026-11-07T03:00:00.264Z", blocking: false },
    ]);
  });

  it("falls back to five_hour / seven_day when there is no limits list", () => {
    const u = parseClaudeUsage({ subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 12, resets_at: null }, seven_day: { utilization: 100, resets_at: "2026-11-06T19:59:59Z" } } });
    expect(u.windows.map((w) => [w.key, w.pct, w.blocking])).toEqual([["session", 12, false], ["weekly", 100, true]]);
  });

  it("says when the plan has no limits to show (API key sessions)", () => {
    const u = parseClaudeUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null });
    expect(u.windows).toEqual([]);
    expect(u.error).toBeTruthy();
  });

  it("an active window under 100% is the one in use, not a stop", () => {
    const u = parseClaudeUsage({ rate_limits_available: true, rate_limits: { limits: [
      { kind: "session", percent: 75, severity: "warning", resets_at: "2026-11-05T07:10:00Z", is_active: true },
      { kind: "weekly_all", percent: 0, severity: "normal", resets_at: "2026-11-06T03:00:00Z", is_active: false },
      { kind: "weekly_scoped", percent: 100, scope: { model: { display_name: "Fable" } }, is_active: false },
    ] } });
    expect(u.windows.map((w) => [w.key, w.blocking])).toEqual([["session", false], ["weekly", false], ["model", false]]);
  });

  it("clamps odd percentages and ignores unreadable rows", () => {
    const u = parseClaudeUsage({ rate_limits_available: true, rate_limits: { limits: [{ kind: "session", percent: 140 }, { kind: "weird" }, null] } });
    expect(u.windows).toEqual([{ key: "session", pct: 100, severity: "critical", resetsAt: null, blocking: true }]);
  });
});
