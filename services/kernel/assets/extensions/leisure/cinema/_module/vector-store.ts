/**
 * Cinema title vectors, kept in SQLite and searched in-process.
 *
 * They used to live on `(:CinemaTitle)` nodes behind a graph vector index.
 * That works on a Neo4j server; on an embedded graph that holds everything in
 * memory (Relate), a catalogue of ~165k titles × 384 floats grew the kernel
 * by gigabytes. Nothing about these vectors is a graph question — search is
 * "nearest k to this vector" — so they belong next to the rows they describe.
 *
 * Storage: `cinema_embeddings(identifier, model, dim, vector)`, one Float32
 * BLOB per (title, model). A model swap writes a new set beside the old one.
 *
 * Search: an int8 copy of every vector (1 byte per dimension, ~64 MB for 165k
 * × 384) is scanned with a dot product, the best few hundred are re-scored
 * against their exact Float32 vectors, and the top k come back. The int8 index
 * is built on the first search and dropped again after a quiet spell, so a
 * kernel nobody is browsing films on pays nothing for it. Vectors written
 * while it is loaded are kept in a small side buffer and scanned exactly.
 *
 * Scores are cosine on 0–1 (0.5 = orthogonal) — the scale the graph vector
 * index reported — so callers and the UI read them as before.
 */

import type { SqliteDb } from "@kernl/extension-sdk";

export interface VectorHit {
  identifier: string;
  score: number;
}

interface Int8Index {
  model: string;
  dim: number;
  ids: string[];
  codes: Int8Array;
  /** Per row: quantisation step ÷ vector norm, so code·q × scale ≈ cosine. */
  scales: Float32Array;
}

/** Re-score this many int8 candidates per requested hit against exact vectors. */
const RERANK_FACTOR = 8;
const RERANK_MIN = 200;
/** Fold the side buffer into the int8 index once it grows past this. */
const PENDING_REBUILD = 5_000;
/** Drop the int8 index after this long without a search. */
const IDLE_UNLOAD_MS = 10 * 60_000;

export function toBlob(v: ArrayLike<number>): Uint8Array {
  const f = Float32Array.from(v as ArrayLike<number>);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

export function fromBlob(b: Uint8Array | ArrayBuffer | null | undefined): Float32Array | null {
  if (!b) return null;
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
  // Copy: a SQLite blob can be unaligned for Float32Array.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

function norm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

/** Raw cosine (−1…1) → the 0…1 scale graph vector indexes report. */
const toUnit = (cos: number) => (1 + Math.max(-1, Math.min(1, cos))) / 2;

export class CinemaVectorStore {
  private index: Int8Index | null = null;
  /** Vectors written since the int8 index was built (identifier → unit vector). */
  private pending = new Map<string, Float32Array>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly db: SqliteDb) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cinema_embeddings (
        identifier TEXT NOT NULL,
        model      TEXT NOT NULL,
        dim        INTEGER NOT NULL,
        vector     BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (identifier, model)
      ) WITHOUT ROWID;
    `);
  }

  // ── Writes ─────────────────────────────────────────

  put(rows: Array<{ identifier: string; vector: ArrayLike<number> }>, model: string): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT INTO cinema_embeddings (identifier, model, dim, vector, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(identifier, model) DO UPDATE SET
         dim = excluded.dim, vector = excluded.vector, updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      for (const r of rows) stmt.run(r.identifier, model, r.vector.length, toBlob(r.vector), now);
    });
    tx();
    if (this.index && this.index.model === model) {
      for (const r of rows) {
        const n = norm(r.vector);
        if (n > 0) this.pending.set(r.identifier, Float32Array.from(r.vector, (x) => x / n));
      }
      if (this.pending.size > PENDING_REBUILD) this.unload();
    }
    return rows.length;
  }

  count(model: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM cinema_embeddings WHERE model = ?")
      .get(model) as { n: number };
    return r.n;
  }

  has(identifier: string, model: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM cinema_embeddings WHERE identifier = ? AND model = ?")
      .get(identifier, model);
  }

  // ── Reads ──────────────────────────────────────────

  get(identifiers: string[], model: string): Map<string, number[]> {
    const out = new Map<string, number[]>();
    const CHUNK = 500;
    for (let i = 0; i < identifiers.length; i += CHUNK) {
      const ids = identifiers.slice(i, i + CHUNK);
      const rows = this.db
        .prepare(
          `SELECT identifier, vector FROM cinema_embeddings
            WHERE model = ? AND identifier IN (${ids.map(() => "?").join(",")})`,
        )
        .all(model, ...ids) as Array<{ identifier: string; vector: Uint8Array }>;
      for (const r of rows) {
        const v = fromBlob(r.vector);
        if (v) out.set(r.identifier, Array.from(v));
      }
    }
    return out;
  }

  /**
   * The k titles nearest `vector`, best first, skipping `exclude`. Scores on
   * the 0–1 cosine scale. Empty when nothing is stored for `model`.
   */
  search(vector: ArrayLike<number>, model: string, k: number, exclude: Set<string> = new Set()): VectorHit[] {
    const qn = norm(vector);
    if (qn === 0 || k <= 0) return [];
    const q = Float32Array.from(vector, (x) => x / qn);
    const idx = this.load(model, q.length);
    this.touch();

    const want = Math.max(RERANK_MIN, (k + exclude.size) * RERANK_FACTOR);
    const candidates = new Map<string, number>();

    if (idx && idx.ids.length > 0) {
      const { codes, scales, ids, dim } = idx;
      const n = ids.length;
      // Bounded min-heap would be tidier; a threshold-pruned array is enough
      // at this size and keeps the hot loop branch-light.
      const top: Array<{ i: number; s: number }> = [];
      let floor = -Infinity;
      for (let r = 0; r < n; r++) {
        let dot = 0;
        const base = r * dim;
        for (let d = 0; d < dim; d++) dot += codes[base + d] * q[d];
        const s = dot * scales[r];
        if (top.length < want) {
          top.push({ i: r, s });
          if (top.length === want) floor = Math.min(...top.map((t) => t.s));
        } else if (s > floor) {
          let minAt = 0;
          for (let t = 1; t < top.length; t++) if (top[t].s < top[minAt].s) minAt = t;
          top[minAt] = { i: r, s };
          floor = Infinity;
          for (const t of top) if (t.s < floor) floor = t.s;
        }
      }
      for (const t of top) candidates.set(ids[t.i], t.s);
    }

    // Exact re-score of the int8 candidates, plus everything written since
    // the index was built.
    const exact = new Map<string, number>();
    for (const [id, v] of this.pending) exact.set(id, dotN(v, q));
    const toFetch = [...candidates.keys()].filter((id) => !exact.has(id) && !exclude.has(id));
    const stored = this.get(toFetch, model);
    for (const [id, v] of stored) {
      const n = norm(v);
      if (n > 0) exact.set(id, dotN(v, q) / n);
    }

    return [...exact.entries()]
      .filter(([id]) => !exclude.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([identifier, cos]) => ({ identifier, score: toUnit(cos) }));
  }

  // ── Int8 index lifecycle ───────────────────────────

  private load(model: string, dim: number): Int8Index | null {
    if (this.index && this.index.model === model && this.index.dim === dim) return this.index;
    this.unload();
    const n = (this.db
      .prepare("SELECT COUNT(*) AS n FROM cinema_embeddings WHERE model = ? AND dim = ?")
      .get(model, dim) as { n: number }).n;
    if (n === 0) return null;
    const ids: string[] = new Array(n);
    const codes = new Int8Array(n * dim);
    const scales = new Float32Array(n);
    let r = 0;
    const rows = this.db
      .prepare("SELECT identifier, vector FROM cinema_embeddings WHERE model = ? AND dim = ?")
      .iterate(model, dim) as Iterable<{ identifier: string; vector: Uint8Array }>;
    for (const row of rows) {
      if (r >= n) break;
      const v = fromBlob(row.vector);
      if (!v || v.length !== dim) continue;
      const vn = norm(v);
      let max = 0;
      for (let d = 0; d < dim; d++) max = Math.max(max, Math.abs(v[d]));
      if (vn === 0 || max === 0) continue;
      const step = max / 127;
      const base = r * dim;
      for (let d = 0; d < dim; d++) codes[base + d] = Math.round(v[d] / step);
      scales[r] = step / vn;
      ids[r] = row.identifier;
      r++;
    }
    this.index = {
      model,
      dim,
      ids: ids.slice(0, r),
      codes: r === n ? codes : codes.slice(0, r * dim),
      scales: r === n ? scales : scales.slice(0, r),
    };
    this.pending.clear();
    return this.index;
  }

  /** Release the int8 index (and the side buffer it complements). */
  unload(): void {
    this.index = null;
    this.pending.clear();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  get loaded(): boolean {
    return this.index !== null;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.unload(), IDLE_UNLOAD_MS);
    this.idleTimer.unref?.();
  }
}

function dotN(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** One store per database handle — the int8 index is shared by every caller. */
const stores = new WeakMap<object, CinemaVectorStore>();
export function cinemaVectorStore(db: SqliteDb): CinemaVectorStore {
  let s = stores.get(db as object);
  if (!s) {
    s = new CinemaVectorStore(db);
    stores.set(db as object, s);
  }
  return s;
}
