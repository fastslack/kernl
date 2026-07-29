/**
 * Brain: unified semantic memory across modules.
 *
 * The brain indexes a *text profile* of rows from many modules (tasks,
 * notes, contacts, communications, reminders, calendar events…) into ONE
 * embedding space, so a mail, a task and a contact about the same topic
 * become neighbours. SQLite stays the source of truth — a `brain_items`
 * row only holds an embedding + a back-pointer (`source_table`,
 * `source_id`) to the exact row it indexes.
 *
 * Storage model:
 *   brain_items(id, kind, source_table, source_id, text, embedding BLOB,
 *               weight, source_updated_at, created_at, updated_at,
 *               last_seen_at)   UNIQUE(source_table, source_id)
 *   brain_watermarks(source_table, watermark, updated_at)
 *   brain_signals(id, item_id, signal, weight_delta, created_at)
 *
 * Embeddings are raw little-endian Float32 BLOBs (same convention as
 * `tool_memory`). Recall is in-memory cosine over the candidate set —
 * fine at the current scale; the Neo4j vector index / `vector-driver`
 * seam is the documented next step when row counts grow.
 *
 * Autoaprendizaje: `reinforce()` nudges an item's `weight` from usage
 * signals (opened +, ignored −, corrected +), mirroring the confidence
 * reinforcement loop already proven in `agent_learnings`. `decayWeights()`
 * applies a gentle time-decay toward the 1.0 baseline so stale boosts fade.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EmbeddingsClient } from "../../core/embeddings/index.js";
import { newId, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import { cosine } from "../../core/ranking/cosine.js";
import { extractKeywords, scoreRelevance } from "../../core/ranking/relevance.js";

export interface BrainItem {
  id: string;
  kind: string;
  source_table: string;
  source_id: string;
  text: string;
  weight: number;
  source_updated_at: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

export interface RecallHit {
  item: BrainItem;
  /** Cosine similarity to the query. */
  similarity: number;
  /** Final ranking score = similarity × weight. */
  score: number;
  /** Best-effort resolved source row (SELECT * FROM source_table WHERE id=…). */
  row?: Record<string, unknown> | null;
}

/** Signal kinds and their weight deltas. Mirrors the agent_learnings loop
 *  (success +0.08 / failure −0.15) so the brain "learns" the same way the
 *  rest of the kernel already does. */
export const SIGNAL_DELTAS: Record<string, number> = {
  open: 0.08, // user opened/used a recalled item → reinforce
  co_open: 0.05, // opened together with another recalled item
  correct: 0.1, // user edited/corrected after seeing it → strongly relevant
  ignore: -0.15, // surfaced but skipped → demote
};

const WEIGHT_FLOOR = 0.1;
const WEIGHT_CEIL = 3.0;
const WEIGHT_BASELINE = 1.0;

export interface UpsertItemInput {
  kind: string;
  sourceTable: string;
  sourceId: string;
  text: string;
  embedding: number[];
  sourceUpdatedAt?: string | null;
}

export class BrainService {
  constructor(
    private readonly db: SqliteDb,
    private readonly embeddings: EmbeddingsClient,
  ) {
    // Schema (brain_items, brain_watermarks, brain_signals) is created by
    // brainMigrations (./migrations.js) via runMigrations() in index.ts's
    // initialize(), BEFORE this constructor runs.
  }

  get dim(): number {
    return this.embeddings.dim;
  }

  /** Embed a batch of texts in input order. Surfaces transport errors. */
  embed(texts: string[]): Promise<number[][]> {
    return this.embeddings.embed(texts, { inputType: "passage" });
  }

  /** Insert or update one indexed item, keyed by (source_table, source_id).
   *  Preserves the learned `weight` on update — re-indexing a row must not
   *  reset what the brain learned about it. */
  upsert(input: UpsertItemInput): void {
    const now = isoNow();
    const buf = floatArrayToBlob(input.embedding);
    this.db
      .prepare(
        "INSERT INTO brain_items (id, kind, source_table, source_id, text, embedding, weight, source_updated_at, created_at, updated_at, last_seen_at)\n" +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)\n" +
          "ON CONFLICT(source_table, source_id) DO UPDATE SET\n" +
          "  kind = excluded.kind,\n" +
          "  text = excluded.text,\n" +
          "  embedding = excluded.embedding,\n" +
          "  source_updated_at = excluded.source_updated_at,\n" +
          "  updated_at = excluded.updated_at",
      )
      .run(
        newId(),
        input.kind,
        input.sourceTable,
        input.sourceId,
        input.text,
        buf,
        WEIGHT_BASELINE,
        input.sourceUpdatedAt ?? null,
        now,
        now,
      );
  }

  /** Drop an indexed item (e.g. its source row was deleted/soft-deleted). */
  removeBySource(sourceTable: string, sourceId: string): number {
    const info = this.db
      .prepare("DELETE FROM brain_items WHERE source_table = ? AND source_id = ?")
      .run(sourceTable, sourceId);
    return info.changes ?? 0;
  }

  getWatermark(sourceTable: string): string {
    const row = this.db
      .prepare("SELECT watermark FROM brain_watermarks WHERE source_table = ?")
      .get(sourceTable) as { watermark: string } | undefined;
    return row?.watermark ?? "";
  }

  setWatermark(sourceTable: string, watermark: string): void {
    this.db
      .prepare(
        "INSERT INTO brain_watermarks (source_table, watermark, updated_at)\n" +
          "VALUES (?, ?, ?)\n" +
          "ON CONFLICT(source_table) DO UPDATE SET watermark = excluded.watermark, updated_at = excluded.updated_at",
      )
      .run(sourceTable, watermark, isoNow());
  }

  /**
   * Cross-module semantic recall with HYBRID ranking (dense + lexical).
   *
   * Paper "Are We Ready For An Agent-Native Memory System?" (Finding 8):
   * moderate dense+lexical fusion beats pure dense "when evidence is
   * semantically related but lexically diverse" — and it rescues exact-term
   * matches (proper nouns, IDs, domain words like "comandas") that a flat
   * 384d embedding flattens, which matters with MiniLM's weaker Spanish.
   *
   * Scoring: `blended = cosineWeight·cosine + (1−cosineWeight)·lexical`,
   * final rank = `blended × weight`. A candidate is kept if it clears the
   * cosine `minSimilarity` floor OR has strong lexical overlap (so a
   * lexically-exact but embedding-weak hit isn't filtered out). Set
   * `hybrid: false` for pure dense behaviour.
   */
  async recall(args: {
    query: string;
    kinds?: string[];
    limit?: number;
    minSimilarity?: number;
    resolveRows?: boolean;
    hybrid?: boolean;
    cosineWeight?: number;
  }): Promise<RecallHit[]> {
    const limit = args.limit ?? 8;
    const threshold = args.minSimilarity ?? 0.25;
    const hybrid = args.hybrid ?? true;
    const cosW = args.cosineWeight ?? 0.7;
    const LEXICAL_RESCUE = 0.5; // include strong lexical matches below the cosine floor
    const [queryVec] = await this.embeddings.embed([args.query], { inputType: "query" });
    const goalKeywords = hybrid ? extractKeywords(args.query) : new Set<string>();

    let sql =
      "SELECT id, kind, source_table, source_id, text, embedding, weight, source_updated_at, created_at, updated_at, last_seen_at FROM brain_items";
    const params: unknown[] = [];
    if (args.kinds && args.kinds.length > 0) {
      sql += ` WHERE kind IN (${args.kinds.map(() => "?").join(",")})`;
      params.push(...args.kinds);
    }
    const rows = this.db.prepare(sql).all(...params) as RawItemRow[];

    const hits: RecallHit[] = [];
    for (const row of rows) {
      const vec = blobToFloatArray(row.embedding);
      const sim = cosine(queryVec, vec);
      const lex = hybrid && goalKeywords.size > 0 ? scoreRelevance(goalKeywords, row.text) : 0;
      // Gate: clear the semantic floor, or be a strong lexical match.
      if (sim < threshold && lex < LEXICAL_RESCUE) continue;
      const relevance = hybrid ? cosW * sim + (1 - cosW) * lex : sim;
      const { embedding: _omit, ...item } = row;
      hits.push({
        item: item as BrainItem,
        similarity: sim,
        score: relevance * row.weight,
      });
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, limit);
    if (args.resolveRows) {
      for (const h of top) h.row = this.resolveRow(h.item.source_table, h.item.source_id);
    }
    return top;
  }

  /** Best-effort fetch of the exact source row. Returns null on any error
   *  (table gone, schema drift) — never throws, the index back-pointer is
   *  advisory. Filters soft-deleted rows when a `deleted_at` column exists. */
  resolveRow(sourceTable: string, sourceId: string): Record<string, unknown> | null {
    try {
      if (!/^[a-zA-Z0-9_]+$/.test(sourceTable)) return null; // identifier guard
      const row = this.db
        .prepare(`SELECT * FROM ${sourceTable} WHERE id = ?`)
        .get(sourceId) as Record<string, unknown> | undefined;
      if (!row) return null;
      if ("deleted_at" in row && row.deleted_at != null && row.deleted_at !== "") return null;
      return row;
    } catch {
      return null;
    }
  }

  /**
   * Apply a usage signal to an item, nudging its weight. Records the signal
   * for auditability and bumps `last_seen_at`. Clamped to [floor, ceil].
   * Unknown signals are no-ops. Returns the new weight, or null if missing.
   */
  reinforce(itemId: string, signal: string): number | null {
    const delta = SIGNAL_DELTAS[signal];
    if (delta === undefined) return null;
    const cur = this.db
      .prepare("SELECT weight FROM brain_items WHERE id = ?")
      .get(itemId) as { weight: number } | undefined;
    if (!cur) return null;
    const next = clamp(cur.weight + delta, WEIGHT_FLOOR, WEIGHT_CEIL);
    const now = isoNow();
    this.db
      .prepare("UPDATE brain_items SET weight = ?, last_seen_at = ? WHERE id = ?")
      .run(next, now, itemId);
    this.db
      .prepare(
        "INSERT INTO brain_signals (id, item_id, signal, weight_delta, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(newId(), itemId, signal, delta, now);
    return next;
  }

  /**
   * Pull every item's weight a fraction of the way back to the 1.0 baseline
   * so old reinforcements/penalties fade (Ebbinghaus-style hygiene, run
   * periodically rather than on the hot recall path). `rate` in [0,1].
   */
  decayWeights(rate = 0.1): number {
    const info = this.db
      .prepare(
        "UPDATE brain_items SET weight = weight + (? - weight) * ? WHERE weight <> ?",
      )
      .run(WEIGHT_BASELINE, rate, WEIGHT_BASELINE);
    return info.changes ?? 0;
  }

  /** Per-kind counts + total + indexed-source watermarks, for `kernel_brain_stats`. */
  stats(): { total: number; byKind: Record<string, number>; watermarks: Record<string, string> } {
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM brain_items").get() as { n: number }).n;
    const kindRows = this.db
      .prepare("SELECT kind, COUNT(*) AS n FROM brain_items GROUP BY kind ORDER BY n DESC")
      .all() as Array<{ kind: string; n: number }>;
    const byKind: Record<string, number> = {};
    for (const r of kindRows) byKind[r.kind] = r.n;
    const wmRows = this.db
      .prepare("SELECT source_table, watermark FROM brain_watermarks")
      .all() as Array<{ source_table: string; watermark: string }>;
    const watermarks: Record<string, string> = {};
    for (const r of wmRows) watermarks[r.source_table] = r.watermark;
    return { total, byKind, watermarks };
  }
}

interface RawItemRow extends BrainItem {
  embedding: Buffer | Uint8Array;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Vector helpers (little-endian Float32, same as tool_memory) ──────

export function floatArrayToBlob(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

export function blobToFloatArray(blob: Buffer | Uint8Array): number[] {
  const buf = blob instanceof Buffer ? blob : Buffer.from(blob);
  const out = new Array<number>(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

// Keep the logger import meaningful even if only used in future branches.
void log;
