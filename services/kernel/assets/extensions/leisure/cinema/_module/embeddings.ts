/**
 * Cinema embeddings — turns rows in `cinema_titles` into vectors, stored in
 * SQLite and searched in-process (vector-store.ts).
 *
 * They used to live on `(:CinemaTitle)` nodes behind a graph vector index; an
 * embedded graph keeps everything in memory, and a catalogue this size grew
 * the kernel by gigabytes for what is only a nearest-neighbour lookup.
 * `migrateGraphVectors()` moves an older install's vectors out of the graph.
 *
 * Vectors are keyed by model, so changing the embedding model writes a fresh
 * set and never silently mixes incompatible vectors.
 */

import { log, type GraphDriver, type EmbeddingsClient, type SqliteDb, safeIndexSuffix } from "@kernl/extension-sdk";
import type { CinemaService } from "./service.js";
import type { CinemaTitle } from "./types.js";
import type { CinemaVectorStore } from "./vector-store.js";

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
 * Whether the whole catalogue may be embedded with this client. The in-process
 * MiniLM is the last-resort fallback when every real embedder is down: it
 * runs on the CPU (a 165k-title catalogue keeps every core busy for an hour)
 * and its vectors are replaced as soon as the configured model is back. Single
 * queries still use it; bulk work waits unless CINEMA_EMBED_LOCAL=1.
 */
export function bulkEmbeddingAllowed(client: EmbeddingsClient): boolean {
  return client.provider !== "local" || process.env.CINEMA_EMBED_LOCAL === "1";
}

export interface GraphVectorMigration {
  moved: number;
  stripped: number;
  indexesDropped: number;
  /** Titles marked embedded whose vector was nowhere to be found — queued again. */
  requeued: number;
}

const MIGRATED_KEY = "vectors_in_sqlite";

/**
 * One-time move of the vectors an older install wrote onto `(:CinemaTitle)`
 * nodes: copy them into the store (under the model `cinema_titles` recorded
 * for each title), strip them from the graph, drop the cinema vector indexes,
 * and queue again any title marked embedded whose vector was lost. The nodes
 * themselves stay — the catalogue projection hangs its edges on them.
 *
 * Runs only against a ready graph, so a server that is briefly down never
 * gets mistaken for "no vectors anywhere"; the next start tries again.
 */
export async function migrateGraphVectors(
  graph: GraphDriver | null,
  store: CinemaVectorStore,
  db: SqliteDb,
): Promise<GraphVectorMigration | null> {
  const done = db
    .prepare("SELECT value FROM cinema_graph_state WHERE key = ?")
    .get(MIGRATED_KEY) as { value: string } | undefined;
  if (done?.value === "1") return null;
  if (!graph?.capabilities.cypher) return null;

  const result: GraphVectorMigration = { moved: 0, stripped: 0, indexesDropped: 0, requeued: 0 };
  for (;;) {
    const page = await graph.run(
      `MATCH (c:${CINEMA_LABEL}) WHERE c.embedding IS NOT NULL
       RETURN c.identifier AS identifier, c.embedding AS embedding LIMIT 1000`,
    );
    if (page.records.length === 0) break;
    const ids = page.records.map((r) => String(r.get("identifier")));
    const meta = new Map<string, { model: string; dim: number }>();
    for (const row of db
      .prepare(
        `SELECT identifier, embedded_model AS model, embedded_dim AS dim FROM cinema_titles
          WHERE identifier IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as Array<{ identifier: string; model: string; dim: number }>) {
      meta.set(row.identifier, { model: row.model, dim: Number(row.dim) });
    }
    const byModel = new Map<string, Array<{ identifier: string; vector: number[] }>>();
    for (const r of page.records) {
      const identifier = String(r.get("identifier"));
      const raw = r.get("embedding");
      const m = meta.get(identifier);
      if (!m?.model || !Array.isArray(raw)) continue;
      const vector = raw.map(Number);
      if (vector.length !== m.dim) continue;
      const list = byModel.get(m.model) ?? [];
      list.push({ identifier, vector });
      byModel.set(m.model, list);
    }
    for (const [model, rows] of byModel) result.moved += store.put(rows, model);
    await graph.run(
      `UNWIND $ids AS id MATCH (c:${CINEMA_LABEL} {identifier: id}) REMOVE c.embedding`,
      { ids },
    );
    result.stripped += ids.length;
  }

  const indexes = await graph.run("SHOW INDEXES YIELD name RETURN name");
  for (const r of indexes.records) {
    const name = String(r.get("name"));
    if (!name.startsWith("cinema-embeddings-")) continue;
    await graph
      .run(`DROP INDEX \`${name.replace(/`/g, "")}\` IF EXISTS`)
      .then(() => { result.indexesDropped++; })
      .catch((err: unknown) => log.warn(`cinema: could not drop vector index ${name} — ${String(err)}`));
  }

  result.requeued = Number(
    db
      .prepare(
        `UPDATE cinema_titles SET embedded_at = NULL, embedded_model = '', embedded_dim = 0
          WHERE embedded_at IS NOT NULL AND embedded_model <> ''
            AND NOT EXISTS (SELECT 1 FROM cinema_embeddings e
                             WHERE e.identifier = cinema_titles.identifier
                               AND e.model = cinema_titles.embedded_model)`,
      )
      .run().changes,
  );
  db.prepare(
    "INSERT INTO cinema_graph_state (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
  ).run(MIGRATED_KEY);
  return result;
}

export interface EmbedBatchResult {
  attempted: number;
  embedded: number;
  /** Vectors written to the store. */
  stored: number;
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
 * them, store the vectors, and stamp `embedded_at`.
 *
 * Designed to be called repeatedly (cron tick or interactive). One call =
 * one batch — caller decides cadence.
 */
export async function embedPending(
  service: CinemaService,
  client: EmbeddingsClient,
  store: CinemaVectorStore,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<EmbedBatchResult> {
  const t0 = Date.now();
  const ids = service.pendingEmbeddingIds(client.model, client.dim, batchSize);
  if (ids.length === 0) {
    return { attempted: 0, embedded: 0, stored: 0, skippedTooLong: 0, durationMs: Date.now() - t0 };
  }

  const titles = ids
    .map((id) => service.getByIdentifier(id))
    .filter((t): t is CinemaTitle => t !== null);
  if (titles.length === 0) {
    return { attempted: 0, embedded: 0, stored: 0, skippedTooLong: 0, durationMs: Date.now() - t0 };
  }

  const texts = titles.map(buildTextProfile);
  const vectors = await embedWithSplit(client, texts);
  if (vectors.length !== titles.length) {
    throw new Error(`embed length mismatch: ${vectors.length} vs ${titles.length}`);
  }
  const skippedTooLong = vectors.filter((v) => v === null).length;

  const stored = store.put(
    titles
      .map((t, i) => ({ identifier: t.identifier, vector: vectors[i] }))
      .filter((u): u is { identifier: string; vector: number[] } => u.vector !== null),
    client.model,
  );

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
    stored,
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
 * Semantic search over the stored vectors. Titles come back hydrated from
 * `cinema_titles`; a title whose row is gone is dropped.
 */
export async function searchSimilar(
  client: EmbeddingsClient,
  store: CinemaVectorStore,
  service: Pick<CinemaService, "getByIdentifier">,
  query: string,
  k: number = 20,
): Promise<SemanticSearchHit[]> {
  if (!query.trim()) return [];
  // Asymmetric encoders (NVIDIA NIM, BGE-retrieval, E5) need the query
  // prefix at search time — without it the vector lives in the "document"
  // half of the embedding space and cosine drops sharply. Symmetric
  // backends ignore the hint.
  const [vector] = await client.embed([query], { inputType: "query" });
  const hits = store.search(vector, client.model, Math.max(1, k));
  const out: SemanticSearchHit[] = [];
  for (const h of hits) {
    const t = service.getByIdentifier(h.identifier);
    if (!t) continue;
    out.push({
      identifier: h.identifier,
      title: t.title ?? "",
      year: Number(t.year ?? 0),
      has_torrent: Boolean(t.has_torrent),
      score: h.score,
      source: "semantic",
    });
  }
  return out;
}

/**
 * Hybrid search — runs FTS5 and semantic in parallel, then fuses the
 * two ranked lists with Reciprocal Rank Fusion.
 *
 * Why RRF: the absolute scores from FTS5 (negative bm25, lower better)
 * and vector cosine (positive, higher better) live on totally
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
  store: CinemaVectorStore,
  service: Pick<CinemaService, "fullTextSearch" | "getByIdentifier">,
  query: string,
  k: number = 20,
): Promise<SemanticSearchHit[]> {
  if (!query.trim()) return [];

  // Fetch both lists in parallel. We pull a wider window (k*3) from each
  // so the fusion has enough overlap to surface jointly-good docs even
  // when one engine ranks them mid-list.
  const wideK = Math.max(50, k * 3);
  const semanticPromise: Promise<SemanticSearchHit[]> = searchSimilar(client, store, service, query, wideK).catch(
    (err) => {
      log.warn(`hybrid: semantic leg failed — ${err instanceof Error ? err.message : err}`);
      return [];
    },
  );
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
