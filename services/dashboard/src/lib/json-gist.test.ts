import { describe, it, expect } from "bun:test";
import { findJson, gistOf, textGist } from "./json-gist.js";
import { goalBadge } from "./goal-parts.js";
import { liveResultGist, liveCallParts, liveStepSummary, liveStepTags, summarizeToolCall } from "./live-steps.js";

const ev = (data: Record<string, unknown>, event = "agent:flow:step") => ({ event, ts: "2026-01-01T00:00:00Z", data }) as any;

describe("findJson", () => {
  it("reads a payload cut short by the server", () => {
    const f = findJson('Ticket T-9. Your input:\n\n```json\n{\n  "repo": "api",\n  "issue": 2915,\n  "title": "Fix units",\n  "diff": "diff --git a/x b/x\\n@@ -2,7 +2');
    expect(f?.partial).toBe(true);
    expect(f?.data).toMatchObject({ repo: "api", issue: 2915, title: "Fix units" });
    expect(f?.before.trim()).toBe("Ticket T-9. Your input:");
  });
});

describe("a cut goal still names its ticket", () => {
  it("chips the repo and issue", () => {
    expect(goalBadge('Ticket T-9. Your input:\n```json\n{"repo":"api","issue":2915,"title":"Fix units","diff":"@@ -2')).toEqual({ tag: "api #2915", title: "Fix units" });
  });
});

describe("gistOf", () => {
  it("leads with how it went, one level down too, and skips ids and times", () => {
    const g = gistOf({ ok: true, result: { id: "e2e_run-x", op: "e2e_run", status: "failed", started: "2026-11-19T00:00:00Z" } });
    expect(g.chips).toEqual([{ k: "", v: "✓ ok", tone: "good" }, { k: "", v: "failed", tone: "bad" }, { k: "op", v: "e2e_run", tone: undefined }]);
  });
  it("turns a refusal into a red chip and its reason into text", () => {
    const g = gistOf({ refuse: true, reason: "Measured in DEV: criterion 8 is not met at 1710x895, the page scrolls." });
    expect(g.chips[0]).toEqual({ k: "", v: "⚠ refuse", tone: "bad" });
    expect(g.text).toContain("criterion 8");
  });
});

describe("LIVE rows", () => {
  it("reads a JSON tool result as chips", () => {
    const g = liveResultGist('{"ok":true,"result":{"id":"e2e_run-mwnqi3j5","op":"e2e_run","status":"failed","started":"2026-11-19');
    expect(g?.chips.map((c) => c.v)).toEqual(["✓ ok", "failed", "e2e_run"]);
  });
  it("leaves prose results alone", () => {
    expect(liveResultGist("4 lines of output")).toBeNull();
  });
  it("drops the cd prefix and chips a command's JSON argument", () => {
    const input = JSON.stringify({ command: `cd /workspace/agents-office && bin/ops skill_lesson '{"skill":"qa","issue":"web#2922","lesson":"x"}'` });
    expect(liveCallParts("Bash", input)).toEqual({ text: "$ bin/ops skill_lesson", args: [{ k: "skill", v: "qa" }, { k: "issue", v: "web#2922" }, { k: "lesson", v: "x" }] });
    expect(summarizeToolCall("Bash", JSON.stringify({ command: "cd /w && ls" }))).toBe("$ ls");
  });
  it("splits a closing answer into its words and its JSON's chips", () => {
    const e = ev({ type: "final", content_preview: 'Rechazo el cierre. json {"refuse":true,"reason":"Medí en DEV y no se cumple el criterio 8 de la página."}' });
    expect(liveStepSummary(e)).toBe("Rechazo el cierre.");
    expect(liveStepTags(e)[0]).toMatchObject({ v: "⚠ refuse", tone: "bad" });
  });
  it("has nothing to say about plain text", () => {
    expect(textGist("just words")).toBeNull();
  });
});
