/**
 * Semantic memory of past tool calls.
 *
 * Indexes every successful tool call by the embedding of its
 * `tool + JSON(args)` summary. On the next call, the server can cheaply
 * surface "you (or this user) ran something semantically similar; here's
 * what came out / how the user reacted to it."
 *
 * Storage model:
 *   tool_memory(id, tool, embedding BLOB, input_json, output_json, receipt_id,
 *               succeeded, user_action, owner_agent_id, created_at)
 *
 * Embeddings are stored as raw little-endian Float32 BLOBs to avoid
 * JSON parse overhead at search time. The cosine search is in-memory
 * over the (small, per-user) candidate set — fine up to ~100k rows;
 * we'll move to vector index columns when we hit that scale.
 *
 * Privacy: every row carries `owner_agent_id` (set from the request
 * context — empty string for top-level / dashboard calls). Search is
 * scoped to the same owner. `purge` deletes by owner; `export` returns
 * everything for that owner.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EmbeddingsClient } from "../../core/embeddings/index.js";
import { newId, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import { cosine } from "../../core/ranking/cosine.js";

export interface ToolMemoryRecord {
  id: string;
  tool: string;
  input_json: string;
  output_json: string;
  receipt_id: string | null;
  succeeded: number;
  user_action: string | null;
  owner_agent_id: string;
  created_at: string;
  /** Cosine similarity to the query, only set in search results. */
  similarity?: number;
}

export interface SearchResult {
  record: ToolMemoryRecord;
  similarity: number;
}

export class ToolMemoryService {
  constructor(
    private readonly db: SqliteDb,
    private readonly embeddings: EmbeddingsClient,
  ) {
    // Schema (tool_memory + indexes) is created by toolMemoryMigrations
    // (./migrations.js) via runMigrations() in index.ts's initialize(),
    // BEFORE this constructor runs.
  }

  /**
   * Build the text we embed for a call. Tool name + canonicalised JSON
   * args, lightly serialised. Same args ⇒ same embedding ⇒ exact-match
   * recall via similarity ≥ 0.99.
   */
  private summary(tool: string, args: unknown): string {
    return `${tool} ${JSON.stringify(args ?? {})}`;
  }

  /** Index one tool call. Best-effort: errors are logged but never thrown
   *  — memory is a side-channel, not on the hot path. */
  async record(args: {
    tool: string;
    input: unknown;
    output: unknown;
    receiptId?: string | null;
    succeeded?: boolean;
    ownerAgentId?: string;
  }): Promise<void> {
    try {
      const text = this.summary(args.tool, args.input);
      const [vec] = await this.embeddings.embed([text]);
      const buf = floatArrayToBlob(vec);
      this.db
        .prepare(
          "INSERT INTO tool_memory (id, tool, embedding, input_json, output_json, receipt_id, succeeded, owner_agent_id, created_at)\n" +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          newId(),
          args.tool,
          buf,
          JSON.stringify(args.input ?? {}),
          JSON.stringify(args.output ?? {}),
          args.receiptId ?? null,
          args.succeeded === false ? 0 : 1,
          args.ownerAgentId ?? "",
          isoNow(),
        );
    } catch (e) {
      log.debug(`tool_memory.record failed: ${(e as Error).message}`);
    }
  }

  /**
   * Find past calls semantically similar to (tool, args). Filters by
   * `ownerAgentId` to keep memories partitioned per agent / user.
   * Cosine threshold defaults to 0.85 — tighter than typical RAG since
   * we're matching tool inputs (more structured than free-form prose).
   */
  async findSimilar(args: {
    tool: string;
    input: unknown;
    ownerAgentId?: string;
    limit?: number;
    minSimilarity?: number;
  }): Promise<SearchResult[]> {
    const text = this.summary(args.tool, args.input);
    const [query] = await this.embeddings.embed([text]);
    const owner = args.ownerAgentId ?? "";
    const limit = args.limit ?? 5;
    const threshold = args.minSimilarity ?? 0.85;

    // Candidates: same tool first; if too few, broaden to all tools.
    let rows = this.db
      .prepare(
        "SELECT id, tool, embedding, input_json, output_json, receipt_id, succeeded, user_action, owner_agent_id, created_at\n" +
          "FROM tool_memory\n" +
          "WHERE tool = ? AND owner_agent_id = ?\n" +
          "ORDER BY created_at DESC\n" +
          "LIMIT 200",
      )
      .all(args.tool, owner) as RawRow[];
    if (rows.length < 5) {
      const broader = this.db
        .prepare(
          "SELECT id, tool, embedding, input_json, output_json, receipt_id, succeeded, user_action, owner_agent_id, created_at\n" +
            "FROM tool_memory\n" +
            "WHERE owner_agent_id = ?\n" +
            "ORDER BY created_at DESC\n" +
            "LIMIT 200",
        )
        .all(owner) as RawRow[];
      const seen = new Set(rows.map((r) => r.id));
      for (const r of broader) if (!seen.has(r.id)) rows.push(r);
    }

    const scored: SearchResult[] = [];
    for (const row of rows) {
      const vec = blobToFloatArray(row.embedding);
      const sim = cosine(query, vec);
      if (sim >= threshold) {
        const { embedding: _ignore, ...rest } = row;
        scored.push({ record: { ...rest, similarity: sim }, similarity: sim });
      }
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  }

  /** Delete all memories for an owner. Returns the row count purged. */
  purge(ownerAgentId = ""): number {
    const info = this.db
      .prepare("DELETE FROM tool_memory WHERE owner_agent_id = ?")
      .run(ownerAgentId);
    return info.changes ?? 0;
  }

  /** Export all rows for an owner (no embeddings — those are large and
   *  deterministic from input_json). */
  export(ownerAgentId = ""): Omit<ToolMemoryRecord, "similarity">[] {
    return this.db
      .prepare(
        "SELECT id, tool, input_json, output_json, receipt_id, succeeded, user_action, owner_agent_id, created_at\n" +
          "FROM tool_memory\n" +
          "WHERE owner_agent_id = ?\n" +
          "ORDER BY created_at DESC",
      )
      .all(ownerAgentId) as Omit<ToolMemoryRecord, "similarity">[];
  }
}

interface RawRow {
  id: string;
  tool: string;
  embedding: Buffer | Uint8Array;
  input_json: string;
  output_json: string;
  receipt_id: string | null;
  succeeded: number;
  user_action: string | null;
  owner_agent_id: string;
  created_at: string;
}

// ── Vector helpers ────────────────────────────────────────────────

function floatArrayToBlob(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

function blobToFloatArray(blob: Buffer | Uint8Array): number[] {
  const buf = blob instanceof Buffer ? blob : Buffer.from(blob);
  const out = new Array<number>(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

