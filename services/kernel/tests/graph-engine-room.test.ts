import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { engineTap, statementLabel } from "../src/core/graph-engine-tap.js";
import { EngineRoom } from "../src/modules/graph-query/engine.js";

describe("statement labels", () => {
  it("name a statement by its clauses, the procedure it calls and the label it reads", () => {
    expect(statementLabel("MATCH (p:Person {id: $id}) OPTIONAL MATCH (p)-[:WORKS_AT]->(c) RETURN p, c"))
      .toBe("MATCH · OPTIONAL MATCH · RETURN :Person");
    expect(statementLabel("CALL db.index.fulltext.queryNodes('x', $q) YIELD node RETURN node"))
      .toBe("CALL db.index.fulltext.queryNodes RETURN");
    expect(statementLabel("CREATE VECTOR INDEX x IF NOT EXISTS FOR (l:AgentLearning) ON (l.embedding)")).toBe("CREATE VECTOR INDEX :AgentLearning");
  });
});

// The engine room on the real engine: what Relate runs, what its planner says, how two things connect.
describe.skipIf(!relateClientInstalled())("the engine room on Relate", () => {
  let g: RelateGraphDriver;
  let room: EngineRoom;

  beforeEach(async () => {
    engineTap.reset();
    g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    room = new EngineRoom(() => g);
    await g.run(`CREATE (:Agent {id: 'b', name: 'Bruno'})-[:RAN]->(:AgentRun {id: 'r1'})-[:TOUCHED]->(:Person {id: 'l', name: 'Lucía Ferreyra'})-[:WORKS_AT]->(:Company {name: 'Delta Norte'})`);
  });
  afterEach(async () => { await g.stop(); });

  it("records every statement with the engine's time, reads and writes on their own lanes", async () => {
    await g.run("MATCH (p:Person) WHERE p.name = $n RETURN p.id", { n: "Lucía Ferreyra" });
    const snap = await room.snapshot(0);
    expect(snap.items.map((i) => i.write)).toEqual([true, false]);
    expect(snap.items[1].ms).toBeGreaterThan(0);
    expect(snap.stats.reads.count).toBe(1);
    expect(snap.stats.writes.count).toBe(1);
    expect((await room.snapshot(snap.lastSeq)).items).toEqual([]);
  });

  it("asks the planner about the reads it saw, and applies only the index it suggests", async () => {
    await g.run("MATCH (p:Person) WHERE p.name = $n RETURN p.id", { n: "x" });
    const [w] = await room.warnings(true);
    expect(w.code).toContain("MissingIndex");
    expect(w.remedy).toMatch(/^CREATE INDEX \w+ FOR \(n:Person\) ON \(n\.name\)$/);
    await expect(room.applyIndex("CREATE INDEX evil FOR (n:Person) ON (n.name)")).rejects.toThrow();
    await expect(room.applyIndex("MATCH (n) DETACH DELETE n")).rejects.toThrow();
    const done = await room.applyIndex(w.remedy);
    expect(done.applied).toBe(w.remedy);
    expect(await room.warnings(true)).toEqual([]);
    // The planner's own EXPLAIN passes are not recorded as kernel work.
    expect(engineTap.since(0).some((q) => q.label.includes("EXPLAIN"))).toBe(false);
  });

  it("does not report Relate's AllNodesScan false positive on a SEARCH that starts from its index", async () => {
    await g.run("CREATE FULLTEXT INDEX people IF NOT EXISTS FOR (n:Person) ON EACH [n.name]");
    await g.run("MATCH (n) SEARCH n IN (FULLTEXT INDEX people FOR $q LIMIT 5) SCORE AS score RETURN n.name", { q: "lucía" });
    expect((await room.warnings(true)).some((w) => w.code.includes("AllNodesScan"))).toBe(false);
  });

  it("profiles a recorded read again as a tree; never a write", async () => {
    await g.run("MATCH (a:Agent {id: $id})-[:RAN]->(r) RETURN r.id", { id: "b" });
    const read = engineTap.topStatements().find((s) => !s.write)!;
    const p = await room.profile(read.key);
    expect(p.rows).toBe(1);
    expect(p.tree?.operator).toBeTruthy();
    expect(p.dbHits).toBeGreaterThan(0);
    const write = engineTap.topStatements().find((s) => s.write)!;
    await expect(room.profile(write.key)).rejects.toThrow();
  });

  it("draws the blueprint: labels with counts, relationship types between them", async () => {
    const bp = await room.blueprint();
    expect(bp.labels.map((l) => l.label).sort()).toEqual(["Agent", "AgentRun", "Company", "Person"]);
    expect(bp.relationships).toContainEqual({ type: "WORKS_AT", from: "Person", to: "Company", count: 1 });
  });

  it("finds how two things connect, by name, with the engine's SHORTEST", async () => {
    const r = await room.path("Bruno", "Delta Norte");
    expect(r.paths[0].nodes.map((n) => n.name)).toEqual(["Bruno", "r1", "Lucía Ferreyra", "Delta Norte"]);
    expect(r.paths[0].rels.map((x) => x.type)).toEqual(["RAN", "TOUCHED", "WORKS_AT"]);
    expect((await room.path("Bruno", "nobody at all")).paths).toEqual([]);
    // Without its accent, the name still means the person.
    expect((await room.path("Bruno", "Lucia")).to?.name).toBe("Lucía Ferreyra");
  });
});
