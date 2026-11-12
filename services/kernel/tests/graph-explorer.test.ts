import { describe, it, expect } from "bun:test";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { GraphExplorer, toNode } from "../src/modules/graph-query/explorer.js";

describe("explorer values", () => {
  it("turns a node into what the browser draws", () => {
    expect(toNode({ elementId: "1", labels: ["Note"], properties: { title: "Line one\nline two", embedding: [1, 2], n: { toNumber: () => 4 }, long: "x".repeat(400) } }))
      .toEqual({ id: "1", labels: ["Note"], name: "Line one", props: { title: "Line one\nline two", n: 4, long: `${"x".repeat(299)}…` } });
    expect(toNode({ foo: 1 })).toBeNull();
  });
});

describe.skipIf(!relateClientInstalled())("explorer on Relate", () => {
  it("samples a label, searches, and walks a neighbourhood", async () => {
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    await g.run(`CREATE (a:Person {name: 'Ada Lovelace'}), (b:Person {name: 'Bob'}), (c:Person {name: 'Cy'}), (t:Task {title: 'Report'}),
                        (a)-[:KNOWS]->(b), (b)-[:KNOWS]->(c), (t)-[:ASSIGNED_TO]->(a)`);
    const ex = new GraphExplorer(() => g);

    const s = await ex.sample("Person");
    expect(s.nodes.map((n) => n.name).sort()).toEqual(["Ada Lovelace", "Bob", "Cy"]);
    expect(s.links.map((l) => l.type)).toEqual(["KNOWS", "KNOWS"]);
    await expect(ex.sample("Bad Label")).rejects.toThrow(/bad label/);

    const found = await ex.search("lovelace");
    expect(found.map((n) => n.name)).toEqual(["Ada Lovelace"]);
    expect(await ex.search("report", "Task")).toHaveLength(1);

    const one = await ex.neighborhood(found[0].id, 1);
    expect(one.nodes.map((n) => n.name).sort()).toEqual(["Ada Lovelace", "Bob", "Report"]);
    expect(one.links).toHaveLength(2);
    const two = await ex.neighborhood(found[0].id, 2);
    expect(two.nodes).toHaveLength(4);
    expect(two.links).toHaveLength(3);
    expect(await ex.neighborhood("nope")).toEqual({ nodes: [], links: [] });
  });
});
