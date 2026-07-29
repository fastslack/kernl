/**
 * Plan simulation: estimate cost + side-effects without running anything.
 *
 * Sums per-node estimates from the cost router (when available) or the
 * static `ToolDefinition.cost` (when not). Side-effects come from the
 * tool's declared `sideEffects` — same list that ends up in the
 * post-execution receipt.
 *
 * Latency: parallel-aware. Depends_on is the only dependency edge, so
 * the wall-clock is the *longest* path through the DAG (not the sum).
 * For sequential plans both are identical; for fan-out/fan-in the
 * difference matters a lot.
 */

import type { CostRouter } from "../../core/llm/cost-router.js";
import type { ToolDefinition } from "../../core/types.js";
import type { Plan, PlanNode } from "./types.js";

export interface Simulation {
  estimated_cost: { usd: number; tokens: number; latency_ms: number };
  side_effects_preview: string[];
  /** True iff at least one node calls a tool whose `cost.reversible === false`. */
  requires_approval: boolean;
}

export function simulate(
  plan: Plan,
  catalog: () => ToolDefinition[],
  costRouter?: CostRouter,
): Simulation {
  const tools = new Map(catalog().map((t) => [t.name, t]));
  const sideEffects: string[] = [];
  let usd = 0;
  let tokens = 0;
  let requiresApproval = false;

  // Per-node latency (used for critical-path computation below).
  const latencyByNode = new Map<string, number>();

  for (const node of plan.nodes) {
    const tool = tools.get(node.tool);
    if (!tool) {
      // Validator catches this; in case it's called pre-validate, default
      // to "expensive enough that the operator notices".
      latencyByNode.set(node.id, 1000);
      continue;
    }

    const estimate = costRouter
      ? costRouter.estimate(tool)
      : {
          tokens_p50: tool.cost?.tokens_p50 ?? 0,
          usd_p50: tool.cost?.usd_p50 ?? 0,
          latency_p50_ms: tool.cost?.latency_p50_ms ?? 0,
          sample_count: 0,
          unknown: !tool.cost,
        };

    usd += estimate.usd_p50;
    tokens += estimate.tokens_p50;
    latencyByNode.set(node.id, estimate.latency_p50_ms);
    for (const e of tool.sideEffects ?? []) sideEffects.push(`${node.id}: ${e}`);
    if (tool.cost?.reversible === false) requiresApproval = true;
  }

  return {
    estimated_cost: {
      usd,
      tokens,
      latency_ms: criticalPathLatency(plan.nodes, latencyByNode),
    },
    side_effects_preview: sideEffects,
    requires_approval: requiresApproval,
  };
}

/** Longest path through the DAG by node-latency weight. The DAG is
 *  guaranteed acyclic (validator caught cycles), so a single forward
 *  sweep in topological order suffices. We re-do the topological sort
 *  here instead of importing it to keep this module standalone. */
function criticalPathLatency(nodes: PlanNode[], latency: Map<string, number>): number {
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const n of nodes) {
    for (const dep of n.depends_on ?? []) {
      adj.get(dep)?.push(n.id);
      indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
    }
  }
  const ready: string[] = [];
  for (const [id, d] of indeg) if (d === 0) ready.push(id);

  const earliestEnd = new Map<string, number>();
  for (const n of nodes) earliestEnd.set(n.id, latency.get(n.id) ?? 0);

  while (ready.length > 0) {
    const id = ready.shift()!;
    for (const next of adj.get(id) ?? []) {
      const cur = earliestEnd.get(next) ?? 0;
      const candidate = (earliestEnd.get(id) ?? 0) + (latency.get(next) ?? 0);
      if (candidate > cur) earliestEnd.set(next, candidate);
      const remaining = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  let max = 0;
  for (const v of earliestEnd.values()) if (v > max) max = v;
  return max;
}
