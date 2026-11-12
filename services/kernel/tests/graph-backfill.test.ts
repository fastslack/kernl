import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { collectGraphBackfills, runGraphBackfills } from "../src/core/graph-backfill.js";
import type { GraphBackfill, KernelModule } from "../src/core/types.js";
import type { GraphDriver } from "../src/core/db-drivers/graph-driver.js";
import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { goalsMigrations } from "../assets/extensions/productivity/goals/_module/migrations/001_goals.js";
import { notesMigrations } from "../assets/extensions/productivity/notes/_module/migrations/001_notes.js";
import { remindersMigrations } from "../assets/extensions/productivity/reminders/_module/migrations/001_reminders.js";
import { TaskService } from "../assets/extensions/productivity/tasks/_module/service.js";
import { CrmService } from "../assets/extensions/people/crm/_module/service.js";
import { GoalsService } from "../assets/extensions/productivity/goals/_module/service.js";
import { NotesService } from "../assets/extensions/productivity/notes/_module/service.js";
import { ReminderService } from "../assets/extensions/productivity/reminders/_module/service.js";

async function memoryGraph(): Promise<GraphDriver> {
  const g = new RelateGraphDriver();
  g.configure({ path: ":memory:" });
  await g.start();
  return g;
}

const count = async (g: GraphDriver, cypher: string) => Number((await g.run(cypher)).records[0].get("n"));

describe("collectGraphBackfills", () => {
  it("orders by `order`, then name, and keeps the first of a name", () => {
    const b = (name: string, order?: number): GraphBackfill => ({ name, version: 1, order, run: async () => ({ nodes: 0, relationships: 0 }) });
    const mods = [
      { name: "z", getGraphBackfill: () => b("notes", 20) },
      { name: "y", getGraphBackfill: () => b("tasks", 10) },
      { name: "x", getGraphBackfill: () => b("crm", 10) },
      { name: "w", getGraphBackfill: () => b("tasks", 1) },
      { name: "v" },
      { name: "u", getGraphBackfill: () => { throw new Error("broken"); } },
    ] as unknown as KernelModule[];
    expect(collectGraphBackfills(mods).map((x) => `${x.name}:${x.order}`)).toEqual(["crm:10", "tasks:10", "notes:20"]);
  });
});

describe.skipIf(!relateClientInstalled())("graph backfill on Relate", () => {
  it("runs each backfill once per store, again on a new version, and survives a failing one", async () => {
    const g = await memoryGraph();
    let runs = 0;
    const ok: GraphBackfill = { name: "ok", version: 1, run: async () => { runs++; return { nodes: 3, relationships: 1 }; } };
    const bad: GraphBackfill = { name: "bad", version: 1, run: async () => { throw new Error("boom"); } };

    const first = await runGraphBackfills([bad, ok], g);
    expect(first.map((o) => `${o.name}:${o.status}`)).toEqual(["bad:failed", "ok:done"]);
    expect((await runGraphBackfills([ok], g))[0].status).toBe("skipped");
    expect(runs).toBe(1);
    expect((await runGraphBackfills([{ ...ok, version: 2 }], g))[0].status).toBe("done");
    expect(runs).toBe(2);
    // The failed one is retried on the next pass.
    expect((await runGraphBackfills([bad], g))[0].status).toBe("failed");
    expect(await runGraphBackfills([ok], null)).toEqual([]);
  });

  it("projects what was created while the graph was off, as the modules do on write", async () => {
    const db = new Database(":memory:");
    for (const [key, m] of [["tasks", tasksMigrations], ["crm", crmMigrations], ["goals", goalsMigrations], ["notes", notesMigrations], ["reminders", remindersMigrations]] as const) {
      runMigrations(db as never, key, m);
    }
    // The graph is off while these are written.
    const off = () => null;
    const tasks = new TaskService(db as never, off);
    const crm = new CrmService(db as never, off);
    const goals = new GoalsService(db as never, off);
    const notes = new NotesService(db as never, off);
    const reminders = new ReminderService(db as never, off);

    const t1 = tasks.create({ title: "Write the report", priority: "high" });
    const t2 = tasks.create({ title: "Collect the numbers" });
    tasks.addDependency(t1.id, t2.id);
    const ada = crm.addContact({ name: "Ada", email: "ada@example.com", company: "Analytical" });
    crm.logInteraction({ contact_id: ada.id, type: "email", summary: "sent the draft", date: "2026-11-10" });
    const goal = goals.createGoal({ title: "Ship Q4" });
    goals.addKeyResult({ goal_id: goal.id, title: "report out", task_id: t1.id });
    notes.create({ title: "Report outline", tags: "work", contact_id: ada.id, task_id: t1.id });
    reminders.create({ title: "Chase numbers", trigger_at: "2026-11-12T09:00:00Z", task_id: t2.id });

    const g = await memoryGraph();
    expect(await count(g, "MATCH (n) RETURN count(n) AS n")).toBe(0);

    const mods = [
      { name: "reminders", getGraphBackfill: () => ({ name: "reminders", version: 1, order: 20, run: (x: GraphDriver) => reminders.graphBackfill(x) }) },
      { name: "notes", getGraphBackfill: () => ({ name: "notes", version: 1, order: 20, run: (x: GraphDriver) => notes.graphBackfill(x) }) },
      { name: "goals", getGraphBackfill: () => ({ name: "goals", version: 1, order: 20, run: (x: GraphDriver) => goals.graphBackfill(x) }) },
      { name: "crm", getGraphBackfill: () => ({ name: "crm", version: 1, order: 10, run: (x: GraphDriver) => crm.graphBackfill(x) }) },
      { name: "tasks", getGraphBackfill: () => ({ name: "tasks", version: 1, order: 10, run: (x: GraphDriver) => tasks.graphBackfill(x) }) },
    ] as unknown as KernelModule[];
    const out = await runGraphBackfills(collectGraphBackfills(mods), g);
    expect(out.every((o) => o.status === "done")).toBe(true);

    expect(await count(g, "MATCH (t:Task {priority: 'high', title: 'Write the report'}) RETURN count(t) AS n")).toBe(1);
    expect(await count(g, "MATCH (:Task {id: '" + t1.id + "'})-[:DEPENDS_ON]->(:Task {id: '" + t2.id + "'}) RETURN count(*) AS n")).toBe(1);
    expect((await g.run("MATCH (p:Person) RETURN p.lastInteraction AS d, p.company AS c")).records[0].toObject()).toMatchObject({ d: "2026-11-10", c: "Analytical" });
    expect(await count(g, "MATCH (:Goal)-[:ACHIEVED_BY]->(:Task) RETURN count(*) AS n")).toBe(1);
    expect(await count(g, "MATCH (:Note)-[:RELATES_TO]->(x) WHERE x:Person OR x:Task RETURN count(*) AS n")).toBe(2);
    expect(await count(g, "MATCH (:Reminder)-[:REMINDS_ABOUT]->(:Task) RETURN count(*) AS n")).toBe(1);

    // Idempotent: a second pass on the same store does nothing new.
    const again = await runGraphBackfills(collectGraphBackfills(mods), g);
    expect(again.every((o) => o.status === "skipped")).toBe(true);
    expect(await count(g, "MATCH (n) WHERE NOT n:KernlGraphBackfill RETURN count(n) AS n")).toBe(6);
  });
});
