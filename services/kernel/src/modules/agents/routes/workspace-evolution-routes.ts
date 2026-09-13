/**
 * Workspace evolution (target='workspace'): scaffolding `.evolve/`, taking
 * snapshots, evaluating a candidate, and accepting, rejecting or reverting it.
 *
 * Split out of `api-routes.ts` unchanged. `workspaceEvolver` is optional
 * upstream, so `ensureEvolver` — which moved in with these routes — answers
 * 503 when the feature is not configured instead of throwing.
 */

import type { ServerResponse } from "node:http";
import type { KernelHttpServer } from "../../../core/http-server.js";
import type { AgentService } from "../service.js";
import type { AgentExecutor } from "../executor.js";
import type { EventBus } from "../../../core/event-bus.js";
import type { WorkspaceEvolverLike } from "../advanced-types.js";
import { log } from "../../../core/logger.js";

export function registerWorkspaceEvolutionRoutes(
  server: KernelHttpServer,
  service: AgentService,
  executor: AgentExecutor,
  events?: EventBus,
  workspaceEvolver?: WorkspaceEvolverLike,
): void {

  // ── Workspace evolution (target='workspace') ─────────────────────────

  function ensureEvolver(res: ServerResponse): WorkspaceEvolverLike | null {
    if (!workspaceEvolver) {
      server.json(res, 503, { error: "workspace evolver not configured" });
      return null;
    }
    return workspaceEvolver;
  }

  // GET /api/workspaces/:id/evolution — describe workspace evolver state
  server.get("/api/workspaces/:id/evolution", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const state = await evolver.describe(id);
      const history = service.listEvolutionRunsByWorkspace(id, 50);
      server.json(res, 200, { ...state, history });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/workspaces/:id/evolution/init — scaffold .evolve/ + git
  server.post("/api/workspaces/:id/evolution/init", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const result = await evolver.init(id);
      server.json(res, 200, result);
    } catch (err) {
      log.error("workspace evolution init failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/workspaces/:id/evolution/snapshot — commit current state
  server.post("/api/workspaces/:id/evolution/snapshot", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{ label?: string; agent_id?: string }>(req)
        .catch(() => ({} as Record<string, unknown>));
      const snap = await evolver.snapshotBaseline({
        workspace_id: id,
        agent_id: typeof body?.agent_id === "string" ? body.agent_id : undefined,
        label: typeof body?.label === "string" ? body.label : undefined,
      });
      server.json(res, 200, snap);
    } catch (err) {
      log.error("workspace snapshot failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/workspaces/:id/evolution/evaluate — run policy.evaluation.command
  server.post("/api/workspaces/:id/evolution/evaluate", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const result = await evolver.evaluate({ workspace_id: id });
      if (!result) { server.json(res, 412, { error: "no policy.json — call /init first" }); return; }
      server.json(res, 200, result);
    } catch (err) {
      log.error("workspace evaluate failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/workspaces/:id/evolution/accept — promote dirty state to candidate
  server.post("/api/workspaces/:id/evolution/accept", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{
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
      }>(req);
      if (!body?.baseline_ref || !body?.evaluation || !body?.agent_id) {
        server.json(res, 400, { error: "baseline_ref, evaluation and agent_id required" });
        return;
      }
      const summary = await evolver.acceptCandidate({
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
      });
      server.json(res, 200, summary);
    } catch (err) {
      log.error("workspace accept failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/workspaces/:id/evolution/reject — record rejection, optionally revert
  server.post("/api/workspaces/:id/evolution/reject", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{
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
        revert?: boolean;
      }>(req);
      if (!body?.baseline_ref || !body?.evaluation || !body?.agent_id) {
        server.json(res, 400, { error: "baseline_ref, evaluation and agent_id required" });
        return;
      }
      const summary = await evolver.rejectCandidate({
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
        revert: body.revert,
      });
      server.json(res, 200, summary);
    } catch (err) {
      log.error("workspace reject failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/workspaces/:id/evolution/cycle — full SEPL: baseline → run agent → evaluate → accept|reject
  server.post("/api/workspaces/:id/evolution/cycle", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{
        agent_id: string;
        goal: string;
        revert_on_fail?: boolean;
        notes?: string;
      }>(req);
      if (!body?.agent_id || !body?.goal) {
        server.json(res, 400, { error: "agent_id and goal required" });
        return;
      }
      const out = await evolver.runCycle({
        workspace_id: id,
        agent_id: body.agent_id,
        goal: body.goal,
        executor,
        events,
        revertOnFail: body.revert_on_fail,
        notes: body.notes,
      });
      server.json(res, 200, out);
    } catch (err) {
      log.error("workspace cycle failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/workspaces/:id/evolution/revert — hard revert to a known ref
  server.post("/api/workspaces/:id/evolution/revert", async (req, res) => {
    try {
      const evolver = ensureEvolver(res); if (!evolver) return;
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{ ref: string }>(req);
      if (!body?.ref) { server.json(res, 400, { error: "ref required" }); return; }
      const result = await evolver.revertTo(id, body.ref);
      server.json(res, 200, result);
    } catch (err) {
      log.error("workspace revert failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });
}
