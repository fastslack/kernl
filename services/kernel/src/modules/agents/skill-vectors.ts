/**
 * Skill vectors — meaning-based matching for the skill recommender.
 *
 * Keyword overlap (skill-scoring.ts) cannot cross languages: an agent
 * prompted in Spanish ("conseguir que los asistentes de IA nombren el
 * producto") shares no words with an English skill about exactly that
 * ("get cited by LLMs"). Embeddings from the kernel's configured client
 * (the same chain chat memory uses) bridge that gap.
 *
 * Vectors are cached in SQLite per (kind, ref, model), keyed by a hash of
 * the embedded text, so a skill is embedded once and again only when its
 * text or the embedding model changes. The first request after install has
 * to embed the whole catalogue; it waits a few seconds for that and
 * otherwise answers "warming" so the caller falls back to keywords while
 * the fill finishes in the background.
 */

import { createHash } from "node:crypto";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EmbeddingsClient } from "../../core/embeddings/client.js";
import { blobToVector, cosineSim, vectorToBlob } from "../../core/ranking/relevance.js";
import { log } from "../../core/logger.js";
import { isoNow } from "../../core/helpers.js";

/** Long manuals add little meaning past their opening; cap what is embedded. */
const MAX_CHARS = 2000;
const BATCH = 64;
/** Below this share of the catalogue embedded, a semantic ranking would be biased. */
const MIN_COVERAGE = 0.9;

export type SemanticState = "on" | "warming" | "off";

export interface SemanticScores {
  state: SemanticState;
  /** slug → cosine similarity in [-1, 1]; empty unless state is "on". */
  scores: Map<string, number>;
}

function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export class SkillVectorIndex {
  /** One fill at a time per model; concurrent requests share it. */
  private filling: Promise<void> | null = null;

  constructor(
    private readonly db: SqliteDb,
    private readonly getClient: () => EmbeddingsClient | null,
  ) {}

  async score(
    agent: { id: string; text: string },
    candidates: Array<{ slug: string; text: string }>,
    opts: { waitMs?: number } = {},
  ): Promise<SemanticScores> {
    const off: SemanticScores = { state: "off", scores: new Map() };
    const client = this.getClient();
    if (!client || candidates.length === 0) return off;

    const texts = new Map(candidates.map((c) => [c.slug, c.text.slice(0, MAX_CHARS)]));
    let vectors = this.load("skill", client.model, texts);

    const missing = [...texts.keys()].filter((s) => !vectors.has(s));
    if (missing.length > 0) {
      const fill = this.fill(client, missing.map((s) => [s, texts.get(s)!] as [string, string]));
      const waited = await Promise.race([
        fill.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), opts.waitMs ?? 8000)),
      ]);
      if (waited) vectors = this.load("skill", client.model, texts);
      if (vectors.size < texts.size * MIN_COVERAGE) {
        return { state: "warming", scores: new Map() };
      }
    }

    let agentVec: number[] | null;
    try {
      agentVec = await this.agentVector(client, agent);
    } catch (e) {
      log.warn(`skill-vectors: agent embedding failed — ${String(e)}`);
      return off;
    }
    if (!agentVec) return off;

    const scores = new Map<string, number>();
    for (const [slug, vec] of vectors) {
      if (vec.length === agentVec.length) scores.set(slug, cosineSim(agentVec, vec));
    }
    return { state: "on", scores };
  }

  /** Cached vectors whose stored hash still matches the current text. */
  private load(kind: string, model: string, texts: Map<string, string>): Map<string, number[]> {
    const rows = this.db
      .prepare("SELECT ref, text_hash, vector FROM agent_skill_vectors WHERE kind = ? AND model = ?")
      .all(kind, model) as Array<{ ref: string; text_hash: string; vector: Buffer }>;
    const out = new Map<string, number[]>();
    for (const r of rows) {
      const text = texts.get(r.ref);
      if (text === undefined || hashOf(text) !== r.text_hash) continue;
      const v = blobToVector(r.vector);
      if (v) out.set(r.ref, v);
    }
    return out;
  }

  private save(kind: string, ref: string, model: string, text: string, vec: number[]): void {
    this.db
      .prepare(
        `INSERT INTO agent_skill_vectors (kind, ref, model, text_hash, vector, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, ref, model) DO UPDATE SET
           text_hash = excluded.text_hash, vector = excluded.vector, updated_at = excluded.updated_at`,
      )
      .run(kind, ref, model, hashOf(text), vectorToBlob(vec), isoNow());
  }

  private fill(client: EmbeddingsClient, items: Array<[string, string]>): Promise<void> {
    if (this.filling) return this.filling;
    const model = client.model;
    this.filling = (async () => {
      const started = Date.now();
      let done = 0;
      try {
        for (let i = 0; i < items.length; i += BATCH) {
          const chunk = items.slice(i, i + BATCH);
          const vecs = await client.embed(chunk.map(([, t]) => t), { inputType: "passage" });
          // The chain may have fallen back to a model with another
          // dimension mid-fill; vectors are filed under the model that
          // produced them only if it is still the one we asked for.
          if (client.model !== model) break;
          chunk.forEach(([slug, text], j) => {
            if (vecs[j]?.length) this.save("skill", slug, model, text, vecs[j]);
          });
          done += chunk.length;
        }
        log.info(`skill-vectors: embedded ${done} skills with ${model} in ${Date.now() - started} ms`);
      } catch (e) {
        log.warn(`skill-vectors: fill stopped after ${done}/${items.length} — ${String(e)}`);
      } finally {
        this.filling = null;
      }
    })();
    return this.filling;
  }

  private async agentVector(
    client: EmbeddingsClient,
    agent: { id: string; text: string },
  ): Promise<number[] | null> {
    const text = agent.text.slice(0, MAX_CHARS);
    const cached = this.load("agent", client.model, new Map([[agent.id, text]])).get(agent.id);
    if (cached) return cached;
    const [vec] = await client.embed([text], { inputType: "query" });
    if (!vec?.length) return null;
    this.save("agent", agent.id, client.model, text, vec);
    return vec;
  }
}
