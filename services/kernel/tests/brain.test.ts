import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { brainMigrations } from "../src/modules/brain/migrations.js";
import { BrainService } from "../src/modules/brain/service.js";
import { BrainIndexer, textProfile, type BrainSource } from "../src/modules/brain/indexer.js";
import type { EmbeddingsClient } from "../src/core/embeddings/index.js";

/**
 * Deterministic mock embeddings: a tiny bag-of-words vector over a fixed
 * vocabulary, L2-normalised. Shared words → high cosine; disjoint words →
 * ~0. Lets us assert cross-module neighbourhood without a real model.
 */
const VOCAB = [
  "mudanza", "embalar", "inmobiliaria", "direccion", "dueño",
  "factura", "pago", "cliente", "reunion", "gimnasio",
  "proteina", "viaje", "vuelo", "hotel", "codigo", "bug",
];

const mockEmbeddings: EmbeddingsClient = {
  provider: "local",
  model: "mock",
  dim: VOCAB.length,
  async available() { return true; },
  async embed(texts) {
    return texts.map((t) => {
      const lower = t.toLowerCase();
      const v = VOCAB.map((w) => (lower.includes(w) ? 1 : 0));
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      return v.map((x) => x / norm);
    });
  },
};

let db: Database;
let svc: BrainService;

function seedSchema(d: Database) {
  d.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, tags TEXT, updated_at TEXT, deleted_at TEXT)",
  );
  d.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, body TEXT, tags TEXT, updated_at TEXT)");
  d.exec(
    "CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, company TEXT, relationship TEXT, notes TEXT, updated_at TEXT)",
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db, "brain", brainMigrations);
  svc = new BrainService(db, mockEmbeddings);
});

describe("brainMigrations", () => {
  test("runMigrations creates brain_items, brain_watermarks, brain_signals", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'brain_%'")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((t) => t.name));
    expect(names.has("brain_items")).toBe(true);
    expect(names.has("brain_watermarks")).toBe(true);
    expect(names.has("brain_signals")).toBe(true);
  });
});

afterEach(() => {
  db.close();
});

describe("textProfile", () => {
  test("joins non-empty columns and skips blanks/nulls", () => {
    const t = textProfile({ a: "Hola", b: "", c: null, d: "Mundo" }, ["a", "b", "c", "d"]);
    expect(t).toBe("Hola. Mundo");
  });
});

describe("BrainService.recall", () => {
  test("ranks an exact-topic item above an unrelated one", async () => {
    const [v1, v2] = await svc.embed(["mudanza embalar", "gimnasio proteina"]);
    svc.upsert({ kind: "task", sourceTable: "tasks", sourceId: "t1", text: "mudanza embalar", embedding: v1 });
    svc.upsert({ kind: "note", sourceTable: "notes", sourceId: "n1", text: "gimnasio proteina", embedding: v2 });

    const hits = await svc.recall({ query: "mudanza", minSimilarity: 0 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].item.source_id).toBe("t1");
  });

  test("kind filter restricts results", async () => {
    const [v] = await svc.embed(["mudanza"]);
    svc.upsert({ kind: "task", sourceTable: "tasks", sourceId: "t1", text: "mudanza", embedding: v });
    const onlyNotes = await svc.recall({ query: "mudanza", kinds: ["note"], minSimilarity: 0 });
    expect(onlyNotes).toHaveLength(0);
  });

  test("upsert preserves a learned weight on re-index", async () => {
    const [v] = await svc.embed(["mudanza"]);
    svc.upsert({ kind: "task", sourceTable: "tasks", sourceId: "t1", text: "mudanza", embedding: v });
    const before = await svc.recall({ query: "mudanza", minSimilarity: 0 });
    svc.reinforce(before[0].item.id, "correct"); // weight 1.0 -> 1.10
    // Re-index the same source row (new embedding/text); weight must survive.
    svc.upsert({ kind: "task", sourceTable: "tasks", sourceId: "t1", text: "mudanza ya", embedding: v });
    const after = await svc.recall({ query: "mudanza", minSimilarity: 0 });
    expect(after[0].item.weight).toBeCloseTo(1.1, 5);
  });
});

describe("BrainService.reinforce (autoaprendizaje)", () => {
  test("ignore demotes, open promotes — reorders ranking", async () => {
    const [v] = await svc.embed(["cliente factura"]);
    // Two items with identical embeddings → tie broken purely by weight.
    svc.upsert({ kind: "comm", sourceTable: "communications", sourceId: "c1", text: "cliente factura", embedding: v });
    svc.upsert({ kind: "task", sourceTable: "tasks", sourceId: "t1", text: "cliente factura", embedding: v });

    let hits = await svc.recall({ query: "cliente factura", minSimilarity: 0 });
    const first = hits[0].item.id;
    const second = hits[1].item.id;

    svc.reinforce(first, "ignore"); // 1.0 -> 0.85
    svc.reinforce(second, "open"); // 1.0 -> 1.08

    hits = await svc.recall({ query: "cliente factura", minSimilarity: 0 });
    expect(hits[0].item.id).toBe(second); // the reinforced one now wins
  });

  test("unknown signal is a no-op; weight clamps to ceiling", async () => {
    const [v] = await svc.embed(["bug codigo"]);
    svc.upsert({ kind: "task", sourceTable: "tasks", sourceId: "t1", text: "bug codigo", embedding: v });
    const id = (await svc.recall({ query: "bug", minSimilarity: 0 }))[0].item.id;
    expect(svc.reinforce(id, "nonsense")).toBeNull();
    for (let i = 0; i < 50; i++) svc.reinforce(id, "correct");
    const w = (await svc.recall({ query: "bug", minSimilarity: 0 }))[0].item.weight;
    expect(w).toBeLessThanOrEqual(3.0);
  });

  test("decayWeights pulls weights back toward baseline", async () => {
    const [v] = await svc.embed(["viaje vuelo"]);
    svc.upsert({ kind: "task", sourceTable: "tasks", sourceId: "t1", text: "viaje vuelo", embedding: v });
    const id = (await svc.recall({ query: "viaje", minSimilarity: 0 }))[0].item.id;
    svc.reinforce(id, "ignore"); // 0.85
    svc.decayWeights(0.5); // -> 0.85 + (1 - 0.85)*0.5 = 0.925
    const w = (await svc.recall({ query: "viaje", minSimilarity: 0 }))[0].item.weight;
    expect(w).toBeCloseTo(0.925, 5);
  });
});

describe("BrainService hybrid recall (paper Finding 8: dense + lexical)", () => {
  // "zorggle" is OUT of the mock VOCAB → its embedding is the zero vector →
  // cosine ≈ 0. But it's a real keyword, so the lexical leg scores it.
  test("hybrid rescues a lexically-exact, embedding-blind match", async () => {
    const [v] = await svc.embed(["zorggle proyecto secreto"]);
    svc.upsert({ kind: "note", sourceTable: "notes", sourceId: "n1", text: "zorggle proyecto secreto", embedding: v });

    const pureDense = await svc.recall({ query: "zorggle", minSimilarity: 0.25, hybrid: false });
    expect(pureDense).toHaveLength(0); // embedding can't see it

    const withHybrid = await svc.recall({ query: "zorggle", minSimilarity: 0.25, hybrid: true });
    expect(withHybrid).toHaveLength(1); // lexical rescue
    expect(withHybrid[0].item.source_id).toBe("n1");
  });

  test("hybrid promotes the lexical-and-semantic match over semantic-only", async () => {
    const [a, b] = await svc.embed(["mudanza embalar", "mudanza cajas"]);
    // Both share the vocab word 'mudanza' (equal cosine to query 'mudanza').
    svc.upsert({ kind: "task", sourceTable: "tasks", sourceId: "t1", text: "mudanza embalar", embedding: a });
    svc.upsert({ kind: "note", sourceTable: "notes", sourceId: "n1", text: "mudanza cajas", embedding: b });
    // Query shares the extra keyword 'embalar' with t1 → lexical tiebreak.
    const hits = await svc.recall({ query: "mudanza embalar", minSimilarity: 0, hybrid: true });
    expect(hits[0].item.source_id).toBe("t1");
  });

  test("hybrid:false reproduces pure-dense ranking", async () => {
    const [v] = await svc.embed(["zorggle"]);
    svc.upsert({ kind: "note", sourceTable: "notes", sourceId: "n1", text: "zorggle", embedding: v });
    const dense = await svc.recall({ query: "zorggle", minSimilarity: 0.25, hybrid: false });
    expect(dense).toHaveLength(0);
  });
});

describe("BrainIndexer (cross-module 'one' recall)", () => {
  test("backfills multiple tables and recall crosses modules", async () => {
    seedSchema(db);
    db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run(
      "t1", "Embalar la casa", "comprar cajas para la mudanza", "hogar", "2026-06-01T10:00:00Z", null,
    );
    db.prepare("INSERT INTO notes VALUES (?,?,?,?,?)").run(
      "n1", "Direccion nueva", "la direccion de la inmobiliaria", "mudanza", "2026-06-01T11:00:00Z",
    );
    db.prepare("INSERT INTO contacts VALUES (?,?,?,?,?,?)").run(
      "ct1", "Juan Dueño", "Inmobiliaria SA", "landlord", "dueño del depto", "2026-06-01T12:00:00Z",
    );

    const indexer = new BrainIndexer(db, svc);
    const res = await indexer.indexAll();
    expect(res.indexed).toBe(3);

    const hits = await svc.recall({ query: "mudanza inmobiliaria", minSimilarity: 0.01, limit: 5 });
    const kinds = new Set(hits.map((h) => h.item.kind));
    // The unified recall surfaces items from more than one module.
    expect(kinds.size).toBeGreaterThanOrEqual(2);
  });

  test("incremental: only rows past the watermark get re-indexed", async () => {
    seedSchema(db);
    db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("t1", "uno", "", "", "2026-06-01T10:00:00Z", null);
    const indexer = new BrainIndexer(db, svc);
    let res = await indexer.indexAll(["task"]);
    expect(res.indexed).toBe(1);

    // Second run with no new rows → nothing re-indexed.
    res = await indexer.indexAll(["task"]);
    expect(res.indexed).toBe(0);

    // Add a newer row → only it is indexed.
    db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("t2", "dos", "", "", "2026-06-02T10:00:00Z", null);
    res = await indexer.indexAll(["task"]);
    expect(res.indexed).toBe(1);
  });

  test("soft-deleted rows are removed from the index", async () => {
    seedSchema(db);
    db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run("t1", "borrame", "", "", "2026-06-01T10:00:00Z", null);
    const indexer = new BrainIndexer(db, svc);
    await indexer.indexAll(["task"]);
    expect(svc.stats().total).toBe(1);

    db.prepare("UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = 't1'").run(
      "2026-06-03T10:00:00Z", "2026-06-03T10:00:00Z",
    );
    const res = await indexer.indexAll(["task"]);
    expect(res.removed).toBe(1);
    expect(svc.stats().total).toBe(0);
  });

  test("missing tables are skipped gracefully", async () => {
    // No schema seeded at all → every source table is absent.
    const indexer = new BrainIndexer(db, svc);
    const res = await indexer.indexAll();
    expect(res.indexed).toBe(0);
  });

  test("a source with an extra/unknown text column still indexes known ones", async () => {
    db.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, updated_at TEXT)"); // no body/tags
    db.prepare("INSERT INTO notes VALUES (?,?,?)").run("n1", "viaje a hotel", "2026-06-01T10:00:00Z");
    const src: BrainSource[] = [
      { kind: "note", table: "notes", tsCol: "updated_at", textCols: ["title", "body", "tags"] },
    ];
    const indexer = new BrainIndexer(db, svc, src);
    const res = await indexer.indexAll();
    expect(res.indexed).toBe(1);
    const hits = await svc.recall({ query: "viaje hotel", minSimilarity: 0 });
    expect(hits[0].item.text).toBe("viaje a hotel");
  });
});
