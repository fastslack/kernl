import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { DecisionGraph } from "../src/modules/agents/services/decision-graph.js";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";

const OPTS = [{ label: "Reabrir con los pendientes" }, { label: "Cerrar igual" }];

describe.skipIf(!relateClientInstalled())("decisions in the built-in graph", () => {
  const drivers: RelateGraphDriver[] = [];
  afterEach(async () => { for (const d of drivers.splice(0)) await d.stop(); });

  async function setup() {
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    drivers.push(g);
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    const s = new AgentService(db, new EventBus());
    const dg = new DecisionGraph(db, () => g);
    s.setDecisionGraph(dg);
    return { g, db, s, dg };
  }

  it("an issue's questions across its parts, who decided each, and what was broken at the time — in one traversal", async () => {
    const { g, db, s, dg } = await setup();
    const closer = s.createAgent({ name: "Cerrador", flow_id: "acme" } as never).id;
    const resolver = s.createAgent({ name: "Resolver", flow_id: "acme" } as never).id;
    const ask = (from: string, text: string, subject: string, category: string) =>
      s.createQuestion({ from_agent_id: from, flow_id: "acme", question: text, options: OPTS, for_operator: true, subject_key: subject, category }).id;

    const a = ask(closer, "web#2653:a-b: el Cerrador no lo cierra", "web#2653:a-b", "closer-blocked");
    s.answerQuestion(a, { selected_index: 0, selected_option: OPTS[0].label, answered_by: "human", source: { via: "whatsapp", actor: "whatsapp:549" } });
    db.run("UPDATE agent_questions SET created_at = '2026-10-28T10:00:00.000Z', answered_at = '2026-10-28T10:00:40.000Z' WHERE id = ?", [a]);

    s.envFacts.report({ flow_id: "acme", key: "dev-e2e", description: "el E2E cae en su preparación", by: "agent:x", blocked: { agent_id: resolver, subject_key: "web#2653:c" } });
    db.run("UPDATE agent_env_facts SET valid_from = '2026-10-29T08:00:00.000Z'");
    const b = ask(resolver, "web#2653:c: el Resolver no puede seguir", "web#2653:c", "resolver-blocked");
    s.answerQuestion(b, { selected_index: 1, selected_option: OPTS[1].label, answered_by: "human", source: { via: "host-ops" } });
    db.run("UPDATE agent_questions SET created_at = '2026-10-29T09:00:00.000Z', answered_at = '2026-10-29T09:30:00.000Z' WHERE id = ?", [b]);
    const c = ask(resolver, "web#2700: otro issue", "web#2700", "resolver-blocked");

    expect(await dg.sync()).toBe(3);
    const hist = (await dg.subjectHistory("web#2653"))!;
    expect(hist.map((h) => [h.subject_key, h.answer, h.via, h.env_open])).toEqual([
      ["web#2653:a-b", "Reabrir con los pendientes", "whatsapp", []],
      ["web#2653:c", "Cerrar igual", "host-ops", ["dev-e2e"]],
    ]);
    expect(hist[0].asked_by).toBe(closer);
    expect((await dg.subjectHistory("web#2653:c"))!.length).toBe(2); // a part leads to its whole issue
    expect((await dg.subjectHistory("web#2700"))!.map((h) => h.id)).toEqual([c]);

    // Parts hang from their issue; the parked part points at the environment problem; times are datetimes.
    const r = (await g.run(
      `MATCH (p:WorkItem {key: 'web#2653'})<-[:PART_OF]-(w:WorkItem) OPTIONAL MATCH (w)-[:BLOCKED_BY]->(e:EnvFact)
       RETURN w.key AS part, e.key AS env ORDER BY part`,
    )).records.map((x) => [x.get("part"), x.get("env")]);
    expect(r).toEqual([["web#2653:a-b", null], ["web#2653:c", "dev-e2e"]]);
    const t = (await g.run("MATCH (q:AgentQuestion {id: $id}) RETURN valueType(q.answered_at) AS t, q.answered_at AS at", { id: a })).records[0];
    expect(String(t.get("t"))).toStartWith("ZONED DATETIME");
    expect(t.get("at")).toBe("2026-10-28T10:00:40.000Z");

    // Who decides what, over the whole office.
    const makers = (await g.run(
      "MATCH (q:AgentQuestion)-[:DECIDED_BY]->(d:DecisionMaker) RETURN d.id AS who, d.via AS via, count(q) AS n ORDER BY who",
    )).records.map((x) => [x.get("who"), x.get("via"), Number(x.get("n"))]);
    expect(makers).toEqual([["host-ops", "host-ops", 1], ["whatsapp:549", "whatsapp", 1]]);

    // Nothing new: nothing projected again.
    expect(await dg.sync()).toBe(0);
  });

  it("the backfill brings an office's whole history into a new store", async () => {
    const { s, dg } = await setup();
    const a = s.createAgent({ name: "QA", flow_id: "o" } as never).id;
    for (let i = 0; i < 3; i++) s.createQuestion({ from_agent_id: a, flow_id: "o", question: `web#${i}: ¿Apruebo?`, options: OPTS, for_operator: true });
    const fresh = new RelateGraphDriver();
    fresh.configure({ path: ":memory:" });
    await fresh.start();
    drivers.push(fresh);
    expect((await dg.backfill(fresh)).nodes).toBe(3);
    expect(Number((await fresh.run("MATCH (q:AgentQuestion)-[:ABOUT]->(w:WorkItem) RETURN count(w) AS c")).records[0].get("c"))).toBe(3);
  });
});
