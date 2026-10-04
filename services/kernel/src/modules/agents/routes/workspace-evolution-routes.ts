/**
 * Workspace evolution (target='workspace'): scaffolding `.evolve/`, taking
 * snapshots, evaluating a candidate, and accepting, rejecting or reverting it.
 *
 * Split out of `api-routes.ts` unchanged. `workspaceEvolver` is optional
 * upstream, so `ensureEvolver` — which moved in with these routes — answers
 * 503 when the feature is not configured instead of throwing.
 */

import { HttpError, type KernelHttpServer } from "../../../core/http-server.js";
import type { AgentService } from "../service.js";
import type { AgentExecutor } from "../executor.js";
import type { EventBus } from "../../../core/event-bus.js";
import type { WorkspaceEvolverLike } from "../advanced-types.js";

/** Body shared by the accept and reject endpoints. */
interface CandidateVerdictBody {
  baseline_ref: string;
  evaluation: {
    passed: boolean;
    exit_code: number;
    stdout?: string;
    stderr?: string;
    duration_ms: number;
    timed_out?: boolean;
  };
  agent_id?: string;
  trigger_run_ids?: string[];
  hypothesis?: string;
  notes?: string;
}

export function registerWorkspaceEvolutionRoutes(
  server: KernelHttpServer,
  service: AgentService,
  executor: AgentExecutor,
  events?: EventBus,
  workspaceEvolver?: WorkspaceEvolverLike,
): void {

  // ── Workspace evolution (target='workspace') ─────────────────────────

  function ensureEvolver(): WorkspaceEvolverLike {
    if (!workspaceEvolver) throw new HttpError(503, "workspace evolver not configured");
    return workspaceEvolver;
  }

  /** The accept/reject body, 400 unless it names the baseline, the evaluation and the agent. */
  function verdictInput(id: string, body: CandidateVerdictBody | null) {
    if (!body?.baseline_ref || !body?.evaluation || !body?.agent_id) {
      throw new HttpError(400, "baseline_ref, evaluation and agent_id required");
    }
    return {
      workspace_id: id,
      agent_id: body.agent_id,
      baseline_ref: body.baseline_ref,
      evaluation: {
        passed: !!body.evaluation.passed,
        exit_code: body.evaluation.exit_code,
        stdout: body.evaluation.stdout ?? "",
        stderr: body.evaluation.stderr ?? "",
        duration_ms: body.evaluation.duration_ms,
        timed_out: !!body.evaluation.timed_out,
      },
      trigger_run_ids: body.trigger_run_ids,
      hypothesis: body.hypothesis,
      notes: body.notes,
    };
  }

  // GET /api/workspaces/:id/evolution — describe workspace evolver state
  server.route("GET", "/api/workspaces/:id/evolution", async ({ params: { id } }) => {
    const state = await ensureEvolver().describe(id);
    const history = service.listEvolutionRunsByWorkspace(id, 50);
    return { ...state, history };
  });

  // POST /api/workspaces/:id/evolution/init — scaffold .evolve/ + git
  server.route("POST", "/api/workspaces/:id/evolution/init", ({ params: { id } }) => ensureEvolver().init(id));

  // POST /api/workspaces/:id/evolution/snapshot — commit current state
  server.route<{ label?: unknown; agent_id?: unknown } | null>("POST", "/api/workspaces/:id/evolution/snapshot", ({ params: { id }, body }) =>
    ensureEvolver().snapshotBaseline({
      workspace_id: id,
      agent_id: typeof body?.agent_id === "string" ? body.agent_id : undefined,
      label: typeof body?.label === "string" ? body.label : undefined,
    }));

  // POST /api/workspaces/:id/evolution/evaluate — run policy.evaluation.command
  server.route("POST", "/api/workspaces/:id/evolution/evaluate", async ({ params: { id } }) => {
    const result = await ensureEvolver().evaluate({ workspace_id: id });
    if (!result) throw new HttpError(412, "no policy.json — call /init first");
    return result;
  });

  // POST /api/workspaces/:id/evolution/accept — promote dirty state to candidate
  server.route<CandidateVerdictBody | null>("POST", "/api/workspaces/:id/evolution/accept", ({ params: { id }, body }) => {
    const evolver = ensureEvolver();
    return evolver.acceptCandidate(verdictInput(id, body));
  });

  // POST /api/workspaces/:id/evolution/reject — record rejection, optionally revert
  server.route<(CandidateVerdictBody & { revert?: boolean }) | null>("POST", "/api/workspaces/:id/evolution/reject", ({ params: { id }, body }) => {
    const evolver = ensureEvolver();
    return evolver.rejectCandidate({ ...verdictInput(id, body), revert: body?.revert });
  });

  // POST /api/workspaces/:id/evolution/cycle — full SEPL: baseline → run agent → evaluate → accept|reject
  server.route<{
    agent_id: string;
    goal: string;
    revert_on_fail?: boolean;
    notes?: string;
  } | null>("POST", "/api/workspaces/:id/evolution/cycle", ({ params: { id }, body }) => {
    const evolver = ensureEvolver();
    if (!body?.agent_id || !body?.goal) throw new HttpError(400, "agent_id and goal required");
    return evolver.runCycle({
      workspace_id: id,
      agent_id: body.agent_id,
      goal: body.goal,
      executor,
      events,
      revertOnFail: body.revert_on_fail,
      notes: body.notes,
    });
  });

  // POST /api/workspaces/:id/evolution/revert — hard revert to a known ref
  server.route<{ ref: string } | null>("POST", "/api/workspaces/:id/evolution/revert", ({ params: { id }, body }) => {
    const evolver = ensureEvolver();
    if (!body?.ref) throw new HttpError(400, "ref required");
    return evolver.revertTo(id, body.ref);
  });
}
