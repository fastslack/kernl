/**
 * These helpers decide what the agent panels show: which glyph, which colour,
 * which link an option opens, where an agent's files live. Each had exactly
 * one home — the middle of an 11k-line component — and no test.
 */

import { describe, it, expect } from "bun:test";
import {
  hexToNum,
  toolGlyph,
  escapeBannerText,
  firstUrlIn,
  urlForOption,
  buildFixerGoal,
  mgmtKindIcon,
  mgmtKindColor,
  safeParse,
  emailCommId,
  resolveAgentWorkspace,
  dependsOnGoogleAuth,
  formatAgentRecentRuns,
  initials,
  parseMeetingTopics,
} from "./agent-helpers.js";

describe("hexToNum", () => {
  it("converts a css hex to a three.js colour number", () => {
    expect(hexToNum("#5b8def")).toBe(0x5b8def);
    expect(hexToNum("ffffff")).toBe(0xffffff);
  });

  it("falls back when the input is empty or not hex", () => {
    expect(hexToNum("", 0x123456)).toBe(0x123456);
    expect(hexToNum("not-a-colour", 0x123456)).toBe(0x123456);
  });
});

describe("toolGlyph", () => {
  it("matches on the tool's subject, not its exact name", () => {
    expect(toolGlyph("kernel_email_send")).toBe("📧");
    expect(toolGlyph("kernel_fs_list")).toBe("📁");
    expect(toolGlyph("kernel_graph_query")).toBe("🧠");
  });

  it("checks the memory/graph subject before the generic agent one", () => {
    // `agent` appears in the name too, but the graph/memory rule comes first.
    expect(toolGlyph("kernel_agents_memory")).toBe("🧠");
  });

  it("falls back to a wrench for unknown or empty names", () => {
    expect(toolGlyph("")).toBe("🔧");
    expect(toolGlyph("kernel_whatever")).toBe("🔧");
    // Worth pinning: the brain tools do NOT match — the rule looks for
    // "memory" or "graph", and `kernel_brain_recall` contains neither.
    expect(toolGlyph("kernel_brain_recall")).toBe("🔧");
  });
});

describe("escapeBannerText", () => {
  it("escapes the five html characters", () => {
    expect(escapeBannerText(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("firstUrlIn / urlForOption", () => {
  it("finds the first url in free text", () => {
    expect(firstUrlIn("see https://example.com/x and more")).toBe("https://example.com/x");
    expect(firstUrlIn("no links here")).toBeNull();
    expect(firstUrlIn(null)).toBeNull();
  });

  it("prefers an explicit option url", () => {
    const q = { context: "https://fallback.dev" };
    expect(urlForOption(q, { label: "Open", url: "https://explicit.dev" })).toBe("https://explicit.dev");
  });

  it("falls back to the context url when the label hints at a link", () => {
    const q = { context: "details at https://fallback.dev" };
    expect(urlForOption(q, { label: "View report" })).toBe("https://fallback.dev");
    expect(urlForOption(q, { label: "Approve" })).toBeNull();
  });

  it("ignores a non-http url on the option", () => {
    const q = { context: null };
    expect(urlForOption(q, { label: "Approve", url: "javascript:alert(1)" })).toBeNull();
  });
});

describe("buildFixerGoal", () => {
  const report = { agentName: "Auditor", agentId: "a-1", status: "failed", ts: 0, runId: "r-9" };

  it("carries the source agent, run and status into the goal", () => {
    const goal = buildFixerGoal(report, "stack trace here");
    expect(goal).toContain("Source agent: Auditor (a-1)");
    expect(goal).toContain("Run ID:       r-9");
    expect(goal).toContain("Status:       failed");
    expect(goal).toContain("stack trace here");
  });

  it("says so when the run id is missing", () => {
    expect(buildFixerGoal({ ...report, runId: undefined }, "x")).toContain("(unknown)");
  });

  it("delimits the report body so the agent can find it", () => {
    const goal = buildFixerGoal(report, "body");
    expect(goal).toContain("--- BEGIN REPORT BODY ---");
    expect(goal).toContain("--- END REPORT BODY ---");
  });
});

describe("mgmt log presentation", () => {
  it("gives each kind its own icon and colour", () => {
    expect(mgmtKindIcon("edit")).toBe("📝");
    expect(mgmtKindIcon("directive")).toBe("📤");
    expect(mgmtKindIcon("escalation")).toBe("📨");
    expect(mgmtKindColor("edit")).toBe("#c67fe8");
    expect(mgmtKindColor("directive")).toBe("#f0883e");
  });

  it("marks a cross-office escalation differently", () => {
    expect(mgmtKindColor("escalation", true)).toBe("#5b8def");
    expect(mgmtKindColor("escalation", false)).toBe("#3dd6c8");
  });
});

describe("safeParse", () => {
  it("passes objects through and parses json", () => {
    const o = { a: 1 };
    expect(safeParse(o)).toBe(o);
    expect(safeParse('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null for junk and nullish input", () => {
    expect(safeParse("{not json")).toBeNull();
    expect(safeParse(null)).toBeNull();
    expect(safeParse(undefined)).toBeNull();
  });
});

describe("emailCommId", () => {
  it("only fires for email-sending tools", () => {
    expect(emailCommId("kernel_tasks_create", '{"id":"x"}')).toBeNull();
    expect(emailCommId(undefined, '{"id":"x"}')).toBeNull();
    expect(emailCommId("kernel_email_send", undefined)).toBeNull();
  });

  it("reads the id out of a json result, under any of its names", () => {
    expect(emailCommId("kernel_email_send", '{"id":"c-1"}')).toBe("c-1");
    expect(emailCommId("kernel_comms_reply", '{"comm_id":"c-2"}')).toBe("c-2");
    expect(emailCommId("kernel_comms_send", '{"thread_id":"c-3"}')).toBe("c-3");
  });

  it("falls back to scanning prose for a uuid", () => {
    const raw = "Sent ok — 9fc67992-9f58-4885-aa08-846e17c6cf59";
    expect(emailCommId("kernel_email_send", raw)).toBe("9fc67992-9f58-4885-aa08-846e17c6cf59");
  });

  it("is null when there is nothing to find", () => {
    expect(emailCommId("kernel_email_send", "sent")).toBeNull();
  });
});

describe("resolveAgentWorkspace", () => {
  it("prefers an absolute external repo path", () => {
    const info = resolveAgentWorkspace({ id: "a", variables: '{"__cwd_path__":"/srv/repo"}' });
    expect(info).toMatchObject({ wsId: null, cwdPath: "/srv/repo", cwdLabel: "/srv/repo" });
  });

  it("ignores a relative cwd and uses the registered workspace", () => {
    const info = resolveAgentWorkspace({ id: "a", variables: { __cwd_path__: "rel", __workspace__: "ws_1" } });
    expect(info).toMatchObject({ wsId: "ws_1", cwdLabel: "data/workspaces/ws_1" });
  });

  it("rejects a workspace id with unsafe characters", () => {
    const info = resolveAgentWorkspace({ id: "a", variables: { __workspace__: "../etc" } });
    expect(info.wsId).toBe("agent-a");
  });

  it("falls back to the per-agent default", () => {
    expect(resolveAgentWorkspace({ id: "a7" }).wsId).toBe("agent-a7");
  });

  const flows = [
    { id: "office", home_workspace_id: "4dbe35a9-0b32", home_repo_path: "" },
    { id: "repo-office", home_workspace_id: "ws_home", home_repo_path: "/srv/office" },
  ];

  it("uses the office workspace home for an agent without its own workspace", () => {
    const info = resolveAgentWorkspace({ id: "a", flow_id: "office" }, flows);
    expect(info).toMatchObject({ wsId: "4dbe35a9-0b32", cwdPath: null, cwdLabel: "data/workspaces/4dbe35a9-0b32" });
  });

  it("prefers the office git repo over its workspace home", () => {
    const info = resolveAgentWorkspace({ id: "a", flow_id: "repo-office" }, flows);
    expect(info).toMatchObject({ wsId: null, cwdPath: "/srv/office" });
  });

  it("keeps the agent's own workspace over the office home", () => {
    const info = resolveAgentWorkspace({ id: "a", flow_id: "office", variables: { __workspace__: "ws_1" } }, flows);
    expect(info.wsId).toBe("ws_1");
  });

  it("accepts Windows absolute paths for an external repo and an office repo", () => {
    expect(resolveAgentWorkspace({ id: "a", variables: { __cwd_path__: "C:\\code\\proj" } }))
      .toMatchObject({ wsId: null, cwdPath: "C:\\code\\proj" });
    expect(resolveAgentWorkspace({ id: "a", flow_id: "win" }, [{ id: "win", home_repo_path: "D:\\offices\\x" }]))
      .toMatchObject({ wsId: null, cwdPath: "D:\\offices\\x" });
    expect(resolveAgentWorkspace({ id: "a", variables: { __cwd_path__: "\\\\nas\\repos\\x" } }).cwdPath)
      .toBe("\\\\nas\\repos\\x");
  });

  it("falls back to the per-agent default when the office is unknown", () => {
    expect(resolveAgentWorkspace({ id: "a7", flow_id: "gone" }, flows).wsId).toBe("agent-a7");
  });
});

describe("dependsOnGoogleAuth", () => {
  it("is true only for gsync builtin handlers", () => {
    expect(dependsOnGoogleAuth({ builtin_handler: "gsync:calendar" })).toBe(true);
    expect(dependsOnGoogleAuth({ builtin_handler: "other:thing" })).toBe(false);
    expect(dependsOnGoogleAuth({})).toBe(false);
    expect(dependsOnGoogleAuth(null)).toBe(false);
  });
});

describe("formatAgentRecentRuns", () => {
  it("prints one compact line per run and caps at five", () => {
    const runs = Array.from({ length: 7 }, (_, i) => ({
      id: "abcdefgh-" + i, status: "completed", steps_count: i, tokens_used: 10,
      created_at: "2026-09-12T10:00:00Z",
    }));
    const out = formatAgentRecentRuns(runs).split("\n");
    expect(out.length).toBe(5);
    expect(out[0]).toBe("[completed] 0 steps · 10 tokens · 2026-09-12 10:00 · abcdefgh");
  });

  it("fills in placeholders for missing fields and handles no runs", () => {
    expect(formatAgentRecentRuns([{}])).toBe("[?] 0 steps · 0 tokens ·  · ?");
    expect(formatAgentRecentRuns([])).toBe("");
  });
});

describe("initials", () => {
  it("takes first and last initial of a full name", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("Jean Luc Picard")).toBe("JP");
  });

  it("takes two letters from a single word, and marks an empty name", () => {
    expect(initials("Wren")).toBe("WR");
    expect(initials("   ")).toBe("?");
  });
});

describe("parseMeetingTopics", () => {
  it("strips bullet markers and drops blank lines", () => {
    expect(parseMeetingTopics("- one\n\n* two\n• three\n  ")).toEqual(["one", "two", "three"]);
  });

  it("is empty for empty input", () => {
    expect(parseMeetingTopics("")).toEqual([]);
  });
});
