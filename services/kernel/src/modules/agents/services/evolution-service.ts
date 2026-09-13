import type { SqliteDb } from "../../../core/db/sqlite.js";
import type { EventBus } from "../../../core/event-bus.js";
import { newId, isoNow } from "../../../core/helpers.js";
import type { AgentEvolutionRun } from "../types.js";

/**
 * Evolution runs (Autogenesis SEPL) — one row per proposed change to an agent.
 * Owns `agent_evolution_runs`; `AgentService` delegates to it.
 */
export class AgentEvolutionService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
  ) {}

  createEvolutionRun(input: {
    agent_id: string;
    base_version: number;
    hypothesis: string;
    proposal: string;
    trigger_run_ids?: string[];
    target?: AgentEvolutionRun["target"];
    workspace_id?: string;
    artifact_ref?: string;
  }): AgentEvolutionRun {
    const row: AgentEvolutionRun = {
      id: newId(),
      agent_id: input.agent_id,
      target: input.target ?? "prompt",
      workspace_id: input.workspace_id ?? "",
      artifact_ref: input.artifact_ref ?? "",
      base_version: input.base_version,
      candidate_version: 0,
      hypothesis: input.hypothesis,
      proposal: input.proposal,
      status: "proposed",
      baseline_score: 0,
      candidate_score: 0,
      trigger_run_ids: JSON.stringify(input.trigger_run_ids ?? []),
      evaluation: "",
      error: "",
      created_at: isoNow(),
      committed_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO agent_evolution_runs
          (id, agent_id, target, workspace_id, artifact_ref,
           base_version, candidate_version, hypothesis, proposal, status,
           baseline_score, candidate_score, trigger_run_ids, evaluation, error,
           created_at, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.agent_id, row.target, row.workspace_id, row.artifact_ref,
        row.base_version, row.candidate_version,
        row.hypothesis, row.proposal, row.status, row.baseline_score, row.candidate_score,
        row.trigger_run_ids, row.evaluation, row.error, row.created_at, row.committed_at,
      );
    this.events.emit("data.changed", { module: "agents", action: "evolution_proposed" });
    return row;
  }

  updateEvolutionRun(
    id: string,
    patch: Partial<Pick<AgentEvolutionRun,
      "candidate_version" | "status" | "baseline_score" | "candidate_score" | "evaluation" | "error" | "committed_at" | "artifact_ref">>,
  ): AgentEvolutionRun | undefined {
    const current = this.db
      .prepare("SELECT * FROM agent_evolution_runs WHERE id = ?")
      .get(id) as AgentEvolutionRun | undefined;
    if (!current) return undefined;
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      params.push(v as unknown);
    }
    if (sets.length === 0) return current;
    params.push(id);
    this.db.prepare(`UPDATE agent_evolution_runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    this.events.emit("data.changed", { module: "agents", action: "evolution_updated" });
    return this.db
      .prepare("SELECT * FROM agent_evolution_runs WHERE id = ?")
      .get(id) as AgentEvolutionRun | undefined;
  }

  listEvolutionRuns(agentId: string, limit = 20): AgentEvolutionRun[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_evolution_runs
         WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, limit) as AgentEvolutionRun[];
  }

  listEvolutionRunsByWorkspace(workspaceId: string, limit = 50): AgentEvolutionRun[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_evolution_runs
         WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(workspaceId, limit) as AgentEvolutionRun[];
  }

  getEvolutionRun(id: string): AgentEvolutionRun | undefined {
    return this.db
      .prepare("SELECT * FROM agent_evolution_runs WHERE id = ?")
      .get(id) as AgentEvolutionRun | undefined;
  }
}
