import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createMetaModule } from "../src/modules/meta/index.js";
import type { ToolDefinition } from "../src/core/types.js";

/**
 * meta module unit tests.
 *
 * The meta module is intentionally tiny and stateless — these tests cover
 * the externally observable contract (tool catalog, search ranking,
 * describe lookups, code-run dispatch). No SQLite, no Neo4j.
 */

function fakeTools(): ToolDefinition[] {
  return [
    {
      name: "kernel_tasks_list",
      description: "List all tasks the user has open right now.",
      inputSchema: z.object({}),
      tags: ["tasks", "productivity", "list"],
      async handler() {
        return {
          content: [{ type: "text" as const, text: "" }],
          structuredContent: { tasks: [{ id: "t1", title: "demo" }] },
        };
      },
    },
    {
      name: "kernel_crm_search_contacts",
      description: "Search the address book for contacts by name or email.",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ contacts: z.array(z.unknown()) }),
      tags: ["crm", "search"],
      async handler() {
        return { content: [{ type: "text" as const, text: "no matches" }] };
      },
    },
    {
      name: "kernel_finance_balance",
      description: "Show the current balance across all accounts.",
      inputSchema: z.object({}),
      tags: ["finance", "balance"],
      async handler() {
        return { content: [{ type: "text" as const, text: "$0" }] };
      },
    },
  ];
}

function getTool(name: string) {
  const mod = createMetaModule({ getCatalog: fakeTools });
  // initialize is stateless — skip for unit test
  return mod.getTools().find((t) => t.name === name)!;
}

describe("meta module", () => {
  test("registers all expected meta tools", () => {
    const mod = createMetaModule({ getCatalog: fakeTools });
    const names = mod.getTools().map((t) => t.name).sort();
    // Smoke test for "did I forget to register one?" — using `toContain`
    // instead of `toEqual` so adding new meta tools doesn't force this
    // test to be edited every time.
    expect(names).toContain("kernel_attest_identity");
    expect(names).toContain("kernel_attest_verify");
    expect(names).toContain("kernel_code_run");
    expect(names).toContain("kernel_meta_elicit_confirm");
    expect(names).toContain("kernel_meta_render_card");
    expect(names).toContain("kernel_tool_describe");
    expect(names).toContain("kernel_tool_search");
  });

  test("kernel_tool_search ranks name matches above description matches", async () => {
    const tool = getTool("kernel_tool_search");
    const result = await tool.handler({ query: "tasks", limit: 10 });
    const data = result.structuredContent as { matches: Array<{ name: string; score: number }> };
    expect(data.matches.length).toBeGreaterThan(0);
    expect(data.matches[0].name).toBe("kernel_tasks_list");
  });

  test("kernel_tool_search returns no matches for nonsense queries", async () => {
    const tool = getTool("kernel_tool_search");
    const result = await tool.handler({ query: "xyzzy_no_such_thing", limit: 10 });
    const data = result.structuredContent as { matches: unknown[]; total: number };
    expect(data.matches).toHaveLength(0);
    expect(data.total).toBe(0);
  });

  test("kernel_tool_describe returns full schema for a known tool", async () => {
    const tool = getTool("kernel_tool_describe");
    const result = await tool.handler({ name: "kernel_crm_search_contacts" });
    const data = result.structuredContent as {
      name: string;
      outputSchema?: unknown;
      tags: string[];
    };
    expect(data.name).toBe("kernel_crm_search_contacts");
    expect(data.outputSchema).toBeDefined();
    expect(data.tags).toContain("crm");
  });

  test("kernel_tool_describe returns isError for unknown tools", async () => {
    const tool = getTool("kernel_tool_describe");
    const result = await tool.handler({ name: "kernel_does_not_exist" });
    expect(result.isError).toBe(true);
  });

  test("kernel_code_run can call another tool and return its structured payload", async () => {
    const tool = getTool("kernel_code_run");
    const result = await tool.handler({
      script: "const r = await tool('kernel_tasks_list', {}); return r.tasks.length;",
      timeoutMs: 5000,
    });
    const data = result.structuredContent as { result: unknown; logs: string[] };
    expect(data.result).toBe(1);
    expect(Array.isArray(data.logs)).toBe(true);
  });

  test("kernel_code_run captures log() calls", async () => {
    const tool = getTool("kernel_code_run");
    const result = await tool.handler({
      script: "log('hello'); log('world'); return input.x;",
      vars: { x: 42 },
      timeoutMs: 5000,
    });
    const data = result.structuredContent as { result: unknown; logs: string[] };
    expect(data.result).toBe(42);
    expect(data.logs).toEqual(["hello", "world"]);
  });

  test("kernel_code_run rejects scripts that try to require()", async () => {
    const tool = getTool("kernel_code_run");
    const result = await tool.handler({
      script: "return require('fs');",
      timeoutMs: 5000,
    });
    expect(result.isError).toBe(true);
  });

  test("kernel_meta_render_card emits both text content and a ui block", async () => {
    const tool = getTool("kernel_meta_render_card");
    const result = await tool.handler({
      title: "Today",
      body: "**3 tasks** due before noon.",
      items: [
        { label: "Tasks", value: "3" },
        { label: "Meetings", value: "2", hint: "1 imminent" },
      ],
      accent: "green",
    });
    // Text fallback
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("# Today");
    expect(text).toContain("Tasks");
    // UI block — present + escaped + accent applied
    expect(result.ui).toBeDefined();
    expect(result.ui!.mimeType).toBe("text/html");
    expect(result.ui!.body).toContain("<h2>Today</h2>");
    expect(result.ui!.body).toContain("#16a34a"); // green accent hex
    expect(result.ui!.body).toContain("<strong>3 tasks</strong>");
    // Structured payload for protocol ≥ 2025-03-26 clients
    const data = result.structuredContent as { rendered: boolean; bytes: number };
    expect(data.rendered).toBe(true);
    expect(data.bytes).toBeGreaterThan(100);
  });

  test("kernel_meta_render_card escapes HTML in user input (no script injection)", async () => {
    const tool = getTool("kernel_meta_render_card");
    const result = await tool.handler({
      title: "<script>alert(1)</script>",
      body: "<img src=x onerror=alert(1)>",
    });
    const ui = result.ui!.body;
    // Raw tags must NOT appear unescaped — they're rendered as &lt;…&gt;.
    expect(ui).not.toContain("<script>alert");
    expect(ui).not.toContain("<img src=x");
    expect(ui).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
