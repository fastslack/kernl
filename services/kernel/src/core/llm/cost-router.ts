/**
 * Cost-aware routing + budget enforcement for tool calls.
 *
 * Two responsibilities:
 *
 *   1. **Pre-flight check.** When a `tools/call` arrives with `_meta.budget`,
 *      compare the tool's *current* cost estimate (rolling p50 from
 *      `tool_cost_history` if we have data, falling back to the static
 *      `ToolDefinition.cost`) against the budget. If we're over, refuse
 *      the call before executing — the client can adapt instead of
 *      paying for a surprise.
 *
 *   2. **Post-flight measurement.** Time every successful call and feed
 *      latency + token estimates into the rolling stats. Over enough
 *      runs the kernel learns each tool's real cost without anyone
 *      hardcoding p50s.
 *
 * Why a separate module: this is shared infrastructure that #5 (plan/
 * validate/commit) and #4 (memory) both consume. The plan validator
 * uses `estimateCost` directly; the memory layer reads cacheable.
 */

import type { SqliteDb } from "../db/sqlite.js";
import type { ToolCost, ToolDefinition } from "../types.js";

export interface Budget {
  max_usd?: number;
  max_latency_ms?: number;
  max_tokens?: number;
}

export interface ActualCost {
  tokens?: number;
  usd?: number;
  latency_ms: number;
}

export interface CostEstimate {
  tokens_p50: number;
  usd_p50: number;
  latency_p50_ms: number;
  /** Number of historical samples backing the estimate. 0 = static only. */
  sample_count: number;
  /** True when the tool declares no cost AND has no history. Callers with
   *  strict budgets should treat this as "could be anything". */
  unknown: boolean;
}

export interface BudgetCheckResult {
  ok: boolean;
  reason?: string;
  estimate: CostEstimate;
}

/**
 * Lightweight per-tool stats accumulator. Rolling exponential average
 * over the last ~100 calls — cheap to compute, robust to outliers, and
 * the SQL is just one UPSERT per call.
 */
export class CostRouter {
  constructor(private readonly db: SqliteDb) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS tool_cost_history (\n" +
        "  tool         TEXT PRIMARY KEY,\n" +
        "  tokens_avg   REAL NOT NULL DEFAULT 0,\n" +
        "  usd_avg      REAL NOT NULL DEFAULT 0,\n" +
        "  latency_avg  REAL NOT NULL DEFAULT 0,\n" +
        "  sample_count INTEGER NOT NULL DEFAULT 0,\n" +
        "  last_seen_at TEXT NOT NULL\n" +
        ")",
    );
  }

  /**
   * Best-available cost estimate for a tool. Prefers historical p50s when
   * we have ≥3 samples (small enough to be cheap, large enough that one
   * outlier doesn't dominate); otherwise returns the static metadata.
   */
  estimate(tool: ToolDefinition): CostEstimate {
    const row = this.db
      .prepare(
        "SELECT tokens_avg, usd_avg, latency_avg, sample_count " +
          "FROM tool_cost_history WHERE tool = ?",
      )
      .get(tool.name) as
      | { tokens_avg: number; usd_avg: number; latency_avg: number; sample_count: number }
      | undefined;

    const stat = tool.cost ?? {};
    const useHistory = row && row.sample_count >= 3;

    return {
      tokens_p50: useHistory ? row.tokens_avg : (stat.tokens_p50 ?? 0),
      usd_p50: useHistory ? row.usd_avg : (stat.usd_p50 ?? 0),
      latency_p50_ms: useHistory ? row.latency_avg : (stat.latency_p50_ms ?? 0),
      sample_count: row?.sample_count ?? 0,
      unknown: !useHistory && !tool.cost,
    };
  }

  /**
   * Compare an estimate against a client-supplied budget. Returns the
   * estimate alongside the decision so the caller can echo it in
   * `_meta.estimated_cost` for transparency.
   */
  checkBudget(tool: ToolDefinition, budget: Budget | undefined): BudgetCheckResult {
    const estimate = this.estimate(tool);
    if (!budget) return { ok: true, estimate };

    if (
      budget.max_usd !== undefined &&
      estimate.usd_p50 > budget.max_usd
    ) {
      return {
        ok: false,
        reason: `tool ${tool.name} estimated at $${estimate.usd_p50.toFixed(
          4,
        )} exceeds budget max_usd=$${budget.max_usd}`,
        estimate,
      };
    }
    if (
      budget.max_latency_ms !== undefined &&
      estimate.latency_p50_ms > budget.max_latency_ms
    ) {
      return {
        ok: false,
        reason: `tool ${tool.name} estimated at ${estimate.latency_p50_ms}ms exceeds budget max_latency_ms=${budget.max_latency_ms}`,
        estimate,
      };
    }
    if (
      budget.max_tokens !== undefined &&
      estimate.tokens_p50 > budget.max_tokens
    ) {
      return {
        ok: false,
        reason: `tool ${tool.name} estimated at ${estimate.tokens_p50} tokens exceeds budget max_tokens=${budget.max_tokens}`,
        estimate,
      };
    }
    return { ok: true, estimate };
  }

  /** Record one observed cost sample. Updates the rolling exponential
   *  average with α=0.2 (recent samples weigh more, ~5-call half-life). */
  record(tool: string, actual: ActualCost): void {
    const row = this.db
      .prepare(
        "SELECT tokens_avg, usd_avg, latency_avg, sample_count " +
          "FROM tool_cost_history WHERE tool = ?",
      )
      .get(tool) as
      | { tokens_avg: number; usd_avg: number; latency_avg: number; sample_count: number }
      | undefined;

    const alpha = 0.2;
    const blend = (prev: number, next: number, count: number): number => {
      if (count === 0) return next;
      return prev * (1 - alpha) + next * alpha;
    };

    const tokens = actual.tokens ?? 0;
    const usd = actual.usd ?? 0;
    const latency = actual.latency_ms;
    const count = row?.sample_count ?? 0;

    const tokens_avg = blend(row?.tokens_avg ?? 0, tokens, count);
    const usd_avg = blend(row?.usd_avg ?? 0, usd, count);
    const latency_avg = blend(row?.latency_avg ?? 0, latency, count);

    this.db
      .prepare(
        "INSERT INTO tool_cost_history (tool, tokens_avg, usd_avg, latency_avg, sample_count, last_seen_at)\n" +
          " VALUES (?, ?, ?, ?, 1, ?)\n" +
          "ON CONFLICT(tool) DO UPDATE SET\n" +
          "  tokens_avg = excluded.tokens_avg,\n" +
          "  usd_avg = excluded.usd_avg,\n" +
          "  latency_avg = excluded.latency_avg,\n" +
          "  sample_count = sample_count + 1,\n" +
          "  last_seen_at = excluded.last_seen_at",
      )
      .run(tool, tokens_avg, usd_avg, latency_avg, new Date().toISOString());
  }

  /**
   * Top-N tools by accumulated dollar cost over the last `windowMs` ms.
   * Approximation: `usd_avg * sample_count`. Good enough for "what's
   * eating my budget"; not a billing-grade aggregation.
   */
  topByCost(limit = 10): Array<{ tool: string; total_usd: number; samples: number; avg_latency_ms: number }> {
    return this.db
      .prepare(
        "SELECT tool, usd_avg * sample_count AS total_usd, sample_count AS samples, latency_avg AS avg_latency_ms\n" +
          "FROM tool_cost_history\n" +
          "ORDER BY total_usd DESC\n" +
          "LIMIT ?",
      )
      .all(limit) as Array<{ tool: string; total_usd: number; samples: number; avg_latency_ms: number }>;
  }
}

/** Helper for the pre-flight error response. The code -32004 is unofficial
 *  but in the "implementation-defined server errors" range (-32000..-32099)
 *  per JSON-RPC 2.0 — the spec encourages servers to define their own. */
export const BUDGET_EXCEEDED_CODE = -32004;
