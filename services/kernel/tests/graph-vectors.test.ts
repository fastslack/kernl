import { describe, it, expect, afterEach } from "bun:test";
import type { GraphDriver } from "../src/core/db-drivers/graph-driver.js";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { asVector, ensureVectorIndex, fulltextSearchClause, runVectorSearch, vectorSearchClause } from "../src/sdk/graph-vectors.js";
import { KnowledgeService } from "../src/modules/chat/knowledge-service.js";

/** The same engine, made to answer as one without VECTOR values or SEARCH (Neo4j 5). */
function withoutSearch(d: GraphDriver): GraphDriver {
  return new Proxy(d, {
    get(t, k) {
      if (k === "capabilities") return { ...t.capabilities, vectorSearch: false };
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

const DIM = 4;
const unit = (...xs: number[]) => xs;

describe("vector clauses for an engine without SEARCH", () => {
  const plain = { capabilities: { cypher: true, vectorSimilarity: true } } as unknown as GraphDriver;

  it("store lists and query through queryNodes, filtering afterwards", () => {
    expect(asVector(plain, "$e")).toBe("$e");
    expect(
      vectorSearchClause(plain, {
        index: "memory-embeddings", label: "Memory", alias: "m", k: "$k", vector: "$v",
        filters: { module: "'chat'" }, where: "m.x > 1",
      }),
    ).toBe("CALL db.index.vector.queryNodes('memory-embeddings', $k, $v) YIELD node AS m, score WHERE m.`module` = 'chat' AND (m.x > 1)");
  });
});

describe.skipIf(!relateClientInstalled())("vectors on the built-in graph", () => {
  const drivers: RelateGraphDriver[] = [];
  afterEach(async () => {
    for (const d of drivers.splice(0)) await d.stop();
  });
  async function start(): Promise<RelateGraphDriver> {
    const d = new RelateGraphDriver();
    d.configure({ path: ":memory:" });
    await d.start();
    drivers.push(d);
    return d;
  }
  const count = async (g: GraphDriver, q: string) => Number((await g.run(q)).records[0].get("c"));

  it("advertises SEARCH and stores embeddings as FLOAT32 vectors, read back as lists", async () => {
    const g = await start();
    expect(g.capabilities.vectorSearch).toBe(true);
    await g.run(`CREATE (:Doc {id: 1, embedding: ${asVector(g, "$e")}}), (:Doc {id: 2, embedding: ${asVector(g, "$none")}}), (:Doc {id: 3, embedding: ${asVector(g, "$empty")}})`, {
      e: [0.5, 0.25, 0, 1],
      none: null,
      empty: [],
    });
    const r = await g.run("MATCH (d:Doc) RETURN d.id AS id, valueType(d.embedding) AS t, d.embedding AS e ORDER BY id");
    expect(String(r.records[0].get("t"))).toStartWith("VECTOR<FLOAT32");
    expect(r.records[0].get("e")).toEqual([0.5, 0.25, 0, 1]);
    expect(r.records[1].get("e")).toBeNull();
    expect(r.records[2].get("e")).toBeNull();
  });

  it("turns list embeddings into vectors and rebuilds an index whose filters changed", async () => {
    const g = await start();
    await g.run("UNWIND range(1, 1200) AS i CREATE (:Note {id: i, kind: 'a', embedding: [1.0, toFloat(i), 0.0, 0.0]})");
    await g.run("CREATE (:Note {id: 0, kind: 'a', embedding: [1, 2, 3, 4]})");
    await ensureVectorIndex(withoutSearch(g), { name: "note-embeddings", label: "Note", dimensions: DIM });
    expect(await count(g, "MATCH (n:Note) WHERE n.embedding IS :: VECTOR RETURN count(n) AS c")).toBe(0);

    await ensureVectorIndex(g, { name: "note-embeddings", label: "Note", dimensions: DIM, filters: ["kind"] });
    expect(await count(g, "MATCH (n:Note) WHERE n.embedding IS :: VECTOR RETURN count(n) AS c")).toBe(1201);
    const idx = await g.run("SHOW VECTOR INDEXES YIELD name, properties WHERE name = 'note-embeddings' RETURN properties");
    expect(idx.records[0].get("properties")).toEqual(["embedding", "kind"]);

    // Twice is a no-op: same index, nothing left to convert.
    await ensureVectorIndex(g, { name: "note-embeddings", label: "Note", dimensions: DIM, filters: ["kind"] });
    const r = await g.run(
      `${vectorSearchClause(g, { index: "note-embeddings", label: "Note", alias: "n", k: "3", vector: "$v", filters: { kind: "'a'" } })} RETURN n.id AS id`,
      { v: unit(1, 0, 0, 0) },
    );
    expect(r.records.length).toBe(3);
  });

  it("finds the nearest matches of a filter, where filtering the nearest k found none", async () => {
    const g = await start();
    await ensureVectorIndex(g, { name: "doc-embeddings", label: "Doc", dimensions: DIM, filters: ["module"] });
    // Forty tasks right next to the query, three chats further away.
    await g.run(`UNWIND range(1, 40) AS i CREATE (:Doc {id: i, module: 'task', embedding: ${asVector(g, "[1.0, 0.01 * i, 0.0, 0.0]")}})`);
    await g.run(`UNWIND range(41, 43) AS i CREATE (:Doc {id: i, module: 'chat', embedding: ${asVector(g, "[0.7, 0.7, 0.0, 0.0]")}})`);
    const spec = { index: "doc-embeddings", label: "Doc", alias: "d", k: "$k", vector: "$v", filters: { module: "'chat'" } };
    const params = { k: 10, v: unit(1, 0, 0, 0) };

    const found = await g.run(`${vectorSearchClause(g, spec)} RETURN d.id AS id, score ORDER BY id`, params);
    expect(found.records.map((r) => Number(r.get("id")))).toEqual([41, 42, 43]);
    // Same 0–1 scale as queryNodes: cos 45° = 0.707 → (1 + 0.707) / 2.
    expect(Number(found.records[0].get("score"))).toBeCloseTo(0.8536, 3);

    const legacy = await g.run(`${vectorSearchClause(withoutSearch(g), spec)} RETURN d.id AS id`, params);
    expect(legacy.records.length).toBe(0);
  });

  it("an index without the filter property degrades to queryNodes instead of failing", async () => {
    const g = await start();
    await ensureVectorIndex(g, { name: "old-embeddings", label: "Old", dimensions: DIM });
    await g.run(`CREATE (:Old {id: 1, module: 'chat', embedding: ${asVector(g, "$e")}})`, { e: unit(1, 0, 0, 0) });
    const spec = { index: "old-embeddings", label: "Old", alias: "o", k: "5", vector: "$v", filters: { module: "'chat'" } };
    await expect(g.run(`${vectorSearchClause(g, spec)} RETURN o.id AS id`, { v: unit(1, 0, 0, 0) })).rejects.toThrow(/WrongPropertyForVectorSearchFilter/);
    const r = await runVectorSearch(g, spec, (c) => `${c} RETURN o.id AS id`, { v: unit(1, 0, 0, 0) });
    expect(r.records.map((x) => Number(x.get("id")))).toEqual([1]);
  });

  it("chat memories are stored as vectors and searched through SEARCH", async () => {
    const g = await start();
    const ks = new KnowledgeService(() => g);
    const near = (i: number) => [1, 0.001 * i, 0, 0, ...Array(380).fill(0)];
    for (let i = 0; i < 40; i++) {
      await ks.createMemoryNode({ id: `cur-${i}`, episode_id: "current", role: "user", content: `now ${i}`, embedding: near(i), created_at: "2026-11-12T10:00:00Z" });
    }
    await ks.createMemoryNode({ id: "old", episode_id: "last-week", role: "user", content: "the earlier talk", embedding: [0.8, 0.6, 0, 0, ...Array(380).fill(0)], created_at: "2026-11-05T10:00:00Z" });

    expect(await count(g, "MATCH (m:Memory) WHERE m.embedding IS :: VECTOR RETURN count(m) AS c")).toBe(41);
    const all = await ks.findSimilarMemories(near(0), 5);
    expect(all.map((m) => m.episode_id)).toEqual(Array(5).fill("current"));
    // Excluding the current episode still applies after the k nearest are taken.
    const other = await ks.findSimilarMemories(near(0), 50, "current");
    expect(other.map((m) => m.id)).toEqual(["old"]);
  });
});

// Full text: Relate deprecates db.index.fulltext.queryNodes for its SEARCH
// clause (its planner says so); Neo4j keeps the procedure.
describe("full-text clauses", () => {
  const neo4j = { capabilities: { cypher: true, vectorSimilarity: true } } as unknown as GraphDriver;
  const relate = { capabilities: { cypher: true, vectorSimilarity: true, fulltextSearch: true } } as unknown as GraphDriver;

  it("use the procedure where the engine has no SEARCH, the clause where it has", () => {
    expect(fulltextSearchClause(neo4j, { alias: "n", index: "kernl_entity_text", query: "$q", k: 20 }))
      .toBe("CALL db.index.fulltext.queryNodes('kernl_entity_text', $q) YIELD node AS n, score");
    expect(fulltextSearchClause(relate, { alias: "l", index: "agent-learning-text", label: "AgentLearning", query: "$t", k: 50 }))
      .toBe("MATCH (l:`AgentLearning`) SEARCH l IN (FULLTEXT INDEX `agent-learning-text` FOR $t LIMIT 50) SCORE AS score");
  });

  it.skipIf(!relateClientInstalled())("on Relate: the capability is found, SEARCH answers, and the planner has nothing to say against it", async () => {
    const d = new RelateGraphDriver();
    d.configure({ path: ":memory:" });
    await d.start();
    try {
      expect(d.capabilities.fulltextSearch).toBe(true);
      await d.run("CREATE FULLTEXT INDEX ft IF NOT EXISTS FOR (n:Person|Company) ON EACH [n.name]");
      await d.run("CREATE (:Person {name: 'Lucía Ferreyra'}), (:Company {name: 'Delta Norte'})");
      const clause = fulltextSearchClause(d, { alias: "n", index: "ft", query: "$q", k: 5 });
      const r = await d.run(`${clause} RETURN n.name AS name, score`, { q: "delta" });
      expect(r.records.map((x) => x.get("name"))).toEqual(["Delta Norte"]);
      const plan = await d.run(`EXPLAIN ${clause} RETURN n`, { q: "delta" });
      const notes = ((plan.summary as { notifications?: Array<{ code?: string }> }).notifications ?? []).map((x) => String(x.code));
      expect(notes.some((c) => /Deprecation/.test(c))).toBe(false);
    } finally {
      await d.stop();
    }
  });
});
