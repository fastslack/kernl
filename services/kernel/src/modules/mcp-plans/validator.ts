/**
 * Plan validation: structural + semantic checks before execution.
 *
 * What we catch here, before any tool runs:
 *   * Cycles in `depends_on` — DAG-only.
 *   * Dangling deps — node references a `depends_on` id that doesn't exist.
 *   * Unknown tools — the kernel catalog doesn't have a registered handler.
 *   * Mutually-exclusive arg modes — can't combine `args` + `args_from`.
 *   * Unknown `args_from` / `args_template` references.
 *
 * What we deliberately don't check:
 *   * Whether `args` matches the tool's inputSchema. Templates and
 *     `args_from` make static type-check fragile (the upstream output
 *     shape isn't always knowable). The executor zod-validates each
 *     node's resolved args at run time and fails that node cleanly.
 */

import type { PlanIssue, PlanNode, Plan } from "./types.js";
import type { ToolDefinition } from "../../core/types.js";

export interface ValidatorContext {
  plan: Plan;
  /** Live tool catalog accessor — same one the meta module uses. */
  catalog: () => ToolDefinition[];
}

export function validatePlan(ctx: ValidatorContext): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const ids = new Set<string>();

  // 1. Duplicate ids
  for (const node of ctx.plan.nodes) {
    if (ids.has(node.id)) {
      issues.push({ level: "error", node_id: node.id, message: `duplicate node id: ${node.id}` });
    }
    ids.add(node.id);
  }

  // 2. Dangling deps + arg mode exclusivity
  for (const node of ctx.plan.nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!ids.has(dep)) {
        issues.push({
          level: "error",
          node_id: node.id,
          message: `node "${node.id}" depends on unknown node "${dep}"`,
        });
      }
    }
    const argModes = [node.args !== undefined, node.args_from !== undefined, node.args_template !== undefined];
    const argModeCount = argModes.filter(Boolean).length;
    if (argModeCount > 1) {
      issues.push({
        level: "error",
        node_id: node.id,
        message: `node "${node.id}" sets multiple arg modes; use only one of args / args_from / args_template`,
      });
    }
    if (node.args_from && !ids.has(node.args_from)) {
      issues.push({
        level: "error",
        node_id: node.id,
        message: `node "${node.id}" args_from references unknown node "${node.args_from}"`,
      });
    }
    // args_from must be in deps (otherwise it could run before its source).
    if (node.args_from && !(node.depends_on ?? []).includes(node.args_from)) {
      issues.push({
        level: "warning",
        node_id: node.id,
        message: `node "${node.id}" args_from "${node.args_from}" is not in depends_on — execution order isn't guaranteed`,
      });
    }
  }

  // 3. Unknown tools — local catalog check. Names with the `peer:`
  //    prefix are mesh-routed by the dispatcher and won't show up in
  //    the local catalog snapshot, so we skip the check for them. The
  //    actual resolution failure (peer not trusted, peer offline) is
  //    surfaced at execution time as a per-node error.
  const known = new Set(ctx.catalog().map((t) => t.name));
  for (const node of ctx.plan.nodes) {
    if (node.tool.startsWith("peer:")) continue;
    if (!known.has(node.tool)) {
      issues.push({
        level: "error",
        node_id: node.id,
        message: `node "${node.id}" calls unknown tool "${node.tool}"`,
      });
    }
  }

  // 4. Cycles via topological sort attempt.
  if (issues.filter((i) => i.level === "error").length === 0) {
    const cycle = findCycle(ctx.plan.nodes);
    if (cycle) {
      issues.push({
        level: "error",
        message: `plan has a dependency cycle through nodes: ${cycle.join(" → ")}`,
      });
    }
  }

  return issues;
}

/** Topological sort. Returns the node ids in execution order, or `null`
 *  if a cycle exists (the cycle path is reported by `findCycle`). */
export function topologicalOrder(nodes: PlanNode[]): string[] | null {
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indegree.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const n of nodes) {
    for (const dep of n.depends_on ?? []) {
      adj.get(dep)?.push(n.id);
      indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1);
    }
  }

  const ready: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) ready.push(id);
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const newDeg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, newDeg);
      if (newDeg === 0) ready.push(next);
    }
  }

  if (order.length !== nodes.length) return null;
  return order;
}

/** Find one cycle path through depends_on. Used only for the validator's
 *  human-readable error message — we already know there IS a cycle when
 *  topologicalOrder returns null. */
function findCycle(nodes: PlanNode[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, n.depends_on ?? []);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(id: string): string[] | null {
    if (visiting.has(id)) {
      // Found cycle — return path from where we entered the cycle.
      const start = path.indexOf(id);
      return [...path.slice(start), id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    path.push(id);
    for (const next of adj.get(id) ?? []) {
      const hit = dfs(next);
      if (hit) return hit;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const n of nodes) {
    const hit = dfs(n.id);
    if (hit) return hit;
  }
  return null;
}
