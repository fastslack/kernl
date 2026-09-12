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

  constructor(private db: SqliteDb) {}

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
    };

    this.db
      .prepare(
        `INSERT INTO agent_learnings (id, agent_id, type, content, confidence, source_runs, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        learning.id, learning.agent_id, learning.type, learning.content,
        learning.confidence, learning.source_runs, learning.active,
        learning.created_at, learning.updated_at,
      );

    this.scheduleEmbed("agent_learnings", "embedding", "embedding_model", learning.id, learning.content);
    return learning;
  }

  getLearnings(agentId: string): AgentLearning[] {
    return this.db
      .prepare("SELECT * FROM agent_learnings WHERE agent_id = ? AND active = 1 ORDER BY confidence DESC")
      .all(agentId) as AgentLearning[];
  }

  // ── Conversational Memory ─────────────────────────

  /** Save a message to agent's conversational memory */
  addMemory(agentId: string, role: "user" | "assistant", content: string, runId = ""): void {
    const id = newId();
    this.db.prepare(
      "INSERT INTO agent_memory (id, agent_id, role, content, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, agentId, role, content, runId, isoNow());
    this.scheduleEmbed("agent_memory", "embedding", "embedding_model", id, content);
  }

  /** Get recent conversational memory for an agent (last N exchanges) */
  getMemory(agentId: string, limit = 20): Array<{ role: string; content: string; created_at: string }> {
    return this.db
      .prepare("SELECT role, content, created_at FROM agent_memory WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(agentId, limit) as Array<{ role: string; content: string; created_at: string }>;
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
  ): Array<{ role: string; content: string; created_at: string }> {
    const recent = this.getMemory(agentId, pool);
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
  ): Array<{ role: string; content: string; created_at: string }> {
    const rows = this.db
      .prepare(
        `SELECT role, content, created_at, embedding
         FROM agent_memory WHERE agent_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, pool) as Array<{
        role: string;
        content: string;
        created_at: string;
        embedding: Buffer | Uint8Array | null;
      }>;
    const items = rows.map(r => ({
      role: r.role,
      content: r.content,
      created_at: r.created_at,
      embedding: blobToVector(r.embedding),
    }));
    return rankByEmbedding(items, goalVector, goal, m => m.content, limit, cosineWeight, minScore)
      .map(({ role, content, created_at }) => ({ role, content, created_at }));
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
  ): AgentRun[] {
    const recent = this.db
      .prepare(
        `SELECT * FROM agent_runs
         WHERE agent_id = ? AND status IN ('completed', 'failed')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, pool) as AgentRun[];
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
  ): AgentRun[] {
    const rows = this.db
      .prepare(
        `SELECT *, goal_embedding FROM agent_runs
         WHERE agent_id = ? AND status IN ('completed', 'failed')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, pool) as Array<AgentRun & { goal_embedding: Buffer | Uint8Array | null }>;
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
  ): AgentLearning[] {
    const all = this.getLearnings(agentId);
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
  ): AgentLearning[] {
    const rows = this.db
      .prepare(
        `SELECT *, embedding FROM agent_learnings
         WHERE agent_id = ? AND active = 1
         ORDER BY confidence DESC`,
      )
      .all(agentId) as Array<AgentLearning & { embedding: Buffer | Uint8Array | null }>;
    if (rows.length <= limit) return rows.map(({ embedding: _, ...rest }) => rest as AgentLearning);
    const items = rows.map(r => ({ ...r, embedding: blobToVector(r.embedding) }));
    return rankByEmbedding(items, goalVector, goal, l => l.content, limit, cosineWeight, minScore ?? 0.45)
      .map(({ embedding: _, ...rest }) => rest as AgentLearning);
  }

  updateLearningConfidence(id: string, delta: number): void {
    const learning = this.db
      .prepare("SELECT confidence FROM agent_learnings WHERE id = ?")
      .get(id) as { confidence: number } | undefined;
    if (!learning) return;

    const newConf = Math.max(0, Math.min(1, learning.confidence + delta));
    this.db
      .prepare("UPDATE agent_learnings SET confidence = ?, updated_at = ? WHERE id = ?")
      .run(newConf, isoNow(), id);
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
  ): { updated: number; deactivated: number } {
    const delta =
      outcome === "success" ? 0.08
      : outcome === "partial" ? 0.02
      : outcome === "failure" ? -0.15
      : 0;
    if (delta === 0) return { updated: 0, deactivated: 0 };

    const learnings = this.getLearningsActiveAt(agentId, runCreatedAt);
    let updated = 0;
    let deactivated = 0;
    for (const l of learnings) {
      this.updateLearningConfidence(l.id, delta);
      updated++;
      // Re-fetch to check new confidence
      const fresh = this.db
        .prepare("SELECT confidence FROM agent_learnings WHERE id = ?")
        .get(l.id) as { confidence: number } | undefined;
      if (fresh && fresh.confidence < 0.15) {
        this.deactivateLearning(l.id);
        deactivated++;
      }
    }
    return { updated, deactivated };
  }

  /**
   * Periodic cleanup: deactivate learnings below minConfidence threshold.
   * Returns count deactivated.
   */
  cleanupLowConfidenceLearnings(agentId: string, minConfidence = 0.15): number {
    const result = this.db
      .prepare(
        `UPDATE agent_learnings SET active = 0, updated_at = ?
         WHERE agent_id = ? AND active = 1 AND confidence < ?`,
      )
      .run(isoNow(), agentId, minConfidence);
    return result.changes as number;
  }
}
