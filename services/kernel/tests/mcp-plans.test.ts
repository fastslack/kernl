import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { topologicalOrder, validatePlan } from "../src/modules/mcp-plans/validator.js";
import { simulate } from "../src/modules/mcp-plans/simulator.js";
import { executePlan, type Dispatcher } from "../src/modules/mcp-plans/executor.js";
import type { ToolDefinition } from "../src/core/types.js";

function fakeCatalog(): ToolDefinition[] {
  return [
    {
      name: "step_a",
      description: "first step",
      inputSchema: z.object({ x: z.number().optional() }),
      cost: { usd_p50: 0.01, latency_p50_ms: 100, reversible: true },
      async handler() {
        return {
          content: [{ type: "text" as const, text: "ok" }],
          structuredContent: { value: 7 },
        };
      },
    },
    {
      name: "step_b",
      description: "needs A's output",
      inputSchema: z.object({ value: z.number() }),
      cost: { usd_p50: 0.05, latency_p50_ms: 200, reversible: false },
      sideEffects: ["external.api.called:1"],
      async handler() {
        return {
          content: [{ type: "text" as const, text: "done" }],
          structuredContent: { result: "done" },
        };
      },
    },
    {
      name: "step_fail",
      description: "always fails",
      inputSchema: z.object({}),
      cost: { usd_p50: 0, latency_p50_ms: 50, reversible: true },
      async handler() {
        return { content: [{ type: "text" as const, text: "boom" }], isError: true };
      },
    },
  ];
}

describe("validator", () => {
  test("clean plan has no errors", () => {
    const issues = validatePlan({
      plan: {
        nodes: [
          { id: "a", tool: "step_a", depends_on: [], on_error: "abort" },
          { id: "b", tool: "step_b", depends_on: ["a"], args_from: "a", on_error: "abort" },
        ],
      },
      catalog: fakeCatalog,
    });
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  test("detects unknown tool", () => {
    const issues = validatePlan({
      plan: { nodes: [{ id: "x", tool: "nonexistent", depends_on: [], on_error: "abort" }] },
      catalog: fakeCatalog,
    });
    expect(issues.some((i) => i.message.includes("unknown tool"))).toBe(true);
  });

  test("detects dangling dependency", () => {
    const issues = validatePlan({
      plan: {
        nodes: [{ id: "a", tool: "step_a", depends_on: ["ghost"], on_error: "abort" }],
      },
      catalog: fakeCatalog,
    });
    expect(issues.some((i) => i.message.includes("ghost"))).toBe(true);
  });

  test("detects cycles", () => {
    const issues = validatePlan({
      plan: {
        nodes: [
          { id: "a", tool: "step_a", depends_on: ["b"], on_error: "abort" },
          { id: "b", tool: "step_a", depends_on: ["a"], on_error: "abort" },
        ],
      },
      catalog: fakeCatalog,
    });
    expect(issues.some((i) => i.message.includes("cycle"))).toBe(true);
  });

  test("warns when args_from skips depends_on", () => {
    const issues = validatePlan({
      plan: {
        nodes: [
          { id: "a", tool: "step_a", depends_on: [], on_error: "abort" },
          { id: "b", tool: "step_b", args_from: "a", depends_on: [], on_error: "abort" },
        ],
      },
      catalog: fakeCatalog,
    });
    expect(issues.some((i) => i.level === "warning" && i.message.includes("not in depends_on"))).toBe(true);
  });
});

describe("topologicalOrder", () => {
  test("returns sequential plan in declared order", () => {
    const order = topologicalOrder([
      { id: "a", tool: "step_a", depends_on: [], on_error: "abort" },
      { id: "b", tool: "step_b", depends_on: ["a"], on_error: "abort" },
    ]);
    expect(order).toEqual(["a", "b"]);
  });

  test("returns null on cycle", () => {
    const order = topologicalOrder([
      { id: "a", tool: "x", depends_on: ["b"], on_error: "abort" },
      { id: "b", tool: "x", depends_on: ["a"], on_error: "abort" },
    ]);
    expect(order).toBeNull();
  });
});

describe("simulator", () => {
  test("sums costs and reports critical-path latency", () => {
    const sim = simulate(
      {
        nodes: [
          { id: "a", tool: "step_a", depends_on: [], on_error: "abort" },
          { id: "b", tool: "step_b", depends_on: ["a"], args_from: "a", on_error: "abort" },
        ],
      },
      fakeCatalog,
    );
    expect(sim.estimated_cost.usd).toBeCloseTo(0.06, 5);
    // Critical path is sequential = 100 + 200.
    expect(sim.estimated_cost.latency_ms).toBe(300);
  });

  test("flags requires_approval when any tool is non-reversible", () => {
    const sim = simulate(
      {
        nodes: [{ id: "b", tool: "step_b", depends_on: [], on_error: "abort" }],
      },
      fakeCatalog,
    );
    expect(sim.requires_approval).toBe(true);
  });

  test("collects side_effects with node_id prefix", () => {
    const sim = simulate(
      { nodes: [{ id: "b", tool: "step_b", depends_on: [], on_error: "abort" }] },
      fakeCatalog,
    );
    expect(sim.side_effects_preview).toEqual(["b: external.api.called:1"]);
  });

  test("parallel branches use longest path, not sum", () => {
    // a → (b, c, d)  — three parallel children. Longest path is a + b.
    // step_a = 100ms, step_b = 200ms ⇒ 300ms total.
    const sim = simulate(
      {
        nodes: [
          { id: "a", tool: "step_a", depends_on: [], on_error: "abort" },
          { id: "b", tool: "step_b", depends_on: ["a"], args_from: "a", on_error: "abort" },
          { id: "c", tool: "step_a", depends_on: ["a"], on_error: "abort" },
          { id: "d", tool: "step_a", depends_on: ["a"], on_error: "abort" },
        ],
      },
      fakeCatalog,
    );
    expect(sim.estimated_cost.latency_ms).toBe(300);
  });
});

describe("executor", () => {
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

  test("happy path: every node completes", async () => {
    const exec = await executePlan(
      "p1",
      {
        nodes: [
          { id: "a", tool: "step_a", depends_on: [], on_error: "abort" },
          { id: "b", tool: "step_b", depends_on: ["a"], args_from: "a", on_error: "abort" },
        ],
      },
      dispatch(fakeCatalog()),
    );
    expect(exec.status).toBe("completed");
    expect(exec.outcomes).toHaveLength(2);
    expect(exec.outcomes.every((o) => o.status === "completed")).toBe(true);
  });

  test("on_error abort: failure marks rest as skipped", async () => {
    const exec = await executePlan(
      "p2",
      {
        nodes: [
          { id: "a", tool: "step_fail", depends_on: [], on_error: "abort" },
          { id: "b", tool: "step_a", depends_on: ["a"], on_error: "abort" },
        ],
      },
      dispatch(fakeCatalog()),
    );
    expect(exec.status).toBe("failed");
    expect(exec.outcomes.find((o) => o.node_id === "a")?.status).toBe("failed");
    expect(exec.outcomes.find((o) => o.node_id === "b")?.status).toBe("skipped");
  });

  test("on_error continue: independent nodes still run after a failure", async () => {
    const exec = await executePlan(
      "p3",
      {
        nodes: [
          { id: "a", tool: "step_fail", depends_on: [], on_error: "continue" },
          { id: "b", tool: "step_a", depends_on: [], on_error: "abort" },
        ],
      },
      dispatch(fakeCatalog()),
    );
    expect(exec.outcomes.find((o) => o.node_id === "a")?.status).toBe("failed");
    expect(exec.outcomes.find((o) => o.node_id === "b")?.status).toBe("completed");
  });

  test("args_from pipes structuredContent of upstream into args", async () => {
    let captured: unknown;
    const customCatalog: ToolDefinition[] = [
      {
        name: "produce",
        description: "",
        inputSchema: z.object({}),
        async handler() {
          return {
            content: [{ type: "text" as const, text: "" }],
            structuredContent: { value: 42 },
          };
        },
      },
      {
        name: "consume",
        description: "",
        inputSchema: z.object({ value: z.number() }),
        async handler(args) {
          captured = args;
          return { content: [{ type: "text" as const, text: "ok" }] };
        },
      },
    ];
    await executePlan(
      "p4",
      {
        nodes: [
          { id: "p", tool: "produce", depends_on: [], on_error: "abort" },
          { id: "c", tool: "consume", depends_on: ["p"], args_from: "p", on_error: "abort" },
        ],
      },
      dispatch(customCatalog),
    );
    expect(captured).toEqual({ value: 42 });
  });
});
