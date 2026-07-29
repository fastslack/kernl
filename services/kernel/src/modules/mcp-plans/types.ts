/**
 * Wire-format types for the plan/validate/commit primitive.
 *
 * Shape philosophy: a plan is a small DAG of tool calls with explicit
 * dependencies. The model emits it once; the server validates the
 * whole thing (auth, budget, side-effects) before touching anything;
 * the user approves once for the full plan; the server commits it
 * with per-node receipts encadenados.
 *
 * What we don't try to be: a general workflow engine. There's no
 * branching, no loops, no retries beyond a per-node `on_error`. If
 * you need that, write `kernel_code_run` and pay the inference round.
 * Plans are for "do these N things in order, atomically, with cost
 * preview."
 */

import { z } from "zod";

export const PlanNodeSchema = z.object({
  /** Stable identifier within this plan (e.g. "fetch", "filter", "send"). */
  id: z.string().min(1),
  /** Tool name to invoke. Must exist in the kernel catalog at validate time. */
  tool: z.string().min(1),
  /**
   * Static arguments. Mutually exclusive with `args_from` / `args_template`.
   * Plain JSON; validated against the tool's inputSchema at execution time.
   */
  args: z.unknown().optional(),
  /**
   * "Take the entire structuredContent of node X as my args." Cheapest
   * way to pipe one tool's output into another.
   */
  args_from: z.string().optional(),
  /**
   * Template-string args. `${nodes.X.<jsonpath>}` references resolve at
   * execution time — see `executor.ts`. Useful for "use X's first
   * result as my `id` arg".
   */
  args_template: z.record(z.string(), z.string()).optional(),
  /** Nodes that must complete (status="completed") before this one starts. */
  depends_on: z.array(z.string()).default([]),
  /** What to do if this node fails. Default: abort the plan. */
  on_error: z.enum(["abort", "skip", "continue"]).default("abort"),
});
export type PlanNode = z.infer<typeof PlanNodeSchema>;

export const PlanConstraintsSchema = z.object({
  max_usd: z.number().nonnegative().optional(),
  max_latency_ms: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  abort_on_first_error: z.boolean().default(true),
});
export type PlanConstraints = z.infer<typeof PlanConstraintsSchema>;

export const PlanSchema = z.object({
  nodes: z.array(PlanNodeSchema).min(1),
  constraints: PlanConstraintsSchema.optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const PlanIssueSchema = z.object({
  level: z.enum(["error", "warning"]),
  node_id: z.string().optional(),
  message: z.string(),
});
export type PlanIssue = z.infer<typeof PlanIssueSchema>;

export const PlanValidationSchema = z.object({
  validated: z.boolean(),
  plan_id: z.string(),
  issues: z.array(PlanIssueSchema),
  estimated_cost: z.object({
    usd: z.number(),
    tokens: z.number(),
    latency_ms: z.number(),
  }),
  side_effects_preview: z.array(z.string()),
  /** True when ANY node has reversible=false. The executor refuses to
   *  commit until the user provides an `approval_token`. */
  requires_approval: z.boolean(),
});
export type PlanValidation = z.infer<typeof PlanValidationSchema>;

export const PlanNodeOutcomeSchema = z.object({
  node_id: z.string(),
  status: z.enum(["completed", "failed", "skipped", "cancelled", "rolled_back"]),
  output: z.unknown().optional(),
  /** Resolved input (after args / args_from / args_template). Stashed
   *  so the rollback path can hand it to inverse tools that derive
   *  their args from the original call's input. */
  input: z.unknown().optional(),
  error: z.string().optional(),
  receipt: z.unknown().optional(),
  /** Optional rollback record — set when this node was undone after a
   *  later node failed. Contains the inverse tool name + its outcome. */
  rollback: z
    .object({
      tool: z.string(),
      status: z.enum(["completed", "failed", "skipped"]),
      error: z.string().optional(),
    })
    .optional(),
  duration_ms: z.number().int().nonnegative(),
});
export type PlanNodeOutcome = z.infer<typeof PlanNodeOutcomeSchema>;

export const PlanExecutionSchema = z.object({
  plan_id: z.string(),
  status: z.enum(["completed", "failed", "cancelled", "rolled_back"]),
  outcomes: z.array(PlanNodeOutcomeSchema),
  total_duration_ms: z.number().int().nonnegative(),
  rollback_attempted: z.boolean(),
});
export type PlanExecution = z.infer<typeof PlanExecutionSchema>;
