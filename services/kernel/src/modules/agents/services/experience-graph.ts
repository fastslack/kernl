/**
 * Shared experience graph — what every agent has learned, reachable by all.
 *
 * Learnings live per agent in `agent_learnings`, and the prompt only ever
 * reads the running agent's own rows, so whatever one agent figured out (an
 * `avoid` about a tool that misbehaves, an `insight` about a project) never
 * reaches the next agent that walks into the same situation. This service
 * projects runs, the tools they used and the learnings derived from them into
 * the active graph driver, and answers one question for the prompt: which
 * learnings of OTHER agents fit this goal — by meaning (vector index) or by
 * words (full-text index) — weighted by how much they share with the running
 * agent (the same tools, the same office).
 *
 * SQLite stays the source of truth; the graph is a projection, rebuilt from
 * scratch on a new store and kept current incrementally:
 *
 *   (:Agent {id, name, flow_id})-[:RAN]->(:AgentRun {id, status, goal, …})
 *   (:AgentRun)-[:USED {calls, errors}]->(:AgentTool {name})
 *   (:Agent)-[:LEARNED]->(:AgentLearning {id, type, content, confidence,
 *                                         active, project_id, embedding})
 *   (:AgentLearning)-[:DERIVED_FROM]->(:AgentRun)
 *
 * Watermarks live in the graph itself (`:AgentXpSync`), so they follow the
 * store: switch to a fresh store and the next sync backfills it.
 *
 * Every method is best-effort. Without a ready graph it does nothing and
 * returns nothing — agents run exactly as they did before.
 */

import type { SqliteDb } from "../../../core/db/sqlite.js";
import type { GraphDriver } from "../../../core/db-drivers/graph-driver.js";
import { log } from "../../../core/logger.js";
import { blobToVector } from "../../../core/ranking/relevance.js";
import { type GraphRunner, inGraphTransaction } from "../../../sdk/graph-batch.js";

export const LEARNING_VECTOR_INDEX = "agent-learning-embeddings";
export const LEARNING_TEXT_INDEX = "agent-learning-text";
const EMBEDDING_DIM = 384;
const BATCH = 500;
/**
 * Bump when syncRuns writes something new for runs already synced.
 * 2: USED.errors counts failed tool results (they are tool_result steps
 * flagged is_error, not error steps).
 */
const RUNS_SYNC_VERSION = 2;
/** Below this final score a shared learning is noise in the prompt, not help. */
const MIN_SCORE = 0.4;

export interface SharedLearning {
  id: string;
  type: "pattern" | "avoid" | "prefer" | "insight";
  content: string;
  confidence: number;
  agentId: string;
  agentName: string;
  /** Relevance to the goal, 0–1. */
  relevance: number;
  /** How many of the running agent's tools the source runs used. */
  toolOverlap: number;
  sameOffice: boolean;
  score: number;
}

export interface SharedLearningQuery {
  agentId: string;
  flowId: string;
  projectId: string | null;
  goal: string;
  /** Goal embedding; null falls back to full-text search. */
  goalVector: number[] | null;
  /** Embedding model of `goalVector`; vectors of another model are not comparable. */
  embeddingModel: string | null;
  /** The running agent's allowed tools — overlap with a learning's runs raises its score. */
  tools: string[];
  limit?: number;
}

export interface SyncResult {
  agents: number;
  runs: number;
  learnings: number;
}

interface RunRow {
  id: string;
  agent_id: string;
  status: string;
  goal: string;
  steps_count: number;
  tokens_used: number;
  project_id: string | null;
  created_at: string;
  done_at: string;
}

interface LearningRow {
  id: string;
  agent_id: string;
  type: string;
  content: string;
  confidence: number;
  source_runs: string;
  active: number;
  project_id: string | null;
  updated_at: string;
  embedding: Uint8Array | null;
  embedding_model: string | null;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const str = (v: unknown): string => (v == null ? "" : String(v));

/** Lucene special characters, so a goal is searched as words, not as a query. */
export function luceneTerms(text: string, max = 12): string {
  const words = text
    .toLowerCase()
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  return [...new Set(words)].slice(0, max).join(" ");
}

/**
 * Final score of a candidate. Relevance carries most of the weight; a
 * learning that held up (confidence), came from runs with the same tools, or
 * from a colleague in the same office, ranks above an equally similar one
 * that did not.
 */
export function scoreSharedLearning(c: {
  relevance: number;
  confidence: number;
  toolOverlap: number;
  sameOffice: boolean;
}): number {
  return (
    0.6 * c.relevance +
    0.25 * c.confidence +
    0.1 * Math.min(c.toolOverlap, 3) / 3 +
    (c.sameOffice ? 0.05 : 0)
  );
}

export class AgentExperienceGraph {
  private schemaFor: GraphDriver | null = null;
  private syncing: Promise<SyncResult> | null = null;

  constructor(
    private readonly db: SqliteDb,
    private readonly getGraph: () => GraphDriver | null,
    /** The embedding model the stored vectors were made with (from the embeddings client). */
    private readonly getEmbeddingModel: () => string | null = () => null,
  ) {}

  private ready(): GraphDriver | null {
    const g = this.getGraph();
    return g?.capabilities.cypher ? g : null;
  }

  get available(): boolean {
    return this.ready() !== null;
  }

  // ── Schema ─────────────────────────────────────────

  private async ensureSchema(g: GraphDriver): Promise<void> {
    if (this.schemaFor === g) return;
    const statements = [
      "CREATE CONSTRAINT agent_id IF NOT EXISTS FOR (a:Agent) REQUIRE a.id IS UNIQUE",
      "CREATE CONSTRAINT agent_run_id IF NOT EXISTS FOR (r:AgentRun) REQUIRE r.id IS UNIQUE",
      "CREATE CONSTRAINT agent_tool_name IF NOT EXISTS FOR (t:AgentTool) REQUIRE t.name IS UNIQUE",
      "CREATE CONSTRAINT agent_learning_id IF NOT EXISTS FOR (l:AgentLearning) REQUIRE l.id IS UNIQUE",
      `CREATE FULLTEXT INDEX \`${LEARNING_TEXT_INDEX}\` IF NOT EXISTS FOR (l:AgentLearning) ON EACH [l.content]`,
    ];
    if (g.capabilities.vectorSimilarity) {
      statements.push(
        `CREATE VECTOR INDEX \`${LEARNING_VECTOR_INDEX}\` IF NOT EXISTS
         FOR (l:AgentLearning) ON (l.embedding)
         OPTIONS { indexConfig: {
           \`vector.dimensions\`: ${EMBEDDING_DIM},
           \`vector.similarity_function\`: 'cosine'
         }}`,
      );
    }
    for (const s of statements) {
      await g.run(s).catch((err) => log.warn(`Agent experience graph: schema statement skipped — ${err}`));
    }
    this.schemaFor = g;
  }

  // ── Sync (SQLite → graph) ──────────────────────────

  /**
   * Bring the graph up to date with SQLite. Concurrent calls share one pass.
   * The first pass on an empty store is the backfill.
   */
  sync(): Promise<SyncResult> {
    if (!this.syncing) {
      this.syncing = this.doSync().finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  private async doSync(): Promise<SyncResult> {
    const g = this.ready();
    if (!g) return { agents: 0, runs: 0, learnings: 0 };
    const t0 = Date.now();
    await this.ensureSchema(g);
    const marks = await this.readWatermarks(g);
    const agents = await this.syncAgents(g);
    const runs = await this.syncRuns(g, marks.runs);
    const learnings = await this.syncLearnings(g, marks.learnings);
    if (runs + learnings > 0) {
      log.info(
        `Agent experience graph: synced ${runs} run(s), ${learnings} learning(s) for ${agents} agent(s) in ${Date.now() - t0}ms`,
      );
    }
    return { agents, runs, learnings };
  }

  private async readWatermarks(g: GraphDriver): Promise<{ runs: string; learnings: string }> {
    const r = await g.run(
      `MERGE (s:AgentXpSync {id: 'agents'})
       RETURN s.runs AS runs, s.learnings AS learnings, coalesce(s.runs_version, 1) AS runsVersion`,
    );
    const rec = r.records[0];
    // A store synced by an older version of syncRuns is synced again from the start.
    if (num(rec?.get("runsVersion")) < RUNS_SYNC_VERSION) {
      await g.run("MATCH (s:AgentXpSync {id: 'agents'}) SET s.runs = '', s.runs_version = $v", { v: RUNS_SYNC_VERSION });
      return { runs: "", learnings: str(rec?.get("learnings")) };
    }
    return { runs: str(rec?.get("runs")), learnings: str(rec?.get("learnings")) };
  }

  private async setWatermark(g: GraphRunner, key: "runs" | "learnings", value: string): Promise<void> {
    await g.run(`MATCH (s:AgentXpSync {id: 'agents'}) SET s.${key} = $value`, { value });
  }

  private async syncAgents(g: GraphDriver): Promise<number> {
    const rows = this.db
      .prepare("SELECT id, name, flow_id FROM agents")
      .all() as Array<{ id: string; name: string; flow_id: string | null }>;
    for (let i = 0; i < rows.length; i += BATCH) {
      await g.run(
        `UNWIND $rows AS row
         MERGE (a:Agent {id: row.id})
         SET a.name = row.name, a.flow_id = row.flow_id`,
        { rows: rows.slice(i, i + BATCH).map((r) => ({ ...r, flow_id: r.flow_id ?? "" })) },
      );
    }
    return rows.length;
  }

  private async syncRuns(g: GraphDriver, since: string): Promise<number> {
    let total = 0;
    // "<done_at>|<id>": runs finishing in the same millisecond must not fall
    // between two batches.
    let [markAt = "", markId = ""] = since.split("|");
    for (;;) {
      const rows = this.db
        .prepare(
          `SELECT id, agent_id, status, substr(goal, 1, 500) AS goal, steps_count, tokens_used,
                  project_id, created_at, COALESCE(completed_at, created_at) AS done_at
             FROM agent_runs
            WHERE status IN ('completed', 'failed')
              AND (COALESCE(completed_at, created_at) > ?
                   OR (COALESCE(completed_at, created_at) = ? AND id > ?))
            ORDER BY done_at, id
            LIMIT ${BATCH}`,
        )
        .all(markAt, markAt, markId) as RunRow[];
      if (rows.length === 0) break;

      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      const tools = this.db
        .prepare(
          `SELECT run_id, tool_name,
                  SUM(type = 'tool_call') AS calls,
                  SUM(type = 'error'
                      OR (type = 'tool_result' AND json_extract(tool_input, '$.is_error') = 1)) AS errors
             FROM agent_run_steps
            WHERE run_id IN (${placeholders}) AND tool_name <> ''
            GROUP BY run_id, tool_name`,
        )
        .all(...ids) as Array<{ run_id: string; tool_name: string; calls: number; errors: number }>;
      const last = rows[rows.length - 1];

      // A batch's runs, the tools they used and the watermark past them land
      // together: a reader never sees a run without its tools.
      await inGraphTransaction(g, async (tx) => {
        await tx.run(
          `UNWIND $rows AS row
           MERGE (a:Agent {id: row.agent_id})
           MERGE (r:AgentRun {id: row.id})
           SET r.status = row.status, r.goal = row.goal, r.steps = row.steps_count,
               r.tokens = row.tokens_used, r.project_id = row.project_id,
               r.created_at = row.created_at, r.done_at = row.done_at
           MERGE (a)-[:RAN]->(r)`,
          { rows },
        );
        if (tools.length > 0) {
          await tx.run(
            `UNWIND $rows AS row
             MATCH (r:AgentRun {id: row.run_id})
             MERGE (t:AgentTool {name: row.tool_name})
             MERGE (r)-[u:USED]->(t)
             SET u.calls = row.calls, u.errors = row.errors`,
            { rows: tools },
          );
        }
        await this.setWatermark(tx, "runs", `${last.done_at}|${last.id}`);
      });

      total += rows.length;
      markAt = last.done_at;
      markId = last.id;
      if (rows.length < BATCH) break;
    }
    return total;
  }

  private async syncLearnings(g: GraphDriver, since: string): Promise<number> {
    // Rows changed since the last pass, plus rows whose embedding arrived after
    // they were synced (scheduleEmbed writes it without touching updated_at).
    const missing = await g.run(
      "MATCH (l:AgentLearning) WHERE l.embedding IS NULL RETURN l.id AS id",
    );
    const waiting = missing.records.map((r) => str(r.get("id")));
    const changed = this.db
      .prepare(
        `SELECT id, agent_id, type, content, confidence, source_runs, active, project_id,
                updated_at, embedding, embedding_model
           FROM agent_learnings WHERE updated_at > ? ORDER BY updated_at, id`,
      )
      .all(since) as LearningRow[];
    const late = waiting.length
      ? (this.db
          .prepare(
            `SELECT id, agent_id, type, content, confidence, source_runs, active, project_id,
                    updated_at, embedding, embedding_model
               FROM agent_learnings
              WHERE embedding IS NOT NULL AND id IN (${waiting.map(() => "?").join(",")})`,
          )
          .all(...waiting) as LearningRow[])
      : [];
    const byId = new Map<string, LearningRow>();
    for (const r of [...changed, ...late]) byId.set(r.id, r);
    const rows = [...byId.values()];
    if (rows.length === 0) return 0;

    const payload = rows.map((r) => {
      const vec = blobToVector(r.embedding);
      let sources: string[] = [];
      try {
        const parsed = JSON.parse(r.source_runs || "[]");
        if (Array.isArray(parsed)) sources = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        /* a broken cell links to no run */
      }
      return {
        id: r.id,
        agent_id: r.agent_id,
        type: r.type,
        content: r.content,
        confidence: r.confidence,
        active: r.active === 1,
        project_id: r.project_id,
        embedding: vec && vec.length === EMBEDDING_DIM ? vec : null,
        embedding_model: vec && vec.length === EMBEDDING_DIM ? r.embedding_model : null,
        sources,
      };
    });

    const newest = changed.length ? changed[changed.length - 1].updated_at : since;
    // Every learning of this pass and the watermark past them, together.
    await inGraphTransaction(g, async (tx) => {
      for (let i = 0; i < payload.length; i += BATCH) {
        await tx.run(
          `UNWIND $rows AS row
           MERGE (a:Agent {id: row.agent_id})
           MERGE (l:AgentLearning {id: row.id})
           SET l.agent_id = row.agent_id, l.type = row.type, l.content = row.content,
               l.confidence = row.confidence, l.active = row.active,
               l.project_id = row.project_id, l.embedding = row.embedding,
               l.embedding_model = row.embedding_model
           MERGE (a)-[:LEARNED]->(l)
           WITH l, row
           UNWIND row.sources AS rid
           MERGE (r:AgentRun {id: rid})
           MERGE (l)-[:DERIVED_FROM]->(r)`,
          { rows: payload.slice(i, i + BATCH) },
        );
      }
      if (newest > since) await this.setWatermark(tx, "learnings", newest);
    });
    return rows.length;
  }

  // ── Query (graph → prompt) ─────────────────────────

  /**
   * Learnings of other agents that fit this goal, best first. Empty when the
   * graph is unavailable, the query fails, or nothing clears the bar.
   */
  async findSharedLearnings(q: SharedLearningQuery): Promise<SharedLearning[]> {
    const g = this.ready();
    if (!g) return [];
    const limit = q.limit ?? 5;
    try {
      await this.ensureSchema(g);
      const useVector =
        !!q.goalVector &&
        q.goalVector.length === EMBEDDING_DIM &&
        g.capabilities.vectorSimilarity &&
        (!q.embeddingModel || q.embeddingModel === (this.getEmbeddingModel() ?? q.embeddingModel));
      // Vectors only compare within one model, so learnings embedded with
      // another one (or not yet embedded) are reached by their words instead.
      // A learning found both ways keeps its better relevance.
      const merged = new Map<string, Omit<SharedLearning, "score">>();
      const found = [
        ...(useVector ? await this.byVector(g, q) : []),
        ...(await this.byText(g, q)),
      ];
      for (const c of found) {
        const prev = merged.get(c.id);
        if (!prev || c.relevance > prev.relevance) merged.set(c.id, c);
      }
      return [...merged.values()]
        .filter((c) => c.relevance >= 0.3)
        .map((c) => ({ ...c, score: scoreSharedLearning(c) }))
        .filter((c) => c.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (err) {
      log.debug(`Agent experience graph: shared-learning query failed — ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private static readonly CANDIDATE_TAIL = `
    WHERE l.active = true AND l.agent_id <> $agentId AND l.confidence >= 0.3
      AND ($model IS NULL OR l.embedding_model = $model)
      AND (l.project_id IS NULL OR l.project_id = $projectId)
    OPTIONAL MATCH (src:Agent)-[:LEARNED]->(l)
    OPTIONAL MATCH (l)-[:DERIVED_FROM]->(:AgentRun)-[:USED]->(t:AgentTool)
      WHERE t.name IN $tools
    RETURN l.id AS id, l.type AS type, l.content AS content, l.confidence AS confidence,
           l.agent_id AS agentId, src.name AS agentName, src.flow_id AS flowId,
           score, count(DISTINCT t) AS toolOverlap`;

  private toCandidates(
    records: Array<{ get(k: string): unknown }>,
    q: SharedLearningQuery,
    relevance: (score: number) => number,
  ): Omit<SharedLearning, "score">[] {
    return records.map((r) => {
      const flowId = str(r.get("flowId"));
      return {
        id: str(r.get("id")),
        type: str(r.get("type")) as SharedLearning["type"],
        content: str(r.get("content")),
        confidence: num(r.get("confidence")),
        agentId: str(r.get("agentId")),
        agentName: str(r.get("agentName")) || str(r.get("agentId")),
        relevance: relevance(num(r.get("score"))),
        toolOverlap: num(r.get("toolOverlap")),
        sameOffice: !!q.flowId && flowId === q.flowId,
      };
    });
  }

  private async byVector(g: GraphDriver, q: SharedLearningQuery): Promise<Omit<SharedLearning, "score">[]> {
    const r = await g.run(
      `CALL db.index.vector.queryNodes($index, $k, $vector) YIELD node AS l, score
       ${AgentExperienceGraph.CANDIDATE_TAIL}`,
      {
        index: LEARNING_VECTOR_INDEX,
        k: 40,
        vector: q.goalVector,
        model: q.embeddingModel,
        agentId: q.agentId,
        projectId: q.projectId,
        tools: q.tools,
      },
    );
    // queryNodes reports cosine on 0–1 with 0.5 for orthogonal vectors; spread
    // the useful half (similar, not opposed) back over 0–1.
    return this.toCandidates(r.records, q, (s) => Math.max(0, Math.min(1, (s - 0.5) * 2)));
  }

  private async byText(g: GraphDriver, q: SharedLearningQuery): Promise<Omit<SharedLearning, "score">[]> {
    const terms = luceneTerms(q.goal);
    if (!terms) return [];
    const r = await g.run(
      `CALL db.index.fulltext.queryNodes($index, $terms) YIELD node AS l, score
       ${AgentExperienceGraph.CANDIDATE_TAIL}`,
      { index: LEARNING_TEXT_INDEX, terms, model: null, agentId: q.agentId, projectId: q.projectId, tools: q.tools },
    );
    // Full-text scores are unbounded, so they are read relative to the best
    // hit — which would make the best hit a perfect match by definition.
    // Shared words are weaker evidence than shared meaning: cap at 0.7.
    const best = Math.max(0, ...r.records.map((x) => num(x.get("score"))));
    return this.toCandidates(r.records, q, (s) => (best > 0 ? 0.7 * (s / best) : 0));
  }
}
