/**
 * The office board's fix for a failure, given the agent as it is now. The
 * first cases are the board seen on 2026-10-03: cards still asking to raise
 * a step limit the chief had already raised.
 */
import { describe, it, expect } from "bun:test";
import { explainFailure } from "./failure-explain.js";
import { planFix, raisedLimit, fmtLimit } from "./failure-fix.js";

const failedAt = Date.parse("2026-10-02T21:00:00Z");
const maxTurns = explainFailure("Claude Code returned an error result: Reached maximum number of turns (15)");

describe("planFix", () => {
  it("knows a step limit raised since the failure solved it", () => {
    expect(planFix(maxTurns, { max_iterations: 40 }, [], failedAt))
      .toEqual({ kind: "resolved", how: "limit_raised", field: "max_iterations", from: 15, to: 40 });
  });

  it("knows a later completed run solved it, whatever the cause", () => {
    const plan = planFix(explainFailure("Stale run cleaned up on startup"), {}, [
      { status: "completed", started_at: "2026-10-03T06:00:00Z", completed_at: "2026-10-03T06:05:00Z" },
    ], failedAt);
    expect(plan).toEqual({ kind: "resolved", how: "ran_ok", at: Date.parse("2026-10-03T06:05:00Z") });
  });

  it("ignores runs from before the failure", () => {
    const plan = planFix(explainFailure("Stale run cleaned up on startup"), {}, [
      { status: "completed", started_at: "2026-10-02T20:00:00Z" },
    ], failedAt);
    expect(plan).toEqual({ kind: "rerun" });
  });

  it("waits while a newer run is in flight", () => {
    expect(planFix(maxTurns, { max_iterations: 15 }, [{ status: "running", started_at: "2026-10-03T06:39:00Z" }], failedAt))
      .toEqual({ kind: "running" });
  });

  it("offers to double the step limit", () => {
    expect(planFix(maxTurns, { max_iterations: 15 }, [], failedAt))
      .toEqual({ kind: "raise", field: "max_iterations", from: 15, to: 30 });
  });

  it("stops raising at the cap and hands it to the chief", () => {
    const at100 = explainFailure("Reached maximum number of turns (100)");
    expect(planFix(at100, { max_iterations: 100 }, [], failedAt)).toEqual({ kind: "chief" });
  });

  it("raises the timeout, not past 30 minutes", () => {
    expect(planFix(explainFailure("Run timed out"), { timeout_ms: 300_000 }, [], failedAt))
      .toEqual({ kind: "raise", field: "timeout_ms", from: 300_000, to: 600_000 });
    expect(raisedLimit("timeout_ms", 20 * 60_000)).toBe(30 * 60_000);
  });

  it("never offers the chief an expired model session", () => {
    expect(planFix(explainFailure("Failed to authenticate: OAuth session expired"), {}, [], failedAt)).toEqual({ kind: "llm" });
  });

  it("hands what has no mechanical fix to the chief", () => {
    expect(planFix(explainFailure("Safety abort: 3 consecutive errors"), {}, [], failedAt)).toEqual({ kind: "chief" });
    expect(planFix(explainFailure("Something odd happened"), {}, [], failedAt)).toEqual({ kind: "chief" });
  });
});

describe("raisedLimit", () => {
  it("adds at least ten steps", () => {
    expect(raisedLimit("max_iterations", 5)).toBe(15);
    expect(raisedLimit("max_iterations", 60)).toBe(100);
  });
});

describe("fmtLimit", () => {
  it("reads each limit in its own unit", () => {
    expect(fmtLimit("timeout_ms", 300_000)).toBe("5 min");
    expect(fmtLimit("max_tokens", 50_000)).toBe("50k");
    expect(fmtLimit("max_iterations", 40)).toBe("40");
  });
});
