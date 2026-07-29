/**
 * Workspace evolver tools — exposed so a supervising agent can drive the
 * gate-on-eval cycle for another agent + workspace.
 *
 * Three tools, all callable by trusted "supervisor" agents:
 *
 *   kernel_workspace_evolution_init      — scaffold .evolve files + git
 *   kernel_workspace_evolution_describe  — inspect policy, head sha, history
 *   kernel_workspace_evolution_run_cycle — full SEPL: snapshot → run → eval → accept|reject
 *
 * The cycle tool re-uses the kernel's AgentExecutor so the worker agent
 * runs through exactly the same code path as a manual run — only the
 * surrounding gate is what's new.
 */

import { z } from "zod";
import { textResult, errorResult } from "../../../../../../src/core/helpers.js";
import type { ToolDefinition } from "../../../../../../src/core/types.js";
import type { AgentService } from "../../../../../../src/modules/agents/service.js";
import type { AgentExecutor } from "../../../../../../src/modules/agents/executor.js";
import type { WorkspaceEvolverService } from "./service.js";

export function workspaceEvolverTools(
  agents: AgentService | null,
  executor: AgentExecutor | null,
  evolver: WorkspaceEvolverService | null,
): ToolDefinition[] {
  if (!evolver) return [];

  return [
    {
      name: "kernel_workspace_evolution_init",
      description:
        "Scaffold .evolve/policy.json + EVOLUTION.md + .evolve/checks/run-all.sh inside a workspace and ensure its git repo exists. " +
        "Idempotent — never overwrites existing content. Required once before run_cycle can operate on a workspace.",
      inputSchema: z.object({
        workspace_id: z.string().describe("UUID of the target workspace"),
      }) as z.ZodType<unknown>,
      handler: async (args: unknown) => {
        const a = args as Record<string, unknown>;
        const id = typeof a.workspace_id === "string" ? a.workspace_id : "";
        if (!id) return errorResult("workspace_id required");
        try {
          const r = await evolver.init(id);
          return textResult(
            `Workspace evolution initialised:\n` +
            `- policy: ${r.policyCreated ? "created" : "kept"}\n` +
            `- objectives: ${r.objectivesCreated ? "created" : "kept"}\n` +
            `- checks: ${r.checksCreated ? "created" : "kept"}\n` +
            `- head: \`${r.head_ref.slice(0, 12)}\``,
          );
        } catch (err) {
          return errorResult(`init failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    {
      name: "kernel_workspace_evolution_describe",
      description:
        "Inspect a workspace's evolver state: whether it's initialised, the loaded policy, the EVOLUTION.md objectives text, the current git head, and the recent evolution-run history.",
      inputSchema: z.object({
        workspace_id: z.string().describe("UUID of the target workspace"),
        history_limit: z.number().int().positive().max(200).optional()
          .describe("Max evolution-run rows to include (default 20)"),
      }) as z.ZodType<unknown>,
      handler: async (args: unknown) => {
        const a = args as Record<string, unknown>;
        const id = typeof a.workspace_id === "string" ? a.workspace_id : "";
        if (!id) return errorResult("workspace_id required");
        const limit = typeof a.history_limit === "number" ? a.history_limit : 20;
        try {
          const state = await evolver.describe(id);
          const history = agents?.listEvolutionRunsByWorkspace(id, limit) ?? [];
          const accepted = history.filter((h) => h.status === "accepted").length;
          const rejected = history.filter((h) => h.status === "rejected").length;
          const lines = [
            `**${id}** — initialised: ${state.initialised ? "yes" : "no"}`,
            `head: ${state.head_ref ? `\`${state.head_ref.slice(0, 12)}\`` : "—"}`,
            `policy: ${state.policy ? "loaded" : "missing (run init first)"}`,
            `objectives: ${state.objectives ? `${state.objectives.length} chars` : "missing"}`,
            `history: ${history.length} entries (${accepted} accepted, ${rejected} rejected)`,
          ];
          return textResult(lines.join("\n"));
        } catch (err) {
          return errorResult(`describe failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    {
      name: "kernel_workspace_evolution_run_cycle",
      description:
        "Run a full SEPL cycle on a workspace: snapshot baseline, dispatch the named agent with the given goal, run the policy evaluation, then either accept the candidate (eval passed) or reject + revert (eval failed). " +
        "Use when supervising another agent and want its filesystem changes gated on a tests-pass / health-check signal.",
      inputSchema: z.object({
        workspace_id: z.string().describe("UUID of the target workspace"),
        agent_id: z.string().describe("UUID of the worker agent that will edit the workspace"),
        goal: z.string().describe("What the worker agent should do (becomes the run's goal text)"),
        revert_on_fail: z.boolean().optional()
          .describe("Default true. When false, leaves dirty files on rejection so a human can triage."),
        notes: z.string().optional()
          .describe("Free-form notes stored in the evolution_run row's proposal field"),
      }) as z.ZodType<unknown>,
      handler: async (args: unknown) => {
        const a = args as Record<string, unknown>;
        if (!executor) return errorResult("AgentExecutor not configured");
        const workspaceId = typeof a.workspace_id === "string" ? a.workspace_id : "";
        const agentId = typeof a.agent_id === "string" ? a.agent_id : "";
        const goal = typeof a.goal === "string" ? a.goal : "";
        if (!workspaceId || !agentId || !goal) {
          return errorResult("workspace_id, agent_id and goal are required");
        }
        try {
          const out = await evolver.runCycle({
            workspace_id: workspaceId,
            agent_id: agentId,
            goal,
            executor,
            revertOnFail: typeof a.revert_on_fail === "boolean" ? a.revert_on_fail : undefined,
            notes: typeof a.notes === "string" ? a.notes : undefined,
          });
          const ev = out.summary.evaluation;
          const lines = [
            `Cycle ${out.summary.evolution_run_id.slice(0, 8)} — **${out.summary.status}**`,
            `agent run: \`${out.agent_run_id}\``,
            `baseline: \`${out.summary.baseline_ref.slice(0, 12)}\``,
            out.summary.candidate_ref
              ? `candidate: \`${out.summary.candidate_ref.slice(0, 12)}\``
              : `candidate: (none — rejected)`,
            ev
              ? `eval: exit=${ev.exit_code}, ${ev.duration_ms}ms${ev.timed_out ? " (timed out)" : ""}`
              : `eval: skipped`,
            out.summary.error ? `error: ${out.summary.error}` : "",
          ].filter(Boolean);
          return textResult(lines.join("\n"));
        } catch (err) {
          return errorResult(`cycle failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
  ];
}
