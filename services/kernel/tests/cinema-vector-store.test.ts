import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CinemaVectorStore } from "../assets/extensions/leisure/cinema/_module/vector-store.js";
import { migrateGraphVectors, bulkEmbeddingAllowed } from "../assets/extensions/leisure/cinema/_module/embeddings.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";

const DIM = 384;
const MODEL = "Xenova/all-MiniLM-L6-v2";

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
}
function unit(seed: number): number[] {
  const r = rng(seed);
  const v = Array.from({ length: DIM }, r);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
function cos(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

describe("CinemaVectorStore", () => {
  let store: CinemaVectorStore;
  const vecs = new Map<string, number[]>();

  beforeEach(() => {
    store = new CinemaVectorStore(new Database(":memory:") as never);
    vecs.clear();
    for (let i = 0; i < 2000; i++) vecs.set(`t${i}`, unit(i + 1));
    store.put([...vecs].map(([identifier, vector]) => ({ identifier, vector })), MODEL);
  });

  it("stores and reads back vectors per model", () => {
    expect(store.count(MODEL)).toBe(2000);
    expect(store.count("other-model")).toBe(0);
    const got = store.get(["t5", "missing"], MODEL);
    expect(got.has("missing")).toBe(false);
    expect(cos(got.get("t5")!, vecs.get("t5")!)).toBeCloseTo(1, 5);
  });

  it("returns the same top hits as an exact scan", () => {
    const q = unit(424242);
    const exact = [...vecs]
      .map(([id, v]) => ({ id, s: cos(v, q) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 10)
      .map((x) => x.id);
    const hits = store.search(q, MODEL, 10);
    expect(hits.map((h) => h.identifier)).toEqual(exact);
    // Scores keep the graph index's 0–1 scale.
    expect(hits[0].score).toBeCloseTo((1 + cos(vecs.get(exact[0])!, q)) / 2, 5);
  });

  it("finds a title from a vector close to it, and honours exclusions", () => {
    const near = vecs.get("t77")!.map((x, i) => x + 0.01 * Math.sin(i));
    expect(store.search(near, MODEL, 1)[0].identifier).toBe("t77");
    expect(store.search(near, MODEL, 3, new Set(["t77"])).map((h) => h.identifier)).not.toContain("t77");
  });

  it("sees vectors written after the index was loaded", () => {
    store.search(unit(1), MODEL, 1); // loads the int8 index
    expect(store.loaded).toBe(true);
    const fresh = unit(999_999);
    store.put([{ identifier: "fresh", vector: fresh }], MODEL);
    expect(store.search(fresh, MODEL, 1)[0].identifier).toBe("fresh");
  });

  it("is empty for a model with no vectors", () => {
    expect(store.search(unit(3), "other-model", 5)).toEqual([]);
  });

  it("releases the index on demand", () => {
    store.search(unit(1), MODEL, 1);
    store.unload();
    expect(store.loaded).toBe(false);
    expect(store.search(vecs.get("t9")!, MODEL, 1)[0].identifier).toBe("t9");
  });
});

describe("bulk embedding policy", () => {
  it("keeps the CPU fallback out of catalogue-wide work unless asked", () => {
    const prev = process.env.CINEMA_EMBED_LOCAL;
    delete process.env.CINEMA_EMBED_LOCAL;
    const local = { provider: "local" } as never;
    expect(bulkEmbeddingAllowed(local)).toBe(false);
    expect(bulkEmbeddingAllowed({ provider: "lmstudio" } as never)).toBe(true);
    process.env.CINEMA_EMBED_LOCAL = "1";
    expect(bulkEmbeddingAllowed(local)).toBe(true);
    if (prev === undefined) delete process.env.CINEMA_EMBED_LOCAL;
    else process.env.CINEMA_EMBED_LOCAL = prev;
  });
});

describe.skipIf(!relateClientInstalled())("moving vectors out of the graph (Relate)", () => {
  it("copies node vectors into SQLite, strips the graph, and requeues lost ones", async () => {
    const db = new Database(":memory:");
    runMigrations(db as never, "cinema", cinemaMigrations);
    const now = "2026-11-11T10:00:00Z";
    const insert = db.prepare(
      `INSERT INTO cinema_titles (identifier, title, has_torrent, embedded_at, embedded_model, embedded_dim, ingested_at, last_seen_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    );
    insert.run("a", "A", now, MODEL, DIM, now, now);
    insert.run("b", "B", now, MODEL, DIM, now, now);
    insert.run("lost", "Lost", now, MODEL, DIM, now, now);

    const graph = new RelateGraphDriver();
    graph.configure({ path: ":memory:" });
    await graph.start();
    await graph.run(
      "CREATE VECTOR INDEX `cinema-embeddings-xenova-all-minilm-l6-v2` IF NOT EXISTS FOR (c:CinemaTitle) ON (c.embedding) OPTIONS { indexConfig: { `vector.dimensions`: 384, `vector.similarity_function`: 'cosine' }}",
    );
    await graph.run(
      "UNWIND $rows AS r CREATE (:CinemaTitle {identifier: r.id, embedding: r.v})",
      { rows: [{ id: "a", v: unit(1) }, { id: "b", v: unit(2) }] },
    );

    const store = new CinemaVectorStore(db as never);
    const r = await migrateGraphVectors(graph, store, db as never);
    expect(r).toEqual({ moved: 2, stripped: 2, indexesDropped: 1, requeued: 1 });

    expect(store.count(MODEL)).toBe(2);
    expect(store.search(unit(1), MODEL, 1)[0].identifier).toBe("a");
    const left = await graph.run("MATCH (c:CinemaTitle) WHERE c.embedding IS NOT NULL RETURN count(c) AS n");
    expect(Number(left.records[0].get("n"))).toBe(0);
    const nodes = await graph.run("MATCH (c:CinemaTitle) RETURN count(c) AS n");
    expect(Number(nodes.records[0].get("n"))).toBe(2);
    const lost = db.prepare("SELECT embedded_at FROM cinema_titles WHERE identifier = 'lost'").get() as { embedded_at: string | null };
    expect(lost.embedded_at).toBeNull();

    // Once only.
    expect(await migrateGraphVectors(graph, store, db as never)).toBeNull();
  });
});
