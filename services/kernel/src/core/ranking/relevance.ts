/**
 * Keyword-based relevance scoring. This is a pragmatic MVP for semantic recall:
 * no embeddings, no external service — just tokenization + overlap scoring.
 * When agents accumulate many memories/learnings/runs, this filters to what's
 * actually related to the current goal instead of the most recent.
 *
 * Upgrade path: swap extractKeywords / scoreRelevance for an embedding-based
 * impl without touching callers (same signatures).
 */

/** Common stopwords across English + Spanish (project uses both). */
const STOPWORDS = new Set([
  // English
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "from",
  "has", "have", "he", "her", "him", "his", "how", "i", "if", "in", "is", "it",
  "its", "my", "of", "on", "or", "our", "she", "so", "that", "the", "their",
  "them", "they", "this", "to", "was", "we", "were", "what", "when", "where",
  "which", "who", "why", "will", "with", "you", "your", "me", "us", "did",
  "does", "doing", "done", "can", "could", "would", "should", "shall",
  "may", "might", "must", "get", "got", "gets", "getting", "make", "made",
  // Spanish
  "el", "la", "los", "las", "un", "una", "unos", "unas", "y", "o", "pero",
  "de", "del", "al", "a", "en", "con", "por", "para", "que", "qué", "si",
  "no", "sí", "es", "son", "ser", "estar", "está", "están", "hay", "ha",
  "han", "haber", "he", "mi", "tu", "su", "sus", "mis", "tus", "me", "te",
  "se", "lo", "les", "le", "nos", "os", "este", "esta", "estos", "estas",
  "ese", "esa", "esos", "esas", "eso", "esto", "como", "cómo", "cuando",
  "cuándo", "donde", "dónde", "muy", "más", "menos", "bien", "mal",
  "qué", "cuál", "cuáles",
]);

/**
 * Extract meaningful keywords from text. Lowercases, strips punctuation,
 * filters short tokens and stopwords. Returns a Set for O(1) membership checks.
 */
export function extractKeywords(text: string, maxKeywords = 30): Set<string> {
  if (!text) return new Set();
  const tokens = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")         // strip accents (comparison helper)
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));

  // Deduplicate but preserve first-seen order so we can truncate to top-N "important"
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      keywords.push(t);
    }
    if (keywords.length >= maxKeywords) break;
  }
  return new Set(keywords);
}

/**
 * Compute a relevance score between a set of goal keywords and a candidate text.
 * Normalized 0-1 where higher = more relevant.
 */
export function scoreRelevance(goalKeywords: Set<string>, candidate: string): number {
  if (goalKeywords.size === 0 || !candidate) return 0;
  const candidateKeywords = extractKeywords(candidate, 100);
  let overlap = 0;
  for (const kw of goalKeywords) {
    if (candidateKeywords.has(kw)) overlap++;
  }
  return overlap / goalKeywords.size;
}

/**
 * Rank a list of items by relevance to a goal. Items with score 0 are kept
 * but deprioritized — falls back to original order (assumed recency-sorted).
 *
 * @param items    Candidate items
 * @param goal     Current goal text (source of keywords)
 * @param getText  Function that extracts the text to match from an item
 * @param limit    Max items to return
 * @param minScore Items below this score are treated as irrelevant (but still
 *                 used as fallback if not enough relevant items exist)
 */
export function rankByRelevance<T>(
  items: T[],
  goal: string,
  getText: (item: T) => string,
  limit: number,
  minScore = 0.05,
): T[] {
  if (items.length <= limit) return items;
  const goalKeywords = extractKeywords(goal);
  if (goalKeywords.size === 0) return items.slice(0, limit);

  const scored = items.map((item, idx) => ({
    item,
    score: scoreRelevance(goalKeywords, getText(item)),
    idx,
  }));

  // Split into relevant (score >= minScore) and irrelevant
  const relevant = scored.filter(s => s.score >= minScore);
  const irrelevant = scored.filter(s => s.score < minScore);

  // Sort relevant by score desc, then by original index (preserves recency tiebreaker)
  relevant.sort((a, b) => b.score - a.score || a.idx - b.idx);

  // If we have enough relevant items, return just those
  if (relevant.length >= limit) {
    return relevant.slice(0, limit).map(s => s.item);
  }

  // Otherwise fill the rest with irrelevant items in original order (recency)
  return [...relevant, ...irrelevant].slice(0, limit).map(s => s.item);
}

// ── Embedding-based ranking ─────────────────────────────────────
//
// Mirrors the lexical signature shape so swapping is mechanical at the
// call site. Same hybrid-scoring logic as scripts/demo-embedding-ranking.ts —
// tuned thresholds came from running that demo against the live fleet.

/** Encode a Float32 vector as a little-endian Float32Array BLOB. */
export function vectorToBlob(vec: number[]): Buffer {
  const arr = new Float32Array(vec);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Decode a Float32Array BLOB back to a number[]. */
export function blobToVector(blob: Buffer | Uint8Array | null | undefined): number[] | null {
  if (!blob || blob.byteLength === 0) return null;
  // The buffer may be unaligned (sqlite blob slice) — copy into a fresh
  // ArrayBuffer to guarantee Float32Array can read it.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  const f32 = new Float32Array(copy.buffer);
  return Array.from(f32);
}

/** Cosine similarity assuming a, b are already L2-normalised (the MiniLM
 *  pipeline emits normalised vectors when called with `normalize: true`). */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Rank items by hybrid (cosine, lexical) score against a goal vector.
 * Falls back to lexical-only for items whose embedding is null/missing —
 * lets us flip the flag on without backfilling first; older rows just
 * keep using the legacy ranking until the backfill catches up.
 *
 * @param items                 Candidate items + their stored embedding (may be null)
 * @param goalVector            Pre-computed embedding of the current goal
 * @param goalText              Original goal text — used for the lexical leg of the hybrid
 * @param getText               Extracts the text to match for the lexical leg
 * @param limit                 Max items to return
 * @param cosineWeight          Hybrid weight on cosine (lexical gets 1 - this)
 * @param minScore              Items below this hybrid score are deprioritised
 *                              (still used as fallback if not enough relevant exist)
 */
export function rankByEmbedding<T extends { embedding: number[] | null }>(
  items: T[],
  goalVector: number[],
  goalText: string,
  getText: (item: T) => string,
  limit: number,
  cosineWeight = 0.7,
  minScore = 0.30,
): T[] {
  if (items.length <= limit) return items;
  const w = Math.max(0, Math.min(1, cosineWeight));
  const goalKw = extractKeywords(goalText);

  const scored = items.map((item, idx) => {
    const lex = goalKw.size > 0 ? scoreRelevance(goalKw, getText(item)) : 0;
    // No embedding → fall back to lexical-only for THIS row. We keep it in the
    // pool so an old un-embedded but textually-relevant memory still surfaces.
    const cos = item.embedding ? cosineSim(goalVector, item.embedding) : lex;
    const score = item.embedding
      ? w * cos + (1 - w) * lex
      : lex;
    return { item, score, cos, lex, idx };
  });

  const relevant = scored.filter(s => s.score >= minScore);
  const irrelevant = scored.filter(s => s.score < minScore);
  // Score desc, ties broken by original index (recency-preserving).
  relevant.sort((a, b) => b.score - a.score || a.idx - b.idx);

  if (relevant.length >= limit) return relevant.slice(0, limit).map(s => s.item);
  return [...relevant, ...irrelevant].slice(0, limit).map(s => s.item);
}
