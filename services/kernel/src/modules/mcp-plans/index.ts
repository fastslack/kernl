/**
 * mcp-plans module — plan/validate/commit primitive.
 *
 * Two tools that move agents from "fire-and-forget" to "preview-then-commit":
 *
 *   * `kernel_plan_validate` — DAG validation + cost simulation +
 *     side-effects preview. Pure: nothing executes. The model can iterate
 *     here for free until the plan is acceptable.
 *   * `kernel_plan_execute` — runs the plan. If the validation said
 *     `requires_approval=true`, the caller MUST first elicit user
 *     approval and pass back the matching `approval_token`. Without
 *     a token the execute call refuses.
 *
 * The approval token is just a HMAC over the plan body keyed with the
 * server's identity — cheap, stateless, no DB row to track.
 */

import { z } from "zod";
import type { KernelModule, ModuleContext, ToolDefinition, ToolResult } from "../../core/types.js";
import { errorResult, structuredResult } from "../../core/helpers.js";
import {
  hashJson,
  signPlanReceipt,
  type Identity,
  type Receipt,
} from "../../core/attestation.js";
import { elicit } from "../../core/elicit.js";
import {
  PlanSchema,
  type Plan,
  type PlanNodeOutcome,
} from "./types.js";
import { validatePlan } from "./validator.js";
import { simulate } from "./simulator.js";
import { executePlan, type Dispatcher } from "./executor.js";
import type { CostRouter } from "../../core/llm/cost-router.js";
import { defineTool } from "../../core/tool-builder.js";

export interface McpPlansOptions {
  getCatalog: () => ToolDefinition[];
  getDispatcher: () => Dispatcher;
  getIdentity?: () => Identity | undefined;
  getCostRouter?: () => CostRouter | undefined;
}

export function createMcpPlansModule(opts: McpPlansOptions): KernelModule {
  const tools: ToolDefinition[] = [
    buildPlanValidate(opts),
    buildPlanExecute(opts),
  ];
  return {
    name: "mcp-plans",
    async initialize(_ctx: ModuleContext): Promise<void> {
      // Stateless module — no migrations, no service.
    },
    getTools(): ToolDefinition[] { return tools; },
    async shutdown(): Promise<void> {},
  };
}

const PlanValidateInput = z.object({
  plan: PlanSchema,
});

function buildPlanValidate(opts: McpPlansOptions): ToolDefinition {
  return defineTool({
    name: "kernel_plan_validate",
    description:
      "Validate + simulate a plan (DAG of tool calls). Pure: nothing " +
      "executes. Returns issues (cycles, dangling deps, unknown tools), " +
      "estimated_cost (sum of per-node p50s, latency = critical path), " +
      "side_effects_preview, and requires_approval (true when any node " +
      "calls a non-reversible tool). Pair with `kernel_plan_execute`.",
    schema: PlanValidateInput,
    outputSchema: z.unknown(),
    tags: ["meta", "plans", "validate"],
    cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 5, reversible: true, cacheable: true },
    async handler({ plan }): Promise<ToolResult> {
      const issues = validatePlan({ plan, catalog: opts.getCatalog });
      const hasErrors = issues.some((i) => i.level === "error");

      const sim = hasErrors
        ? {
            estimated_cost: { usd: 0, tokens: 0, latency_ms: 0 },
            side_effects_preview: [],
            requires_approval: false,
          }
        : simulate(plan, opts.getCatalog, opts.getCostRouter?.());

      const planId = `plan_${hashJson(plan).slice("sha256:".length, "sha256:".length + 16)}`;
      return structuredResult({
        validated: !hasErrors,
        plan_id: planId,
        issues,
        ...sim,
        // Approval token — bound to the plan content. The execute tool
        // re-derives this and checks equality. See `tokenFor`.
        approval_token: opts.getIdentity ? tokenFor(plan, opts.getIdentity()) : undefined,
      });
    },
  });
}

const PlanExecuteInput = z.object({
  plan: PlanSchema,
  /** Required when validation said `requires_approval=true`. Obtain by
   *  calling `kernel_plan_validate` first and copying the field — the
   *  server re-derives it from the plan body and checks equality. */
  approval_token: z.string().optional(),
  /** When true, prompt the user via elicitation BEFORE executing.
   *  Useful in interactive sessions; non-interactive callers pass
   *  approval_token instead. */
  prompt_user: z.boolean().default(false),
});

function buildPlanExecute(opts: McpPlansOptions): ToolDefinition {
  return defineTool({
    name: "kernel_plan_execute",
    description:
      "Run a plan that previously passed `kernel_plan_validate`. When the " +
      "plan touches non-reversible tools, the caller MUST either pass a " +
      "matching `approval_token` (from validate) or set `prompt_user: true` " +
      "to drive an interactive elicitation. Returns one outcome per node " +
      "with status, duration, and the per-call receipt when attestation is on.",
    schema: PlanExecuteInput,
    outputSchema: z.unknown(),
    tags: ["meta", "plans", "execute", "commit"],
    sideEffects: ["plan.executed:1"],
    async handler({ plan, approval_token, prompt_user }): Promise<ToolResult> {
      const issues = validatePlan({ plan, catalog: opts.getCatalog });
      if (issues.some((i) => i.level === "error")) {
        return errorResult(`Plan invalid:\n${issues.map((i) => `  - ${i.message}`).join("\n")}`);
      }
      const sim = simulate(plan, opts.getCatalog, opts.getCostRouter?.());

      // Approval gate
      if (sim.requires_approval) {
        const expected = tokenFor(plan, opts.getIdentity?.());
        if (approval_token && expected && approval_token === expected) {
          // Token approved — fall through.
        } else if (prompt_user) {
          const outcome = await elicit<{ confirm: boolean }>({
            message:
              `This plan touches non-reversible tools and needs approval.\n\n` +
              `Estimated cost: $${sim.estimated_cost.usd.toFixed(4)} · ` +
              `${sim.estimated_cost.tokens} tokens · ` +
              `~${sim.estimated_cost.latency_ms}ms\n\n` +
              `Side effects:\n${sim.side_effects_preview.map((s) => `  - ${s}`).join("\n") || "  (none)"}`,
            fields: { confirm: { type: "boolean", title: "Approve and run plan?" } },
            required: ["confirm"],
          });
          if (outcome.action !== "accept" || !outcome.content.confirm) {
            return errorResult("plan execution declined by user");
          }
        } else {
          return errorResult(
            "plan requires approval — call kernel_plan_validate to obtain " +
              "an approval_token or pass prompt_user: true",
          );
        }
      }

      const planId = `plan_${hashJson(plan).slice("sha256:".length, "sha256:".length + 16)}`;
      const dispatch = opts.getDispatcher();
      const exec = await executePlan(planId, plan, dispatch, {
        catalog: opts.getCatalog,
        rollbackOnAbort: true,
      });

      // Chain it cryptographically: when an identity is active we collect
      // the per-node receipts and sign a plan_receipt with a merkle root.
      // Verifiers can audit the whole plan with ONE signature — and
      // detectar tampering en cualquier nodo individual.
      const identity = opts.getIdentity?.();
      let planReceipt: ReturnType<typeof signPlanReceipt> | undefined;
      if (identity) {
        const childReceipts = exec.outcomes
          .map((o) => o.receipt)
          .filter((r): r is Receipt => isReceipt(r));
        const nodeSummary = exec.outcomes.map((o) => `${o.node_id}:${o.status}`);
        const succeededCount = exec.outcomes.filter((o) => o.status === "completed").length;
        planReceipt = signPlanReceipt({
          identity,
          planId,
          childReceipts,
          nodeSummary,
          succeededCount,
        });
      }

      return structuredResult({ ...exec, plan_receipt: planReceipt });
    },
  });
}

/**
 * Receipt-shape duck-type — the plan executor stores receipts under
 * `outcome.receipt: unknown` (plans don't depend on attestation
 * directly), so we runtime-check before encadenarlas.
 */
function isReceipt(r: unknown): r is Receipt {
  if (!r || typeof r !== "object") return false;
  const obj = r as Record<string, unknown>;
  return (
    typeof obj.v === "number" &&
    typeof obj.tool === "string" &&
    typeof obj.input_hash === "string" &&
    typeof obj.output_hash === "string" &&
    typeof obj.server_id === "string" &&
    typeof obj.sig === "string"
  );
}

/**
 * Cheap, stateless approval token — HMAC of the canonical plan body
 * keyed with the server identity's secret. Same plan body produces the
 * same token; different plan ⇒ different token; without the secret you
 * can't forge one. Empty string when there's no identity (no
 * attestation enabled), so the approval gate falls back to elicitation.
 */
function tokenFor(plan: Plan, identity: Identity | undefined): string | undefined {
  if (!identity) return undefined;
  // The Identity API exposes `signBytes`; we reuse it as a MAC by
  // signing the canonical plan and hashing the signature. Cryptographically
  // this is overkill (Ed25519 isn't a MAC) but it's free and identifying:
  // possession of the secret is the only way to produce the same bytes.
  const sig = identity.signBytes(new TextEncoder().encode(JSON.stringify(plan)));
  // 16 hex chars = 64 bits, plenty for replay-guard.
  let s = "";
  for (let i = 0; i < 8; i++) s += sig[i].toString(16).padStart(2, "0");
  return s;
}
