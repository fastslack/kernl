/**
 * The LIVE timeline is what a person watches while an agent works, so every
 * step has to say something. These cases pin the summaries that used to live
 * — untested — inside the 3D component: tool calls, tool results, the JSON
 * previews the server truncates, and the Δt / token chips.
 */

import { describe, it, expect } from "bun:test";
import type { AgentFlowEvent } from "./stores.js";
import { liveToolRows } from "./live-steps.js";
import {
  liveStepIcon,
  liveStepLabel,
  liveEventType,
  liveEventSummary,
  toolCategory,
  tryParseJson,
  basenameOf,
  summarizeToolCall,
  summarizeToolResult,
  summarizeText,
  liveStepSummary,
  liveStepCategory,
  liveFmtDelta,
  liveFmtTokens,
  liveStepDeltaMs,
  liveStepTokens,
  liveStepTokensTotal,
  runElapsedMs,
  runTokensTotal,
} from "./live-steps.js";

function ev(data: Record<string, unknown>, event = "agent:step", ts = "2026-09-12T10:00:00.000Z"): AgentFlowEvent {
  return { event, data, ts };
}

describe("liveStepIcon / liveStepLabel", () => {
  it("names the step types a run actually emits", () => {
    expect(liveStepIcon("tool_call")).toBe("🔧");
    expect(liveStepLabel("tool_call")).toBe("calling tool");
    expect(liveStepLabel("chain_triggered")).toBe("handoff");
  });

  it("falls back to the raw type rather than showing nothing", () => {
    expect(liveStepIcon("brand_new")).toBe("•");
    expect(liveStepLabel("brand_new")).toBe("brand_new");
    expect(liveStepLabel("")).toBe("step");
  });
});

describe("liveEventType", () => {
  it("reads the step's own type for step events", () => {
    expect(liveEventType(ev({ type: "tool_result" }))).toBe("tool_result");
  });

  it("uses the last event segment otherwise", () => {
    expect(liveEventType(ev({}, "agent:run_completed"))).toBe("run_completed");
  });
});

describe("liveEventSummary", () => {
  it("says which lesson was retired instead of the raw event name", () => {
    expect(liveEventSummary(ev({ count: 1, learnings: [{ content: "Do not retry on 4xx" }] }, "agent:flow:learning_deactivated")))
      .toBe("Retired 1 lesson: Do not retry on 4xx");
    expect(liveEventSummary(ev({ count: 3 }, "agent:flow:learning_deactivated")))
      .toBe("Retired 3 lessons below the confidence floor");
  });

  it("distinguishes a builtin run from a prompted one", () => {
    expect(liveEventSummary(ev({ builtin: true }, "agent:run_started")))
      .toBe("Builtin run (native code, no prompt)");
    expect(liveEventSummary(ev({ goal: "ship" }, "agent:run_started")))
      .toBe("Started — goal: ship");
  });

  it("reports a non-completed finish by its status", () => {
    expect(liveEventSummary(ev({ status: "failed" }, "agent:run_completed"))).toBe("Run failed");
  });

  it("wraps a tool_call preview in a json fence", () => {
    const out = liveEventSummary(ev({ type: "tool_call", tool_name: "Bash", content_preview: '{"command":"ls"}' }));
    expect(out.startsWith("```json")).toBe(true);
    expect(out).toContain("Bash(");
  });

  it("marks a tool_result whose json was cut mid-string as truncated", () => {
    const cut = '{"rows":[{"id":"a"},{"id":"b"';
    const out = liveEventSummary(ev({ type: "tool_result", content_preview: cut }));
    expect(out).toContain("```json");
    expect(out).toContain("truncated");
  });
});

describe("toolCategory", () => {
  it("buckets the tools the timeline colours", () => {
    expect(toolCategory("Bash")).toBe("shell");
    expect(toolCategory("Read")).toBe("fs");
    expect(toolCategory("WebSearch")).toBe("web");
    expect(toolCategory("kernel_tasks_create")).toBe("kernel");
    expect(toolCategory("mcp__x__y")).toBe("mcp");
    expect(toolCategory("TodoWrite")).toBe("meta");
  });

  it("is 'tool' for anything unknown or empty", () => {
    expect(toolCategory("Whatever")).toBe("tool");
    expect(toolCategory("")).toBe("tool");
  });
});

describe("tryParseJson / basenameOf", () => {
  it("parses a plain json payload", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("stops at the first successful parse of a double-encoded payload", () => {
    // The peel branch below the first `JSON.parse` is unreachable for this
    // shape: parsing a JSON-encoded string succeeds and returns the inner
    // string, so the function returns before it can peel again. Documented
    // rather than changed — callers have always seen the string.
    expect(tryParseJson(JSON.stringify('{"a":1}'))).toBe('{"a":1}');
  });

  it("returns null instead of throwing on junk", () => {
    expect(tryParseJson("{not json")).toBeNull();
    expect(tryParseJson("")).toBeNull();
  });

  it("takes the last path segment, on either separator", () => {
    expect(basenameOf("/src/index.ts")).toBe("index.ts");
    expect(basenameOf("C:\\tmp\\x.md")).toBe("x.md");
    expect(basenameOf("")).toBe("");
  });
});

describe("summarizeToolCall", () => {
  it("says which agent the chief changed and what, instead of a raw id=…", () => {
    expect(summarizeToolCall(
      "mcp__kernel__kernel_agents_update",
      '{"id":"d22f8c60-cfaf-4230-b0e7-3bb1def7f9c9","max_iterations":40}',
    )).toBe("Change agent d22f8c60 settings · max_iterations → 40");
    expect(summarizeToolCall(
      "kernel_agents_flows_update",
      '{"id":"4dbe35a9-0b32","name":"Career Office","description":"x"}',
    )).toBe("Change office 4dbe35a9 settings · name → Career Office · description → x");
  });
  it("prefers a Bash description over the command", () => {
    expect(summarizeToolCall("Bash", '{"description":"List files","command":"ls -la"}')).toBe("List files");
    expect(summarizeToolCall("Bash", '{"command":"ls -la"}')).toBe("$ ls -la");
  });

  it("names the file for fs tools, with the line range when given", () => {
    expect(summarizeToolCall("Read", '{"file_path":"/a/b/index.ts","offset":10,"limit":5}'))
      .toBe("Read index.ts · L10–15");
    expect(summarizeToolCall("Edit", '{"file_path":"/a/x.ts","replace_all":true}'))
      .toBe("Edit x.ts (replace all)");
  });

  it("falls back to the tool name when the payload is unusable", () => {
    expect(summarizeToolCall("kernel_thing", "{not json")).toBe("kernel_thing");
    expect(summarizeToolCall("", "{}")).toBe("calling tool");
  });

  it("shows the first couple of scalar args for an unknown tool", () => {
    expect(summarizeToolCall("kernel_rss_add", '{"url":"http://x.dev","title":"X","opts":{"deep":true}}'))
      .toBe("kernel_rss_add · url=http://x.dev · title=X");
  });
});

describe("summarizeToolResult / summarizeText", () => {
  it("says so when there is no output", () => {
    expect(summarizeToolResult("Bash", "")).toBe("no output");
  });

  it("counts array items and object fields", () => {
    expect(summarizeToolResult("x", "[1,2,3]")).toBe("3 items");
    expect(summarizeToolResult("x", '{"a":1,"b":2,"c":3}')).toContain("3 fields");
  });

  it("surfaces an error field first", () => {
    expect(summarizeToolResult("x", '{"error":"nope"}')).toBe("error · nope");
  });

  it("unwraps an MCP text envelope and counts its lines", () => {
    const payload = JSON.stringify({ content: [{ type: "text", text: "a\nb\nc" }] });
    expect(summarizeToolResult("Bash", payload)).toContain("3 lines");
  });

  it("counts grep matches and glob paths by shape", () => {
    expect(summarizeText("Grep", "a.ts:1:x\nb.ts:2:y")).toContain("2 matches");
    expect(summarizeText("Glob", "/a/b.ts\n/c/d.ts")).toBe("2 paths");
  });
});

describe("liveStepSummary / liveStepCategory", () => {
  it("routes tool steps through the summarizers", () => {
    expect(liveStepSummary(ev({ type: "tool_call", tool_name: "LS", content_preview: '{"path":"/srv"}' })))
      .toBe("List srv");
  });

  it("never returns an empty line for a thought without preview", () => {
    expect(liveStepSummary(ev({ type: "thought", content_preview: "" }))).toBe("thinking…");
  });

  it("defers run lifecycle events to the prose summary", () => {
    expect(liveStepSummary(ev({ status: "completed" }, "agent:run_completed")))
      .toBe("Run completed successfully");
  });

  it("colours by tool for tool steps and by kind otherwise", () => {
    expect(liveStepCategory(ev({ type: "tool_call", tool_name: "Bash" }))).toBe("shell");
    expect(liveStepCategory(ev({ type: "thought" }))).toBe("think");
    expect(liveStepCategory(ev({ type: "rate_limit_wait" }))).toBe("error");
    expect(liveStepCategory(ev({}, "agent:run_started"))).toBe("meta");
  });
});

describe("chips", () => {
  it("formats durations compactly and returns '' for nothing", () => {
    expect(liveFmtDelta(450)).toBe("450ms");
    expect(liveFmtDelta(1500)).toBe("1.5s");
    expect(liveFmtDelta(65_000)).toBe("1m05s");
    expect(liveFmtDelta(120_000)).toBe("2m");
    expect(liveFmtDelta(-1)).toBe("");
  });

  it("formats token counts and returns '' for zero", () => {
    expect(liveFmtTokens(0)).toBe("");
    expect(liveFmtTokens(950)).toBe("950");
    expect(liveFmtTokens(1500)).toBe("1.5k");
    expect(liveFmtTokens(2_500_000)).toBe("2.5M");
  });
});

describe("buffer maths", () => {
  // Newest first — the order the component keeps.
  const events: AgentFlowEvent[] = [
    ev({ tokens: 10, tokens_total: 300 }, "agent:step", "2026-09-12T10:00:10.000Z"),
    ev({ tokens_total: 200 }, "agent:step", "2026-09-12T10:00:04.000Z"),
    ev({}, "agent:step", "2026-09-12T10:00:00.000Z"),
  ];

  it("measures Δt against the previous event in time", () => {
    expect(liveStepDeltaMs(events, 0)).toBe(6000);
    expect(liveStepDeltaMs(events, 2)).toBeNull();
  });

  it("reads per-step tokens, ignoring missing ones", () => {
    expect(liveStepTokens(events[0])).toBe(10);
    expect(liveStepTokens(events[2])).toBe(0);
  });

  it("walks back to the last known cumulative total", () => {
    expect(liveStepTokensTotal(events, 0)).toBe(300);
    expect(liveStepTokensTotal(events, 2)).toBe(0);
  });

  it("spans the whole buffer for elapsed time and total tokens", () => {
    expect(runElapsedMs(events)).toBe(10_000);
    expect(runTokensTotal(events)).toBe(300);
    expect(runElapsedMs([events[0]])).toBe(0);
  });
});

describe("liveToolRows", () => {
  let t = 0;
  const ev = (type: string, tool = "", preview = ""): AgentFlowEvent => ({
    event: "agent:flow:step",
    data: { type, tool_name: tool, content_preview: preview },
    ts: `2026-10-02T18:00:${String(t++).padStart(2, "0")}.000Z`,
  });
  // The buffer is newest first, so build it oldest-first and reverse.
  const buffer = (...xs: AgentFlowEvent[]) => xs.reverse();
  const polls = (n: number, tool = "kernel_career_liveness", out = (_i: number) => "ok") =>
    Array.from({ length: n }, (_, i) => [ev("tool_call", tool, "{}"), ev("tool_result", tool, out(i))]).flat();

  it("folds repeated calls with their results into one row", () => {
    const rows = liveToolRows(buffer(ev("thought", "", "hm"), ...polls(25), ev("final", "", "done")));
    expect(rows.map((r) => r.kind)).toEqual(["event", "tools", "event"]);
    const g = rows[1] as Extract<ReturnType<typeof liveToolRows>[number], { kind: "tools" }>;
    expect(g).toMatchObject({ tool: "kernel_career_liveness", calls: 25, failed: 0, pending: 0 });
    expect(g.items).toHaveLength(50);
    expect(g.items.map((x) => x.i)).toEqual(Array.from({ length: 50 }, (_, k) => k + 1));
  });

  it("leaves a single call and its result as two rows", () => {
    expect(liveToolRows(buffer(...polls(1))).map((r) => r.kind)).toEqual(["event", "event"]);
  });

  it("counts failures and a call still waiting for its result", () => {
    const xs = buffer(...polls(3, "A", (i) => (i === 0 ? "Error: nope" : "ok")), ev("tool_call", "A", "{}"));
    const g = liveToolRows(xs)[0] as Extract<ReturnType<typeof liveToolRows>[number], { kind: "tools" }>;
    expect(g).toMatchObject({ calls: 4, failed: 1, pending: 1 });
  });

  it("keeps its key while the run grows at the front", () => {
    const base = polls(2, "A");
    const k1 = (liveToolRows(buffer(...base))[0] as { key: string }).key;
    const k2 = (liveToolRows(buffer(...base, ...polls(1, "A")))[0] as { key: string }).key;
    expect(k2).toBe(k1);
  });

  it("a result's is_error flag wins over its text, both ways", () => {
    const res = (preview: string, is_error?: boolean): AgentFlowEvent => {
      const e = ev("tool_result", "A", preview);
      if (is_error !== undefined) e.data.is_error = is_error;
      return e;
    };
    const xs = buffer(
      ev("tool_call", "A", "{}"), res("ok", true),
      ev("tool_call", "A", "{}"), res("Error: nope", false),
      ev("tool_call", "A", "{}"), res('[{"code":"invalid_type","expected":"string","received":"undefined","path":["text"],"message":"Required"}]'),
    );
    const g = liveToolRows(xs)[0] as Extract<ReturnType<typeof liveToolRows>[number], { kind: "tools" }>;
    expect(g).toMatchObject({ calls: 3, failed: 2, pending: 0 });
  });

  it("does not merge calls to the same tool across another tool", () => {
    const rows = liveToolRows(buffer(...polls(2, "A"), ...polls(1, "B"), ...polls(2, "A")));
    expect(rows.map((r) => (r.kind === "tools" ? `${r.tool}×${r.calls}` : "ev"))).toEqual(["A×2", "ev", "ev", "A×2"]);
  });
});
