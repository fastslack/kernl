import { cosine } from "./cosine.js";
import type { EmbeddingsClient } from "../embeddings/client.js";

/** Optional FTS leg: given a query, return candidate ids ranked best-first. */
export type FtsRanker = (query: string, limit: number) => string[];

export interface RankAndPageInput<T> {
  items: T[];
  query: string;
  /** Extract a stable id + the text to embed/match for one item. */
  key: (item: T) => { id: string; text: string };
  /** Max results to return. */
  k: number;
  /** Optional FTS leg to fuse with the semantic leg via RRF. */
  fts?: FtsRanker;
}

export interface RankAndPageResult<T> {
  ranked: T[];
  scores: Map<string, number>;
  /** True when the semantic leg was unavailable and we fell back to FTS/lexical. */
  degraded: boolean;
}

const RRF_K = 60;

/**
 * Stateless ranking layer. Generalizes cinema's hybrid search:
 *   - semantic leg: embed query + items, score by cosine
 *   - optional FTS leg: caller-supplied ranked ids
 *   - fuse available legs with Reciprocal Rank Fusion (rank-only, scale-free)
 *   - if the semantic leg is unavailable, degrade to FTS or lexical token overlap
 * The LLM never sees the raw inventory — only the top-k this returns.
 */
export class RankingService {
  constructor(private embeddings: EmbeddingsClient | null) {}

  async rankAndPage<T>(input: RankAndPageInput<T>): Promise<RankAndPageResult<T>> {
    const { items, query, key, k, fts } = input;
    const keyed = items.map((item) => ({ item, ...key(item) }));
    const byId = new Map(keyed.map((e) => [e.id, e.item]));

    // ── semantic leg ───────────────────────────────────────────────
    let semanticRanked: string[] = [];
    let degraded = false;
    const useSemantic = this.embeddings && (await this.safeAvailable(this.embeddings));
    if (useSemantic && query.trim()) {
      try {
        const [qVec] = await this.embeddings!.embed([query], { inputType: "query" });
        const docVecs = await this.embeddings!.embed(
          keyed.map((e) => e.text),
          { inputType: "passage" },
        );
        semanticRanked = keyed
          .map((e, i) => ({ id: e.id, score: cosine(qVec, docVecs[i]) }))
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((s) => s.id);
      } catch {
        degraded = true;
      }
    } else {
      degraded = true;
    }

    // ── fts leg (optional) — drop ids not present in this item slice ─
    const ftsRanked =
      fts && query.trim()
        ? fts(query, Math.max(50, k * 3)).filter((id) => byId.has(id))
        : [];

    // ── fuse, or lexical fallback when no leg produced anything ─────
    let scores: Map<string, number>;
    if (semanticRanked.length === 0 && ftsRanked.length === 0) {
      degraded = true;
      scores = this.lexicalScores(keyed, query);
    } else {
      scores = this.rrf([semanticRanked, ftsRanked]);
    }

    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([id]) => byId.get(id)!)
      .filter((x) => x !== undefined) as T[];

    return { ranked, scores, degraded };
  }

  private async safeAvailable(client: EmbeddingsClient): Promise<boolean> {
    try {
      return await client.available();
    } catch {
      return false;
    }
  }

  /** Reciprocal Rank Fusion over N ranked id-lists. rank starts at 1. */
  private rrf(lists: string[][]): Map<string, number> {
    const scores = new Map<string, number>();
    for (const list of lists) {
      list.forEach((id, i) => {
        scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + (i + 1)));
      });
    }
    return scores;
  }

  /** Deterministic last resort: sum of query-token occurrences per item. */
  private lexicalScores<T>(
    keyed: Array<{ id: string; text: string }>,
    query: string,
  ): Map<string, number> {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scores = new Map<string, number>();
    for (const e of keyed) {
      const lc = e.text.toLowerCase();
      let s = 0;
      for (const t of tokens) {
        s += (lc.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
      }
      if (s > 0) scores.set(e.id, s);
    }
    return scores;
  }
}
