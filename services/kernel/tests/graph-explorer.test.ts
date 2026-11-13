import { describe, it, expect } from "bun:test";
import { ensureEntityTextIndex, FOLD_ENTITIES_CYPHER, FOLD_PAIRS, foldText, foldedQuery } from "../src/modules/brain/ask.js";
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

  it("finds names with or without their accents, through the index and through the substring fallback", async () => {
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    await g.run(`CREATE (:Person {name: 'Lucía Ferreyra'}), (:Person {name: 'Martin Sosa'}), (:Concept {name: 'Logística'})`);
    // What the brain's entity index keeps current in the background, done here and awaited.
    await ensureEntityTextIndex(g);
    await g.run(FOLD_ENTITIES_CYPHER, { pairs: FOLD_PAIRS });
    const ex = new GraphExplorer(() => g);
    expect((await ex.search("Lucia")).map((n) => n.name)).toEqual(["Lucía Ferreyra"]);
    expect((await ex.search("martín")).map((n) => n.name)).toEqual(["Martin Sosa"]);
    // The fallback (a label, so no index): a piece of a word, accents ignored both ways.
    expect((await ex.search("ferrey", "Person")).map((n) => n.name)).toEqual(["Lucía Ferreyra"]);
    expect((await ex.search("logist", "Concept")).map((n) => n.name)).toEqual(["Logística"]);
    // The folded copy is plumbing: the explorer does not show it.
    expect((await ex.search("Lucia"))[0].props.search_fold).toBeUndefined();
    await g.stop();
  });
});

describe("folding accents", () => {
  it("strips accents and lowercases; a query keeps its own form and adds the bare one", () => {
    expect(foldText("Lucía FERREYRA, Logística, Ñandú")).toBe("lucia ferreyra, logistica, nandu");
    expect(foldedQuery("Martín Sosa")).toBe("Martín Sosa martin sosa");
    expect(foldedQuery("plain words")).toBe("plain words");
  });
});
