/**
 * Every row in the LIVE activity feed has to open into something useful. The
 * steps that carry a tool payload already did; the run lifecycle and the
 * self-learning events (lesson learned, self-eval, lesson dropped, handoff)
 * showed one truncated line and nothing behind it. These cases pin what each
 * of them shows when expanded.
 */

import { describe, it, expect } from "bun:test";
import type { AgentFlowEvent } from "./stores.js";
import { liveEventDetail, type DetailSection } from "./live-event-detail.js";

const ev = (event: string, data: Record<string, unknown>): AgentFlowEvent => ({
  event: `agent:flow:${event}`, data, ts: "2026-10-02T15:28:29.000Z",
});
const base = { agent_id: "a1", agent_name: "Tobias", run_id: "run-123" };

function section<K extends DetailSection["kind"]>(d: ReturnType<typeof liveEventDetail>, kind: K, label?: string) {
  return d!.sections.find((s) => s.kind === kind && (label === undefined || ("label" in s && s.label === label))) as
    Extract<DetailSection, { kind: K }> | undefined;
}
function field(d: ReturnType<typeof liveEventDetail>, label: string) {
  for (const s of d!.sections) if (s.kind === "fields") {
    const f = s.fields.find((x) => x.label === label);
    if (f) return f;
  }
  return undefined;
}

describe("liveEventDetail", () => {
  it("leaves tool steps to the payload renderer", () => {
    for (const type of ["tool_call", "tool_result", "thought", "final", "error"])
      expect(liveEventDetail(ev("step", { ...base, type, content_preview: "x" }))).toBeNull();
  });

  it("lesson learned: the whole lesson, its kind explained and its confidence", () => {
    const long = "Cuando se requiere usar una herramienta específica, verificar que esté disponible antes de planificar. ".repeat(3);
    const d = liveEventDetail(ev("learning_created", {
      ...base, learning_id: "l-9", learning_type: "avoid", content: long, confidence: 0.42,
    }));
    expect(section(d, "text", "Lesson")!.body).toBe(long.trim());
    expect(field(d, "Kind")!.value).toBe("Avoid");
    expect(field(d, "Kind")!.hint).toMatch(/not to do/i);
    expect(field(d, "Confidence")!.value).toBe("42%");
    expect(field(d, "Lesson ID")!.value).toBe("l-9");
    expect(d!.copyText).toContain(long.trim());
  });

  it("self-eval: score meter, outcome in words, and every issue as its own line", () => {
    const d = liveEventDetail(ev("auto_eval", {
      ...base, score: 1, outcome: "failure", confidence: 0.8,
      issues: "- Did not call the required tool\n- Answered without checking the inbox",
    }));
    const m = section(d, "meter")!;
    expect([m.value, m.max]).toEqual([1, 5]);
    expect(m.caption).toBe("1 / 5 · Failure");
    expect(m.tone).toBe("bad");
    expect(section(d, "list", "Issues found")!.items.map((i) => i.text)).toEqual([
      "Did not call the required tool",
      "Answered without checking the inbox",
    ]);
    expect(field(d, "Grader confidence")!.value).toBe("80%");
  });

  it("self-eval without issues says so instead of an empty list", () => {
    const d = liveEventDetail(ev("auto_eval", { ...base, score: 5, outcome: "success", confidence: 0.9, issues: "" }));
    expect(section(d, "meter")!.tone).toBe("good");
    expect(section(d, "list", "Issues found")!.items).toEqual([]);
    expect(section(d, "list", "Issues found")!.empty).toMatch(/no issues/i);
  });

  it("run completed: status, steps, tokens, the result and the error when it failed", () => {
    const ok = liveEventDetail(ev("run_completed", {
      ...base, status: "completed", steps_count: 9, tokens_used: 12655, result_preview: "Carta enviada a Nadia.",
    }));
    expect(field(ok, "Status")!).toMatchObject({ value: "Completed", tone: "good" });
    expect(field(ok, "Steps")!.value).toBe("9");
    expect(field(ok, "Tokens")!.value).toBe("12,655");
    expect(section(ok, "text", "Result")!.body).toBe("Carta enviada a Nadia.");
    expect(section(ok, "text", "Error")).toBeUndefined();

    const bad = liveEventDetail(ev("run_completed", {
      ...base, status: "failed", steps_count: 2, tokens_used: 0, result_preview: "", error: "Rate limited by provider",
    }));
    expect(field(bad, "Status")!).toMatchObject({ value: "Failed", tone: "bad" });
    expect(section(bad, "text", "Error")!.body).toBe("Rate limited by provider");
  });

  it("run started: the full goal and what triggered it", () => {
    const goal = "Resolve every question in triage.\n- Answer it yourself…";
    const d = liveEventDetail(ev("run_started", { ...base, goal, trigger_type: "schedule" }));
    expect(section(d, "text", "Goal")!.body).toBe(goal);
    expect(field(d, "Trigger")!.value).toBe("Scheduled");
    expect(field(d, "Run ID")!.value).toBe("run-123");
  });

  it("handoff: who receives the work and through which chain", () => {
    const d = liveEventDetail(ev("chain_triggered", {
      source_agent_id: "a1", source_agent_name: "Tobias", target_agent_id: "a2",
      target_agent_name: "Nadia", chain_id: "c1", chain_label: "review", run_id: "run-123",
    }));
    expect(field(d, "From")!.value).toBe("Tobias");
    expect(field(d, "To")!.value).toBe("Nadia");
    expect(field(d, "Chain")!.value).toBe("review");
  });

  it("lesson dropped: lists the lessons that were retired, with their text", () => {
    const d = liveEventDetail(ev("learning_deactivated", {
      ...base, count: 2,
      learnings: [
        { id: "l1", type: "insight", content: "Prefer the search tool", confidence: 0.12 },
        { id: "l2", type: "avoid", content: "Do not retry on 4xx", confidence: 0.1 },
      ],
    }));
    const list = section(d, "list", "Retired lessons")!;
    expect(list.items.map((i) => i.text)).toEqual(["Prefer the search tool", "Do not retry on 4xx"]);
    expect(list.items[0].meta).toBe("Insight · 12%");
    expect(section(d, "note")!.body).toMatch(/confidence/i);
  });

  it("lesson dropped from an older kernel (count only) still explains what happened", () => {
    const d = liveEventDetail(ev("learning_deactivated", { ...base, count: 3 }));
    expect(field(d, "Lessons retired")!.value).toBe("3");
    expect(section(d, "note")!.body).toMatch(/confidence/i);
  });

  it("any other event falls back to its fields, never to nothing", () => {
    const d = liveEventDetail(ev("something_new", { ...base, reason: "budget", attempts: 3, nested: { a: 1 } }));
    expect(field(d, "Reason")!.value).toBe("budget");
    expect(field(d, "Attempts")!.value).toBe("3");
    expect(section(d, "text", "Nested")!.body).toContain('"a": 1');
  });

  it("returns null when an event carries nothing beyond its ids", () => {
    expect(liveEventDetail(ev("auto_eval_started", { ...base }))).not.toBeNull(); // explained even when empty
    expect(liveEventDetail(ev("something_empty", { agent_id: "a1", agent_name: "T" }))).toBeNull();
  });
});
