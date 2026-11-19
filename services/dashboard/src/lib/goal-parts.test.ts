import { describe, it, expect } from "bun:test";
import { goalParts, extractJsonObject, goalBadge } from "./goal-parts.js";
import { liveEventDetail } from "./live-event-detail.js";
import { liveStepSummary, liveStepTags, liveStepCategory } from "./live-steps.js";

const GOAL = 'Ticket T-1. Your input: ```json {"repo":"web","issue":42,"title":"Fix the login button","url":"https://example.com/i/42","summary":{"files":["a.js","b.js"],"note":"short"}} ``` You work this ticket as its writer.';

const ev = (data: Record<string, unknown>, event = "agent:run_started") =>
  ({ event, ts: "2026-01-01T00:00:00Z", data }) as any;

describe("goalParts", () => {
  it("pulls title and short fields out of a fenced JSON input", () => {
    const g = goalParts(GOAL);
    expect(g.title).toBe("Fix the login button");
    expect(g.tags).toEqual([{ k: "repo", v: "web" }, { k: "issue", v: "#42" }]);
    expect(g.prose).toContain("Ticket T-1. Your input");
    expect(g.prose).toContain("You work this ticket as its writer.");
  });

  it("finds a bare object too", () => {
    expect(extractJsonObject('do this {"a":1,"b":"x"} then')?.data).toEqual({ a: 1, b: "x" });
  });

  it("fits a chip: first two fields and the title", () => {
    expect(goalBadge(GOAL)).toEqual({ tag: "web #42", title: "Fix the login button" });
    expect(goalBadge("ship it")).toEqual({ tag: "", title: "ship it" });
  });

  it("leaves a plain goal alone", () => {
    expect(goalParts("ship it")).toMatchObject({ title: "ship it", tags: [], data: null });
  });
});

describe("run_started rows", () => {
  it("summarizes by the input title, with tags", () => {
    const e = ev({ goal: GOAL, trigger_type: "event" });
    expect(liveStepSummary(e)).toBe("Fix the login button");
    expect(liveStepTags(e).map((t) => t.v)).toEqual(["web", "#42", "event"]);
    expect(liveStepCategory(e)).toBe("run");
  });

  it("opens into the input field by field, then the instructions", () => {
    const d = liveEventDetail(ev({ goal: GOAL, run_id: "r1" }))!;
    const labels = d.sections.flatMap((s: any) => (s.kind === "fields" ? s.fields.map((f: any) => f.label) : [s.label]));
    expect(labels).toEqual(expect.arrayContaining(["Repo", "Issue", "Title", "Url", "Summary › Note", "Summary › Files", "Instructions", "Run ID"]));
  });

  it("tags the account a run uses", () => {
    expect(liveStepTags(ev({ type: "claude_account", account: "Personal" }, "agent:flow:step"))).toEqual([{ k: "", v: "Personal", tone: undefined }]);
  });
});
