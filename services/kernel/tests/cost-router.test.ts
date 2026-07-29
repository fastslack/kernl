import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { CostRouter } from "../src/core/llm/cost-router.js";
import type { ToolDefinition } from "../src/core/types.js";

let db: Database;
let router: CostRouter;

beforeEach(() => {
  db = new Database(":memory:");
  router = new CostRouter(db);
});

afterEach(() => {
  db.close();
});

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "demo_tool",
    description: "demo",
    inputSchema: z.object({}),
    async handler() {
      return { content: [{ type: "text" as const, text: "" }] };
    },
    ...overrides,
  };
}

describe("CostRouter.estimate", () => {
  test("returns static cost when no history exists", () => {
    const t = tool({
      cost: { tokens_p50: 100, usd_p50: 0.01, latency_p50_ms: 250 },
    });
    const e = router.estimate(t);
    expect(e.tokens_p50).toBe(100);
    expect(e.usd_p50).toBe(0.01);
    expect(e.latency_p50_ms).toBe(250);
    expect(e.sample_count).toBe(0);
    expect(e.unknown).toBe(false);
  });

  test("flags unknown when tool has no static cost AND no history", () => {
    const t = tool();
    const e = router.estimate(t);
    expect(e.unknown).toBe(true);
  });

  test("uses history once we have ≥3 samples", () => {
    const t = tool({ cost: { tokens_p50: 100, usd_p50: 0.01, latency_p50_ms: 250 } });
    router.record(t.name, { latency_ms: 1000, tokens: 500, usd: 0.05 });
    router.record(t.name, { latency_ms: 1000, tokens: 500, usd: 0.05 });
    router.record(t.name, { latency_ms: 1000, tokens: 500, usd: 0.05 });
    const e = router.estimate(t);
    // Rolling avg with α=0.2 — won't be exactly 1000, but should be >> 250.
    expect(e.latency_p50_ms).toBeGreaterThan(250);
    expect(e.sample_count).toBe(3);
  });
});

describe("CostRouter.checkBudget", () => {
  test("approves when no budget is given", () => {
    const t = tool({ cost: { usd_p50: 5 } });
    expect(router.checkBudget(t, undefined).ok).toBe(true);
  });

  test("rejects when usd_p50 exceeds max_usd", () => {
    const t = tool({ cost: { usd_p50: 0.5 } });
    const r = router.checkBudget(t, { max_usd: 0.10 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("max_usd");
  });

  test("rejects when latency exceeds max_latency_ms", () => {
    const t = tool({ cost: { latency_p50_ms: 30_000 } });
    const r = router.checkBudget(t, { max_latency_ms: 5_000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("max_latency_ms");
  });

  test("approves when within all limits", () => {
    const t = tool({ cost: { usd_p50: 0.01, latency_p50_ms: 100, tokens_p50: 50 } });
    const r = router.checkBudget(t, { max_usd: 1, max_latency_ms: 5_000, max_tokens: 1_000 });
    expect(r.ok).toBe(true);
  });

  test("returns the estimate alongside the decision", () => {
    const t = tool({ cost: { usd_p50: 0.01 } });
    const r = router.checkBudget(t, { max_usd: 1 });
    expect(r.estimate.usd_p50).toBe(0.01);
  });
});

describe("CostRouter.topByCost", () => {
  test("orders tools by accumulated total cost", () => {
    router.record("cheap", { latency_ms: 10, usd: 0.001 });
    router.record("cheap", { latency_ms: 10, usd: 0.001 });
    router.record("expensive", { latency_ms: 5000, usd: 1.5 });
    router.record("expensive", { latency_ms: 5000, usd: 1.5 });
    const top = router.topByCost(10);
    expect(top[0].tool).toBe("expensive");
    expect(top[0].samples).toBe(2);
    expect(top[0].total_usd).toBeGreaterThan(0);
  });
});
