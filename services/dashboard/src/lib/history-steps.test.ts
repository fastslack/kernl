/**
 * HISTORY must open every row into the same detail LIVE shows. Its rows come
 * from two places — the stored run steps and the run's event log — and both
 * have to be turned into the shape the LIVE renderers already understand.
 */

import { describe, it, expect } from "bun:test";
import { stepAsFlowEvent, historyStepDetail, eventLogToFlowEvents, groupHistoryRows, toolChips, looksFailed, storedErrorFlag } from "./history-steps.js";
import { liveStepSummary } from "./live-steps.js";
import { liveEventDetail } from "./live-event-detail.js";

const step = (over: Record<string, unknown>) => ({
  step_number: 2, type: "tool_call", content: "", tool_name: "", tool_input: "{}", tool_output: "", ...over,
});
const log = (event_subtype: string, raw: Record<string, unknown>, event_type = "run", detail = "") => ({
  event_type, event_subtype, detail, raw_data: JSON.stringify(raw), created_at: "2026-10-02T18:39:10.000Z",
});

describe("stepAsFlowEvent", () => {
  it("feeds a tool call's input to the LIVE summarizer", () => {
    const e = stepAsFlowEvent(step({ tool_name: "ToolSearch", tool_input: '{"query":"select:mcp__kernel__kernel_agents_directory"}' }));
    expect(e.data.type).toBe("tool_call");
    expect(liveStepSummary(e)).not.toBe("");
    expect(String(e.data.content_preview)).toContain("kernel_agents_directory");
  });

  it("feeds a tool result its output, and a thought its text", () => {
    expect(stepAsFlowEvent(step({ type: "tool_result", tool_output: "ok" })).data.content_preview).toBe("ok");
    expect(stepAsFlowEvent(step({ type: "thought", content: "hmm" })).data.content_preview).toBe("hmm");
  });
});

describe("historyStepDetail", () => {
  it("shows a tool call's whole input, pretty-printed and labelled with the tool", () => {
    const d = historyStepDetail(step({ tool_name: "mcp__kernel__kernel_agents_directory", tool_input: '{"flow_id":"ops","limit":5}' }));
    expect(d.label).toBe("Input");
    expect(d.body).toContain("```json");
    expect(d.body).toContain('"flow_id": "ops"');
    expect(d.empty).toBe(false);
  });

  it("pretty-prints a JSON tool result in full — no truncation", () => {
    const big = JSON.stringify({ flows: Array.from({ length: 80 }, (_, i) => ({ id: `f${i}`, name: `Office ${i}` })) });
    const d = historyStepDetail(step({ type: "tool_result", tool_output: big }));
    expect(d.label).toBe("Output");
    expect(d.body).toContain('"name": "Office 79"');
    expect(d.body).not.toMatch(/truncated/i);
  });

  it("renders a prose result as text and says when nothing came back", () => {
    expect(historyStepDetail(step({ type: "tool_result", tool_output: "Posted to **Nadia**" })).body).toContain("Posted to **Nadia**");
    const none = historyStepDetail(step({ type: "tool_result", tool_output: "" }));
    expect(none.empty).toBe(true);
    expect(none.body).toMatch(/^No output/);
  });

  it("thoughts and finals show their text", () => {
    expect(historyStepDetail(step({ type: "thought", content: "Voy a revisar mi inbox" }))).toEqual(
      { label: "", body: "Voy a revisar mi inbox", empty: false });
  });

  it("a call with no arguments says so instead of printing {}", () => {
    expect(historyStepDetail(step({ tool_name: "kernel_agents_inbox", tool_input: "{}" }))).toMatchObject({ empty: true, label: "Input" });
  });
});

describe("eventLogToFlowEvents", () => {
  it("run started → the goal and the trigger", () => {
    const [e] = eventLogToFlowEvents(log("started", { goal: "Ship it", trigger_type: "manual" }), "run-1");
    expect(e.event).toBe("agent:flow:run_started");
    expect(e.data).toMatchObject({ goal: "Ship it", trigger_type: "manual", run_id: "run-1" });
  });

  it("run completed → status, counts, result and error", () => {
    const [e] = eventLogToFlowEvents(
      log("completed", { status: "failed", steps_count: 3, tokens_used: 90, result_preview: "", error: "boom" }), "run-1");
    expect(e.event).toBe("agent:flow:run_completed");
    const d = liveEventDetail(e)!;
    expect(d.copyText).toContain("boom");
    expect(d.copyText).toContain("Failed");
  });

  it("a self-eval that drew a lesson and retired others opens into three rows, like LIVE", () => {
    const evs = eventLogToFlowEvents(log("auto_eval", {
      score: 2, outcome: "failure", confidence: 0.9, issues: "- skipped the inbox",
      learning: { id: "l-1", type: "avoid", content: "Always read the inbox first", confidence: 0.4 },
      retired_learnings: [{ id: "l-0", type: "insight", content: "old idea", confidence: 0.1 }],
    }), "run-1");
    expect(evs.map((e) => e.event)).toEqual([
      "agent:flow:auto_eval", "agent:flow:learning_created", "agent:flow:learning_deactivated",
    ]);
    expect(liveEventDetail(evs[0])!.copyText).toContain("skipped the inbox");
    expect(liveEventDetail(evs[1])!.copyText).toContain("Always read the inbox first");
    expect(liveEventDetail(evs[2])!.copyText).toContain("old idea");
  });

  it("an older self-eval (score only) still opens, with what it has", () => {
    const evs = eventLogToFlowEvents(log("auto_eval", { score: 4, outcome: "success", confidence: 0.7, has_lesson: false }), "r");
    expect(evs).toHaveLength(1);
    expect(liveEventDetail(evs[0])!.copyText).toContain("4 / 5");
  });

  it("an unknown event keeps its fields instead of disappearing", () => {
    const [e] = eventLogToFlowEvents(log("budget_warning", { remaining: 12 }, "agent", "low budget"), "r");
    expect(e.event).toBe("agent:flow:budget_warning");
    expect(liveEventDetail(e)!.copyText).toContain("12");
  });

  it("tolerates a broken raw_data", () => {
    const evs = eventLogToFlowEvents({ ...log("started", {}), raw_data: "{not json" }, "r");
    expect(evs[0].event).toBe("agent:flow:run_started");
  });
});

describe("groupHistoryRows", () => {
  const s = (n: number, type: string, tool = "", extra: Record<string, unknown> = {}) =>
    ({ step_number: n, type, content: "", tool_name: tool, tool_input: "{}", tool_output: "", ...extra }) as never;

  it("folds a run of tool steps into one row, pairing each call with its result", () => {
    const rows = groupHistoryRows([
      s(1, "thought", "", { content: "plan" }),
      s(2, "tool_call", "ToolSearch", { tool_input: '{"query":"select:x"}' }),
      s(3, "tool_result", "ToolSearch"),
      s(4, "tool_call", "mcp__kernel__kernel_agents_directory"),
      s(5, "tool_result", "mcp__kernel__kernel_agents_directory", { tool_output: '{"flows":[],"unassigned":[]}' }),
      s(6, "thought", "", { content: "done" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["step", "tools", "step"]);
    const g = rows[1] as Extract<ReturnType<typeof groupHistoryRows>[number], { kind: "tools" }>;
    expect(g.uses.map((u) => u.name)).toEqual(["ToolSearch", "kernel_agents_directory"]);
    expect(g.uses.every((u) => u.ok)).toBe(true);
    expect(g.range).toBe("2–5");
    expect(g.uses[1].result?.step_number).toBe(5);
  });

  it("a lone tool call stays an ordinary row", () => {
    expect(groupHistoryRows([s(1, "tool_call", "A")]).map((r) => r.kind)).toEqual(["step"]);
  });

  it("marks a failed tool so the chip can say so", () => {
    const rows = groupHistoryRows([
      s(1, "tool_call", "A"), s(2, "tool_result", "A", { tool_output: "Error: permission denied" }),
      s(3, "tool_call", "B"), s(4, "tool_result", "B", { tool_output: "ok" }),
    ]);
    const g = rows[0] as Extract<ReturnType<typeof groupHistoryRows>[number], { kind: "tools" }>;
    expect(g.uses.map((u) => u.ok)).toEqual([false, true]);
  });

  it("a call whose result never came is still listed, as pending", () => {
    const rows = groupHistoryRows([s(1, "tool_call", "A"), s(2, "tool_result", "A"), s(3, "tool_call", "B")]);
    const g = rows[0] as Extract<ReturnType<typeof groupHistoryRows>[number], { kind: "tools" }>;
    expect(g.uses[1].name).toBe("B");
    expect(g.uses[1].result).toBeUndefined();
  });
});

describe("toolChips", () => {
  const s = (n: number, type: string, tool = "", extra: Record<string, unknown> = {}) =>
    ({ step_number: n, type, content: "", tool_name: tool, tool_input: "{}", tool_output: "", ...extra }) as never;
  const usesOf = (steps: never[]) => {
    const g = groupHistoryRows(steps)[0] as Extract<ReturnType<typeof groupHistoryRows>[number], { kind: "tools" }>;
    return g.uses;
  };
  const polls = (n: number, tool = "mcp__kernel__kernel_career_liveness", out = (_i: number) => "ok") =>
    Array.from({ length: n }, (_, i) => [
      s(i * 2 + 1, "tool_call", tool), s(i * 2 + 2, "tool_result", tool, { tool_output: out(i) }),
    ]).flat();

  it("folds 25 consecutive calls to one tool into a single chip", () => {
    const chips = toolChips(usesOf(polls(25)));
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ name: "kernel_career_liveness", count: 25, failed: 0, pending: 0 });
    expect(chips[0].uses).toHaveLength(25);
  });

  it("counts the failed calls of a run", () => {
    const chips = toolChips(usesOf(polls(5, undefined, (i) => (i === 1 || i === 3 ? "Error: boom" : "ok"))));
    expect(chips[0]).toMatchObject({ count: 5, failed: 2, pending: 0 });
  });

  it("counts a call with no result as pending, not failed", () => {
    const tool = "mcp__kernel__kernel_career_liveness";
    const chips = toolChips(usesOf([...polls(2, tool), s(5, "tool_call", tool)]));
    expect(chips[0]).toMatchObject({ count: 3, failed: 0, pending: 1 });
  });

  it("keeps non-consecutive calls to the same tool apart", () => {
    const steps = [...polls(2, "A"), s(5, "tool_call", "B"), s(6, "tool_result", "B"), s(7, "tool_call", "A"), s(8, "tool_result", "A")];
    expect(toolChips(usesOf(steps)).map((c) => `${c.name}×${c.count}`)).toEqual(["A×2", "B×1", "A×1"]);
  });
});

describe("tool result error flag", () => {
  const s = (n: number, type: string, tool = "", extra: Record<string, unknown> = {}) =>
    ({ step_number: n, type, content: "", tool_name: tool, tool_input: "{}", tool_output: "", ...extra }) as never;
  const zod = '[{"code":"invalid_type","expected":"string","received":"undefined","path":["text"],"message":"Required"}]';
  const okOf = (...steps: never[]) => {
    const g = groupHistoryRows(steps)[0] as Extract<ReturnType<typeof groupHistoryRows>[number], { kind: "tools" }>;
    return g.uses.map((u) => u.ok);
  };

  it("a recorded is_error: true marks the call failed even when the output reads fine", () => {
    expect(okOf(s(1, "tool_call", "A"), s(2, "tool_result", "A", { tool_input: '{"is_error":true}', tool_output: "ok" }))).toEqual([false]);
  });

  it("a recorded is_error: false marks the call succeeded even when the output reads as an error", () => {
    expect(okOf(s(1, "tool_call", "A"), s(2, "tool_result", "A", { tool_input: '{"is_error":false}', tool_output: "Error: boom" }))).toEqual([true]);
  });

  it("without the flag (older runs) it falls back to the output", () => {
    expect(okOf(
      s(1, "tool_call", "A"), s(2, "tool_result", "A", { tool_output: zod }),
      s(3, "tool_call", "B"), s(4, "tool_result", "B", { tool_output: "ok" }),
    )).toEqual([false, true]);
  });

  it("storedErrorFlag reads only booleans on tool_result rows", () => {
    expect(storedErrorFlag(s(1, "tool_result", "A", { tool_input: '{"is_error":true}' }))).toBe(true);
    expect(storedErrorFlag(s(1, "tool_result", "A"))).toBeUndefined();
    expect(storedErrorFlag(s(1, "tool_result", "A", { tool_input: '{"is_error":"yes"}' }))).toBeUndefined();
    expect(storedErrorFlag(s(1, "tool_call", "A", { tool_input: '{"is_error":true}' }))).toBeUndefined();
  });

  it("stepAsFlowEvent carries the flag when the step has one", () => {
    expect(stepAsFlowEvent(s(2, "tool_result", "A", { tool_input: '{"is_error":true}' })).data.is_error).toBe(true);
    expect("is_error" in stepAsFlowEvent(s(2, "tool_result", "A")).data).toBe(false);
  });
});

describe("looksFailed", () => {
  it("recognises a zod issue array", () => {
    expect(looksFailed('[{"code":"invalid_type","expected":"string","received":"undefined","path":["text"],"message":"Required"}]')).toBe(true);
    expect(looksFailed('[{"code":"too_small","minimum":1,"type":"string","inclusive":true,"path":["q"],"message":"Too short"},{"code":"custom","path":[],"message":"Bad"}]')).toBe(true);
  });

  it("does not treat an ordinary JSON array as an error", () => {
    expect(looksFailed('[{"id":1,"title":"Backend dev"},{"id":2,"title":"SRE"}]')).toBe(false);
    expect(looksFailed("[]")).toBe(false);
    // code + message alone is not enough: plenty of records have both.
    expect(looksFailed('[{"code":"AR","message":"Argentina"},{"code":"UY","message":"Uruguay"}]')).toBe(false);
    // one issue-shaped element among records is not a validation failure.
    expect(looksFailed('[{"code":"x","message":"m","path":[]},{"id":2}]')).toBe(false);
  });
});
