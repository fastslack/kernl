import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { remindersMigrations } from "../assets/extensions/productivity/reminders/_module/migrations/001_reminders.js";
import { shoppingMigrations } from "../assets/extensions/home/shopping/_module/migrations/001_shopping.js";
import { commsMigrations } from "../assets/extensions/people/comms/_module/migrations.js";
import { lifeMigrations } from "../assets/extensions/home/life/_module/life-migrations.js";
import {
  queryDailySummary,
  queryHabits,
  queryWaterIntake,
  queryMoodLog,
} from "../src/modules/dashboard/life-queries.js";
import {
  computeMoonPhase,
  computeWorldClocks,
  computeEaster,
  computeHolidays,
  getDailyQuote,
} from "../assets/extensions/home/life/_module/life-service.js";
import {
  queryKpis,
  queryFullDashboard,
  queryAgenda,
  CORE_KPI_CHANNELS,
} from "../src/modules/dashboard/api.js";
import { DashboardRegistry } from "../src/core/dashboard-registry.js";
import type { Neo4jClient } from "../src/core/db/neo4j.js";
import { queryTasks, type DashboardTasks } from "../assets/extensions/productivity/tasks/_module/dashboard-queries.js";
import { queryCrm, type DashboardCrm } from "../assets/extensions/people/crm/_module/dashboard-queries.js";
import { queryReminders } from "../assets/extensions/productivity/reminders/_module/dashboard-queries.js";
import { queryShopping } from "../assets/extensions/home/shopping/_module/dashboard-queries.js";
import { createTasksModule } from "../assets/extensions/productivity/tasks/_module/index.js";
import { createCrmModule } from "../assets/extensions/people/crm/_module/index.js";
import { createRemindersModule } from "../assets/extensions/productivity/reminders/_module/index.js";
import { createShoppingModule } from "../assets/extensions/home/shopping/_module/index.js";
import { queryComms } from "../assets/extensions/people/comms/_module/dashboard-queries.js";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "tasks", tasksMigrations);
  runMigrations(db, "crm", crmMigrations);
  runMigrations(db, "reminders", remindersMigrations);
  runMigrations(db, "shopping", shoppingMigrations);
  return db;
}

function setupDbWithComms(): Database {
  const db = setupDb();
  runMigrations(db, "comms", commsMigrations);
  return db;
}

const now = new Date().toISOString();
const today = now.split("T")[0];

describe("Dashboard API queries", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── queryKpis ──────────────────────────────────────────

  describe("queryKpis", () => {
    it("returns zeroes on empty DB", () => {
      const kpis = queryKpis(db);
      expect(kpis.tasks.total).toBe(0);
      expect(kpis.tasks.open).toBe(0);
      expect(kpis.tasks.done).toBe(0);
      expect(kpis.tasks.blocked).toBe(0);
      expect(kpis.contacts.total).toBe(0);
      expect(kpis.reminders.total).toBe(0);
      expect(kpis.reminders.active).toBe(0);
      expect(kpis.shopping.products).toBe(0);
      expect(kpis.shopping.lowStock).toBe(0);
    });

    it("counts tasks correctly", () => {
      db.prepare(
        `INSERT INTO tasks (id, title, status, priority, created_at, updated_at)
         VALUES ('t1','A','todo','medium',?,?), ('t2','B','done','low',?,?), ('t3','C','blocked','high',?,?)`,
      ).run(now, now, now, now, now, now);

      const kpis = queryKpis(db);
      expect(kpis.tasks.total).toBe(3);
      expect(kpis.tasks.open).toBe(2); // todo + blocked
      expect(kpis.tasks.done).toBe(1);
      expect(kpis.tasks.blocked).toBe(1);
    });

    it("counts contacts and reminders", () => {
      db.prepare(
        `INSERT INTO contacts (id, name, relationship, created_at, updated_at)
         VALUES ('c1','Alice','personal',?,?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO reminders (id, title, trigger_at, status, created_at, updated_at)
         VALUES ('r1','Call','${now}','active',?,?), ('r2','Meet','${now}','fired',?,?)`,
      ).run(now, now, now, now);

      const kpis = queryKpis(db);
      expect(kpis.contacts.total).toBe(1);
      expect(kpis.reminders.total).toBe(2);
      expect(kpis.reminders.active).toBe(1);
    });

    it("counts low stock products", () => {
      db.prepare(
        `INSERT INTO products (id, name, current_stock, min_stock, created_at, updated_at)
         VALUES ('p1','Milk',2,5,?,?), ('p2','Bread',10,3,?,?)`,
      ).run(now, now, now, now);

      const kpis = queryKpis(db);
      expect(kpis.shopping.products).toBe(2);
      expect(kpis.shopping.lowStock).toBe(1);
    });
  });

  // ── queryTasks ─────────────────────────────────────────

  describe("queryTasks", () => {
    it("returns empty distributions on empty DB", () => {
      const tasks = queryTasks(db);
      expect(tasks.byStatus).toEqual({});
      expect(tasks.byPriority).toEqual({});
      expect(tasks.overdue).toEqual([]);
      expect(tasks.dueSoon).toEqual([]);
      expect(tasks.recentlyCompleted).toEqual([]);
    });

    it("detects overdue and due-soon tasks", () => {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];

      db.prepare(
        `INSERT INTO tasks (id, title, status, priority, due_date, created_at, updated_at)
         VALUES ('t1','Overdue','todo','high',?,?,?), ('t2','Today','in_progress','urgent',?,?,?)`,
      ).run(yesterday, now, now, today, now, now);

      const tasks = queryTasks(db);
      expect(tasks.overdue).toHaveLength(1);
      expect(tasks.overdue[0].title).toBe("Overdue");
      expect(tasks.dueSoon).toHaveLength(1);
      expect(tasks.dueSoon[0].title).toBe("Today");
    });

    it("includes recently completed", () => {
      db.prepare(
        `INSERT INTO tasks (id, title, status, priority, completed_at, created_at, updated_at)
         VALUES ('t1','Done task','done','medium',?,?,?)`,
      ).run(now, now, now);

      const tasks = queryTasks(db);
      expect(tasks.recentlyCompleted).toHaveLength(1);
      expect(tasks.recentlyCompleted[0].title).toBe("Done task");
    });

    it("counts by context", () => {
      db.prepare(
        `INSERT INTO tasks (id, title, status, priority, context, created_at, updated_at)
         VALUES ('t1','A','todo','medium','@work',?,?), ('t2','B','todo','low','@work',?,?), ('t3','C','todo','high','@home',?,?)`,
      ).run(now, now, now, now, now, now);

      const tasks = queryTasks(db);
      expect(tasks.byContext["@work"]).toBe(2);
      expect(tasks.byContext["@home"]).toBe(1);
    });
  });

  // ── queryCrm ──────────────────────────────────────────

  describe("queryCrm", () => {
    it("detects stale contacts", () => {
      const staleDate = new Date(Date.now() - 45 * 86_400_000).toISOString().split("T")[0];

      db.prepare(
        `INSERT INTO contacts (id, name, relationship, last_interaction, created_at, updated_at)
         VALUES ('c1','Stale','personal',?,?,?), ('c2','Fresh','professional',?,?,?)`,
      ).run(staleDate, now, now, today, now, now);

      const crm = queryCrm(db);
      expect(crm.total).toBe(2);
      expect(crm.staleContacts).toHaveLength(1);
      expect(crm.staleContacts[0].name).toBe("Stale");
    });

    it("counts by relationship", () => {
      db.prepare(
        `INSERT INTO contacts (id, name, relationship, created_at, updated_at)
         VALUES ('c1','A','personal',?,?), ('c2','B','personal',?,?), ('c3','C','family',?,?)`,
      ).run(now, now, now, now, now, now);

      const crm = queryCrm(db);
      expect(crm.byRelationship.personal).toBe(2);
      expect(crm.byRelationship.family).toBe(1);
    });

    it("lists recent interactions", () => {
      db.prepare(
        `INSERT INTO contacts (id, name, relationship, created_at, updated_at)
         VALUES ('c1','Alice','personal',?,?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO interactions (id, contact_id, type, summary, date, created_at)
         VALUES ('i1','c1','call','Catch up',?,?)`,
      ).run(today, now);

      const crm = queryCrm(db);
      expect(crm.recentInteractions).toHaveLength(1);
      expect(crm.recentInteractions[0].contact_name).toBe("Alice");
    });
  });

  // ── queryReminders ────────────────────────────────────

  describe("queryReminders", () => {
    it("returns empty on empty DB", () => {
      const rem = queryReminders(db);
      expect(rem.upcoming24h).toEqual([]);
      expect(rem.overdue).toEqual([]);
      expect(rem.byStatus).toEqual({});
      expect(rem.firedToday).toBe(0);
      expect(rem.recurringCount).toBe(0);
    });

    it("counts recurring reminders", () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      db.prepare(
        `INSERT INTO reminders (id, title, trigger_at, status, repeat, created_at, updated_at)
         VALUES ('r1','Daily','${future}','active','daily',?,?), ('r2','Once','${future}','active','none',?,?)`,
      ).run(now, now, now, now);

      const rem = queryReminders(db);
      expect(rem.recurringCount).toBe(1);
      expect(rem.upcoming24h).toHaveLength(2);
    });
  });

  // ── queryShopping ─────────────────────────────────────

  describe("queryShopping", () => {
    it("returns low stock items", () => {
      db.prepare(
        `INSERT INTO products (id, name, current_stock, min_stock, unit, created_at, updated_at)
         VALUES ('p1','Milk',1,5,'liter',?,?)`,
      ).run(now, now);

      const shop = queryShopping(db);
      expect(shop.lowStock).toHaveLength(1);
      expect(shop.lowStock[0].name).toBe("Milk");
    });

    it("returns active lists with progress", () => {
      db.prepare(
        `INSERT INTO shopping_lists (id, name, status, created_at, updated_at)
         VALUES ('sl1','Groceries','active',?,?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO shopping_list_items (id, list_id, name, checked, created_at, updated_at)
         VALUES ('i1','sl1','Apples',1,?,?), ('i2','sl1','Bananas',0,?,?)`,
      ).run(now, now, now, now);

      const shop = queryShopping(db);
      expect(shop.activeLists).toHaveLength(1);
      expect(shop.activeLists[0].total).toBe(2);
      expect(shop.activeLists[0].checked).toBe(1);
    });
  });

  // ── queryFullDashboard ────────────────────────────────

  describe("queryFullDashboard", () => {
    // Wired the way bootstrap wires it: each extension contributes its own
    // channel, and the dashboard reads the sections through the registry.
    function coreKpiRegistry(): DashboardRegistry {
      const registry = new DashboardRegistry();
      for (const mod of [createTasksModule(), createCrmModule(), createRemindersModule(), createShoppingModule()]) {
        registry.registerModule(mod);
      }
      return registry;
    }

    function readerFor(registry: DashboardRegistry) {
      return (name: string) => registry.queryChannel(name, db, {} as Neo4jClient);
    }

    it("each core KPI section is a channel registered by its owning extension", () => {
      expect(coreKpiRegistry().getChannelNames().sort()).toEqual([...CORE_KPI_CHANNELS].sort());
    });

    it("integrates all sections", async () => {
      const dash = await queryFullDashboard(db, readerFor(coreKpiRegistry()));
      expect(dash.generatedAt).toBeTruthy();
      expect(dash.kpis).toBeDefined();
      expect(dash.tasks).toEqual(queryTasks(db));
      expect(dash.crm).toEqual(queryCrm(db));
      expect(dash.reminders).toEqual(queryReminders(db));
      expect(dash.shopping).toEqual(queryShopping(db));
    });

    it("leaves a section null when its extension is not active", async () => {
      const registry = new DashboardRegistry();
      registry.registerModule(createTasksModule());

      const dash = await queryFullDashboard(db, readerFor(registry));
      expect(dash.tasks).toEqual(queryTasks(db));
      expect(dash.crm).toBeNull();
      expect(dash.reminders).toBeNull();
      expect(dash.shopping).toBeNull();
    });

    it("reflects inserted data across modules", async () => {
      db.prepare(
        `INSERT INTO tasks (id, title, status, priority, created_at, updated_at)
         VALUES ('t1','Task','todo','high',?,?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO contacts (id, name, relationship, created_at, updated_at)
         VALUES ('c1','Bob','professional',?,?)`,
      ).run(now, now);

      const dash = await queryFullDashboard(db, readerFor(coreKpiRegistry()));
      expect(dash.kpis.tasks.total).toBe(1);
      expect(dash.kpis.contacts.total).toBe(1);
      expect((dash.tasks as DashboardTasks).byPriority.high).toBe(1);
      expect((dash.crm as DashboardCrm).total).toBe(1);
    });
  });
});

// ── queryAgenda ──────────────────────────────────

describe("queryAgenda", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

describe("queryAgenda", () => {
  it("returns 14-day structure", () => {
    const agenda = queryAgenda(db);
    expect(agenda.days).toHaveLength(14);
    expect(agenda.overdue).toBeDefined();
    expect(agenda.workloadForecast).toHaveLength(14);
  });

  it("includes tasks due today", () => {
    db.prepare(
      `INSERT INTO tasks (id, title, status, priority, due_date, created_at, updated_at)
       VALUES ('t1','Due today','todo','high',?,?,?)`,
    ).run(today, now, now);

    const agenda = queryAgenda(db);
    const todayDay = agenda.days.find((d) => d.isToday);
    expect(todayDay).toBeDefined();
    expect(todayDay!.items.some((i) => i.title === "Due today")).toBe(true);
  });

  it("includes overdue tasks", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];
    db.prepare(
      `INSERT INTO tasks (id, title, status, priority, due_date, created_at, updated_at)
       VALUES ('t1','Overdue','todo','high',?,?,?)`,
    ).run(yesterday, now, now);

    const agenda = queryAgenda(db);
    expect(agenda.overdue.length).toBeGreaterThanOrEqual(1);
    expect(agenda.overdue[0].title).toBe("Overdue");
  });

  it("populates workload forecast", () => {
    db.prepare(
      `INSERT INTO tasks (id, title, status, priority, due_date, created_at, updated_at)
       VALUES ('t1','A','todo','high',?,?,?)`,
    ).run(today, now, now);

    const agenda = queryAgenda(db);
    expect(agenda.workloadForecast[0].taskCount).toBe(1);
    expect(agenda.workloadForecast[0].total).toBeGreaterThanOrEqual(1);
  });
});
});

// ── Life Queries ────────────────────────────

function setupDbWithLife(): Database {
  const db = setupDb();
  runMigrations(db, "life", lifeMigrations);
  return db;
}

describe("Life queries", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDbWithLife();
  });

  afterEach(() => {
    db.close();
  });

  describe("queryDailySummary", () => {
    it("returns zeroes on empty tables", () => {
      const summary = queryDailySummary(db);
      expect(summary.tasksDone).toBe(0);
      expect(summary.tasksCreated).toBe(0);
      expect(summary.interactions).toBe(0);
      expect(summary.remindersFired).toBe(0);
      expect(summary.purchases).toBe(0);
    });

    it("crosses module tables for today", () => {
      // Add a done task today
      db.prepare(
        `INSERT INTO tasks (id, title, status, priority, created_at, updated_at)
         VALUES ('t1','Done today','done','medium',?,?)`,
      ).run(now, now);

      // Add an interaction today
      db.prepare(
        `INSERT INTO contacts (id, name, relationship, created_at, updated_at)
         VALUES ('c1','Alice','personal',?,?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO interactions (id, contact_id, type, date, created_at)
         VALUES ('i1','c1','call',?,?)`,
      ).run(today, now);

      const summary = queryDailySummary(db);
      expect(summary.tasksDone).toBe(1);
      expect(summary.tasksCreated).toBe(1);
      expect(summary.interactions).toBe(1);
    });
  });

  describe("queryWaterIntake", () => {
    it("returns zero on empty life_log", () => {
      const water = queryWaterIntake(db, today);
      expect(water.glasses).toBe(0);
      expect(water.goal).toBe(8);
    });

    it("counts water intake for today", () => {
      db.prepare(
        `INSERT INTO life_log (id, type, value, date, created_at)
         VALUES ('w1','water','',?,?), ('w2','water','',?,?), ('w3','water','',?,?)`,
      ).run(today, now, today, now, today, now);

      const water = queryWaterIntake(db, today);
      expect(water.glasses).toBe(3);
    });

    it("does not count other dates", () => {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0]!;
      db.prepare(
        `INSERT INTO life_log (id, type, value, date, created_at)
         VALUES ('w1','water','',?,?), ('w2','water','',?,?)`,
      ).run(today, now, yesterday, now);

      const water = queryWaterIntake(db, today);
      expect(water.glasses).toBe(1);
    });
  });

  describe("queryHabits", () => {
    it("returns empty array with no habits", () => {
      const habits = queryHabits(db, today);
      expect(habits).toEqual([]);
    });

    it("tracks habit done today", () => {
      db.prepare(
        `INSERT INTO life_log (id, type, value, date, created_at)
         VALUES ('h1','habit','meditate',?,?)`,
      ).run(today, now);

      const habits = queryHabits(db, today);
      expect(habits).toHaveLength(1);
      expect(habits[0].name).toBe("meditate");
      expect(habits[0].doneToday).toBe(true);
      expect(habits[0].streak).toBe(1);
    });

    it("calculates streaks across consecutive days", () => {
      const d0 = today;
      const d1 = new Date(Date.now() - 86_400_000).toISOString().split("T")[0]!;
      const d2 = new Date(Date.now() - 2 * 86_400_000).toISOString().split("T")[0]!;

      db.prepare(
        `INSERT INTO life_log (id, type, value, date, created_at)
         VALUES ('h1','habit','exercise',?,?), ('h2','habit','exercise',?,?), ('h3','habit','exercise',?,?)`,
      ).run(d0, now, d1, now, d2, now);

      const habits = queryHabits(db, today);
      expect(habits).toHaveLength(1);
      expect(habits[0].streak).toBe(3);
    });

    it("breaks streak on gap", () => {
      const d0 = today;
      const d2 = new Date(Date.now() - 2 * 86_400_000).toISOString().split("T")[0]!;
      // Skip d1 — gap breaks streak

      db.prepare(
        `INSERT INTO life_log (id, type, value, date, created_at)
         VALUES ('h1','habit','run',?,?), ('h2','habit','run',?,?)`,
      ).run(d0, now, d2, now);

      const habits = queryHabits(db, today);
      expect(habits[0].streak).toBe(1); // Only today counts
    });
  });

  describe("queryMoodLog", () => {
    it("returns empty array with no mood entries", () => {
      const moods = queryMoodLog(db, 7);
      expect(moods).toEqual([]);
    });

    it("returns mood entries with parsed values", () => {
      db.prepare(
        `INSERT INTO life_log (id, type, value, date, created_at)
         VALUES ('m1','mood','4',?,?), ('m2','mood','5',?,?)`,
      ).run(today, now, new Date(Date.now() - 86_400_000).toISOString().split("T")[0]!, now);

      const moods = queryMoodLog(db, 7);
      expect(moods).toHaveLength(2);
      expect(moods[0].value).toBe(4);
      expect(moods[1].value).toBe(5);
    });

    it("limits results to requested days", () => {
      for (let i = 0; i < 10; i++) {
        const d = new Date(Date.now() - i * 86_400_000).toISOString().split("T")[0]!;
        db.prepare(
          `INSERT INTO life_log (id, type, value, date, created_at)
           VALUES (?,'mood','3',?,?)`,
        ).run(`m${i}`, d, now);
      }

      const moods = queryMoodLog(db, 5);
      expect(moods).toHaveLength(5);
    });
  });
});

// ── Life Service pure functions ─────────────

describe("Life Service pure functions", () => {
  it("computeMoonPhase returns valid phase data", () => {
    const moon = computeMoonPhase(new Date());
    expect(moon.phase).toBeTruthy();
    expect(moon.illumination).toBeGreaterThanOrEqual(0);
    expect(moon.illumination).toBeLessThanOrEqual(100);
    expect(moon.emoji).toBeTruthy();
    expect(moon.age).toBeGreaterThanOrEqual(0);
    expect(moon.age).toBeLessThan(30);
  });

  it("computeMoonPhase known new moon date", () => {
    // Jan 6, 2000 was a new moon reference
    const moon = computeMoonPhase(new Date(2000, 0, 6, 18, 14, 0));
    expect(moon.phase).toBe("New Moon");
    expect(moon.illumination).toBeLessThanOrEqual(5);
  });

  it("computeWorldClocks returns valid clocks", () => {
    const clocks = computeWorldClocks(["America/Buenos_Aires", "Asia/Tokyo"]);
    expect(clocks).toHaveLength(2);
    expect(clocks[0].city).toBe("Buenos Aires");
    expect(clocks[1].city).toBe("Tokyo");
    expect(clocks[0].time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("computeEaster returns correct dates", () => {
    // Known Easter dates
    const e2024 = computeEaster(2024);
    expect(e2024.getMonth()).toBe(2); // March (0-indexed)
    expect(e2024.getDate()).toBe(31);

    const e2025 = computeEaster(2025);
    expect(e2025.getMonth()).toBe(3); // April
    expect(e2025.getDate()).toBe(20);
  });

  it("computeHolidays returns upcoming holidays", () => {
    const holidays = computeHolidays();
    expect(holidays.length).toBeGreaterThan(0);
    expect(holidays.length).toBeLessThanOrEqual(8);
    // Should be sorted by daysUntil
    for (let i = 1; i < holidays.length; i++) {
      expect(holidays[i].daysUntil).toBeGreaterThanOrEqual(holidays[i - 1].daysUntil);
    }
    // All should be in the future or today
    holidays.forEach((h) => {
      expect(h.daysUntil).toBeGreaterThanOrEqual(0);
    });
  });

  it("getDailyQuote returns a quote with text and author", () => {
    const quote = getDailyQuote();
    expect(quote.text).toBeTruthy();
    expect(quote.author).toBeTruthy();
  });
});

// ── queryComms ──────────────────────────────────────

describe("queryComms", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDbWithComms();
  });

  afterEach(() => {
    db.close();
  });

  it("returns null when communications table does not exist", () => {
    const plainDb = new Database(":memory:");
    const result = queryComms(plainDb);
    expect(result).toBeNull();
    plainDb.close();
  });

  it("returns expanded KPIs on empty DB", () => {
    const cm = queryComms(db)!;
    expect(cm).not.toBeNull();
    expect(cm.kpis.total).toBe(0);
    expect(cm.kpis.drafts).toBe(0);
    expect(cm.kpis.sent).toBe(0);
    expect(cm.kpis.failed).toBe(0);
    expect(cm.kpis.archived).toBe(0);
    expect(cm.kpis.scheduled).toBe(0);
    expect(cm.kpis.channelsActive).toBe(0);
    expect(cm.kpis.threadCount).toBe(0);
    expect(cm.kpis.inbound).toBe(0);
    expect(cm.kpis.outbound).toBe(0);
  });

  it("counts inbound and outbound messages", () => {
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, created_at, updated_at)
       VALUES ('c1','email','outbound','sent','Out',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, created_at, updated_at)
       VALUES ('c2','email','inbound','sent','In',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, created_at, updated_at)
       VALUES ('c3','whatsapp','outbound','draft','Draft',?,?)`,
    ).run(now, now);

    const cm = queryComms(db)!;
    expect(cm.kpis.total).toBe(3);
    expect(cm.kpis.inbound).toBe(1);
    expect(cm.kpis.outbound).toBe(2);
    expect(cm.kpis.channelsActive).toBe(2);
    expect(cm.kpis.drafts).toBe(1);
    expect(cm.kpis.sent).toBe(2);
  });

  it("returns velocity with 8 weeks", () => {
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, sent_at, created_at, updated_at)
       VALUES ('c1','email','outbound','sent','Test',?,?,?)`,
    ).run(today, now, now);

    const cm = queryComms(db)!;
    expect(cm.velocity.length).toBe(8);
    // Last week should have at least 1 sent
    const lastWeek = cm.velocity[cm.velocity.length - 1];
    expect(lastWeek.sent).toBeGreaterThanOrEqual(1);
  });

  it("groups threads correctly", () => {
    // Create a thread with 3 messages
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, thread_id, created_at, updated_at)
       VALUES ('t1','email','outbound','sent','Thread subj','thread-abc',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, thread_id, created_at, updated_at)
       VALUES ('t2','email','inbound','sent','Re: Thread subj','thread-abc',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, thread_id, created_at, updated_at)
       VALUES ('t3','email','outbound','sent','Re: Re: Thread subj','thread-abc',?,?)`,
    ).run(now, now);
    // Single message (not a thread - thread_id equals id)
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, thread_id, created_at, updated_at)
       VALUES ('s1','email','outbound','sent','Solo','s1',?,?)`,
    ).run(now, now);

    const cm = queryComms(db)!;
    expect(cm.kpis.threadCount).toBe(1);
    expect(cm.threads.length).toBe(1);
    expect(cm.threads[0].thread_id).toBe("thread-abc");
    expect(cm.threads[0].message_count).toBe(3);
  });

  it("computes top contacts by volume", () => {
    // Add a contact
    db.prepare(
      `INSERT INTO contacts (id, name, email, phone, company, notes, created_at, updated_at)
       VALUES ('ct1','Alice Smith','alice@test.com','','','',?,?)`,
    ).run(now, now);
    // Add comms for that contact
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, contact_id, created_at, updated_at)
       VALUES ('c1','email','outbound','sent','Hi',  'ct1',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, contact_id, created_at, updated_at)
       VALUES ('c2','email','inbound','sent','Re: Hi','ct1',?,?)`,
    ).run(now, now);

    const cm = queryComms(db)!;
    expect(cm.topContacts.length).toBe(1);
    expect(cm.topContacts[0].name).toBe("Alice Smith");
    expect(cm.topContacts[0].total).toBe(2);
    expect(cm.topContacts[0].sent_count).toBe(1);
    expect(cm.topContacts[0].received_count).toBe(1);
  });

  it("returns failed messages with error_message", () => {
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, error_message, created_at, updated_at)
       VALUES ('f1','email','outbound','failed','Fail msg','SMTP timeout',?,?)`,
    ).run(now, now);

    const cm = queryComms(db)!;
    expect(cm.kpis.failed).toBe(1);
    expect(cm.failedMessages.length).toBe(1);
    expect(cm.failedMessages[0].error_message).toBe("SMTP timeout");
  });

  it("returns scheduled messages ordered by scheduled_at ASC", () => {
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, scheduled_at, created_at, updated_at)
       VALUES ('s1','email','outbound','draft','Later','2026-03-05T10:00:00Z',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, scheduled_at, created_at, updated_at)
       VALUES ('s2','email','outbound','ready','Sooner','2026-03-04T08:00:00Z',?,?)`,
    ).run(now, now);

    const cm = queryComms(db)!;
    expect(cm.kpis.scheduled).toBe(2);
    expect(cm.scheduledMessages.length).toBe(2);
    // First should be the sooner one
    expect(cm.scheduledMessages[0].id).toBe("s2");
    expect(cm.scheduledMessages[1].id).toBe("s1");
  });

  it("returns byDirection breakdown", () => {
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, created_at, updated_at)
       VALUES ('d1','email','inbound','sent','In1',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, created_at, updated_at)
       VALUES ('d2','email','outbound','sent','Out1',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, created_at, updated_at)
       VALUES ('d3','email','outbound','draft','Out2',?,?)`,
    ).run(now, now);

    const cm = queryComms(db)!;
    expect(cm.byDirection.inbound).toBe(1);
    expect(cm.byDirection.outbound).toBe(2);
  });

  it("returns recent activity ordered by updated_at DESC", () => {
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, created_at, updated_at)
       VALUES ('a1','email','outbound','sent','First',?,?)`,
    ).run("2026-03-01T10:00:00Z", "2026-03-01T10:00:00Z");
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, created_at, updated_at)
       VALUES ('a2','email','inbound','sent','Second',?,?)`,
    ).run("2026-03-02T10:00:00Z", "2026-03-02T10:00:00Z");

    const cm = queryComms(db)!;
    expect(cm.recentActivity.length).toBe(2);
    expect(cm.recentActivity[0].id).toBe("a2"); // More recent first
    expect(cm.recentActivity[1].id).toBe("a1");
  });

  it("enriches pendingDrafts with contact_name and age_hours", () => {
    db.prepare(
      `INSERT INTO contacts (id, name, email, phone, company, notes, created_at, updated_at)
       VALUES ('ct2','Bob Jones','bob@test.com','','','',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO communications (id, channel, direction, status, subject, contact_id, created_at, updated_at)
       VALUES ('dr1','email','outbound','draft','Draft email','ct2',?,?)`,
    ).run(now, now);

    const cm = queryComms(db)!;
    expect(cm.pendingDrafts.length).toBe(1);
    expect(cm.pendingDrafts[0].contact_name).toBe("Bob Jones");
    expect(cm.pendingDrafts[0].age_hours).toBeGreaterThanOrEqual(0);
  });
});
