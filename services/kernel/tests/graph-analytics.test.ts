import { describe, it, expect } from "bun:test";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { betweenness, components, louvain, pageRank, type Projection } from "../src/modules/graph-analytics/algorithms.js";
import { GraphAnalytics, type RemoteSession } from "../src/modules/graph-analytics/service.js";

const proj = (n: number, edges: Array<[number, number]>): Projection => ({
  n, src: Int32Array.from(edges.map((e) => e[0])), dst: Int32Array.from(edges.map((e) => e[1])),
});

// Two triangles joined by one bridge (2–3), plus an isolated node 6.
const barbell = proj(7, [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [2, 3]]);

describe("algorithms", () => {
  it("pagerank sums to one and ranks the hub first", () => {
    const star = pageRank(proj(4, [[1, 0], [2, 0], [3, 0]]));
    expect([...star].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(star[0]).toBeGreaterThan(star[1]);
    expect(star[1]).toBeCloseTo(star[2], 12);
  });

  it("finds components and communities", () => {
    expect([...components(barbell)]).toEqual([0, 0, 0, 0, 0, 0, 6]);
    const c = louvain(barbell);
    expect(c[0]).toBe(c[1]);
    expect(c[1]).toBe(c[2]);
    expect(c[3]).toBe(c[4]);
    expect(c[4]).toBe(c[5]);
    expect(c[0]).not.toBe(c[3]);
    expect(new Set(c).size).toBe(3);
    // Deterministic.
    expect([...louvain(barbell)]).toEqual([...c]);
  });

  it("puts the bridge ends highest in betweenness, with exact values", () => {
    const b = betweenness(barbell);
    // Node 2 lies on every shortest path between {0,1} and {3,4,5}: 2 × 3 = 6 pairs, plus none inside.
    expect(b[2]).toBeCloseTo(6, 9);
    expect(b[3]).toBeCloseTo(6, 9);
    expect(b[0]).toBe(0);
    expect(b[6]).toBe(0);
  });
});

describe.skipIf(!relateClientInstalled())("analytics on Relate", () => {
  async function graph() {
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    await g.run(`CREATE (a:Person {name: 'Ada'}), (b:Person {name: 'Bob'}), (c:Person {name: 'Cy'}),
                        (d:Person {name: 'Dee'}), (e:Person {name: 'Eve'}), (f:Person {name: 'Fay'}), (x:Task {title: 'T'}),
                        (a)-[:KNOWS]->(b), (b)-[:KNOWS]->(c), (c)-[:KNOWS]->(a),
                        (d)-[:KNOWS]->(e), (e)-[:KNOWS]->(f), (f)-[:KNOWS]->(d), (c)-[:WORKS_WITH]->(d),
                        (x)-[:ASSIGNED_TO]->(a)`);
    return g;
  }

  it("computes locally and writes the result on the nodes", async () => {
    const g = await graph();
    const svc = new GraphAnalytics(() => g, () => null);
    expect(svc.engines()).toEqual(["local"]);

    const comm = await svc.analyze({ algorithm: "communities", labels: ["Person"] });
    expect(comm).toMatchObject({ engine: "local", property: "communityId", nodes: 6, relationships: 7, groups: 2 });
    const r = await g.run("MATCH (p:Person) RETURN p.name AS n, p.communityId AS c ORDER BY n");
    const byName = Object.fromEntries(r.records.map((x) => [x.get("n"), Number(x.get("c"))]));
    expect(byName.Ada).toBe(byName.Cy);
    expect(byName.Dee).toBe(byName.Fay);
    expect(byName.Ada).not.toBe(byName.Dee);
    const task = await g.run("MATCH (t:Task) RETURN t.communityId AS c");
    expect(task.records[0].get("c")).toBeNull();

    // Only one relationship type: the bridge is gone, and so is its betweenness.
    const bt = await svc.analyze({ algorithm: "betweenness", labels: ["Person"], relationships: ["KNOWS"], write: false, top: 1 });
    expect(bt.property).toBeUndefined();
    expect(bt.top![0].score).toBe(0); // two separate triangles: every pair is adjacent

    const pr = await svc.analyze({ algorithm: "pagerank", labels: ["Person", "Task"], top: 1 });
    expect(pr).toMatchObject({ nodes: 7, relationships: 8 });
    // Dee is pointed at by Cy and Fay; Ada by Cy and the task, which nobody points at.
    expect(pr.top![0].name).toBe("Dee");

    await expect(svc.analyze({ algorithm: "pagerank", labels: ["Bad Label"] })).rejects.toThrow(/Not a label/);
    await expect(svc.analyze({ algorithm: "pagerank", labels: ["Person"], engine: "gds" })).rejects.toThrow(/no Graph Data Science/);
  });

  it("sends a remote GDS only numbered nodes and edges, and cleans up after", async () => {
    const g = await graph();
    const sent: Array<{ cypher: string; params?: Record<string, unknown> }> = [];
    let closed = false;
    const fake: RemoteSession = {
      async run(cypher, params) {
        sent.push({ cypher, params });
        if (cypher.includes("gds.wcc.stream")) return Array.from({ length: 6 }, (_, i) => ({ i, value: i < 3 ? 10 : 20 }));
        return [];
      },
      async close() { closed = true; },
    };
    const svc = new GraphAnalytics(() => g, () => ({ uri: "bolt://gds.test", user: "u", password: "p" }), async () => fake);
    expect(svc.engines()).toEqual(["remote", "local"]);
    const out = await svc.analyze({ algorithm: "components", labels: ["Person"], relationships: ["KNOWS"] });
    expect(out).toMatchObject({ engine: "remote", groups: 2 });
    const payload = JSON.stringify(sent.map((s) => s.params ?? {}));
    expect(payload).not.toMatch(/Ada|Person|KNOWS/);
    expect(sent.some((s) => s.cypher.includes("gds.graph.drop"))).toBe(true);
    expect(sent.some((s) => s.cypher.includes("DETACH DELETE"))).toBe(true);
    expect(closed).toBe(true);
    const r = await g.run("MATCH (p:Person {name: 'Dee'}) RETURN p.componentId AS c");
    expect(Number(r.records[0].get("c"))).toBe(20);
  });
});
