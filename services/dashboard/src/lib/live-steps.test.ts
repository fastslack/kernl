/**
 * The LIVE timeline is what a person watches while an agent works, so every
 * step has to say something. These cases pin the summaries that used to live
 * — untested — inside the 3D component: tool calls, tool results, the JSON
 * previews the server truncates, and the Δt / token chips.
 */

import { describe, it, expect } from "bun:test";
import type { AgentFlowEvent } from "./stores.js";
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
