/**
 * Prompt lineage and evolution runs for a single agent (Autogenesis RSPL/SEPL):
 * listing versions, diffing them, restoring one, and accepting or rejecting a
 * proposed evolution.
 *
 * Split out of `api-routes.ts` unchanged. `optimizer` is optional upstream and
 * stays optional here: without it the evolution endpoints report that the
 * feature is unavailable rather than failing.
 */

import { HttpError, type KernelHttpServer } from "../../../core/http-server.js";
import type { AgentService } from "../service.js";
import type { ReflectionOptimizerLike } from "../advanced-types.js";

export function registerPromptVersionRoutes(
  server: KernelHttpServer,
  service: AgentService,
  optimizer?: ReflectionOptimizerLike,
): void {

  /** A `:version`-style path segment as a number, 400 with `message` when it is not one. */
  const versionParam = (raw: string, message: string): number => {
    const version = Number(raw);
    if (!Number.isFinite(version)) throw new HttpError(400, message);
    return version;
  };

  // ── Prompt versions (Autogenesis RSPL lineage) ────

  // GET /api/agents/:id/prompt-versions
  server.route("GET", "/api/agents/:id/prompt-versions", ({ params: { id } }) => {
    const versions = service.listPromptVersions(id, 100);
    const active = service.getActivePromptVersion(id);
    return { versions, active_version: active?.version ?? null };
  });

  // GET /api/agents/:id/prompt-versions/:version
  server.route("GET", "/api/agents/:id/prompt-versions/:version", ({ params }) => {
    const version = versionParam(params.version, "id and version required");
    const row = service.getPromptVersion(params.id, version);
    if (!row) throw new HttpError(404, "version not found");
    return row;
  });

  // GET /api/agents/:id/prompt-versions/:from/diff/:to
  server.route("GET", "/api/agents/:id/prompt-versions/:from/diff/:to", ({ params }) => {
    const from = versionParam(params.from, "id, from, to required");
    const to = versionParam(params.to, "id, from, to required");
    const diff = service.diffPromptVersions(params.id, from, to);
    if (!diff) throw new HttpError(404, "version(s) not found");
    return diff;
  });

  // POST /api/agents/:id/prompt-versions/:version/restore — roll back to this version
  server.route<{ note?: string } | null>("POST", "/api/agents/:id/prompt-versions/:version/restore", ({ params, body }) => {
    const version = versionParam(params.version, "id and version required");
    const snap = service.restorePromptVersion(params.id, version, body?.note ?? "");
    if (!snap) throw new HttpError(404, "agent or version not found");
    return { success: true, version: snap };
  });

  // POST /api/agents/:id/prompt-versions/:version/activate — flip active to existing version
  server.route("POST", "/api/agents/:id/prompt-versions/:version/activate", ({ params }) => {
    const version = versionParam(params.version, "id and version required");
    const row = service.activatePromptVersion(params.id, version);
    if (!row) throw new HttpError(404, "agent or version not found");
    return { success: true, version: row };
  });

  // ── Evolution runs (Autogenesis SEPL) ─────────────

  // GET /api/agents/:id/evolution — list recent evolution cycles
  server.route("GET", "/api/agents/:id/evolution", ({ params: { id } }) => ({
    evolution_runs: service.listEvolutionRuns(id, 50),
  }));

  // POST /api/agents/:id/evolution/run — trigger one reflection cycle synchronously
  server.route<{
    lookbackRuns?: number;
    minFailures?: number;
    commitMargin?: number;
    dryRun?: boolean;
    model?: string;
  } | null>("POST", "/api/agents/:id/evolution/run", async ({ params: { id }, body }) => {
    if (!optimizer) throw new HttpError(503, "optimizer not configured");
    const run = await optimizer.runCycle(id, body ?? {});
    if (!run) return { triggered: false, reason: "not enough failures in lookback window" };
    return { triggered: true, evolution: run };
  });

  // POST /api/agents/evolution/:runId/accept — manual commit of a proposed/rejected candidate
  server.route("POST", "/api/agents/evolution/:runId/accept", ({ params: { runId } }) => {
    const evo = service.getEvolutionRun(runId);
    if (!evo) throw new HttpError(404, "evolution run not found");
    if (!evo.candidate_version) throw new HttpError(400, "no candidate written yet");
    service.activatePromptVersion(evo.agent_id, evo.candidate_version);
    const updated = service.updateEvolutionRun(runId, {
      status: "accepted",
      committed_at: new Date().toISOString(),
    });
    return { success: true, evolution: updated };
  });

  // POST /api/agents/evolution/:runId/reject — explicitly reject a proposed candidate
  server.route("POST", "/api/agents/evolution/:runId/reject", ({ params: { runId } }) => {
    const updated = service.updateEvolutionRun(runId, { status: "rejected" });
    if (!updated) throw new HttpError(404, "evolution run not found");
    return { success: true, evolution: updated };
  });
}
