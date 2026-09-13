/**
 * Prompt lineage and evolution runs for a single agent (Autogenesis RSPL/SEPL):
 * listing versions, diffing them, restoring one, and accepting or rejecting a
 * proposed evolution.
 *
 * Split out of `api-routes.ts` unchanged. `optimizer` is optional upstream and
 * stays optional here: without it the evolution endpoints report that the
 * feature is unavailable rather than failing.
 */

import type { KernelHttpServer } from "../../../core/http-server.js";
import type { AgentService } from "../service.js";
import type { ReflectionOptimizerLike } from "../advanced-types.js";
import { log } from "../../../core/logger.js";

export function registerPromptVersionRoutes(
  server: KernelHttpServer,
  service: AgentService,
  optimizer?: ReflectionOptimizerLike,
): void {


  // ── Prompt versions (Autogenesis RSPL lineage) ────

  // GET /api/agents/:id/prompt-versions
  server.get("/api/agents/:id/prompt-versions", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const versions = service.listPromptVersions(id, 100);
      const active = service.getActivePromptVersion(id);
      server.json(res, 200, { versions, active_version: active?.version ?? null });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/:id/prompt-versions/:version
  server.get("/api/agents/:id/prompt-versions/:version", (req, res) => {
    try {
      const p = (req as unknown as { params: Record<string, string> }).params ?? {};
      const agentId = p.id;
      const version = Number(p.version);
      if (!agentId || !Number.isFinite(version)) { server.json(res, 400, { error: "id and version required" }); return; }
      const row = service.getPromptVersion(agentId, version);
      if (!row) { server.json(res, 404, { error: "version not found" }); return; }
      server.json(res, 200, row);
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/:id/prompt-versions/:from/diff/:to
  server.get("/api/agents/:id/prompt-versions/:from/diff/:to", (req, res) => {
    try {
      const p = (req as unknown as { params: Record<string, string> }).params ?? {};
      const agentId = p.id;
      const from = Number(p.from);
      const to = Number(p.to);
      if (!agentId || !Number.isFinite(from) || !Number.isFinite(to)) {
        server.json(res, 400, { error: "id, from, to required" });
        return;
      }
      const diff = service.diffPromptVersions(agentId, from, to);
      if (!diff) { server.json(res, 404, { error: "version(s) not found" }); return; }
      server.json(res, 200, diff);
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/:id/prompt-versions/:version/restore — roll back to this version
  server.post("/api/agents/:id/prompt-versions/:version/restore", async (req, res) => {
    try {
      const p = (req as unknown as { params: Record<string, string> }).params ?? {};
      const agentId = p.id;
      const version = Number(p.version);
      if (!agentId || !Number.isFinite(version)) { server.json(res, 400, { error: "id and version required" }); return; }
      const body = await server.parseBody<{ note?: string }>(req).catch(() => ({} as { note?: string }));
      const snap = service.restorePromptVersion(agentId, version, body?.note ?? "");
      if (!snap) { server.json(res, 404, { error: "agent or version not found" }); return; }
      server.json(res, 200, { success: true, version: snap });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/:id/prompt-versions/:version/activate — flip active to existing version
  server.post("/api/agents/:id/prompt-versions/:version/activate", (req, res) => {
    try {
      const p = (req as unknown as { params: Record<string, string> }).params ?? {};
      const agentId = p.id;
      const version = Number(p.version);
      if (!agentId || !Number.isFinite(version)) { server.json(res, 400, { error: "id and version required" }); return; }
      const row = service.activatePromptVersion(agentId, version);
      if (!row) { server.json(res, 404, { error: "agent or version not found" }); return; }
      server.json(res, 200, { success: true, version: row });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Evolution runs (Autogenesis SEPL) ─────────────

  // GET /api/agents/:id/evolution — list recent evolution cycles
  server.get("/api/agents/:id/evolution", (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const runs = service.listEvolutionRuns(id, 50);
      server.json(res, 200, { evolution_runs: runs });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/:id/evolution/run — trigger one reflection cycle synchronously
  server.post("/api/agents/:id/evolution/run", async (req, res) => {
    try {
      if (!optimizer) { server.json(res, 503, { error: "optimizer not configured" }); return; }
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const body = await server.parseBody<{
        lookbackRuns?: number;
        minFailures?: number;
        commitMargin?: number;
        dryRun?: boolean;
        model?: string;
      }>(req).catch(() => ({} as Record<string, unknown>));
      const run = await optimizer.runCycle(id, body ?? {});
      if (!run) {
        server.json(res, 200, { triggered: false, reason: "not enough failures in lookback window" });
        return;
      }
      server.json(res, 200, { triggered: true, evolution: run });
    } catch (err) {
      log.error("Evolution cycle failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/evolution/:runId/accept — manual commit of a proposed/rejected candidate
  server.post("/api/agents/evolution/:runId/accept", (req, res) => {
    try {
      const runId = (req as unknown as { params: Record<string, string> }).params?.runId;
      if (!runId) { server.json(res, 400, { error: "runId required" }); return; }
      const evo = service.getEvolutionRun(runId);
      if (!evo) { server.json(res, 404, { error: "evolution run not found" }); return; }
      if (!evo.candidate_version) { server.json(res, 400, { error: "no candidate written yet" }); return; }
      service.activatePromptVersion(evo.agent_id, evo.candidate_version);
      const updated = service.updateEvolutionRun(runId, {
        status: "accepted",
        committed_at: new Date().toISOString(),
      });
      server.json(res, 200, { success: true, evolution: updated });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/agents/evolution/:runId/reject — explicitly reject a proposed candidate
  server.post("/api/agents/evolution/:runId/reject", (req, res) => {
    try {
      const runId = (req as unknown as { params: Record<string, string> }).params?.runId;
      if (!runId) { server.json(res, 400, { error: "runId required" }); return; }
      const updated = service.updateEvolutionRun(runId, { status: "rejected" });
      if (!updated) { server.json(res, 404, { error: "evolution run not found" }); return; }
      server.json(res, 200, { success: true, evolution: updated });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });
}
