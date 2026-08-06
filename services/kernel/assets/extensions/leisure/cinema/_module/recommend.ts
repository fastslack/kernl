/**
 * Discovery from the vectors the module already builds.
 *
 * `embeddings.ts` turns titles into vectors so a QUERY can be answered. The
 * same vectors answer two questions nobody has to type:
 *
 *   similarTo   the route from a film you liked to the next one
 *   forYou      what this catalogue holds that resembles what you keep
 *
 * Neither depends on canonical identification, which matters here more than
 * it sounds: 81 of this catalogue's titles are theatrical cartoons that
 * Wikidata does not catalogue and that are, by downloads, the most popular
 * things in it. Every signal built on identification is blind to them.
 * Cosine similarity is not.
 *
 * The vector arithmetic is kept pure and separate from Neo4j so the parts
 * that can be wrong — the weighting, the centroid, the blend — are testable
 * without a graph.
 */

import { log } from "../../../../../src/core/logger.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { EmbeddingsClient } from "../../../../../src/core/embeddings/index.js";
import { indexNameFor } from "./embeddings.js";

/** Matches the label embeddings.ts writes. */
const CINEMA_LABEL = "CinemaTitle";

/**
 * Below this many rated/saved titles there is no profile.
 *
 * A centroid of one film is that film, and a "for you" rail built from it
 * recommends six copies of what you just watched. Two is barely better. The
 * rail stays hidden until there is enough to average — an absent rail is
 * honest, a bad one is not.
 */
export const MIN_PROFILE_TITLES = 3;

export interface ProfileEntry {
  identifier: string;
  weight: number;
}

interface TasteRow {
  identifier: string;
  watchlist: number;
  watched_at: string | null;
  user_rating: number;
}

/**
 * How much one title says about someone's taste, and in which direction.
 *
 * Rating outranks watching, which outranks saving, because each is a stronger
 * commitment than the last. A low rating carries NEGATIVE weight — Rocchio's
 * insight: "I watched this and disliked it" is information, and letting it
 * push the centroid away is more useful than discarding it. A middling rating
 * is deliberately near-neutral; 5 and 6 out of 10 mean "fine", which is not
 * a direction.
 */
export function tasteWeight(row: TasteRow): number {
  if (row.user_rating >= 8) return 3;
  if (row.user_rating >= 7) return 2;
  if (row.user_rating > 0 && row.user_rating <= 3) return -2;
  if (row.user_rating === 4) return -1;
  if (row.user_rating > 0) return 0.25;      // 5-6: watched, no strong opinion
  if (row.watched_at) return 1.5;
  if (row.watchlist === 1) return 1;
  return 0;
}

/**
 * The titles that describe someone's taste, with their weights.
 *
 * Zero-weight rows are dropped rather than carried: they contribute nothing
 * to the centroid and would only inflate the count that decides whether a
 * profile exists at all.
 */
export function buildProfile(db: SqliteDb): ProfileEntry[] {
  const rows = db.prepare(`
    SELECT identifier, watchlist, watched_at, user_rating
    FROM cinema_titles
    WHERE deleted_at IS NULL
      AND (watchlist = 1 OR watched_at IS NOT NULL OR user_rating > 0)
  `).all() as TasteRow[];

  return rows
    .map((r) => ({ identifier: r.identifier, weight: tasteWeight(r) }))
    .filter((e) => e.weight !== 0);
}

/**
 * Weighted mean of vectors, L2-normalized.
 *
 * Normalizing matters because the result is compared by cosine: an
 * unnormalized centroid built from six strong positives and one negative has
 * a magnitude that says nothing and a direction that says everything.
 * Returns null when the vectors cancel out — possible when the negatives
 * balance the positives — because a zero vector has no direction to search in.
 */
export function centroid(vectors: number[][], weights: number[]): number[] | null {
  if (vectors.length === 0 || vectors.length !== weights.length) return null;
  const dim = vectors[0].length;
  if (dim === 0) return null;

  const sum = new Array<number>(dim).fill(0);
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    const w = weights[i];
    if (v.length !== dim) continue;
    for (let d = 0; d < dim; d++) sum[d] += v[d] * w;
  }

  let norm = 0;
  for (const x of sum) norm += x * x;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) return null;

  return sum.map((x) => x / norm);
}

export interface RecommendHit {
  identifier: string;
  /** Cosine against the query vector, as Neo4j reports it. */
  score: number;
}

/**
 * Read stored vectors straight off the nodes.
 *
 * The label filter is not optional: this Neo4j instance is shared with a
 * medical ontology of several million nodes, and an unfiltered MATCH would
 * scan all of it.
 */
async function vectorsFor(
  graph: GraphDriver,
  identifiers: string[],
): Promise<Map<string, number[]>> {
  if (identifiers.length === 0) return new Map();
  const result = await graph.run(
    `
    MATCH (n:${CINEMA_LABEL})
    WHERE n.identifier IN $ids AND n.embedding IS NOT NULL
    RETURN n.identifier AS identifier, n.embedding AS embedding
    `,
    { ids: identifiers },
  );
  const out = new Map<string, number[]>();
  for (const r of result.records) {
    const v = r.get("embedding") as unknown;
    if (Array.isArray(v)) out.set(r.get("identifier") as string, v.map(Number));
  }
  return out;
}

/**
 * Nearest neighbours of a vector, excluding whatever the caller already knows.
 *
 * Over-fetches before excluding: the index returns the k nearest overall, and
 * if several of those are titles being excluded, asking for exactly k would
 * come back short.
 */
async function nearest(
  graph: GraphDriver,
  client: EmbeddingsClient,
  vector: number[],
  k: number,
  exclude: Set<string>,
): Promise<RecommendHit[]> {
  const fetch = Math.min(k + exclude.size + 10, 500);
  const result = await graph.run(
    `
    CALL db.index.vector.queryNodes($indexName, $k, $vector)
    YIELD node, score
    WHERE '${CINEMA_LABEL}' IN labels(node)
    RETURN node.identifier AS identifier, score
    ORDER BY score DESC
    `,
    { indexName: indexNameFor(client), k: fetch, vector },
  );
  const hits: RecommendHit[] = [];
  for (const r of result.records) {
    const identifier = r.get("identifier") as string;
    if (exclude.has(identifier)) continue;
    hits.push({ identifier, score: Number(r.get("score") ?? 0) });
    if (hits.length >= k) break;
  }
  return hits;
}

/**
 * Films resembling one the user is looking at.
 *
 * Uses the STORED vector rather than re-embedding the title's text: the two
 * would differ whenever the text profile has changed since the row was
 * indexed, and the stored one is what every other title was compared against.
 *
 * Returns empty rather than throwing when the title has no vector — an
 * un-embedded title is the normal state during a backfill, and a detail page
 * should render without its "similar" row rather than fail.
 */
export async function similarTo(
  client: EmbeddingsClient,
  graph: GraphDriver | null,
  identifier: string,
  k = 12,
): Promise<RecommendHit[]> {
  if (!graph?.capabilities.cypher) {
    throw new Error("similar titles require an active graph driver — activate Neo4j in /extensions");
  }
  const vectors = await vectorsFor(graph, [identifier]);
  const self = vectors.get(identifier);
  if (!self) return [];
  return nearest(graph, client, self, k, new Set([identifier]));
}

export interface ForYouResult {
  hits: RecommendHit[];
  /** How many titles the taste profile was built from. */
  profile_size: number;
  /** Why the rail is empty, when it is. */
  reason: "ok" | "no_profile" | "no_vectors" | "no_direction";
}

/**
 * The catalogue, ranked against what the user keeps.
 *
 * Every title already in the profile is excluded: recommending something back
 * to the person who saved it is the most obvious way for this to look broken.
 *
 * The four outcomes are distinguished rather than collapsed into "empty",
 * because they call for different things from the UI — no profile means "use
 * the watchlist a while", no vectors means "run the embed runner", and those
 * are not the same message.
 */
export async function forYou(
  db: SqliteDb,
  client: EmbeddingsClient,
  graph: GraphDriver | null,
  k = 24,
): Promise<ForYouResult> {
  if (!graph?.capabilities.cypher) {
    throw new Error("recommendations require an active graph driver — activate Neo4j in /extensions");
  }

  const profile = buildProfile(db);
  // Counted on the positives: three films someone disliked describe what to
  // avoid, not a taste to search for.
  const positives = profile.filter((p) => p.weight > 0);
  if (positives.length < MIN_PROFILE_TITLES) {
    return { hits: [], profile_size: positives.length, reason: "no_profile" };
  }

  const vectors = await vectorsFor(graph, profile.map((p) => p.identifier));
  const usable = profile.filter((p) => vectors.has(p.identifier));
  if (usable.filter((p) => p.weight > 0).length < MIN_PROFILE_TITLES) {
    return { hits: [], profile_size: positives.length, reason: "no_vectors" };
  }

  const c = centroid(
    usable.map((p) => vectors.get(p.identifier) as number[]),
    usable.map((p) => p.weight),
  );
  if (!c) return { hits: [], profile_size: positives.length, reason: "no_direction" };

  const exclude = new Set(profile.map((p) => p.identifier));
  const hits = await nearest(graph, client, c, k, exclude);
  log.info(`cinema: for-you built from ${usable.length} titles → ${hits.length} hits`);
  return { hits, profile_size: positives.length, reason: "ok" };
}
