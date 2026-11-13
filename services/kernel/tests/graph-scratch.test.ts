import { describe, it, expect } from "bun:test";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { GraphQueryService } from "../src/modules/graph-query/service.js";
import { IDLE_MS, MAX_GRAPHS, ScratchGraphs, collectSlice, scratchGate } from "../src/modules/graph-query/scratch.js";

describe("scratch gate", () => {
  it("allows writes but not file access or foreign procedures", () => {
    expect(scratchGate("CREATE (:Step {n: 1})")).toBeNull();
    expect(scratchGate("MATCH (n) DETACH DELETE n")).toBeNull();
    expect(scratchGate("CREATE (:X {q: 'LOAD CSV in a string'})")).toBeNull();
    expect(scratchGate("LOAD CSV FROM 'file:///etc/passwd' AS r CREATE (:L {r: r})")).toMatch(/LOAD CSV/);
    expect(scratchGate("CALL apoc.load.json('x')")).toMatch(/apoc/);
    expect(scratchGate("CALL db.createLabel('X')")).toMatch(/not allowed/);
    expect(scratchGate("USE other MATCH (n) RETURN n")).toMatch(/USE/);
  });

  it("collects nodes and relationships from rows, lists and paths, once each", () => {
    const a = { elementId: "a", labels: ["P"], properties: { name: "Ada", embedding: [1, 2], n: { toNumber: () => 3 } } };
    const b = { elementId: "b", labels: ["P"], properties: {} };
    const r = { elementId: "r", type: "KNOWS", startNodeElementId: "a", endNodeElementId: "b", properties: {} };
    const s = collectSlice([{ p: [a, r, b] }, { x: a, list: [b] }, { path: { segments: [{ start: a, relationship: r, end: b }] } }]);
    expect(s.nodes.map((n) => n.elementId)).toEqual(["a", "b"]);
    expect(s.nodes[0].properties).toEqual({ name: "Ada", n: 3 });
    expect(s.relationships).toEqual([{ elementId: "r", type: "KNOWS", start: "a", end: "b", properties: {} }]);
  });
});

describe.skipIf(!relateClientInstalled())("scratch graphs on Relate", () => {
  const open = async () => {
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    return g;
  };

  it("gives each owner its own graph, reuses wiped graphs and caps how many exist", async () => {
    let now = 1_000_000;
    let opened = 0;
    const pool = new ScratchGraphs(async () => { opened++; return open(); }, () => now);
    await pool.run("run:1", "CREATE (:Step {n: 1})-[:THEN]->(:Step {n: 2})");
    await pool.run("run:1", "CREATE INDEX step_n IF NOT EXISTS FOR (s:Step) ON (s.n)");
    await pool.run("run:2", "CREATE (:Other)");
    expect(await pool.stats("run:1")).toEqual({ nodes: 2, relationships: 1 });
    expect(await pool.stats("run:2")).toEqual({ nodes: 1, relationships: 0 });

    // run:1 ends: its graph is wiped and handed to the next run.
    expect(await pool.release("run:1")).toBe(true);
    await pool.run("run:3", "RETURN 1");
    expect(opened).toBe(2);
    expect(await pool.stats("run:3")).toEqual({ nodes: 0, relationships: 0 });
    const idx = await (await pool.get("run:3")).run("SHOW INDEXES YIELD name RETURN name");
    expect(idx.records.map((r) => r.get("name"))).not.toContain("step_n");

    for (let i = 4; i < 4 + MAX_GRAPHS - 2; i++) await pool.get(`run:${i}`);
    await expect(pool.get("run:99")).rejects.toThrow(/in use/);
    // Idle ones go back after IDLE_MS.
    now += IDLE_MS + 1;
    await pool.get("run:99");
    expect(pool.owners()).toEqual(["run:99"]);
  });

  it("copies a slice of the main graph into a scratch graph", async () => {
    const main = await open();
    await main.run(`CREATE (a:Person {id: 'a', name: 'Ada', embedding: [0.1, 0.2]}), (b:Person:Friend {id: 'b', name: 'Bob'}),
                    (c:Person {id: 'c', name: 'Cy'}), (t:Task {id: 't', title: 'Report'}),
                    (a)-[:KNOWS {since: 2020}]->(b), (b)-[:KNOWS]->(c), (t)-[:ASSIGNED_TO]->(a)`);
    const q = new GraphQueryService(() => main);
    const out = await q.query("MATCH p = (:Person {name: 'Ada'})-[:KNOWS*1..2]->(:Person) RETURN p", { raw: true });
    expect(out.ok).toBe(true);
    const slice = collectSlice(out.rows!);
    expect(slice.nodes).toHaveLength(3);
    expect(slice.relationships).toHaveLength(2);

    const pool = new ScratchGraphs(open);
    expect(await pool.copyIn("run:x", slice)).toEqual({ nodes: 3, relationships: 2, skipped: 0 });
    // Copying again updates in place.
    await pool.copyIn("run:x", slice);
    expect(await pool.stats("run:x")).toEqual({ nodes: 3, relationships: 2 });

    const r = await pool.run("run:x", "MATCH (a:Person {name: 'Ada'})-[k:KNOWS]->(b:Friend) RETURN b.name AS b, k.since AS since, a.embedding AS e");
    expect(r.records.map((x) => [x.get("b"), Number(x.get("since")), x.get("e")])).toEqual([["Bob", 2020, null]]);
    // Reshape it freely; the main graph does not change.
    await pool.run("run:x", "MATCH (p:Person) SET p.checked = true");
    const check = await main.run("MATCH (p:Person) WHERE p.checked IS NOT NULL RETURN count(p) AS n");
    expect(Number(check.records[0].get("n"))).toBe(0);
  });
});
