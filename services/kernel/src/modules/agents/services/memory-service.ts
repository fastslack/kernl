import type { SqliteDb } from "../../../core/db/sqlite.js";
import type { EmbeddingsClient } from "../../../core/embeddings/client.js";
import { newId, isoNow } from "../../../core/helpers.js";
import { log } from "../../../core/logger.js";
import {
  rankByRelevance,
  rankByEmbedding,
  vectorToBlob,
  blobToVector,
} from "../../../core/ranking/relevance.js";
import type { AgentLearning, AgentRun } from "../types.js";

/** One conversational memory entry. `attachments`: chat attachment ids it carried. */
export interface MemoryEntry {
  role: string;
  content: string;
  attachments: string[];
  created_at: string;
}

function toMemoryEntry(row: { role: string; content: string; attachments?: string | null; created_at: string }): MemoryEntry {
  let attachments: string[] = [];
  if (row.attachments) {
    try {
      const parsed = JSON.parse(row.attachments);
      if (Array.isArray(parsed)) attachments = parsed.filter((x): x is string => typeof x === "string");
    } catch { /* a broken cell reads as none */ }
  }
  return { role: row.role, content: row.content, attachments, created_at: row.created_at };
}

/**
 * What an agent remembers: conversational memory, distilled learnings, and the
 * relevance ranking that decides what gets injected into a prompt. Owns
 * `agent_memory` and `agent_learnings`, and holds the embeddings client, since
 * every write here is what schedules a vector.
 *
 * It also *reads* `agent_runs` (never writes it) to rank similar past runs —
 * that table belongs to run management.
 *
 * `AgentService` delegates to it.
 */
export class AgentMemoryService {
  /**
   * Embeddings client — set lazily by bootstrap once createEmbeddingsClient
   * resolves (the agents module initialises before that happens). Stays
   * null on hosts where embeddings are disabled or LMStudio + local both
   * failed; in that case write-time embedding silently no-ops and the
   * reader degrades to lexical ranking. Best-effort everywhere.
   */
  private embeddings: EmbeddingsClient | null = null;

  /**
   * `emit` publishes learning events to the agents.flow stream (the 3D office,
   * the live log): created by any path, reinforced or weakened by a run, retired
   * by another agent's run or by the cleanup.
   */
  constructor(
    private db: SqliteDb,
    private emit: (event: string, payload: Record<string, unknown>) => void = () => {},
  ) {}

  private agentName(id: string): string {
    try {
      return (this.db.prepare("SELECT name FROM agents WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "";
    } catch {
      return "";
    }
  }

  /** A learning's confidence over time, oldest first, with the run (and agent) that moved it. */
  getConfidenceHistory(learningId: string, limit = 200): Array<{ at: string; before: number | null; after: number; delta: number; run_id: string; agent_id: string; agent_name: string; cause: string }> {
    try {
      return this.db
        .prepare(
          `SELECT h.at, h.before, h.after, h.delta, h.run_id, h.agent_id, COALESCE(a.name, '') AS agent_name, h.cause
             FROM agent_learning_confidence h LEFT JOIN agents a ON a.id = h.agent_id
            WHERE h.learning_id = ? ORDER BY h.at, h.rowid LIMIT ?`,
        )
        .all(learningId, limit) as never;
    } catch {
      return [];
    }
  }

  /**
   * How each lesson's confidence moved over time, for many lessons at once —
   * the learning time machine replays a library from these. `[at, after]` pairs,
   * oldest first; `retired_at` is when it fell below the floor (or was swept),
   * or its last update for a lesson retired before the history existed.
   */
  getConfidenceTimelines(learningIds: string[]): Record<string, { points: Array<[string, number]>; retired_at: string | null }> {
    const out: Record<string, { points: Array<[string, number]>; retired_at: string | null }> = {};
    if (learningIds.length === 0) return out;
    for (let i = 0; i < learningIds.length; i += 500) {
      const ids = learningIds.slice(i, i + 500);
      const marks = ids.map(() => "?").join(",");
      try {
        const rows = this.db
          .prepare(`SELECT learning_id, at, after, cause FROM agent_learning_confidence WHERE learning_id IN (${marks}) ORDER BY at, rowid`)
          .all(...ids) as Array<{ learning_id: string; at: string; after: number; cause: string }>;
        for (const r of rows) {
          const t = (out[r.learning_id] ??= { points: [], retired_at: null });
          t.points.push([r.at, r.after]);
          if (!t.retired_at && (r.cause === "sweep" || (r.cause.startsWith("run:") && r.after < 0.15))) t.retired_at = r.at;
        }
      } catch { /* no history table yet */ }
      const retired = this.db
        .prepare(`SELECT id, updated_at FROM agent_learnings WHERE active = 0 AND id IN (${marks})`)
        .all(...ids) as Array<{ id: string; updated_at: string }>;
      for (const r of retired) {
        const t = (out[r.id] ??= { points: [], retired_at: null });
        t.retired_at ??= r.updated_at;
      }
    }
    return out;
  }

  /** One row of a learning's confidence history; never fails the caller. */
  private recordConfidence(row: { learningId: string; before: number | null; after: number; runId?: string; agentId?: string; cause: string }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO agent_learning_confidence (learning_id, at, before, after, delta, run_id, agent_id, cause)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(row.learningId, isoNow(), row.before, row.after, row.before === null ? 0 : row.after - row.before,
          row.runId ?? "", row.agentId ?? "", row.cause);
    } catch { /* the table arrives with agents migration 63 */ }
  }

  /** Inject the embeddings client. Idempotent — last writer wins. */
  setEmbeddingsClient(client: EmbeddingsClient | null): void {
    this.embeddings = client;
    if (client) {
      log.info(`AgentService: semantic ranking enabled (${client.provider} ${client.model} dim=${client.dim})`);
    }
  }

  getEmbeddingsClient(): EmbeddingsClient | null {
    return this.embeddings;
  }

  /**
   * Embed a single text — best-effort. Returns null on any failure or when
   * no client is wired. Callers MUST treat null as "store no embedding,
   * reader will fall back to lexical for this row".
   */
  private async embedOne(text: string): Promise<number[] | null> {
    if (!this.embeddings || !text || text.length === 0) return null;
    try {
      const [vec] = await this.embeddings.embed([text]);
      return vec ?? null;
    } catch (err) {
      log.debug(`AgentService.embedOne failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Fire-and-forget background embed: keeps the public addMemory/addLearning/
   * createRun signatures sync (existing callers untouched) while still landing
   * a vector on the row a moment later. Reader degrades to lexical for rows
   * whose embedding hasn't arrived yet — safe to call even when embeddings
   * are disabled (no-op on null client).
   *
   * `column` and `modelColumn` are interpolated into the SQL but only ever
   * supplied from this file and `AgentService.createRun` — never from user input.
   */
  scheduleEmbed(
    table: "agent_memory" | "agent_learnings" | "agent_runs",
    column: "embedding" | "goal_embedding",
    modelColumn: "embedding_model" | "goal_embedding_model",
    rowId: string,
    text: string,
  ): void {
    if (!this.embeddings || !text || text.length === 0) return;
    const client = this.embeddings;
    queueMicrotask(() => {
      void (async () => {
        try {
          const vec = await this.embedOne(text);
          if (!vec) return;
          this.db
            .prepare(`UPDATE ${table} SET ${column} = ?, ${modelColumn} = ? WHERE id = ?`)
            .run(vectorToBlob(vec), client.model, rowId);
        } catch (err) {
          log.debug(`scheduleEmbed(${table}/${rowId}) failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    });
  }

  // ── Learnings ─────────────────────────────────────

  addLearning(input: {
    agent_id: string;
    type: AgentLearning["type"];
    content: string;
    confidence?: number;
    source_runs?: string[];
    /** null/omitted = craft learning (every project); set = only for that project. */
    project_id?: string | null;
    /** Where it came from: auto (grading), feedback, tool, outbox, office-pack, marketplace, manual. */
    source?: string;
    /** The run that produced it, when there is one. */
    run_id?: string;
  }): AgentLearning {
    const now = isoNow();
    const learning: AgentLearning = {
      id: newId(),
      agent_id: input.agent_id,
      type: input.type,
      content: input.content,
      confidence: input.confidence ?? 0.5,
      source_runs: JSON.stringify(input.source_runs ?? []),
      active: 1,
      created_at: now,
      updated_at: now,
      project_id: input.project_id ?? null,
    };

    this.db
      .prepare(
        `INSERT INTO agent_learnings (id, agent_id, type, content, confidence, source_runs, active, created_at, updated_at, project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        learning.id, learning.agent_id, learning.type, learning.content,
        learning.confidence, learning.source_runs, learning.active,
        learning.created_at, learning.updated_at, learning.project_id,
      );

    this.scheduleEmbed("agent_learnings", "embedding", "embedding_model", learning.id, learning.content);
    const source = input.source ?? "manual";
    const runId = input.run_id ?? input.source_runs?.[0] ?? "";
    this.recordConfidence({ learningId: learning.id, before: null, after: learning.confidence, runId, agentId: learning.agent_id, cause: `created:${source}` });
    // A pack or a marketplace install brings dozens at once: recorded, not animated.
    if (source !== "office-pack" && source !== "marketplace") {
      this.emit("agent:flow:learning_created", {
        agent_id: learning.agent_id,
        agent_name: this.agentName(learning.agent_id),
        run_id: runId,
        learning_id: learning.id,
        learning_type: learning.type,
        content: learning.content,
        confidence: learning.confidence,
        source,
      });
    }
    return learning;
  }

  /**
   * Which learnings a run sees: without a project only craft learnings
   * (project_id NULL); with one, craft learnings plus that project's.
   */
  private learningScope(projectId: string | null): { sql: string; params: unknown[] } {
    return projectId
      ? { sql: "(project_id IS NULL OR project_id = ?)", params: [projectId] }
      : { sql: "project_id IS NULL", params: [] };
  }

  getLearnings(agentId: string, projectId: string | null = null): AgentLearning[] {
    const sc = this.learningScope(projectId);
    return this.db
      .prepare(`SELECT * FROM agent_learnings WHERE agent_id = ? AND active = 1 AND ${sc.sql} ORDER BY confidence DESC`)
      .all(agentId, ...sc.params) as AgentLearning[];
  }

  // ── Conversational Memory ─────────────────────────

  /** Save a message to agent's conversational memory. `attachments`: ids of
   *  chat attachments the message carried (already bound by the caller). */
  addMemory(agentId: string, role: "user" | "assistant", content: string, runId = "", projectId: string | null = null, attachments: readonly string[] = []): void {
    const id = newId();
    this.db.prepare(
      "INSERT INTO agent_memory (id, agent_id, role, content, run_id, project_id, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, agentId, role, content, runId, projectId, attachments.length ? JSON.stringify(attachments) : "", isoNow());
    this.scheduleEmbed("agent_memory", "embedding", "embedding_model", id, content);
  }

  /** Get recent conversational memory for an agent (last N exchanges).
   *  Strictly per project: null reads only memory written without one. */
  getMemory(agentId: string, limit = 20, projectId: string | null = null): MemoryEntry[] {
    const rows = this.db
      .prepare("SELECT role, content, attachments, created_at FROM agent_memory WHERE agent_id = ? AND project_id IS ? ORDER BY created_at DESC LIMIT ?")
      .all(agentId, projectId, limit) as Array<{ role: string; content: string; attachments: string; created_at: string }>;
    return rows.map(toMemoryEntry);
  }

  /** Clear all memory for an agent */
  clearMemory(agentId: string): void {
    this.db.prepare("DELETE FROM agent_memory WHERE agent_id = ?").run(agentId);
  }

  // ── Relevance ranking ─────────────────────────────

  getRelevantMemory(
    agentId: string,
    goal: string,
    limit = 20,
    pool = 100,
    projectId: string | null = null,
  ): MemoryEntry[] {
    const recent = this.getMemory(agentId, pool, projectId);
    return rankByRelevance(recent, goal, m => m.content, limit);
  }

  /**
   * Embedding-aware variant of getRelevantMemory. Reads pre-computed
   * vectors written by scheduleEmbed(); rows whose embedding hasn't landed
   * yet (or failed) participate via lexical-only score, so the ranker is
   * always usable regardless of backfill state.
   */
  getRelevantMemoryByEmbedding(
    agentId: string,
    goal: string,
    goalVector: number[],
    limit = 20,
    pool = 100,
    cosineWeight?: number,
    minScore?: number,
    projectId: string | null = null,
  ): MemoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT role, content, attachments, created_at, embedding
         FROM agent_memory WHERE agent_id = ? AND project_id IS ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, projectId, pool) as Array<{
        role: string;
        content: string;
        attachments: string;
        created_at: string;
        embedding: Buffer | Uint8Array | null;
      }>;
    const items = rows.map(r => ({
      ...toMemoryEntry(r),
      embedding: blobToVector(r.embedding),
    }));
    return rankByEmbedding(items, goalVector, goal, m => m.content, limit, cosineWeight, minScore)
      .map(({ role, content, attachments, created_at }) => ({ role, content, attachments, created_at }));
  }

  /**
   * Find past runs of this agent whose goals are similar to the current one.
   * Used to inject "when you did X you got Y" context into the prompt.
   */
  findSimilarPastRuns(
    agentId: string,
    goal: string,
    limit = 3,
    pool = 30,
    projectId: string | null = null,
  ): AgentRun[] {
    const recent = this.db
      .prepare(
        `SELECT * FROM agent_runs
         WHERE agent_id = ? AND status IN ('completed', 'failed') AND project_id IS ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, projectId, pool) as AgentRun[];
    // Match against goal text; skip runs with empty goals.
    const filtered = recent.filter(r => r.goal && r.goal.length > 0);
    return rankByRelevance(filtered, goal, r => r.goal, limit, 0.1);
  }

  /** Embedding-aware variant of findSimilarPastRuns. */
  findSimilarPastRunsByEmbedding(
    agentId: string,
    goal: string,
    goalVector: number[],
    limit = 3,
    pool = 30,
    cosineWeight?: number,
    minScore?: number,
    projectId: string | null = null,
  ): AgentRun[] {
    const rows = this.db
      .prepare(
        `SELECT *, goal_embedding FROM agent_runs
         WHERE agent_id = ? AND status IN ('completed', 'failed') AND project_id IS ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, projectId, pool) as Array<AgentRun & { goal_embedding: Buffer | Uint8Array | null }>;
    const filtered = rows
      .filter(r => r.goal && r.goal.length > 0)
      .map(r => ({ ...r, embedding: blobToVector(r.goal_embedding) }));
    const ranked = rankByEmbedding(filtered, goalVector, goal, r => r.goal, limit, cosineWeight, minScore);
    // Strip the helper columns we attached for ranking — restore the AgentRun shape.
    return ranked.map(r => {
      const { embedding: _e, goal_embedding: _ge, ...rest } = r;
      return rest as AgentRun;
    });
  }

  /**
   * Get learnings ranked by relevance to the current goal. Within each
   * relevance tier, prefers higher confidence. Prevents irrelevant learnings
   * (e.g. "avoid X" when agent isn't doing X) from hogging the prompt.
   */
  getRelevantLearnings(
    agentId: string,
    goal: string,
    limit = 15,
    projectId: string | null = null,
  ): AgentLearning[] {
    const all = this.getLearnings(agentId, projectId);
    if (all.length <= limit) return all;
    // Rank by relevance; ties broken by confidence (already sorted desc by getLearnings)
    return rankByRelevance(all, goal, l => l.content, limit);
  }

  /**
   * Embedding-aware variant of getRelevantLearnings. minScore defaults are
   * higher than for memory because learnings are more structured (auto-eval
   * lessons), so cosine scores cluster higher.
   */
  getRelevantLearningsByEmbedding(
    agentId: string,
    goal: string,
    goalVector: number[],
    limit = 15,
    cosineWeight?: number,
    minScore?: number,
    projectId: string | null = null,
  ): AgentLearning[] {
    const sc = this.learningScope(projectId);
    const rows = this.db
      .prepare(
        `SELECT *, embedding FROM agent_learnings
         WHERE agent_id = ? AND active = 1 AND ${sc.sql}
         ORDER BY confidence DESC`,
      )
      .all(agentId, ...sc.params) as Array<AgentLearning & { embedding: Buffer | Uint8Array | null }>;
    if (rows.length <= limit) return rows.map(({ embedding: _, ...rest }) => rest as AgentLearning);
    const items = rows.map(r => ({ ...r, embedding: blobToVector(r.embedding) }));
    return rankByEmbedding(items, goalVector, goal, l => l.content, limit, cosineWeight, minScore ?? 0.45)
      .map(({ embedding: _, ...rest }) => rest as AgentLearning);
  }

  updateLearningConfidence(
    id: string,
    delta: number,
    by: { runId?: string; agentId?: string; cause?: string } = {},
  ): { before: number; after: number } | null {
    const learning = this.db
      .prepare("SELECT confidence FROM agent_learnings WHERE id = ?")
      .get(id) as { confidence: number } | undefined;
    if (!learning) return null;

    const newConf = Math.max(0, Math.min(1, learning.confidence + delta));
    this.db
      .prepare("UPDATE agent_learnings SET confidence = ?, updated_at = ? WHERE id = ?")
      .run(newConf, isoNow(), id);
    this.recordConfidence({ learningId: id, before: learning.confidence, after: newConf, runId: by.runId, agentId: by.agentId, cause: by.cause ?? "run" });
    return { before: learning.confidence, after: newConf };
  }

  deactivateLearning(id: string): void {
    this.db
      .prepare("UPDATE agent_learnings SET active = 0, updated_at = ? WHERE id = ?")
      .run(isoNow(), id);
  }

  /**
   * Get learnings that were active (and would have been injected into prompt)
   * at the time a given run started. Used to attribute run outcomes back to learnings.
   */
  getLearningsActiveAt(agentId: string, referenceTime: string): AgentLearning[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_learnings
         WHERE agent_id = ? AND active = 1 AND created_at < ?
         ORDER BY confidence DESC LIMIT 15`,
      )
      .all(agentId, referenceTime) as AgentLearning[];
  }

  /**
   * Given a run outcome, adjust confidence of learnings that were active during it.
   * Success boosts confidence, failure penalizes it. Learnings below 0.15 get deactivated.
   * Returns count of learnings updated / deactivated.
   */
  reinforceLearningsForRun(
    agentId: string,
    runCreatedAt: string,
    outcome: "success" | "partial" | "failure" | "neutral",
    runId?: string,
  ): { updated: number; deactivated: number } {
    const delta =
      outcome === "success" ? 0.08
      : outcome === "partial" ? 0.02
      : outcome === "failure" ? -0.15
      : 0;
    if (delta === 0) return { updated: 0, deactivated: 0 };

    // When the run's prompt was recorded, only what it carried is credited or
    // blamed — and a failure never weakens an `avoid` learning: a failure is
    // what that learning warned about, not evidence against it. Runs recorded
    // before that existed fall back to every learning active at the time.
    const injected = runId ? this.getInjectedLearnings(runId) : null;
    const learnings: Array<Pick<AgentLearning, "id" | "type">> = injected
      ? injected.filter((l) => !(delta < 0 && l.type === "avoid"))
      : this.getLearningsActiveAt(agentId, runCreatedAt);
    let updated = 0;
    let deactivated = 0;
    const items: Array<Record<string, unknown>> = [];
    const retiredByOwner = new Map<string, Array<{ id: string; type: string; content: string; confidence: number }>>();
    for (const l of learnings) {
      const moved = this.updateLearningConfidence(l.id, delta, { runId, agentId, cause: `run:${outcome}` });
      if (!moved) continue;
      updated++;
      const row = this.db
        .prepare("SELECT agent_id, type, content FROM agent_learnings WHERE id = ?")
        .get(l.id) as { agent_id: string; type: string; content: string } | undefined;
      const owner = row?.agent_id ?? "";
      const retired = moved.after < 0.15;
      if (retired) {
        this.deactivateLearning(l.id);
        deactivated++;
        // The running agent's own retirements are announced by its grading;
        // another agent's lesson retired by this run is announced to its owner.
        if (owner && owner !== agentId) {
          retiredByOwner.set(owner, [...(retiredByOwner.get(owner) ?? []), { id: l.id, type: row?.type ?? "", content: row?.content ?? "", confidence: moved.after }]);
        }
      }
      items.push({
        learning_id: l.id, owner_agent_id: owner, owner_agent_name: owner === agentId ? "" : this.agentName(owner),
        shared: owner !== "" && owner !== agentId, learning_type: row?.type ?? l.type,
        before: moved.before, after: moved.after, delta: moved.after - moved.before, deactivated: retired,
      });
    }
    if (items.length) {
      this.emit("agent:flow:learning_reinforced", {
        agent_id: agentId, agent_name: this.agentName(agentId), run_id: runId ?? "", outcome, items,
      });
    }
    for (const [owner, list] of retiredByOwner) {
      this.emit("agent:flow:learning_deactivated", {
        agent_id: owner, agent_name: this.agentName(owner), run_id: runId ?? "",
        count: list.length, learnings: list, cause: "shared", by_agent_id: agentId,
      });
    }
    return { updated, deactivated };
  }

  /**
   * Record which learnings a run's prompt carried. Called once per prompt
   * assembly per kind (own / shared); an empty list still marks the run as
   * recorded, so grading knows it carried nothing rather than "unknown".
   */
  recordInjectedLearnings(runId: string, learningIds: string[], shared: boolean): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO agent_run_learnings (run_id, learning_id, shared) VALUES (?, ?, ?)",
    );
    stmt.run(runId, "", 0);
    for (const id of learningIds) stmt.run(runId, id, shared ? 1 : 0);
  }

  /**
   * The learnings a run's prompt carried, still active, with their type —
   * null when the run's prompt was never recorded.
   */
  getInjectedLearnings(runId: string): Array<Pick<AgentLearning, "id" | "type">> | null {
    const marked = this.db
      .prepare("SELECT 1 FROM agent_run_learnings WHERE run_id = ? LIMIT 1")
      .get(runId);
    if (!marked) return null;
    return this.db
      .prepare(
        `SELECT l.id, l.type FROM agent_run_learnings rl
           JOIN agent_learnings l ON l.id = rl.learning_id
          WHERE rl.run_id = ? AND l.active = 1`,
      )
      .all(runId) as Array<Pick<AgentLearning, "id" | "type">>;
  }

  /**
   * Periodic cleanup: deactivate learnings below minConfidence threshold.
   * Returns count deactivated.
   */
  cleanupLowConfidenceLearnings(agentId: string, minConfidence = 0.15): number {
    const going = this.db
      .prepare("SELECT id, type, content, confidence FROM agent_learnings WHERE agent_id = ? AND active = 1 AND confidence < ?")
      .all(agentId, minConfidence) as Array<{ id: string; type: string; content: string; confidence: number }>;
    if (going.length === 0) return 0;
    const result = this.db
      .prepare(
        `UPDATE agent_learnings SET active = 0, updated_at = ?
         WHERE agent_id = ? AND active = 1 AND confidence < ?`,
      )
      .run(isoNow(), agentId, minConfidence);
    for (const l of going) {
      this.recordConfidence({ learningId: l.id, before: l.confidence, after: l.confidence, agentId, cause: "sweep" });
    }
    this.emit("agent:flow:learning_deactivated", {
      agent_id: agentId, agent_name: this.agentName(agentId), run_id: "",
      count: going.length, learnings: going, cause: "sweep",
    });
    return result.changes as number;
  }
}
