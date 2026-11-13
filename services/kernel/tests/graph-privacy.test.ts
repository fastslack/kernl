import { describe, it, expect } from "bun:test";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { GraphQueryService } from "../src/modules/graph-query/service.js";
import { clientGate, clientPolicy, filterSchema, redactRows } from "../src/modules/graph-query/privacy.js";

const policy = clientPolicy({});

describe("client policy", () => {
  it("reads the settings, defaulting to read with private mail, memory and facts", () => {
    expect(policy.access).toBe("read");
    expect([...policy.privateLabels]).toContain("Email");
    expect(clientPolicy({ GRAPH_MCP_ACCESS: "OFF" }).access).toBe("off");
    expect(clientPolicy({ GRAPH_MCP_ACCESS: "bogus" }).access).toBe("read");
    expect([...clientPolicy({ GRAPH_PRIVATE_LABELS: "Secret, Diary" }).privateLabels]).toEqual(["Secret", "Diary"]);
    expect(clientPolicy({ GRAPH_PRIVATE_LABELS: "none" }).privateLabels.size).toBe(0);
  });

  it("lets labeled reads through and stops anything that could reach a private node", () => {
    for (const q of [
      "MATCH (p:Person)-[:KNOWS]->(f:Person) RETURN p.name, f.name",
      "MATCH (p:Person) WHERE p.name = ':Email ()' RETURN count(p)",
      "MATCH (t:Task) WITH t MATCH (t)-[:ASSIGNED_TO]->(p:Person) RETURN t.title, p.name",
      "MATCH (n:Person) CALL (n) { MATCH (n)-[:KNOWS]->(m:Person) RETURN count(m) AS c } RETURN n.name, c",
      "MATCH (p:Person) RETURN size((p.name)) AS n",
    ]) expect(clientGate(q, policy)).toBeNull();

    expect(clientGate("MATCH (e:Email) RETURN e.subject", policy)).toMatch(/:Email is private/);
    expect(clientGate("MATCH (x:Person|EmailThread) RETURN x", policy)).toMatch(/EmailThread/);
    expect(clientGate("MATCH (p:Person)-[:SENT]->(m) RETURN m.subject", policy)).toMatch(/Give \(m\) a label/);
    expect(clientGate("MATCH (p:Person)--() RETURN p", policy)).toMatch(/needs a label/);
    expect(clientGate("MATCH (n) RETURN n", policy)).toMatch(/Give \(n\) a label/);
    expect(clientGate("MATCH (a:Person), (n) RETURN n", policy)).toMatch(/Give \(n\)/);
    expect(clientGate("MATCH (n:$($l)) RETURN n", policy)).toMatch(/Dynamic labels/);
    expect(clientGate("MATCH (p:Person) RETURN p", { ...policy, access: "schema" })).toMatch(/may not query/);
    // With no private labels, only the access level matters.
    expect(clientGate("MATCH (n) RETURN n", { access: "read", privateLabels: new Set() })).toBeNull();
  });

  it("hides private labels from the schema and private nodes from rows", () => {
    const s = filterSchema({
      labels: [{ label: "Person" }, { label: "Email" }],
      relationships: [{ from: "Person", to: "Email" }, { from: "Person", to: "Person" }],
      indexes: [{ labels: ["Person", "Fact"] }, { labels: ["Memory"] }],
    }, policy);
    expect(s).toEqual({ labels: [{ label: "Person" }], relationships: [{ from: "Person", to: "Person" }], indexes: [{ labels: ["Person"] }] });

    const r = redactRows([{ p: { _labels: ["Person"], name: "Ada" }, list: [{ labels: ["Fact"], properties: {} }] }], policy);
    expect(r).toEqual({ rows: [{ p: { _labels: ["Person"], name: "Ada" }, list: [{ _private: true }] }], redacted: 1 });
  });
});

describe.skipIf(!relateClientInstalled())("client queries on Relate", () => {
  it("answers clients without private data, and agents with all of it", async () => {
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    await g.run(`CREATE (a:Person {name: 'Ada'}), (e:Email {subject: 'Salary'}), (f:Fact {title: 'Ada · lives in · Rome'}),
                        (a)-[:SENT]->(e), (f)-[:ABOUT]->(a)`);
    await g.run("CREATE FULLTEXT INDEX facts_text IF NOT EXISTS FOR (n:Fact|Person) ON EACH [n.title, n.name]");
    const svc = new GraphQueryService(() => g);

    const agent = await svc.query("MATCH (p:Person)-[:SENT]->(m) RETURN m.subject AS s");
    expect(agent.rows).toEqual([{ s: "Salary" }]);

    const client = await svc.query("MATCH (p:Person)-[:SENT]->(m) RETURN m.subject AS s", { policy });
    expect(client).toMatchObject({ ok: false, error: expect.stringMatching(/label/) });

    expect((await svc.query("CALL db.index.fulltext.queryNodes('facts_text', 'Ada') YIELD node RETURN node.name", { policy })).error)
      .toMatch(/covers private labels/);

    const ok = await svc.query("MATCH (p:Person) RETURN p", { policy });
    expect(ok.rows).toEqual([{ p: { _labels: ["Person"], name: "Ada" } }]);

    expect(await svc.schemaText(policy)).not.toContain("Email");
    expect(await svc.schemaText()).toContain("Email");
  });
});
