import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { executePlan, type Dispatcher } from "../src/modules/mcp-plans/executor.js";
import type { ToolDefinition } from "../src/core/types.js";

/**
 * Rollback semantics: when a plan aborts mid-execution, the executor
 * walks completed nodes in reverse and invokes each tool's `inverse`.
 * Verified here:
 *   * inverse-aware nodes get rolled back (status flips to rolled_back).
 *   * non-reversible nodes (no inverse) stay committed and surface
 *     `rollback: { status: "skipped", error: "no inverse declared" }`.
 *   * partial rollbacks report `rollback_attempted=true` but the
 *     overall status reflects which side-effects survived.
 *   * `rollbackOnAbort: false` opts out (legacy behaviour).
 */

let createCount = 0;
let deleteCount = 0;
const created = new Map<string, { id: string }>();

function fakeCatalog(): ToolDefinition[] {
  return [
    {
      name: "create_record",
      description: "Create a record (reversible — paired with delete_record).",
      inputSchema: z.object({ name: z.string() }),
      cost: { reversible: true },
      inverse: { tool: "delete_record", argsFrom: "output" },
      sideEffects: ["record.created:1"],
      async handler(args) {
        createCount++;
        const { name } = args as { name: string };
        const id = `rec_${createCount}_${name}`;
        created.set(id, { id });
        return {
          content: [{ type: "text" as const, text: `created ${id}` }],
          structuredContent: { id },
        };
      },
    },
    {
      name: "delete_record",
      description: "Delete a record by id.",
      inputSchema: z.object({ id: z.string() }),
      cost: { reversible: true },
      sideEffects: ["record.deleted:1"],
      async handler(args) {
        deleteCount++;
        const { id } = args as { id: string };
        created.delete(id);
        return { content: [{ type: "text" as const, text: `deleted ${id}` }] };
      },
    },
    {
      name: "send_irreversible_email",
      description: "Send an email — no inverse possible.",
      inputSchema: z.object({ to: z.string() }),
      cost: { reversible: false },
      // intentionally no `inverse`
      sideEffects: ["email.sent:1"],
      async handler() {
        return { content: [{ type: "text" as const, text: "sent" }] };
      },
    },
    {
      name: "always_fail",
      description: "Always fails — used to trigger abort.",
      inputSchema: z.object({}),
      cost: { reversible: true },
      async handler() {
        return { content: [{ type: "text" as const, text: "boom" }], isError: true };
      },
    },
  ];
}

function dispatch(catalog: ToolDefinition[]): Dispatcher {
  const map = new Map(catalog.map((t) => [t.name, t]));
  return async (toolName, args) => {
    const tool = map.get(toolName);
    if (!tool) return { isError: true, output: { error: "unknown" }, duration_ms: 0 };
    const t0 = Date.now();
    const r = await tool.handler(args);
    return {
      isError: r.isError === true,
      output: r.structuredContent ?? { content: r.content },
      duration_ms: Date.now() - t0,
    };
  };
}

describe("plan executor — rollback path", () => {
  test("happy path: no rollback attempted when no node failed", async () => {
    createCount = 0; deleteCount = 0; created.clear();
    const cat = fakeCatalog();
    const exec = await executePlan(
      "p1",
      {
        nodes: [
          { id: "a", tool: "create_record", args: { name: "first" }, depends_on: [], on_error: "abort" },
          { id: "b", tool: "create_record", args: { name: "second" }, depends_on: ["a"], on_error: "abort" },
        ],
      },
      dispatch(cat),
      { catalog: () => cat },
    );
    expect(exec.status).toBe("completed");
    expect(exec.rollback_attempted).toBe(false);
    expect(deleteCount).toBe(0);
    expect(created.size).toBe(2);
  });

  test("aborts → rolls back completed nodes in reverse order", async () => {
    createCount = 0; deleteCount = 0; created.clear();
    const cat = fakeCatalog();
    const exec = await executePlan(
      "p2",
      {
        nodes: [
          { id: "a", tool: "create_record", args: { name: "first" }, depends_on: [], on_error: "abort" },
          { id: "b", tool: "create_record", args: { name: "second" }, depends_on: ["a"], on_error: "abort" },
          { id: "c", tool: "always_fail", args: {}, depends_on: ["b"], on_error: "abort" },
        ],
      },
      dispatch(cat),
      { catalog: () => cat },
    );
    expect(exec.rollback_attempted).toBe(true);
    expect(deleteCount).toBe(2);             // both creates undone
    expect(created.size).toBe(0);
    // Both completed nodes should now be marked rolled_back.
    const a = exec.outcomes.find((o) => o.node_id === "a");
    const b = exec.outcomes.find((o) => o.node_id === "b");
    expect(a?.status).toBe("rolled_back");
    expect(b?.status).toBe("rolled_back");
    expect(exec.status).toBe("rolled_back");
  });

  test("nodes without an inverse stay committed and surface a clear marker", async () => {
    createCount = 0; deleteCount = 0; created.clear();
    const cat = fakeCatalog();
    const exec = await executePlan(
      "p3",
      {
        nodes: [
          { id: "a", tool: "create_record", args: { name: "x" }, depends_on: [], on_error: "abort" },
          { id: "b", tool: "send_irreversible_email", args: { to: "x@y" }, depends_on: ["a"], on_error: "abort" },
          { id: "c", tool: "always_fail", args: {}, depends_on: ["b"], on_error: "abort" },
        ],
      },
      dispatch(cat),
      { catalog: () => cat },
    );
    expect(exec.rollback_attempted).toBe(true);
    const emailOutcome = exec.outcomes.find((o) => o.node_id === "b");
    expect(emailOutcome?.rollback?.status).toBe("skipped");
    expect(emailOutcome?.rollback?.error).toContain("no inverse");
    // The create node DID get rolled back (it has an inverse).
    const createOutcome = exec.outcomes.find((o) => o.node_id === "a");
    expect(createOutcome?.status).toBe("rolled_back");
    // Even with a partial rollback, we stay at "rolled_back" because
    // the planner made a best-effort attempt.
    expect(exec.status).toBe("rolled_back");
  });

  test("rollbackOnAbort: false preserves legacy abort-and-leave behaviour", async () => {
    createCount = 0; deleteCount = 0; created.clear();
    const cat = fakeCatalog();
    const exec = await executePlan(
      "p4",
      {
        nodes: [
          { id: "a", tool: "create_record", args: { name: "leftover" }, depends_on: [], on_error: "abort" },
          { id: "c", tool: "always_fail", args: {}, depends_on: ["a"], on_error: "abort" },
        ],
      },
      dispatch(cat),
      { catalog: () => cat, rollbackOnAbort: false },
    );
    expect(exec.rollback_attempted).toBe(false);
    expect(deleteCount).toBe(0);
    expect(created.size).toBe(1);
    expect(exec.status).toBe("failed");
  });

  test("inverse with argsFrom: input passes the original input to the inverse", async () => {
    const cat: ToolDefinition[] = [
      {
        name: "annotate",
        description: "annotate by id",
        inputSchema: z.object({ id: z.string(), note: z.string() }),
        inverse: { tool: "remove_annotation", argsFrom: "input" },
        async handler() {
          return { content: [{ type: "text" as const, text: "annotated" }], structuredContent: { ok: true } };
        },
      },
      {
        name: "remove_annotation",
        description: "remove annotation by id",
        inputSchema: z.object({ id: z.string(), note: z.string() }),
        async handler(args) {
          return {
            content: [{ type: "text" as const, text: `removed annotation for ${(args as { id: string }).id}` }],
          };
        },
      },
      {
        name: "always_fail",
        description: "fail",
        inputSchema: z.object({}),
        async handler() {
          return { content: [{ type: "text" as const, text: "fail" }], isError: true };
        },
      },
    ];

    const calls: unknown[] = [];
    const customDispatch: Dispatcher = async (name, args) => {
      calls.push({ name, args });
      const tool = cat.find((t) => t.name === name)!;
      const r = await tool.handler(args);
      return { isError: r.isError === true, output: r.structuredContent ?? { content: r.content }, duration_ms: 0 };
    };

    await executePlan(
      "p5",
      {
        nodes: [
          { id: "a", tool: "annotate", args: { id: "rec_1", note: "hi" }, depends_on: [], on_error: "abort" },
          { id: "b", tool: "always_fail", args: {}, depends_on: ["a"], on_error: "abort" },
        ],
      },
      customDispatch,
      { catalog: () => cat },
    );

    const removeCall = calls.find((c) => (c as { name: string }).name === "remove_annotation");
    expect(removeCall).toBeDefined();
    expect((removeCall as { args: { id: string; note: string } }).args).toEqual({ id: "rec_1", note: "hi" });
  });
});
