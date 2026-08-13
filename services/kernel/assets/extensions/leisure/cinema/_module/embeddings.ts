/**
 * Cinema embeddings — turns rows in `cinema_titles` into vectors and
 * stores them on `(:CinemaTitle)` nodes in Neo4j with a vector index.
 *
 * Why a unique label: `MATCH (c:CinemaTitle)` scopes every query to this
 * module's own nodes without extra `WHERE c.foo IS NOT NULL` gates, and
 * keeps them separate from whatever else the graph grows to hold.
 *
 * The vector index name is parameterized by the model id so changing
 * the embedding model creates a fresh index, lets us re-embed in the
 * background, and never silently mixes incompatible vectors.
 */

import { log } from "../../../../../src/core/logger.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { EmbeddingsClient } from "../../../../../src/core/embeddings/index.js";
import { safeIndexSuffix } from "../../../../../src/core/embeddings/index.js";
import type { CinemaService } from "./service.js";
import type { CinemaTitle } from "./types.js";

const CINEMA_LABEL = "CinemaTitle";
const DEFAULT_BATCH_SIZE = 32;
/** Trim long descriptions to keep embeddings consistent and bound LMStudio
 *  context. archive.org descriptions occasionally hit 30k chars. */
const MAX_DESC_CHARS = 800;
/** Cap subjects/collections in the text profile to avoid noise. */
const MAX_SUBJECTS = 6;
const MAX_COLLECTIONS = 3;
/** Hard cap on the assembled text profile in CHARS. NVIDIA's nv-embedqa
 *  family rejects inputs >512 tokens with a 400. Empirically, a 1400-char
 *  cap was still hitting 832-token rows on Devanagari / Cyrillic content
 *  (~1.7 chars per token in those scripts). 700 chars leaves margin even
 *  for ~1.4 chars/token worst-case. Rows that STILL exceed the limit at
 *  this cap get caught by the embed-with-retry path below and skipped
 *  individually rather than killing the run. */
const MAX_PROFILE_CHARS = 700;

/**
 * Build the embedding source text for a title. Spanish-leaning structure —
 * archive.org metadata is mostly English so the model leans on bge-m3's
 * multilingual training, but the connector words are ES so retrieval feels
 * native when the user types in ES.
 *
 * If `description_es` was filled by a translation pipeline, prefer it over
 * the original English description.
 */
export function buildTextProfile(t: CinemaTitle): string {
  const parts: string[] = [];
  parts.push(t.title || t.identifier);
  if (t.year) parts.push(`(${t.year})`);
  if (t.creator) parts.push(`dirigida por ${t.creator}`);
  const subjects = t.subject.slice(0, MAX_SUBJECTS).filter(Boolean);
  if (subjects.length > 0) parts.push(`temas: ${subjects.join(", ")}`);
  const cols = t.collection.slice(0, MAX_COLLECTIONS).filter(Boolean);
  if (cols.length > 0) parts.push(`collections: ${cols.join(", ")}`);
  const desc = t.description_es || t.description;
  if (desc) parts.push(desc.slice(0, MAX_DESC_CHARS));
  let profile = parts.join(". ").replace(/\s+/g, " ").trim();
  // Non-empty guard: NVIDIA NIM rejects a batch outright if any element is
  // blank ("all elements must be non-empty"). A title with no usable metadata
  // can assemble to "" here — fall back to the identifier (or a placeholder)
  // so we always emit a valid, embeddable string.
  if (!profile) profile = (t.identifier || t.title || "untitled").trim() || "untitled";
  // Token-ceiling guard. NVIDIA's nv-embedqa caps inputs at 512 tokens. ASCII
  // tokenizes at ~0.25 token/char, but dense scripts (Arabic/Cyrillic/CJK/
  // Devanagari) run ~1 token/char — observed 698 chars → 576 tokens. So cap
  // non-ASCII-heavy profiles lower so they FIT and embed, instead of getting
  // skip-stamped. Anything still over the ceiling at this cap is caught and
  // skipped individually by embedWithSplit().
  const nonAscii = (profile.match(/[^\x00-\x7F]/g) || []).length;
  const cap = nonAscii > profile.length * 0.3 ? 420 : MAX_PROFILE_CHARS;
  return profile.length > cap ? profile.slice(0, cap) : profile;
}

export function indexNameFor(client: EmbeddingsClient): string {
  return `cinema-embeddings-${safeIndexSuffix(client.model)}`;
}

/**
 * Ensure the vector index exists for the current model+dim. Idempotent.
 * Returns true on creation/already-present, false if Neo4j refused (older
 * versions without vector index support).
 */
export async function ensureCinemaVectorIndex(
  graph: GraphDriver | null,
  client: EmbeddingsClient,
): Promise<boolean> {
  if (!graph?.capabilities.cypher) return false;
  const indexName = indexNameFor(client);
  // `vector.dimensions` requires an int literal — Neo4j's driver
  // serialises a JS-number-typed parameter as a float (`384.0`) and
  // the index config rejects it ("Expected a map from String to Strings
  // and Integers"). Inline the dim, which we control, and keep the
  // identifier-name interpolation safe (sanitised in indexNameFor).
  const dim = Math.floor(client.dim);
  try {
    // Uniqueness on the key this module MERGEs by. Without it, `MERGE` is only
    // atomic within a transaction, so two batches writing the same identifier
    // concurrently each create a node — the vector index then holds two
    // half-populated copies and searches return the same film twice. Best
    // effort: a graph that already carries duplicates rejects this, and the
    // catalogue projection repairs and retries it.
    await graph
      .run(
        `CREATE CONSTRAINT cinema_title_identifier IF NOT EXISTS
         FOR (c:${CINEMA_LABEL}) REQUIRE c.identifier IS UNIQUE`,
      )
      .catch((err: unknown) => {
        log.warn(
          `cinema: could not assert uniqueness on ${CINEMA_LABEL}.identifier — ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      });
    await graph.run(
      `
      CREATE VECTOR INDEX \`${indexName}\` IF NOT EXISTS
      FOR (c:${CINEMA_LABEL}) ON (c.embedding)
      OPTIONS { indexConfig: {
        \`vector.dimensions\`: ${dim},
        \`vector.similarity_function\`: 'cosine'
      }}
      `,
    );
    return true;
  } catch (err) {
    log.warn(`cinema: vector index '${indexName}' create failed`, err);
    return false;
  }
}

export interface EmbedBatchResult {
  attempted: number;
  embedded: number;
  graphWrites: number;
  /** Rows the embedder rejected with a token-limit 400 even at our
   *  truncated text profile. Stamped as embedded anyway so the next pass
   *  doesn't pick them up forever. */
  skippedTooLong: number;
  durationMs: number;
}

/** True when the embedder rejected the request CONTENT (HTTP 400) — the
 *  request was understood but a row is unembeddable as-is, so bisecting
 *  isolates it and we skip-stamp the offender. This covers every 400 shape
 *  NVIDIA returns, not just token-size:
 *    - `... 400 Bad Request — {"error":"Input length 576 exceeds maximum
 *       allowed token size 512"}`                          (token overflow)
 *    - `... 400 Bad Request — {"error":"... detail={'type': 'string_type',
 *       'loc': ('body','input','constrained-str'), ...}"}` (validation; dense
 *       non-Latin rows surface this variant instead of the clean token msg)
 *    - `... 400 ... all elements must be non-empty`        (blank element)
 *  Auth/quota/transport (401/403/429/5xx, timeouts, shape mismatch) do NOT
 *  match, so they re-throw and the runner's consecutive-failure backoff
 *  handles the real outage instead of silently skip-stamping good rows. */
function isRowContentRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes(" 400 Bad Request") ||
    msg.includes("exceeds maximum allowed token size") ||
    msg.includes("maximum context length") ||
    msg.includes("max_tokens")
  );
}

/**
 * Embed a batch, but on a token-limit 400 split-and-retry recursively to
 * isolate the offending row. Returns one entry per input text:
 *   - number[]  → embedded successfully
 *   - null      → individually rejected with token-limit at single-row
 *                 size; caller marks it embedded anyway so it never re-tries.
 * Re-throws non-token-limit errors so the runner's consecutive-failure
 * counter kicks in for real outages (network down, quota burnt, etc.).
 */
async function embedWithSplit(
  client: EmbeddingsClient,
  texts: string[],
): Promise<Array<number[] | null>> {
  try {
    const vecs = await client.embed(texts);
    return vecs;
  } catch (err) {
    if (!isRowContentRejection(err)) throw err;
    if (texts.length === 1) {
      log.warn(
        `cinema embed: single row rejected by the embedder (content/too-long) — skipping (text starts: "${texts[0].slice(0, 60).replace(/\s+/g, " ")}…")`,
      );
      return [null];
    }
    const mid = Math.floor(texts.length / 2);
    const [left, right] = await Promise.all([
      embedWithSplit(client, texts.slice(0, mid)),
      embedWithSplit(client, texts.slice(mid)),
    ]);
    return [...left, ...right];
  }
}

/**
 * Pull a batch of titles missing an embedding for the current model, embed
 * them, write nodes+vectors to Neo4j, and stamp `embedded_at` in SQLite.
 *
 * Designed to be called repeatedly (cron tick or interactive). One call =
 * one batch — caller decides cadence.
 */
export async function embedPending(
  service: CinemaService,
  client: EmbeddingsClient,
  graph: GraphDriver | null,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<EmbedBatchResult> {
  const t0 = Date.now();
  const ids = service.pendingEmbeddingIds(client.model, client.dim, batchSize);
  if (ids.length === 0) {
    return { attempted: 0, embedded: 0, graphWrites: 0, skippedTooLong: 0, durationMs: Date.now() - t0 };
  }

  const titles = ids
    .map((id) => service.getByIdentifier(id))
    .filter((t): t is CinemaTitle => t !== null);
  if (titles.length === 0) {
    return { attempted: 0, embedded: 0, graphWrites: 0, skippedTooLong: 0, durationMs: Date.now() - t0 };
  }

  const texts = titles.map(buildTextProfile);
  const vectors = await embedWithSplit(client, texts);
  if (vectors.length !== titles.length) {
    throw new Error(`embed length mismatch: ${vectors.length} vs ${titles.length}`);
  }
  const skippedTooLong = vectors.filter((v) => v === null).length;

  let graphWrites = 0;
  if (graph?.capabilities.cypher) {
    await ensureCinemaVectorIndex(graph, client);
    const updates = titles
      .map((t, i) => ({
        identifier: t.identifier,
        title: t.title,
        year: t.year,
        has_torrent: t.has_torrent,
        embedding: vectors[i],
      }))
      .filter((u): u is typeof u & { embedding: number[] } => u.embedding !== null);
    if (updates.length > 0) {
      await graph.run(
        `
        UNWIND $updates AS u
        MERGE (c:${CINEMA_LABEL} {identifier: u.identifier})
        SET c.title = u.title,
            c.year = u.year,
            c.has_torrent = u.has_torrent,
            c.embedding = u.embedding,
            c.updated_at = timestamp()
        `,
        { updates },
      );
    }
    graphWrites = updates.length;
  }

  // Mark every row as embedded — including the ones we skipped — so the
  // next pass doesn't keep re-picking the same hopelessly-long row. The
  // marking is keyed by (model, dim); a future model swap re-attempts.
  for (const t of titles) {
    service.markEmbedded(t.identifier, client.model, client.dim);
  }

  const embedded = vectors.filter((v) => v !== null).length;
  return {
    attempted: titles.length,
    embedded,
    graphWrites,
    skippedTooLong,
    durationMs: Date.now() - t0,
  };
}

export interface SemanticSearchHit {
  identifier: string;
  title: string;
  year: number;
  has_torrent: boolean;
  score: number;
  /** Where this hit came from in hybrid mode. Helps the UI render a tiny
   *  badge ("kw" vs "sem") so the user understands why a result was
   *  picked. Always "semantic" for the pure semantic path. */
  source?: "fts" | "semantic" | "hybrid";
}

/**
 * Semantic search via Neo4j's vector index. Throws if Neo4j is down — the
 * caller should fall back to the SQLite LIKE-search if it cares about
 * graceful degradation. We don't paper over it because returning random
 * keyword hits as if they were "semantic" misleads the UI.
 */
export async function searchSimilar(
  client: EmbeddingsClient,
  graph: GraphDriver | null,
  query: string,
  k: number = 20,
): Promise<SemanticSearchHit[]> {
  if (!graph?.capabilities.cypher) {
    throw new Error("semantic search requires an active graph driver with cypher support — activate Neo4j in /extensions");
  }
  if (!query.trim()) return [];
  // Asymmetric encoders (NVIDIA NIM, BGE-retrieval, E5) need the query
  // prefix at search time — without it the vector lives in the "document"
  // half of the embedding space and cosine drops sharply. Symmetric
  // backends ignore the hint.
  const [vector] = await client.embed([query], { inputType: "query" });
  const indexName = indexNameFor(client);
  const result = await graph.run(
    `
    CALL db.index.vector.queryNodes($indexName, $k, $vector)
    YIELD node, score
    WHERE '${CINEMA_LABEL}' IN labels(node)
    RETURN node.identifier AS identifier,
           node.title AS title,
           node.year AS year,
           node.has_torrent AS has_torrent,
           score
    ORDER BY score DESC
    `,
    { indexName, k: Math.max(1, k), vector },
  );
  return result.records.map((r) => ({
    identifier: r.get("identifier") as string,
    title: (r.get("title") as string) ?? "",
    year: Number(r.get("year") ?? 0),
    has_torrent: Boolean(r.get("has_torrent")),
    score: Number(r.get("score") ?? 0),
    source: "semantic" as const,
  }));
}

/**
 * Hybrid search — runs FTS5 and semantic in parallel, then fuses the
 * two ranked lists with Reciprocal Rank Fusion.
 *
 * Why RRF: the absolute scores from FTS5 (negative bm25, lower better)
 * and Neo4j vector cosine (positive, higher better) live on totally
 * different scales. Normalizing them is fragile. RRF only uses RANKS:
 * for each candidate doc d,  score(d) = sum over lists L of 1/(k + rank_L(d)).
 * k=60 is the standard constant from the original RRF paper.
 *
 * Result: docs that show up high in BOTH lists win. Docs that only
 * appear in one list still rank decently when their rank is good. This
 * fixes the "ALF" failure mode of pure semantic — FTS5 finds the
 * literal token instantly, semantic adds related items, and the fusion
 * surfaces the exact-name match without burying conceptual matches.
 */
const RRF_K = 60;

export async function hybridSearch(
  client: EmbeddingsClient,
  graph: GraphDriver | null,
  service: { fullTextSearch: (q: string, limit: number) => string[] },
  query: string,
  k: number = 20,
): Promise<SemanticSearchHit[]> {
  if (!query.trim()) return [];

  // Fetch both lists in parallel. We pull a wider window (k*3) from each
  // so the fusion has enough overlap to surface jointly-good docs even
  // when one engine ranks them mid-list.
  const wideK = Math.max(50, k * 3);
  const semanticPromise: Promise<SemanticSearchHit[]> = graph?.capabilities.cypher
    ? searchSimilar(client, graph, query, wideK).catch((err) => {
        log.warn(`hybrid: semantic leg failed — ${err instanceof Error ? err.message : err}`);
        return [];
      })
    : Promise.resolve([]);
  const ftsIds = service.fullTextSearch(query, wideK);
  const semantic = await semanticPromise;

  // Build per-engine rank maps. rank starts at 1.
  const ftsRank = new Map<string, number>();
  ftsIds.forEach((id, i) => ftsRank.set(id, i + 1));
  const semRank = new Map<string, number>();
  semantic.forEach((hit, i) => semRank.set(hit.identifier, i + 1));
  const semHitMap = new Map(semantic.map((h) => [h.identifier, h]));

  // Union of all candidate identifiers seen by either engine.
  const candidates = new Set<string>([...ftsRank.keys(), ...semRank.keys()]);
  const fused: SemanticSearchHit[] = [];
  for (const id of candidates) {
    const fr = ftsRank.get(id);
    const sr = semRank.get(id);
    let score = 0;
    if (fr !== undefined) score += 1 / (RRF_K + fr);
    if (sr !== undefined) score += 1 / (RRF_K + sr);
    const semHit = semHitMap.get(id);
    fused.push({
      identifier: id,
      // The semantic leg already gives us title/year/has_torrent; if the
      // doc came only from FTS, the caller hydrates from SQLite by
      // identifier — leaving these defaulted is fine.
      title: semHit?.title ?? "",
      year: semHit?.year ?? 0,
      has_torrent: semHit?.has_torrent ?? true,
      score,
      source: fr !== undefined && sr !== undefined ? "hybrid"
              : fr !== undefined ? "fts"
              : "semantic",
    });
  }

  fused.sort((a, b) => b.score - a.score);
  return fused.slice(0, k);
}
