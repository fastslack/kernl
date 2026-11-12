import { describe, it, expect } from "bun:test";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { blankLiterals, planGate, readPlan, staticGate } from "../src/modules/graph-query/gate.js";
import { GraphQueryService, extractCypher, plain } from "../src/modules/graph-query/service.js";

describe("static gate", () => {
  it("lets reads through", () => {
    for (const q of [
      "MATCH (p:Person)-[:KNOWS]->(f) RETURN p.name, count(f) ORDER BY 2 DESC LIMIT 5",
      "MATCH (p:Person) WHERE p.name = 'SET me CREATE (x)' RETURN p",
      "MATCH p = (a:Person)-[:KNOWS*1..3]->(b) RETURN length(p)",
      "CALL db.index.fulltext.queryNodes('kernl_entity_text', 'ada') YIELD node RETURN node.name",
      "CALL db.labels()",
      "MATCH (n:Person) CALL (n) { MATCH (n)--(m) RETURN count(m) AS c } RETURN n.name, c",
      "MATCH (n:Offset) RETURN n // DELETE in a comment",
    ]) expect(staticGate(q)).toBeNull();
  });

  it("refuses writes, foreign procedures and unbounded paths", () => {
    expect(staticGate("MATCH (n) DETACH DELETE n")).toMatch(/DETACH/);
    expect(staticGate("MATCH (n:Person) SET n.x = 1 RETURN n")).toMatch(/SET/);
    expect(staticGate("merge (n:Person {id: 1})")).toMatch(/MERGE/);
    expect(staticGate("LOAD CSV FROM 'file:///x' AS r RETURN r")).toMatch(/LOAD CSV/);
    expect(staticGate("CALL apoc.periodic.iterate('a','b',{})")).toMatch(/apoc/);
    expect(staticGate("CALL db.createLabel('X')")).toMatch(/not allowed/);
    expect(staticGate("MATCH (a)-[*]->(b) RETURN b")).toMatch(/upper bound/);
    expect(staticGate("MATCH (a)-[:KNOWS*2..]->(b) RETURN b")).toMatch(/upper bound/);
    expect(staticGate("MATCH (a)-[:KNOWS*1..9]->(b) RETURN b")).toMatch(/at most 6/);
    expect(staticGate("MATCH ((a)-->(b))+ RETURN b")).toMatch(/Quantified/);
    expect(staticGate("EXPLAIN MATCH (n) RETURN n")).toMatch(/EXPLAIN/);
  });

  it("blanks strings and comments but keeps backticked names", () => {
    expect(blankLiterals("RETURN 'a' + \"b\" // c")).toBe("RETURN " + " ".repeat(3) + " + " + " ".repeat(3) + " " + " ".repeat(4));
    expect(blankLiterals("MATCH (n:`My Label`) RETURN n")).toBe("MATCH (n:`My Label`) RETURN n");
  });
});

describe("plan gate", () => {
  it("reads both engines' plans and refuses writing operators and cartesian products", () => {
    const relate = { root: { operator: "ProduceResults", children: [{ operator: "SetProperty", children: [] }] } };
    expect(planGate(readPlan(relate))).toMatch(/SetProperty/);
    const neo = { operatorType: "ProduceResults@neo4j", children: [{ operatorType: "Offset", children: [{ operatorType: "NodeByLabelScan", children: [] }] }] };
    expect(readPlan(neo).operators).toEqual(["ProduceResults", "Offset", "NodeByLabelScan"]);
    expect(planGate(readPlan(neo))).toBeNull();
    const cart = readPlan({ root: { operator: "Expand", warnings: [{ code: "Neo.ClientNotification.Statement.CartesianProduct", description: "d", remedy: "join them" }] } });
    expect(planGate(cart)).toMatch(/cartesian product\)\. join them/);
    expect(readPlan(null, [{ code: "X", title: "t", description: "from notifications" }]).warnings).toEqual([{ code: "X", description: "from notifications", remedy: undefined }]);
  });
});

describe("model answers and rows", () => {
  it("finds the query in JSON, a fence or plain text", () => {
    expect(extractCypher('{"cypher": "MATCH (n) RETURN n"}')).toBe("MATCH (n) RETURN n");
    expect(extractCypher("Here:\n```cypher\nMATCH (n) RETURN n\n```")).toBe("MATCH (n) RETURN n");
    expect(extractCypher("I cannot answer that.")).toBeUndefined();
  });

  it("turns rows into plain JSON", () => {
    expect(plain({ n: { labels: ["Person"], properties: { name: "Ada", embedding: [1, 2] } }, c: { low: 3, high: 0, toNumber: () => 3 } }))
      .toEqual({ n: { _labels: ["Person"], name: "Ada", embedding: "[vector]" }, c: 3 });
    expect(plain(Array(40).fill(0.1))).toBe("[vector of 40]");
  });
});

describe.skipIf(!relateClientInstalled())("graph queries on Relate", () => {
  async function setup() {
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    await g.run(`CREATE (a:Person {id: 'a', name: 'Ada'}), (b:Person {id: 'b', name: 'Bob'}), (c:Person {id: 'c', name: 'Cy'}),
                        (t:Task {id: 't', title: 'Report'}), (a)-[:KNOWS]->(b), (b)-[:KNOWS]->(c), (t)-[:ASSIGNED_TO]->(a),
                        (:KernlGraphBackfill {name: 'x'})`);
    return { g, svc: new GraphQueryService(() => g) };
  }

  it("describes the graph without the kernel's bookkeeping", async () => {
    const { svc } = await setup();
    const s = await svc.schema();
    expect(s.labels.map((l) => [l.label, l.count])).toEqual([["Person", 3], ["Task", 1]]);
    expect(s.labels[0].properties).toEqual(["id", "name"]);
    expect(s.relationships).toEqual([
      { from: "Person", type: "KNOWS", to: "Person", count: 2 },
      { from: "Task", type: "ASSIGNED_TO", to: "Person", count: 1 },
    ]);
    expect(await svc.schemaText()).toContain("(:Task)-[:ASSIGNED_TO]->(:Person)  ×1");
  });

  it("runs reads, caps rows, and explains what to fix", async () => {
    const { svc } = await setup();
    const ok = await svc.query("MATCH (a:Person)-[:KNOWS*1..2]->(b:Person) WHERE a.name = $n RETURN b.name AS name ORDER BY name", { params: { n: "Ada" } });
    expect(ok).toMatchObject({ ok: true, rows: [{ name: "Bob" }, { name: "Cy" }] });

    const capped = await svc.query("MATCH (p:Person) RETURN p.name AS n ORDER BY n", { limit: 2 });
    expect(capped).toMatchObject({ ok: true, rows: [{ n: "Ada" }, { n: "Bob" }], truncated: true });

    expect((await svc.query("CALL db.labels()")).ok).toBe(true);

    const typo = await svc.query("MATCH (p:person)-[:KNOW]->(x) RETURN p");
    expect(typo.error).toContain("No node has the label :person. Did you mean :Person?");
    expect(typo.error).toContain("No relationship has the type :KNOW. Did you mean :KNOWS?");

    expect((await svc.query("MATCH (a:Person), (t:Task) RETURN a, t")).error).toMatch(/cartesian/);
    expect((await svc.query("MATCH (p:Person) SET p.x = 1")).error).toMatch(/Read-only/);
    expect((await svc.query("MATCH (p:Person RETURN p")).error).toMatch(/does not parse/);
    // Nothing was written.
    expect((await svc.query("MATCH (p:Person) WHERE p.x IS NOT NULL RETURN count(p) AS n")).rows).toEqual([{ n: 0 }]);
  });

  it("answers a question, correcting the query from the errors", async () => {
    const { svc } = await setup();
    const asked: string[] = [];
    const answers = [
      '{"cypher": "MATCH (t:Tasks)-[:ASSIGNED_TO]->(p:Person) RETURN p.name AS who"}',
      '{"cypher": "MATCH (t:Task {title: \'Report\'})-[:ASSIGNED_TO]->(p:Person) RETURN p.name AS who"}',
    ];
    const out = await svc.ask("who has the report task?", async (system, user) => {
      asked.push(user);
      expect(system).toContain(":Task (1): id, title");
      return answers.shift()!;
    });
    expect(out).toMatchObject({ ok: true, attempts: 2, rows: [{ who: "Ada" }] });
    expect(asked[1]).toContain("Did you mean :Task?");

    const never = await svc.ask("anything", async () => "I don't know", { attempts: 2 });
    expect(never).toMatchObject({ ok: false, attempts: 2, error: "The model did not return a query." });
  });
});
