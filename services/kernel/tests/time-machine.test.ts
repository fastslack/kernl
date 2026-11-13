import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { brainMigrations } from "../src/modules/brain/migrations.js";
import { FactStore } from "../src/modules/brain/facts.js";
import { TimeMachine } from "../src/modules/brain/time-machine.js";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";

// The time machine asks the graph what held at a moment, in one query, and
// sorts each fact by both timelines. The story it is held to: Kernl learned
// where Lucía worked in October; she moved on Nov 1; Kernl heard of it Nov 12.
describe.skipIf(!relateClientInstalled())("the time machine on the built-in graph", () => {
  const drivers: RelateGraphDriver[] = [];
  afterEach(async () => {
    for (const d of drivers.splice(0)) await d.stop();
  });

  async function story() {
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    drivers.push(g);
    const db = new Database(":memory:");
    runMigrations(db as never, "brain", brainMigrations);
    db.exec(`CREATE TABLE tool_provenance (id TEXT, call_id TEXT, at TEXT, actor_kind TEXT, actor_id TEXT, actor_name TEXT,
      run_id TEXT, tool TEXT, ok INTEGER, ref TEXT, detail TEXT)`);
    db.exec("CREATE TABLE agents (id TEXT, name TEXT, flow_id TEXT)");
    let clock = "2026-10-02T10:00:00.000Z";
    const facts = new FactStore(db as never, () => g, () => clock);
    await g.run("CREATE (:Person {id: 'l', name: 'Lucía Ferreyra'})");
    const andina = facts.assert({ subject: "Person:l", subjectName: "Lucía Ferreyra", predicate: "works_at", object: "Andina", validFrom: "2024-01-01" });
    const city = facts.assert({ subject: "Person:l", predicate: "lives_in", object: "Buenos Aires", validFrom: "2024-01-01" });
    db.prepare("INSERT INTO tool_provenance VALUES ('p1','c1',?, 'agent','ana','Ana · CRM','r1','kernel_facts_assert',1,?, '')").run(clock, andina.fact.id);
    clock = "2026-11-12T14:50:00.000Z";
    const delta = facts.assert({ subject: "Person:l", predicate: "works_at", object: "Delta Norte", validFrom: "2026-11-01", mode: "change" });
    await facts.project([facts.get(andina.fact.id)!, facts.get(city.fact.id)!, delta.fact]);
    // Bruno: a run on Nov 10 that acted on Lucía, and a lesson kept on Nov 12.
    db.prepare("INSERT INTO agents VALUES ('bruno', 'Bruno · Sales', 'ventas')").run();
    await g.run(
      `CREATE (a:Agent {id: 'bruno', name: 'Bruno · Sales'})-[:RAN]->(r:AgentRun {id: 'r2'})
       WITH a, r MATCH (p:Person {id: 'l'})
       CREATE (r)-[:TOUCHED {tool: 'kernel_crm_log_interaction', at: '2026-11-10T14:30:00.000Z'}]->(p)
       CREATE (a)-[:LEARNED]->(:AgentLearning {id: 'L1', type: 'avoid', content: 'Check the address is current',
         created_at: datetime('2026-11-12T14:51:00Z')})`,
    );
    const tm = new TimeMachine(db as never, () => g, (x) => facts.ensureGraphSchema(x));
    return { tm, ids: { andina: andina.fact.id, delta: delta.fact.id, city: city.fact.id } };
  }

  it("an agent at a moment: what it acted on, as Kernl saw it then, and the lessons it held", async () => {
    const { tm } = await story();
    const then = await tm.agentAsOf("Bruno · Sales", "2026-11-10T14:30:00Z");
    expect(then.touched.map((x) => [x.name, x.state])).toEqual([["Lucía Ferreyra", "stale"]]);
    expect(then.touched[0].stale_facts).toEqual(["works at: Andina"]);
    expect(then.lessons).toEqual([]);
    const later = await tm.agentAsOf("bruno", "2026-11-12T15:00:00Z");
    expect(later.touched[0].state).toBe("known");
    expect(later.lessons.map((l) => l.content)).toEqual(["Check the address is current"]);
  });

  const state = (snap: Awaited<ReturnType<TimeMachine["asOf"]>>, id: string) => snap.facts.find((f) => f.id === id)?.state ?? "absent";

  it("before the move, Kernl knew the truth", async () => {
    const { tm, ids } = await story();
    const s = await tm.asOf("Lucía Ferreyra", "2026-10-15T00:00:00Z");
    expect(state(s, ids.andina)).toBe("known");
    expect(state(s, ids.delta)).toBe("absent");
    expect(s.gaps).toBe(0);
  });

  it("between the move and the news, the old employer is stale and the new one not yet known", async () => {
    const { tm, ids } = await story();
    const s = await tm.asOf("Person:l", "2026-11-10T14:30:00Z");
    expect(state(s, ids.andina)).toBe("stale");
    expect(state(s, ids.delta)).toBe("unknown");
    expect(state(s, ids.city)).toBe("known");
    expect(s.gaps).toBe(2);
    // Who wrote the stale belief, and what the new value replaced.
    expect(s.facts.find((f) => f.id === ids.andina)?.written_by?.name).toBe("Ana · CRM");
    expect(s.facts.find((f) => f.id === ids.delta)?.replaces).toEqual({ id: ids.andina, how: "change" });
  });

  it("asked for it, the snapshot carries Relate's PROFILE of the same statement", async () => {
    const { tm } = await story();
    const s = await tm.asOf("Lucía Ferreyra", "2026-11-10T14:30:00Z", { profile: true });
    expect(s.profile).toBeTruthy();
    expect(s.profile!.rows).toBe(s.facts.length);
    expect(s.profile!.operators.length).toBeGreaterThan(1);
    // The walk starts from the person's index, not from a scan of every fact.
    expect(s.profile!.operators.some((o) => o.start?.startsWith("index"))).toBe(true);
    expect(s.profile!.phases).toBeTruthy();
  });

  it("between two moments, one query says what changed and how", async () => {
    const { tm, ids } = await story();
    const d = await tm.diff("Lucía Ferreyra", "2026-11-10T14:30:00Z", "2026-11-12T15:00:00Z");
    const by = Object.fromEntries(d.changes.map((c) => [c.id, `${c.before}→${c.after}`]));
    expect(by[ids.andina]).toBe("stale→absent");
    expect(by[ids.delta]).toBe("unknown→known");
    expect(by[ids.city]).toBeUndefined();
  });

  it("after the news, the graph is right again", async () => {
    const { tm, ids } = await story();
    const s = await tm.asOf("Lucía Ferreyra", "2026-11-12T15:00:00Z");
    expect(state(s, ids.andina)).toBe("absent");
    expect(state(s, ids.delta)).toBe("known");
    expect(s.gaps).toBe(0);
  });
});

// An agent's story replays what its runs did with lessons: those it was given
// (recalled, with who learned them) are not those it kept (created), and the
// confidence each run moved sends a spark back to the lesson's owner.
describe("the time machine's lesson replay", () => {
  it("tells recalled lessons from created ones, and replays the reinforcement", async () => {
    const { agentsMigrations } = await import("../src/modules/agents/migrations.js");
    const { AgentMemoryService } = await import("../src/modules/agents/services/memory-service.js");
    const db = new Database(":memory:");
    runMigrations(db as never, "agents", agentsMigrations);
    db.exec(`CREATE TABLE tool_provenance (id TEXT, call_id TEXT, at TEXT, actor_kind TEXT, actor_id TEXT, actor_name TEXT,
      run_id TEXT, tool TEXT, ok INTEGER, ref TEXT, detail TEXT)`);
    const at = "2026-11-10T10:00:00.000Z";
    for (const [id, name] of [["ana", "Ana"], ["bruno", "Bruno"]]) {
      db.prepare("INSERT INTO agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, at, at);
    }
    db.prepare("INSERT INTO agent_runs (id, agent_id, goal, status, created_at, completed_at) VALUES ('r1', 'bruno', 'send the mail', 'completed', ?, ?)")
      .run("2026-11-11T10:00:00.000Z", "2026-11-11T10:05:00.000Z");
    const mem = new AgentMemoryService(db as never);
    const anas = mem.addLearning({ agent_id: "ana", type: "avoid", content: "Check the address", confidence: 0.5 });
    db.prepare("UPDATE agent_learnings SET created_at = ? WHERE id = ?").run("2026-11-01T09:00:00.000Z", anas.id);
    mem.recordInjectedLearnings("r1", [anas.id], true);
    const own = mem.addLearning({ agent_id: "bruno", type: "prefer", content: "Mail before noon", source_runs: ["r1"], source: "auto" });
    db.prepare("UPDATE agent_learnings SET created_at = ? WHERE id = ?").run("2026-11-11T10:05:30.000Z", own.id);
    mem.reinforceLearningsForRun("bruno", "2026-11-11T10:00:00.000Z", "success", "r1");

    const tm = new TimeMachine(db as never, () => null, async () => {});
    const s = tm.agentStory("bruno");
    const kinds = s.replay.map((e) => e.event);
    const recalled = s.replay.find((e) => e.event === "learning_recalled")!;
    expect((recalled.data.items as Array<Record<string, unknown>>)[0]).toMatchObject({ learning_id: anas.id, source_agent_id: "ana", source_agent_name: "Ana", shared: true });
    // Ana's lesson is recalled, never shown as one Bruno created; his own is.
    expect(kinds.filter((k) => k === "learning_created")).toHaveLength(1);
    const reinforced = s.replay.find((e) => e.event === "learning_reinforced")!;
    expect(reinforced.data.outcome).toBe("success");
    expect((reinforced.data.items as Array<Record<string, unknown>>)[0]).toMatchObject({ owner_agent_id: "ana", shared: true, before: 0.5 });
    expect(kinds.indexOf("learning_recalled")).toBeLessThan(kinds.indexOf("learning_reinforced"));
    expect(s.ticks.some((t) => t.label === "Bruno recalls 1 lesson(s) from Ana")).toBe(true);
  });
});
