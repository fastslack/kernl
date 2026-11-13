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
import { shoppingMigrations } from "../assets/extensions/home/shopping/_module/migrations/001_shopping.js";
import { ShoppingService } from "../assets/extensions/home/shopping/_module/service.js";
import { googleSyncMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/001_google_sync.js";
import { fullSyncMigrations } from "../assets/extensions/integration/google-sync/_module/migrations/002_full_sync.js";
import { GoogleGraphSync } from "../assets/extensions/integration/google-sync/_module/graph-sync.js";

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
  it("projects shopping and Google mail and calendar rows", async () => {
    const db = new Database(":memory:");
    runMigrations(db as never, "shopping", shoppingMigrations);
    runMigrations(db as never, "crm", crmMigrations);
    runMigrations(db as never, "google-sync", googleSyncMigrations);
    runMigrations(db as never, "google-sync-full", fullSyncMigrations);
    const off = () => null;
    const shop = new ShoppingService(db as never, off);
    const crm = new CrmService(db as never, off);

    const food = shop.createCategory({ name: "Food" });
    const dairy = shop.createCategory({ name: "Dairy", parent_id: food.id });
    const store = shop.createStore({ name: "Corner shop" });
    const milk = shop.createProduct({ name: "Milk", category_id: dairy.id })!;
    shop.logPurchase({ product_id: milk.id, store_id: store.id, quantity: 1, unit_price: 1.1, purchased_at: "2026-11-01" });
    shop.logPurchase({ product_id: milk.id, store_id: store.id, quantity: 2, unit_price: 1.3, purchased_at: "2026-11-09" });

    crm.addContact({ name: "Ada", email: "ada@example.com", relationship: "personal" });
    const now = "2026-11-10T10:00:00Z";
    db.prepare(`INSERT INTO google_emails (id, gmail_id, thread_id, from_email, to_emails, subject, date, created_at)
                VALUES ('e1', 'g1', 't1', 'Ada@example.com', 'me@example.com', 'Hello', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO google_email_threads (id, gmail_thread_id, subject, message_count, created_at, updated_at)
                VALUES ('th1', 't1', 'Hello', 1, ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO google_calendar_events (id, google_event_id, title, start_at, organizer_email, attendees, created_at, updated_at)
                VALUES ('c1', 'ev1', 'Coffee', ?, 'ada@example.com', '[]', ?, ?)`).run(now, now, now);

    const g = await memoryGraph();
    const sync = new GoogleGraphSync(db as never, () => g);
    const mods = [
      { name: "crm", getGraphBackfill: () => ({ name: "crm", version: 1, order: 10, run: (x: GraphDriver) => crm.graphBackfill(x) }) },
      { name: "shopping", getGraphBackfill: () => ({ name: "shopping", version: 1, order: 20, run: (x: GraphDriver) => shop.graphBackfill(x) }) },
      { name: "google-sync", getGraphBackfill: () => ({ name: "google-sync", version: 1, order: 30, run: async () => {
        await sync.createConstraints();
        const r = await sync.syncAll();
        return { nodes: r.emailNodes + r.threadNodes + r.calendarNodes, relationships: r.sentRels + r.partOfRels + r.organizedRels };
      } }) },
    ] as unknown as KernelModule[];
    const out = await runGraphBackfills(collectGraphBackfills(mods), g);
    expect(out.map((o) => `${o.name}:${o.status}`)).toEqual(["crm:done", "shopping:done", "google-sync:done"]);

    expect(await count(g, "MATCH (:Category {name: 'Dairy'})-[:CHILD_OF]->(:Category {name: 'Food'}) RETURN count(*) AS n")).toBe(1);
    expect(await count(g, "MATCH (:Product {name: 'Milk'})-[:IN_CATEGORY]->(:Category {name: 'Dairy'}) RETURN count(*) AS n")).toBe(1);
    const bought = (await g.run("MATCH (:Product)-[r:BOUGHT_AT]->(:Store) RETURN r.purchase_count AS c, r.last_price AS p, r.last_date AS d")).records[0].toObject();
    expect({ c: Number(bought.c), p: bought.p, d: bought.d }).toEqual({ c: 2, p: 1.3, d: "2026-11-09" });

    expect(await count(g, "MATCH (:Person {name: 'Ada'})-[:SENT]->(:Email {subject: 'Hello'})-[:PART_OF]->(:EmailThread) RETURN count(*) AS n")).toBe(1);
    expect(await count(g, "MATCH (:Person {name: 'Ada'})-[:ORGANIZED]->(:CalendarEvent {title: 'Coffee'}) RETURN count(*) AS n")).toBe(1);
  });
});

describe("backfill passes asked for while one runs", () => {
  it("a pass requested during a running one runs right after it, and graphReplaced() reaches every subscriber", async () => {
    const { scheduleGraphBackfills, graphReplaced, onGraphReplaced } = await import("../src/core/graph-backfill.js");
    let passes = 0;
    let release: (() => void) | null = null;
    // A graph whose first pass hangs until released: the boot pass on the old store.
    const graph = {
      capabilities: { cypher: true },
      run: async (q: string) => {
        if (q.startsWith("MATCH (m:KernlGraphBackfill")) {
          passes++;
          if (passes === 1) await new Promise<void>((r) => { release = r; });
        }
        return { records: [] };
      },
    } as unknown as GraphDriver;
    const mod = { name: "m", getGraphBackfill: () => ({ name: "m", version: 1, run: async () => ({ nodes: 0, relationships: 0 }) }) } as unknown as KernelModule;
    const stop = scheduleGraphBackfills(() => [mod], () => graph, { firstDelayMs: 0, everyMs: 60_000 });
    const heard: string[] = [];
    const off = onGraphReplaced(() => heard.push("replaced"));
    try {
      await new Promise((r) => setTimeout(r, 20));
      expect(passes).toBe(1);
      graphReplaced(); // asked while the first pass is still running
      expect(heard).toEqual(["replaced"]);
      release!();
      await new Promise((r) => setTimeout(r, 30));
      expect(passes).toBe(2);
    } finally {
      off();
      stop();
    }
    graphReplaced();
    expect(heard).toEqual(["replaced"]);
  });
});

describe("a backfill pass on a store that was switched out", () => {
  it("does not hold up the pass on the new store, even if it never finishes", async () => {
    const { scheduleGraphBackfills, requestGraphBackfillPass } = await import("../src/core/graph-backfill.js");
    const seen: string[] = [];
    const hangs = {
      capabilities: { cypher: true },
      run: async (q: string) => { if (q.startsWith("MATCH (m:KernlGraphBackfill")) { seen.push("old"); await new Promise(() => {}); } return { records: [] }; },
    } as unknown as GraphDriver;
    const fresh = {
      capabilities: { cypher: true },
      run: async (q: string) => { if (q.startsWith("MATCH (m:KernlGraphBackfill")) seen.push("new"); return { records: [] }; },
    } as unknown as GraphDriver;
    let active: GraphDriver = hangs;
    const mod = { name: "m", getGraphBackfill: () => ({ name: "m", version: 1, run: async () => ({ nodes: 0, relationships: 0 }) }) } as unknown as KernelModule;
    const stop = scheduleGraphBackfills(() => [mod], () => active, { firstDelayMs: 0, everyMs: 60_000 });
    try {
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual(["old"]);
      active = fresh; // the live switch: the old driver is stopped and never answers
      requestGraphBackfillPass();
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual(["old", "new"]);
    } finally {
      stop();
    }
  });
});
