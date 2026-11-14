/**
 * How each agent's instructions evolved, in the graph, connected to the runs
 * that drove it.
 *
 *   (:Agent {id})-[:HAS_VERSION]->(v:PromptVersion {id, key, agent_id, version,
 *       source, note, active, created_at, prompt_chars, goal_chars, prompt_preview})
 *   (v)-[:REVISES]->(:PromptVersion)                 the version it was written from
 *   (:Agent)-[:EVOLVED]->(e:EvolutionRun {id, agent_id, target, status, hypothesis,
 *       evaluation, error, baseline_score, candidate_score, delta, created_at,
 *       committed_at, workspace_id, artifact_ref})
 *   (e)-[:FROM_VERSION]->(:PromptVersion)            the version the cycle started from
 *   (e)-[:PROPOSED]->(:PromptVersion)                the candidate it wrote
 *   (e)-[:TRIGGERED_BY]->(:AgentRun {id})            the runs that motivated it
 *
 * SQLite stays the record (agent_prompt_versions, agent_evolution_runs); this
 * is the connected view. With the experience graph's runs and lessons it
 * answers in one traversal what used to take joins by hand: which failures
 * started a cycle, what it proposed, and what the agent learned around it.
 * The full prompt text stays in SQLite; the graph carries a preview and sizes.
 *
 * Both tables are small (a version per change, a cycle per reflection), so a
 * pass projects them whole and removes what SQLite no longer has. A pass is
 * skipped when nothing changed since the last one on the same store.
 */
import type { GraphDriver } from "../../../core/db-drivers/graph-driver.js";
import type { SqliteDb } from "../../../core/db/sqlite.js";
import { log } from "../../../core/logger.js";

const SCHEMA = [
  "CREATE CONSTRAINT prompt_version_id IF NOT EXISTS FOR (v:PromptVersion) REQUIRE v.id IS UNIQUE",
  "CREATE INDEX prompt_version_key IF NOT EXISTS FOR (v:PromptVersion) ON (v.key)",
  "CREATE CONSTRAINT evolution_run_id IF NOT EXISTS FOR (e:EvolutionRun) REQUIRE e.id IS UNIQUE",
];

const BATCH = 500;

interface VersionRow {
  id: string; agent_id: string; version: number; system_prompt: string; goal_template: string;
  parent_version: number; source: string; note: string; active: number; created_at: string;
}

interface EvolutionRow {
  id: string; agent_id: string; base_version: number; candidate_version: number; hypothesis: string;
  status: string; baseline_score: number; candidate_score: number; trigger_run_ids: string;
  evaluation: string; error: string; created_at: string; committed_at: string | null;
  target?: string | null; workspace_id?: string | null; artifact_ref?: string | null;
}

/** "<agent>#<version>": a version's identity across the two tables. */
export const versionKey = (agentId: string, version: number): string => `${agentId}#${version}`;

function triggerIds(json: string): string[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  } catch {
    return [];
  }
}

export class EvolutionGraph {
  private schemaReady = new WeakSet<object>();
  /** What the last pass projected, and onto which store: a new store is projected from the start. */
  private lastSignature = "";
  private lastGraph: GraphDriver | null = null;

  constructor(private readonly db: SqliteDb, private readonly getGraph: () => GraphDriver | null | undefined) {}

  private graph(): GraphDriver | null {
    const g = this.getGraph();
    return g?.capabilities.cypher ? g : null;
  }

  private async ensureSchema(g: GraphDriver): Promise<void> {
    if (this.schemaReady.has(g)) return;
    for (const s of SCHEMA) {
      try { await g.run(s); } catch (err) { log.debug(`evolution-graph: ${s.slice(0, 60)}… — ${String(err)}`); }
    }
    this.schemaReady.add(g);
  }

  /** Cheap fingerprint of both tables: a pass with the same one has nothing to do. */
  private signature(): string {
    try {
      const v = this.db.prepare(
        "SELECT count(*) AS n, coalesce(max(created_at), '') AS last, coalesce(sum(active * version), 0) AS act FROM agent_prompt_versions",
      ).get() as { n: number; last: string; act: number };
      const e = this.db.prepare(
        `SELECT count(*) AS n, coalesce(max(max(created_at, coalesce(committed_at, ''))), '') AS last,
                coalesce(group_concat(status, ''), '') AS st FROM (SELECT * FROM agent_evolution_runs ORDER BY id)`,
      ).get() as { n: number; last: string; st: string };
      return `${v.n}|${v.last}|${v.act}|${e.n}|${e.last}|${e.st.length}:${hashString(e.st)}`;
    } catch {
      return "";
    }
  }

  /** Project both tables when they changed since the last pass on this store; returns the rows written. */
  async sync(): Promise<number> {
    const g = this.graph();
    if (!g) return 0;
    const sig = this.signature();
    if (!sig) return 0; // the tables are not there (agents migrations not run)
    if (g === this.lastGraph && sig === this.lastSignature) return 0;
    await this.ensureSchema(g);
    const versions = this.db.prepare(
      `SELECT id, agent_id, version, system_prompt, goal_template, parent_version, source, note, active, created_at
         FROM agent_prompt_versions ORDER BY agent_id, version`,
    ).all() as VersionRow[];
    const runs = this.db.prepare("SELECT * FROM agent_evolution_runs ORDER BY created_at").all() as EvolutionRow[];
    await this.projectVersions(g, versions);
    await this.projectEvolutionRuns(g, runs);
    await this.prune(g, versions.map((v) => v.id), runs.map((r) => r.id));
    this.lastGraph = g;
    this.lastSignature = sig;
    return versions.length + runs.length;
  }

  private async projectVersions(g: GraphDriver, rows: VersionRow[]): Promise<void> {
    const data = rows.map((v) => ({
      id: v.id,
      agent: v.agent_id,
      parent: v.parent_version > 0 && v.parent_version !== v.version ? versionKey(v.agent_id, v.parent_version) : null,
      created_at: v.created_at,
      props: {
        key: versionKey(v.agent_id, v.version), agent_id: v.agent_id, version: v.version, source: v.source,
        note: v.note.slice(0, 500), active: v.active === 1,
        prompt_chars: v.system_prompt.length, goal_chars: v.goal_template.length,
        prompt_preview: v.system_prompt.slice(0, 400),
      },
    }));
    for (let i = 0; i < data.length; i += BATCH) {
      await g.run(
        `UNWIND $rows AS r
         MERGE (v:PromptVersion {id: r.id}) SET v += r.props, v.created_at = datetime(r.created_at)
         MERGE (a:Agent {id: r.agent}) MERGE (a)-[:HAS_VERSION]->(v)`,
        { rows: data.slice(i, i + BATCH) },
      );
    }
    // Parents after every version exists, so a parent written later in the same pass is found.
    const withParent = data.filter((d) => d.parent);
    for (let i = 0; i < withParent.length; i += BATCH) {
      await g.run(
        `UNWIND $rows AS r
         MATCH (v:PromptVersion {id: r.id})
         MATCH (p:PromptVersion {key: r.parent})
         MERGE (v)-[:REVISES]->(p)`,
        { rows: withParent.slice(i, i + BATCH) },
      );
    }
  }

  private async projectEvolutionRuns(g: GraphDriver, rows: EvolutionRow[]): Promise<void> {
    const data = rows.map((e) => {
      const isPrompt = (e.target ?? "prompt") === "prompt";
      return {
        id: e.id,
        agent: e.agent_id,
        created_at: e.created_at,
        committed_at: e.committed_at,
        base: isPrompt && e.base_version > 0 ? versionKey(e.agent_id, e.base_version) : null,
        candidate: isPrompt && e.candidate_version > 0 ? versionKey(e.agent_id, e.candidate_version) : null,
        triggers: triggerIds(e.trigger_run_ids),
        props: {
          agent_id: e.agent_id, target: e.target ?? "prompt", status: e.status,
          hypothesis: e.hypothesis.slice(0, 1000), evaluation: e.evaluation.slice(0, 1000), error: e.error.slice(0, 300),
          baseline_score: Number(e.baseline_score) || 0, candidate_score: Number(e.candidate_score) || 0,
          delta: (Number(e.candidate_score) || 0) - (Number(e.baseline_score) || 0),
          workspace_id: e.workspace_id ?? "", artifact_ref: e.artifact_ref ?? "",
        },
      };
    });
    for (let i = 0; i < data.length; i += BATCH) {
      const batch = data.slice(i, i + BATCH);
      await g.run(
        `UNWIND $rows AS r
         MERGE (e:EvolutionRun {id: r.id}) SET e += r.props,
           e.created_at = datetime(r.created_at), e.committed_at = datetime(r.committed_at)
         MERGE (a:Agent {id: r.agent}) MERGE (a)-[:EVOLVED]->(e)`,
        { rows: batch },
      );
      const withBase = batch.filter((r) => r.base);
      if (withBase.length) {
        await g.run(
          `UNWIND $rows AS r MATCH (e:EvolutionRun {id: r.id}) MATCH (v:PromptVersion {key: r.base})
           MERGE (e)-[:FROM_VERSION]->(v)`,
          { rows: withBase },
        );
      }
      const withCandidate = batch.filter((r) => r.candidate);
      if (withCandidate.length) {
        await g.run(
          `UNWIND $rows AS r MATCH (e:EvolutionRun {id: r.id}) MATCH (v:PromptVersion {key: r.candidate})
           MERGE (e)-[:PROPOSED]->(v)`,
          { rows: withCandidate },
        );
      }
      const triggers = batch.flatMap((r) => r.triggers.map((run) => ({ id: r.id, run })));
      if (triggers.length) {
        // The experience graph fills these runs in; a run it has not synced yet is created bare and completed later.
        await g.run(
          `UNWIND $rows AS r MATCH (e:EvolutionRun {id: r.id}) MERGE (run:AgentRun {id: r.run})
           MERGE (e)-[:TRIGGERED_BY]->(run)`,
          { rows: triggers },
        );
      }
    }
  }

  /** Versions and cycles SQLite no longer has (their agent was deleted) leave the graph too. */
  private async prune(g: GraphDriver, versionIds: string[], runIds: string[]): Promise<void> {
    await g.run("MATCH (v:PromptVersion) WHERE NOT v.id IN $ids DETACH DELETE v", { ids: versionIds });
    await g.run("MATCH (e:EvolutionRun) WHERE NOT e.id IN $ids DETACH DELETE e", { ids: runIds });
  }
}

/** FNV-1a, enough to notice a status change without carrying every status in the signature. */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
