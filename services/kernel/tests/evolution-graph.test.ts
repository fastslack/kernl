import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { EvolutionGraph, versionKey } from "../src/modules/agents/services/evolution-graph.js";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";

describe.skipIf(!relateClientInstalled())("instruction versions and improvement cycles in the built-in graph", () => {
  const drivers: RelateGraphDriver[] = [];
  afterEach(async () => { for (const d of drivers.splice(0)) await d.stop(); });

  async function setup() {
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    drivers.push(g);
    const db = new Database(":memory:");
    runMigrations(db as never, "agents", agentsMigrations);
    const s = new AgentService(db as never, new EventBus());
    const flow = s.createFlow({ name: "Ops" } as never);
    const agent = s.createAgent({ name: "Closer", description: "x", flow_id: flow.id, active: true } as never);
    // Start from a clean lineage whatever createAgent seeded.
    db.run("DELETE FROM agent_prompt_versions WHERE agent_id = ?", [agent.id]);
    const version = (v: number, parent: number, source: string, active: boolean, at: string) =>
      db.run(
        `INSERT INTO agent_prompt_versions (id, agent_id, version, system_prompt, goal_template, parent_version, source, note, active, created_at)
         VALUES (?, ?, ?, ?, '', ?, ?, '', ?, ?)`,
        [`pv-${v}`, agent.id, v, `You close issues. Version ${v}.`, parent, source, active ? 1 : 0, at],
      );
    version(1, 0, "initial", false, "2026-10-01T10:00:00Z");
    version(2, 1, "reflection", false, "2026-10-05T10:00:00Z");
    version(3, 2, "manual", true, "2026-10-09T10:00:00Z");
    const cycle = (id: string, status: string, base: number, candidate: number, triggers: string[], at: string) =>
      db.run(
        `INSERT INTO agent_evolution_runs (id, agent_id, base_version, candidate_version, hypothesis, proposal, status,
           baseline_score, candidate_score, trigger_run_ids, evaluation, error, created_at, committed_at)
         VALUES (?, ?, ?, ?, 'It narrates tool output instead of running the tool.', 'new prompt', ?, 4, 7, ?, 'judge: fixes it', '', ?, ?)`,
        [id, agent.id, base, candidate, status, JSON.stringify(triggers), at, status === "accepted" ? at : null],
      );
    cycle("ev-1", "accepted", 1, 2, ["run-a", "run-b"], "2026-10-05T09:00:00Z");
    cycle("ev-2", "failed", 3, 0, [], "2026-10-10T09:00:00Z");
    return { g, db, s, agentId: agent.id, eg: new EvolutionGraph(db as never, () => g) };
  }

  const one = async (g: RelateGraphDriver, cypher: string, params: Record<string, unknown> = {}) =>
    (await g.run(cypher, params)).records.map((r) => r.toObject());

  it("an agent's lineage, the cycle that wrote a version and the runs that started it, in one traversal", async () => {
    const { g, agentId, eg } = await setup();
    expect(await eg.sync()).toBe(5);

    const lineage = await one(g,
      `MATCH (:Agent {id: $a})-[:HAS_VERSION]->(v:PromptVersion)
       OPTIONAL MATCH (v)-[:REVISES]->(p:PromptVersion)
       RETURN v.version AS v, p.version AS parent, v.source AS source, v.active AS active ORDER BY v`,
      { a: agentId });
    expect(lineage.map((r) => [Number(r.v), r.parent === null ? null : Number(r.parent), r.source, r.active])).toEqual([
      [1, null, "initial", false], [2, 1, "reflection", false], [3, 2, "manual", true],
    ]);

    const cycle = await one(g,
      `MATCH (e:EvolutionRun {id: 'ev-1'})-[:FROM_VERSION]->(b:PromptVersion), (e)-[:PROPOSED]->(c:PromptVersion)
       OPTIONAL MATCH (e)-[:TRIGGERED_BY]->(r:AgentRun)
       RETURN b.version AS base, c.version AS candidate, e.delta AS delta, e.status AS status, collect(r.id) AS runs`);
    expect(Number(cycle[0].base)).toBe(1);
    expect(Number(cycle[0].candidate)).toBe(2);
    expect(Number(cycle[0].delta)).toBe(3);
    expect(cycle[0].status).toBe("accepted");
    expect([...(cycle[0].runs as string[])].sort()).toEqual(["run-a", "run-b"]);

    // A failed cycle proposed nothing; times are native datetimes, so "cycles in October" is a range test.
    const failed = await one(g, "MATCH (e:EvolutionRun {id: 'ev-2'}) OPTIONAL MATCH (e)-[:PROPOSED]->(c) RETURN count(c) AS proposed");
    expect(Number(failed[0].proposed)).toBe(0);
    const october = await one(g,
      "MATCH (e:EvolutionRun) WHERE e.created_at >= datetime('2026-10-01T00:00:00Z') AND e.created_at < datetime('2026-11-01T00:00:00Z') RETURN count(e) AS n");
    expect(Number(october[0].n)).toBe(2);
    expect(versionKey(agentId, 3)).toBe(`${agentId}#3`);
  });

  it("does nothing when nothing changed, and follows an activation and rows SQLite no longer has", async () => {
    const { g, db, agentId, eg } = await setup();
    await eg.sync();
    expect(await eg.sync()).toBe(0);

    db.run("UPDATE agent_prompt_versions SET active = CASE version WHEN 2 THEN 1 ELSE 0 END WHERE agent_id = ?", [agentId]);
    expect(await eg.sync()).toBeGreaterThan(0);
    const active = await one(g, "MATCH (v:PromptVersion {active: true}) RETURN v.version AS v");
    expect(active.map((r) => Number(r.v))).toEqual([2]);

    // An agent removed for good: its rows go with it (deleteAgent only deactivates, and keeps them).
    db.run("DELETE FROM agent_evolution_runs WHERE agent_id = ?", [agentId]);
    db.run("DELETE FROM agent_prompt_versions WHERE agent_id = ?", [agentId]);
    await eg.sync();
    const left = await one(g, "MATCH (v:PromptVersion) RETURN count(v) AS v UNION ALL MATCH (e:EvolutionRun) RETURN count(e) AS v");
    expect(left.map((r) => Number(r.v))).toEqual([0, 0]);
  });

  it("projects everything again onto a new store, though nothing changed in SQLite", async () => {
    const { g, db } = await setup();
    let active = g;
    const eg = new EvolutionGraph(db as never, () => active);
    expect(await eg.sync()).toBe(5);
    const fresh = new RelateGraphDriver();
    fresh.configure({ path: ":memory:" });
    await fresh.start();
    drivers.push(fresh);
    active = fresh; // the live switch to another store
    expect(await eg.sync()).toBe(5);
    expect(await eg.sync()).toBe(0);
  });
});
