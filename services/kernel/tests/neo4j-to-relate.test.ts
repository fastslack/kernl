import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import neo4j from "neo4j-driver";
import { writeFileSync } from "node:fs";
import { runNeo4jImportChild, mergeGraphOnlyFromNeo4j, connectNeo4j, estimateRelateBytes, averagePrintedChars, RELATE_BYTES, type Neo4jSource } from "../src/core/db-drivers/builtins/neo4j-to-relate.js";

// The estimate used to print the maps in Cypher (toString(properties(n))): Relate
// accepts it, Neo4j 5.22 refuses it, and the rehearsal against production's
// Neo4j failed right there. The maps are measured in the client now.
describe("measuring property maps for the size estimate", () => {
  it("counts what the values hold, however the driver boxes them", () => {
    const int = neo4j.int(42);
    const dt = new neo4j.types.DateTime(2026, 11, 12, 14, 50, 0, 0, 0);
    expect(averagePrintedChars([])).toBe(0);
    expect(averagePrintedChars([{ a: 42 }, { a: int }])).toBe(JSON.stringify({ a: 42 }).length);
    expect(averagePrintedChars([{ at: dt }])).toBe(JSON.stringify({ at: dt.toString() }).length);
    expect(averagePrintedChars([{ e: [0.1, 0.2] }, null])).toBe((JSON.stringify({ e: [0.1, 0.2] }).length + 2) / 2);
  });
});
import { relateClientInstalled, RelateGraphDriver } from "../src/core/db-drivers/builtins/relate-graph-driver.js";

// The 0.5.0 upgrade of a Neo4j install: the whole graph moves, types intact.
// Needs a Neo4j to read from; skipped without one:
//   docker run -d --rm --name relate-bench-neo4j -p 127.0.0.1:27687:7687 \
//     -e NEO4J_AUTH=neo4j/bench-password-1 neo4j:5.22.0
//   KERNL_TEST_NEO4J=bolt://127.0.0.1:27687 bun test tests/neo4j-to-relate.test.ts
const URI = process.env.KERNL_TEST_NEO4J ?? "";
const src: Neo4jSource = { uri: URI, user: "neo4j", password: process.env.KERNL_TEST_NEO4J_PASSWORD ?? "bench-password-1" };

async function seedNeo4j() {
  const d = await connectNeo4j(src);
  const s = d.session();
  await s.run("MATCH (n) DETACH DELETE n");
  await s.run(`
    CREATE (l:Person {id: 'p1', name: 'Lucía Ferreyra', lastInteraction: datetime('2026-11-12T14:50:00Z'),
                      born: date('1990-04-02'), office: point({latitude: -34.58, longitude: -58.43}), score: 9007199254740993})
    CREATE (b:Person {id: 'p2', name: 'Bruno'})
    CREATE (l)-[:KNOWS {type: 'colleague', since: date('2025-01-10')}]->(b)
    CREATE (e:Episode {id: 'e1', summary: 'Talked about trucks', embedding: [0.1, 0.2, 0.3], message_count: 4})
    CREATE (m:Memory {id: 'm1', content: 'Lucía prefers Thursdays', strength: 0.82, reinforcements: 3,
                      last_recalled_at: datetime('2026-11-01T09:00:00Z'), ttl: duration('P30D')})
    CREATE (c:Concept {label_lower: 'route planning', label: 'Route planning', gravity: 4.5, mention_count: 7})
    CREATE (a:Article {link: 'https://example.com/a', title: 'Trucks', published: localdatetime('2026-10-01T08:00:00')})
    CREATE (e)-[:HAS_MEMORY]->(m), (m)-[:EXPRESSES]->(c), (m)-[:MENTIONS]->(l)
    CREATE (t:CinemaTitle {id: 'ct1', title: 'Nueve reinas', embedding: [0.5, 0.25, 0.125, 0.0625]})
  `);
  await s.run("CREATE CONSTRAINT person_id IF NOT EXISTS FOR (p:Person) REQUIRE p.id IS UNIQUE");
  await s.close();
  await d.close();
}

describe.skipIf(!URI || !relateClientInstalled())("Neo4j to Relate", () => {
  const drivers: RelateGraphDriver[] = [];
  afterAll(async () => { for (const d of drivers) await d.stop(); });

  it("copies every node and relationship, with temporal, point, big-integer and list values", async () => {
    await seedNeo4j();
    const dir = mkdtempSync(join(tmpdir(), "kernl-n2r-"));
    const to = join(dir, "graph");
    // As the kernel runs it: in a child, since the client cannot close the store it wrote.
    const entry = join(dir, "task.ts");
    writeFileSync(entry, `const m = await import(${JSON.stringify(join(import.meta.dir, "../src/core/db-drivers/builtins/neo4j-to-relate.ts"))}); await m.runNeo4jImportTask();\n`);
    const summary = await runNeo4jImportChild(src, to, { entry });
    expect(summary).toStartWith("7 nodes, 4 relationships");

    const g = new RelateGraphDriver();
    g.configure({ path: to });
    await g.start();
    drivers.push(g);
    const one = async (q: string) => (await g.run(q)).records[0];
    const p = await one(`MATCH (p:Person {id: 'p1'}) RETURN p.name AS name, valueType(p.lastInteraction) AS lt,
      p.lastInteraction AS li, valueType(p.born) AS bt, valueType(p.office) AS ot, p.office.latitude AS lat, p.score AS score`);
    expect(p.get("name")).toBe("Lucía Ferreyra");
    expect(String(p.get("lt"))).toStartWith("ZONED DATETIME");
    expect(p.get("li")).toBe("2026-11-12T14:50:00.000Z");
    expect(String(p.get("bt"))).toStartWith("DATE");
    expect(String(p.get("ot"))).toStartWith("POINT");
    expect(Number(p.get("lat"))).toBeCloseTo(-34.58, 5);
    expect(Number(p.get("score"))).toBe(9007199254740992); // past 2^53 a double rounds, as JSON would

    const m = await one(`MATCH (e:Episode {id: 'e1'})-[:HAS_MEMORY]->(m:Memory)-[:EXPRESSES]->(c:Concept)
      RETURN m.strength AS s, m.reinforcements AS n, valueType(m.ttl) AS ttl, c.gravity AS g, size(e.embedding) AS dims`);
    expect(Number(m.get("s"))).toBeCloseTo(0.82, 6);
    expect(Number(m.get("n"))).toBe(3);
    expect(String(m.get("ttl"))).toStartWith("DURATION");
    expect(Number(m.get("g"))).toBeCloseTo(4.5, 6);
    expect(Number(m.get("dims"))).toBe(3);

    const k = await one("MATCH (:Person {id: 'p1'})-[k:KNOWS]->(:Person {id: 'p2'}) RETURN k.type AS t, valueType(k.since) AS st");
    expect(k.get("t")).toBe("colleague");
    expect(String(k.get("st"))).toStartWith("DATE");

    const a = await one("MATCH (a:Article) RETURN valueType(a.published) AS t, count(*) AS c");
    expect(String(a.get("t"))).toStartWith("LOCAL DATETIME");
    const left = await one("MATCH (n:__KernlImport) RETURN count(n) AS c");
    expect(Number(left.get("c"))).toBe(0);
  }, 60_000);

  it("estimates the graph's size in Relate from Neo4j's counts and a sample of its properties", async () => {
    await seedNeo4j();
    const e = await estimateRelateBytes(src);
    expect(e.nodes).toBeGreaterThan(0);
    expect(e.relationships).toBeGreaterThan(0);
    expect(e.bytes).toBeGreaterThanOrEqual(e.nodes * RELATE_BYTES.node + e.relationships * RELATE_BYTES.rel);
  }, 30_000);

  it("merges what lives only in the graph into a store rebuilt from SQLite, and again without duplicating", async () => {
    await seedNeo4j();
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    drivers.push(g);
    // What the backfills would have rebuilt: the people, not their KNOWS edge.
    await g.run("CREATE (:Person {id: 'p1', name: 'Lucía Ferreyra'}), (:Person {id: 'p2', name: 'Bruno'})");
    const run = (q: string, p?: Record<string, unknown>) => g.run(q, p);
    await mergeGraphOnlyFromNeo4j(src, run);
    await mergeGraphOnlyFromNeo4j(src, run);
    const r = (await g.run(`
      MATCH (m:Memory) WITH count(m) AS memories
      MATCH (c:Concept) WITH memories, count(c) AS concepts
      MATCH (:Person {id: 'p1'})-[k:KNOWS]->(:Person {id: 'p2'}) WITH memories, concepts, count(k) AS knows
      MATCH (:Memory {id: 'm1'})-[x:MENTIONS]->(:Person {id: 'p1'})
      RETURN memories, concepts, knows, count(x) AS mentions`)).records[0];
    expect(Number(r.get("memories"))).toBe(1);
    expect(Number(r.get("concepts"))).toBe(1);
    expect(Number(r.get("knows"))).toBe(1);
    expect(Number(r.get("mentions"))).toBe(1);
  }, 60_000);
});

// Keep the import of the driver namespace used even when the suite is skipped.
void neo4j;
