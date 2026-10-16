import { describe, expect, it } from "bun:test";
import {
  EVAL_EVERY_MIN_DEFAULT, evalEveryMin, hasFreshFailures, newestCreatedAt, shouldGrade,
} from "../assets/extensions/agents/agent-advanced/_module/llm-gates.js";

// Self-improvement spent US$86 a week re-grading routine runs and re-reflecting on old failures.

describe("shouldGrade", () => {
  const now = Date.parse("2026-10-16T08:00:00Z");
  it("always grades a failure", () => {
    expect(shouldGrade("failed", now - 1000, now, 60)).toBe(true);
  });
  it("grades a completed run at most once per window per agent", () => {
    expect(shouldGrade("completed", undefined, now, 60)).toBe(true);
    expect(shouldGrade("completed", now - 59 * 60_000, now, 60)).toBe(false);
    expect(shouldGrade("completed", now - 60 * 60_000, now, 60)).toBe(true);
  });
  it("a window of 0 grades every run, as before", () => {
    expect(shouldGrade("completed", now - 1000, now, 0)).toBe(true);
  });
});

describe("evalEveryMin", () => {
  it("reads __eval_every_min__ and falls back to the default", () => {
    expect(evalEveryMin('{"__eval_every_min__": 0}')).toBe(0);
    expect(evalEveryMin('{"__eval_every_min__": "15"}')).toBe(15);
    expect(evalEveryMin("{}")).toBe(EVAL_EVERY_MIN_DEFAULT);
    expect(evalEveryMin("not json")).toBe(EVAL_EVERY_MIN_DEFAULT);
    expect(evalEveryMin('{"__eval_every_min__": -3}')).toBe(EVAL_EVERY_MIN_DEFAULT);
  });
});

describe("hasFreshFailures", () => {
  const runs = [{ created_at: "2026-10-15T10:00:00Z" }, { created_at: "2026-10-16T02:00:00Z" }];
  it("the failures a previous cycle already saw do not trigger another one", () => {
    expect(hasFreshFailures(runs, "2026-10-16T02:00:00Z")).toBe(false);
    expect(hasFreshFailures(runs, "2026-10-16T05:00:00Z")).toBe(false);
  });
  it("one newer failure is enough", () => {
    expect(hasFreshFailures(runs, "2026-10-16T01:00:00Z")).toBe(true);
  });
  it("an agent never reflected on reflects", () => {
    expect(hasFreshFailures(runs, undefined)).toBe(true);
  });
  it("newestCreatedAt", () => {
    expect(newestCreatedAt(runs)).toBe("2026-10-16T02:00:00Z");
    expect(newestCreatedAt([])).toBeUndefined();
  });
});
