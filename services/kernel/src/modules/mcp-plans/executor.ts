/**
 * Plan executor: topologically ordered, parallel-where-possible.
 *
 * Execution model:
 *   1. Topo-sort the DAG.
 *   2. At each step, run all nodes whose dependencies have completed.
 *   3. Resolve per-node args (static / args_from / args_template).
 *   4. Dispatch via the catalog dispatcher (same path as `tools/call`).
 *   5. Record outcome; on failure honour `on_error` policy.
 *
 * Cancellation: pass an AbortSignal in `ExecuteOptions`. Pending nodes
 * stop being scheduled; in-flight tool calls aren't interrupted unless
 * the tool itself respects abort signals (most don't yet).
 */

import { topologicalOrder } from "./validator.js";
import type { Plan, PlanNode, PlanNodeOutcome, PlanExecution } from "./types.js";
import type { ToolDefinition } from "../../core/types.js";

export interface DispatchResult {
  isError: boolean;
  /** Whatever shape the tool returned. We pass this on to downstream
   *  nodes via `args_from`, so structuredContent (when present) lives at
   *  `output.structuredContent`. */
  output: unknown;
  /** Receipt the underlying tool/call emitted, when attestation is on. */
  receipt?: unknown;
  duration_ms: number;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
  /**
   * Optional catalog accessor. Required for rollback — the executor
   * needs to look up `ToolDefinition.inverse` to undo completed nodes
   * when a later one fails. Without it, rollback is silently skipped
   * (rollback_attempted stays false).
   */
  catalog?: () => ToolDefinition[];
  /**
   * If true, when a node fails with `on_error: "abort"`, walk the
   * already-completed nodes in reverse order and invoke each tool's
   * inverse. Default: true (atomic-or-nothing semantics).
   */
  rollbackOnAbort?: boolean;
}

export type Dispatcher = (toolName: string, args: unknown) => Promise<DispatchResult>;

export async function executePlan(
  planId: string,
  plan: Plan,
  dispatch: Dispatcher,
  opts: ExecuteOptions = {},
): Promise<PlanExecution> {
  const order = topologicalOrder(plan.nodes);
  if (!order) {
    return {
      plan_id: planId,
      status: "failed",
      outcomes: [],
      total_duration_ms: 0,
      rollback_attempted: false,
    };
  }
  const byId = new Map(plan.nodes.map((n) => [n.id, n] as const));
  const outcomes = new Map<string, PlanNodeOutcome>();
  const started = Date.now();
  let aborted = false;

  // Sequential execution — parallel-where-possible adds complexity that
  // pays off only past 4-5 nodes. For the typical 2-5 node plan this is
  // simpler and observably indistinguishable.
  for (const id of order) {
    if (opts.signal?.aborted) {
      aborted = true;
      outcomes.set(id, {
        node_id: id,
        status: "cancelled",
        duration_ms: 0,
      });
      continue;
    }
    const node = byId.get(id)!;

    // Skip if any dep failed and we're in abort mode.
    const depBlocked = (node.depends_on ?? []).some((d) => {
      const dep = outcomes.get(d);
      return !dep || dep.status !== "completed";
    });
    if (depBlocked) {
      outcomes.set(id, {
        node_id: id,
        status: "skipped",
        duration_ms: 0,
        error: "skipped: upstream dependency did not complete",
      });
      continue;
    }

    const args = resolveArgs(node, outcomes);
    let result: DispatchResult;
    try {
      result = await dispatch(node.tool, args);
    } catch (err: unknown) {
      result = {
        isError: true,
        output: { error: err instanceof Error ? err.message : String(err) },
        duration_ms: 0,
      };
    }

    if (!result.isError) {
      outcomes.set(id, {
        node_id: id,
        status: "completed",
        input: args,
        output: result.output,
        receipt: result.receipt,
        duration_ms: result.duration_ms,
      });
      continue;
    }

    // Error path
    const errMsg =
      typeof result.output === "object" && result.output && "error" in result.output
        ? String((result.output as { error: unknown }).error)
        : "tool returned isError";
    outcomes.set(id, {
      node_id: id,
      status: "failed",
      error: errMsg,
      input: args,
      output: result.output,
      receipt: result.receipt,
      duration_ms: result.duration_ms,
    });
    if (node.on_error === "abort") {
      // Mark the rest as skipped.
      for (const remaining of order) {
        if (!outcomes.has(remaining)) {
          outcomes.set(remaining, {
            node_id: remaining,
            status: "skipped",
            duration_ms: 0,
            error: `aborted: upstream node "${id}" failed`,
          });
        }
      }
      break;
    }
    // "skip" / "continue" — fall through and keep going. The blocker
    // logic at the top of each iteration will skip nodes that depended
    // on this one.
  }

  let rollbackAttempted = false;
  // Rollback path: any node failed in abort mode AND we have a catalog.
  // Walk completed nodes in REVERSE execution order and invoke their
  // inverse tools. This gives "atomic or nothing" semantics — each
  // committed side-effect gets paired with its undo.
  const anyFailed = [...outcomes.values()].some((o) => o.status === "failed");
  const wantRollback = opts.rollbackOnAbort !== false && anyFailed && opts.catalog !== undefined;
  if (wantRollback && opts.catalog) {
    rollbackAttempted = true;
    const catalog = new Map(opts.catalog().map((t) => [t.name, t]));
    const reversed = [...order].reverse();
    for (const id of reversed) {
      const outcome = outcomes.get(id);
      if (!outcome || outcome.status !== "completed") continue;
      const node = byId.get(id);
      if (!node) continue;
      const tool = catalog.get(node.tool);
      const inverse = tool?.inverse;
      if (!inverse) {
        // No inverse declared — record skip and move on. The node stays
        // committed; the operator now knows exactly which non-reversible
        // side-effect occurred (the one with no rollback record).
        outcome.rollback = { tool: "", status: "skipped", error: "no inverse declared" };
        continue;
      }
      const inverseTool = catalog.get(inverse.tool);
      if (!inverseTool) {
        outcome.rollback = { tool: inverse.tool, status: "failed", error: `inverse tool not in catalog: ${inverse.tool}` };
        continue;
      }
      const source = inverse.argsFrom ?? "output";
      const inverseArgs = source === "input" ? outcome.input : extractStructured(outcome.output);
      try {
        const r = await dispatch(inverse.tool, inverseArgs);
        outcome.rollback = {
          tool: inverse.tool,
          status: r.isError ? "failed" : "completed",
          error: r.isError ? `inverse returned isError` : undefined,
        };
        if (!r.isError) outcome.status = "rolled_back";
      } catch (err: unknown) {
        outcome.rollback = {
          tool: inverse.tool,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  const status = computeOverallStatus(outcomes, aborted, rollbackAttempted);
  return {
    plan_id: planId,
    status,
    outcomes: order.map((id) => outcomes.get(id)!).filter(Boolean),
    total_duration_ms: Date.now() - started,
    rollback_attempted: rollbackAttempted,
  };
}

function resolveArgs(node: PlanNode, outcomes: Map<string, PlanNodeOutcome>): unknown {
  if (node.args_from) {
    const upstream = outcomes.get(node.args_from);
    if (!upstream || upstream.status !== "completed") {
      throw new Error(`args_from "${node.args_from}" has no completed output`);
    }
    return extractStructured(upstream.output);
  }
  if (node.args_template) {
    const out: Record<string, unknown> = {};
    for (const [k, tmpl] of Object.entries(node.args_template)) {
      out[k] = renderTemplate(tmpl, outcomes);
    }
    return out;
  }
  return node.args ?? {};
}

/** Pull the structured payload out of a CallToolResult-shaped output. If
 *  the tool didn't emit structuredContent, fall back to the raw text. */
function extractStructured(output: unknown): unknown {
  if (output && typeof output === "object" && "structuredContent" in output) {
    return (output as { structuredContent: unknown }).structuredContent;
  }
  if (output && typeof output === "object" && "content" in output) {
    const content = (output as { content: Array<{ type: string; text: string }> }).content;
    return content.map((c) => c.text).join("");
  }
  return output;
}

/** Resolve `${nodes.X.path.to.field}` references against completed
 *  outcomes. Lookup uses dot-paths over the structured output. Missing
 *  references raise — the validator should have caught them, but if a
 *  node's output shape didn't match what the template expected we fail
 *  the dependent node cleanly. */
function renderTemplate(tmpl: string, outcomes: Map<string, PlanNodeOutcome>): string {
  return tmpl.replace(/\$\{nodes\.([^}]+)\}/g, (_match, expr: string) => {
    const [nodeId, ...path] = expr.split(".");
    const upstream = outcomes.get(nodeId);
    if (!upstream || upstream.status !== "completed") {
      throw new Error(`template references unfinished node "${nodeId}"`);
    }
    let cur: unknown = extractStructured(upstream.output);
    for (const segment of path) {
      if (cur === null || cur === undefined) {
        throw new Error(`template path "${expr}" hit null/undefined`);
      }
      if (typeof cur !== "object") {
        throw new Error(`template path "${expr}" tried to descend into non-object`);
      }
      cur = (cur as Record<string, unknown>)[segment];
    }
    return cur === undefined ? "" : String(cur);
  });
}

function computeOverallStatus(
  outcomes: Map<string, PlanNodeOutcome>,
  aborted: boolean,
  rollbackAttempted: boolean,
): PlanExecution["status"] {
  if (aborted) return "cancelled";
  let anyFailed = false;
  let anyRolledBack = false;
  for (const o of outcomes.values()) {
    if (o.status === "failed") anyFailed = true;
    if (o.status === "rolled_back") anyRolledBack = true;
  }
  if (!anyFailed) return "completed";
  // Plan failed AND we walked the rollback path → "rolled_back" iff at
  // least one completed node was successfully undone (the operator can
  // see exactly which by inspecting outcome.rollback). Otherwise "failed".
  if (rollbackAttempted && anyRolledBack) return "rolled_back";
  return "failed";
}
