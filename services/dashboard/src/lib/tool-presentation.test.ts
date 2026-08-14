/**
 * The chat renders one card per tool call. Left raw, that card shows
 * `mcp__kernel__kernel_rss_add` over the *keys* of the input — which tells a
 * reader nothing about what just happened, and never links to the thing the
 * tool created.
 *
 * These are the pure functions behind the card: the human label, the one-line
 * summary, the links found in a tool result, and the matching dashboard screen.
 */

import { describe, it, expect } from "bun:test";
import { presentTool, summarizeInput, resultLinks, kernlLink, formatToolInput } from "./tool-presentation.js";

describe("presentTool", () => {
  it("reads the module and the action out of a kernel MCP tool name", () => {
    const t = presentTool("mcp__kernel__kernel_rss_add");
    expect(t.module).toBe("rss");
    expect(t.label).toBe("RSS · Add");
  });

  it("works without the MCP server prefix", () => {
    expect(presentTool("kernel_tasks_create").label).toBe("Tasks · Create");
  });

  it("keeps a multi-word action readable", () => {
    expect(presentTool("kernel_rss_list_items").label).toBe("RSS · List items");
  });

  it("title-cases a bare CLI tool name", () => {
    const t = presentTool("ToolSearch");
    expect(t.label).toBe("Tool Search");
    expect(t.module).toBeNull();
  });

  it("names the server for a non-kernel MCP tool", () => {
    expect(presentTool("mcp__xactions__x_post_tweet").label).toBe("Xactions · X post tweet");
  });

  it("gives every tool an icon", () => {
    expect(presentTool("kernel_rss_add").icon.length).toBeGreaterThan(0);
    expect(presentTool("SomeToolNobodyMapped").icon.length).toBeGreaterThan(0);
  });
});

describe("summarizeInput", () => {
  it("shows the values, not the argument names", () => {
    const s = summarizeInput({ name: "Open Source Projects", feed_url: "https://www.opensourceprojects.dev/rss" });
    expect(s).toBe("Open Source Projects · opensourceprojects.dev/rss");
  });

  it("truncates a long value", () => {
    const s = summarizeInput({ body: "x".repeat(80) });
    expect(s.length).toBeLessThan(50);
    expect(s.endsWith("…")).toBe(true);
  });

  it("keeps at most three values", () => {
    const s = summarizeInput({ a: "one", b: "two", c: "three", d: "four" });
    expect(s).toBe("one · two · three");
  });

  it("skips values that are not worth a glance", () => {
    expect(summarizeInput({ tags: ["a", "b"], name: "Feed" })).toBe("Feed");
    expect(summarizeInput({})).toBe("");
    expect(summarizeInput(undefined)).toBe("");
  });
});

describe("resultLinks", () => {
  it("pulls the URL out of a markdown tool result", () => {
    const out = resultLinks("Feed added: **Open Source Projects** (osp)\n- URL: https://www.opensourceprojects.dev/rss");
    expect(out).toEqual(["https://www.opensourceprojects.dev/rss"]);
  });

  it("drops punctuation that closed the sentence, not the URL", () => {
    expect(resultLinks("see (https://a.dev/rss).")).toEqual(["https://a.dev/rss"]);
  });

  it("dedupes and caps the list at three", () => {
    const text = "https://a.dev https://a.dev https://b.dev https://c.dev https://d.dev";
    expect(resultLinks(text)).toEqual(["https://a.dev", "https://b.dev", "https://c.dev"]);
  });

  it("only follows http and https", () => {
    expect(resultLinks("javascript:alert(1) ftp://a.dev/x")).toEqual([]);
    expect(resultLinks(undefined)).toEqual([]);
  });
});

describe("formatToolInput", () => {
  it("pretty-prints the arguments", () => {
    expect(formatToolInput({ name: "Feed" })).toBe('{\n  "name": "Feed"\n}');
  });

  it("cuts an input too big to read", () => {
    const out = formatToolInput({ body: "x".repeat(4000) });
    expect(out.length).toBeLessThan(1300);
    expect(out.endsWith("…")).toBe(true);
  });

  it("never throws on something JSON cannot hold", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof formatToolInput(circular)).toBe("string");
  });
});

describe("kernlLink", () => {
  it("sends a kernel module to its dashboard screen", () => {
    expect(kernlLink("mcp__kernel__kernel_rss_add")).toEqual({ href: "/rss-registry", label: "RSS Registry" });
  });

  it("stays quiet for a module with no screen", () => {
    expect(kernlLink("kernel_nutrition_log")).toBeNull();
  });

  it("stays quiet for tools that are not the kernel's", () => {
    expect(kernlLink("Bash")).toBeNull();
  });
});
