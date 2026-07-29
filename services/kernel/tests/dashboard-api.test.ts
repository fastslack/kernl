import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { remindersMigrations } from "../assets/extensions/productivity/reminders/_module/migrations/001_reminders.js";
import { shoppingMigrations } from "../assets/extensions/home/shopping/_module/migrations/001_shopping.js";
import { issuesMigrations } from "../assets/extensions/productivity/issues/_module/migrations.js";
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
  queryTasks,
  queryCrm,
  queryReminders,
  queryShopping,
  queryFullDashboard,
  queryAgenda,
  queryCrossModuleIntel,
} from "../src/modules/dashboard/api.js";
import { queryIssues, parseScopedLabels } from "../assets/extensions/productivity/issues/_module/dashboard-queries.js";
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

function setupDbWithIssues(): Database {
  const db = setupDb();
  runMigrations(db, "issues", issuesMigrations);
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
      expect(kpis.issues).toBeNull();
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
    it("integrates all sections", () => {
      const dash = queryFullDashboard(db);
      expect(dash.generatedAt).toBeTruthy();
      expect(dash.kpis).toBeDefined();
      expect(dash.tasks).toBeDefined();
      expect(dash.crm).toBeDefined();
      expect(dash.reminders).toBeDefined();
      expect(dash.shopping).toBeDefined();
    });

    it("reflects inserted data across modules", () => {
      db.prepare(
        `INSERT INTO tasks (id, title, status, priority, created_at, updated_at)
         VALUES ('t1','Task','todo','high',?,?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO contacts (id, name, relationship, created_at, updated_at)
         VALUES ('c1','Bob','professional',?,?)`,
      ).run(now, now);

      const dash = queryFullDashboard(db);
      expect(dash.kpis.tasks.total).toBe(1);
      expect(dash.kpis.contacts.total).toBe(1);
      expect(dash.tasks.byPriority.high).toBe(1);
      expect(dash.crm.total).toBe(1);
    });
  });
});

// ── Enhanced Issues queries ──────────────────────────

describe("Enhanced Issues queries", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDbWithIssues();
  });

  afterEach(() => {
    db.close();
  });

  describe("queryIssues enhanced", () => {
    it("returns null without issues table", () => {
      const plainDb = setupDb();
      expect(queryIssues(plainDb)).toBeNull();
      plainDb.close();
    });

    it("returns all fields on empty issues table", () => {
      const iss = queryIssues(db)!;
      expect(iss).not.toBeNull();
      expect(iss.kpis.total).toBe(0);
      expect(iss.velocity).toHaveLength(8);
      expect(iss.velocity.every((v: { opened: number; closed: number }) => v.opened === 0 && v.closed === 0)).toBe(true);
      expect(iss.milestones).toEqual([]);
      expect(iss.assigneeWorkload).toEqual([]);
      expect(iss.ageAnalysis.avgCloseTimeDays).toBe(0);
      expect(iss.ageAnalysis.buckets).toEqual([]);
      expect(iss.staleIssues).toEqual([]);
      expect(iss.activityHeatmap).toHaveLength(7);
      expect(iss.overBudget).toEqual([]);
      expect(iss.labelTrends).toEqual([]);
    });

    it("computes velocity with created and closed issues", () => {
      const thisWeek = today;
      db.prepare(
        `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, assignees, created_at, updated_at, synced_at)
         VALUES ('i1','github','ext1',1,'org/repo','Issue 1','open','[]',?,?,?)`,
      ).run(thisWeek, thisWeek, now);
      db.prepare(
        `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, assignees, created_at, updated_at, closed_at, synced_at)
         VALUES ('i2','github','ext2',2,'org/repo','Issue 2','closed','[]',?,?,?,?)`,
      ).run(thisWeek, thisWeek, thisWeek, now);

      const iss = queryIssues(db)!;
      expect(iss.velocity.length).toBeGreaterThan(0);
      // The last week should have at least 1 opened and 1 closed
      const lastWeek = iss.velocity[iss.velocity.length - 1];
      expect(lastWeek.opened).toBeGreaterThanOrEqual(1);
      expect(lastWeek.closed).toBeGreaterThanOrEqual(1);
    });

    it("computes milestones", () => {
      db.prepare(
        `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, milestone, assignees, created_at, updated_at, synced_at)
         VALUES ('i1','github','e1',1,'r','A','open','v1.0','[]',?,?,?),
                ('i2','github','e2',2,'r','B','closed','v1.0','[]',?,?,?),
                ('i3','github','e3',3,'r','C','open','v2.0','[]',?,?,?)`,
      ).run(now, now, now, now, now, now, now, now, now);

      const iss = queryIssues(db)!;
      expect(iss.milestones).toHaveLength(2);
      const v1 = iss.milestones.find((m) => m.milestone === "v1.0")!;
      expect(v1.total).toBe(2);
      expect(v1.open).toBe(1);
      expect(v1.closed).toBe(1);
      expect(v1.progressPct).toBe(50);
    });

    it("computes assignee workload from JSON assignees", () => {
      db.prepare(
        `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, assignees, time_estimate, time_spent, created_at, updated_at, synced_at)
         VALUES ('i1','github','e1',1,'r','A','open','["alice","bob"]',3600,1800,?,?,?),
                ('i2','github','e2',2,'r','B','open','["alice"]',7200,3600,?,?,?)`,
      ).run(now, now, now, now, now, now);

      const iss = queryIssues(db)!;
      expect(iss.assigneeWorkload.length).toBeGreaterThanOrEqual(1);
      const alice = iss.assigneeWorkload.find((a) => a.assignee === "alice")!;
      expect(alice.openCount).toBe(2);
    });

    it("detects stale issues", () => {
      const staleDate = new Date(Date.now() - 20 * 86_400_000).toISOString();
      db.prepare(
        `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, assignees, created_at, updated_at, synced_at)
         VALUES ('i1','github','e1',1,'r','Stale issue','open','[]',?,?,?)`,
      ).run(staleDate, staleDate, now);

      const iss = queryIssues(db)!;
      expect(iss.staleIssues).toHaveLength(1);
      expect(iss.staleIssues[0].title).toBe("Stale issue");
      expect(iss.staleIssues[0].daysSinceUpdate).toBeGreaterThanOrEqual(14);
      expect(iss.staleCount).toBe(1);
    });

    it("computes age analysis with buckets", () => {
      // Insert open issues of different ages
      const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
      db.prepare(
        `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, assignees, created_at, updated_at, synced_at)
         VALUES ('i1','github','e1',1,'r','Young','open','[]',?,?,?),
                ('i2','github','e2',2,'r','Old','open','[]',?,?,?)`,
      ).run(daysAgo(3), now, now, daysAgo(45), now, now);

      const iss = queryIssues(db)!;
      expect(iss.ageAnalysis.buckets.length).toBeGreaterThan(0);
    });

    it("computes activity heatmap", () => {
      db.prepare(
        `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, assignees, created_at, updated_at, synced_at)
         VALUES ('i1','github','e1',1,'r','A','open','[]',?,?,?)`,
      ).run(now, now, now);

      const iss = queryIssues(db)!;
      expect(iss.activityHeatmap).toHaveLength(7);
      const totalCreated = iss.activityHeatmap.reduce((s, d) => s + d.created, 0);
      expect(totalCreated).toBe(1);
    });

    it("detects over-budget issues", () => {
      db.prepare(
        `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, assignees, time_estimate, time_spent, created_at, updated_at, synced_at)
         VALUES ('i1','github','e1',1,'r','Over','open','[]',3600,7200,?,?,?)`,
      ).run(now, now, now);

      const iss = queryIssues(db)!;
      expect(iss.overBudget).toHaveLength(1);
      expect(iss.overBudget[0].title).toBe("Over");
      expect(iss.overBudget[0].overBy).toBe(3600);
    });

    it("computes avgCloseTimeDays", () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
      db.prepare(
        `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, assignees, created_at, updated_at, closed_at, synced_at)
         VALUES ('i1','github','e1',1,'r','Done','closed','[]',?,?,?,?)`,
      ).run(twoDaysAgo, now, now, now);

      const iss = queryIssues(db)!;
      expect(iss.avgCloseTimeDays).toBeGreaterThan(0);
    });
  });

  describe("queryKpis with issues", () => {
    it("includes issues stats when table exists", () => {
      db.prepare(
        `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, assignees, is_pull_request, created_at, updated_at, synced_at)
         VALUES ('i1','github','e1',1,'r','A','open','[]',0,?,?,?),
                ('i2','github','e2',2,'r','B','closed','[]',0,?,?,?),
                ('i3','github','e3',3,'r','C','open','[]',1,?,?,?)`,
      ).run(now, now, now, now, now, now, now, now, now);

      const kpis = queryKpis(db);
      expect(kpis.issues).not.toBeNull();
      expect(kpis.issues!.total).toBe(3);
      expect(kpis.issues!.open).toBe(2);
      expect(kpis.issues!.closed).toBe(1);
      expect(kpis.issues!.prs).toBe(1);
    });
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

    it("includes issues when table exists", () => {
      db.prepare(
        `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, assignees, created_at, updated_at, synced_at)
         VALUES ('i1','github','e1',1,'org/repo','New issue','open','[]',?,?,?)`,
      ).run(now, now, now);

      const agenda = queryAgenda(db);
      const todayDay = agenda.days.find((d) => d.isToday);
      expect(todayDay).toBeDefined();
      expect(todayDay!.items.some((i) => i.type === "issue")).toBe(true);
    });

    it("degrades without issues table", () => {
      const plainDb = setupDb();
      const agenda = queryAgenda(plainDb);
      expect(agenda.days).toHaveLength(14);
      expect(agenda.workloadForecast).toHaveLength(14);
      plainDb.close();
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

  describe("queryCrossModuleIntel", () => {
    it("returns null without issues table", () => {
      const plainDb = setupDb();
      expect(queryCrossModuleIntel(plainDb)).toBeNull();
      plainDb.close();
    });

    it("returns workload forecast", () => {
      db.prepare(
        `INSERT INTO tasks (id, title, status, priority, created_at, updated_at)
         VALUES ('t1','Open task','todo','high',?,?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, assignees, time_estimate, created_at, updated_at, synced_at)
         VALUES ('i1','github','e1',1,'r','Open issue','open','[]',7200,?,?,?)`,
      ).run(now, now, now);

      const intel = queryCrossModuleIntel(db)!;
      expect(intel).not.toBeNull();
      expect(intel.workloadForecast.openTasks).toBe(1);
      expect(intel.workloadForecast.openIssues).toBe(1);
      expect(intel.workloadForecast.estimatedHoursRemaining).toBeGreaterThan(0);
    });

    it("matches authors to contacts", () => {
      db.prepare(
        `INSERT INTO contacts (id, name, relationship, created_at, updated_at)
         VALUES ('c1','Alice Developer','professional',?,?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, author, assignees, created_at, updated_at, synced_at)
         VALUES ('i1','github','e1',1,'r','Fix bug','open','Alice Developer','[]',?,?,?)`,
      ).run(now, now, now);

      const intel = queryCrossModuleIntel(db)!;
      expect(intel.authorContactMatches.length).toBeGreaterThanOrEqual(1);
      expect(intel.authorContactMatches[0].author).toBe("Alice Developer");
    });

    it("computes velocity comparison", () => {
      // Complete a task this week
      db.prepare(
        `INSERT INTO tasks (id, title, status, priority, created_at, updated_at)
         VALUES ('t1','Done','done','medium',?,?)`,
      ).run(now, now);
      // Close an issue this week
      db.prepare(
        `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, assignees, created_at, updated_at, closed_at, synced_at)
         VALUES ('i1','github','e1',1,'r','Fixed','closed','[]',?,?,?,?)`,
      ).run(now, now, today, now);

      const intel = queryCrossModuleIntel(db)!;
      expect(intel.velocityComparison.tasksPerWeek).toBe(1);
      expect(intel.velocityComparison.issuesPerWeek).toBe(1);
    });
  });
});

// ── Scoped Labels Intelligence ────────────────────

describe("Scoped Labels Intelligence", () => {
  let db: Database;

  function insertIssue(
    id: string,
    state: string,
    opts: {
      labels?: string[];
      repo?: string;
      updated_at?: string;
      created_at?: string;
      closed_at?: string | null;
      assignees?: string;
    } = {},
  ) {
    const repo = opts.repo ?? "org/app";
    const updatedAt = opts.updated_at ?? now;
    const createdAt = opts.created_at ?? now;
    const closedAt = opts.closed_at ?? (state !== "open" ? now : null);
    const assignees = opts.assignees ?? "[]";
    db.prepare(
      `INSERT INTO issues (id, provider, external_id, external_number, repo, title, state, assignees, created_at, updated_at, closed_at, synced_at)
       VALUES (?, 'gitlab', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, id, repo, `Issue ${id}`, state, assignees, createdAt, updatedAt, closedAt, now);
    if (opts.labels) {
      const stmt = db.prepare(`INSERT INTO issue_labels (issue_id, label) VALUES (?, ?)`);
      for (const label of opts.labels) stmt.run(id, label);
    }
  }

  beforeEach(() => {
    db = setupDbWithIssues();
  });

  afterEach(() => {
    db.close();
  });

  it("parses scoped labels PRI::CRITICAL correctly", () => {
    insertIssue("i1", "open", { labels: ["PRI::CRITICAL", "Type::BUG"] });
    insertIssue("i2", "closed", { labels: ["PRI::1", "Type::FIX"] });

    const dims = parseScopedLabels(db);
    expect(dims.length).toBeGreaterThanOrEqual(2);
    const pri = dims.find((d) => d.scope === "PRI");
    expect(pri).toBeDefined();
    expect(pri!.values.find((v) => v.value === "CRITICAL")).toBeDefined();
    expect(pri!.values.find((v) => v.value === "CRITICAL")!.open).toBe(1);
  });

  it("generates workflow funnel from Status:: labels", () => {
    insertIssue("i1", "open", { labels: ["Status::Ready to start"] });
    insertIssue("i2", "open", { labels: ["Status::Working on it"] });
    insertIssue("i3", "open", { labels: ["Status::Working on it"] });
    insertIssue("i4", "closed", { labels: ["Status::Done"] });

    const iss = queryIssues(db)!;
    expect(iss.workflowFunnel.stages.length).toBeGreaterThanOrEqual(3);
    const working = iss.workflowFunnel.stages.find((s) => s.name === "Working on it");
    expect(working).toBeDefined();
    expect(working!.count).toBe(2);
    expect(iss.workflowFunnel.bottleneck).toBe("Working on it");
  });

  it("calculates priority matrix with avgAgeDays", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    insertIssue("i1", "open", { labels: ["PRI::CRITICAL"], created_at: thirtyDaysAgo });
    insertIssue("i2", "open", { labels: ["PRI::1"] });
    insertIssue("i3", "closed", { labels: ["PRI::2"] });

    const iss = queryIssues(db)!;
    expect(iss.priorityMatrix.criticalOpen).toBe(1);
    const crit = iss.priorityMatrix.byPriority.find((p) => p.priority === "CRITICAL");
    expect(crit).toBeDefined();
    expect(crit!.open).toBe(1);
    expect(crit!.avgAgeDays).toBeGreaterThan(25);
  });

  it("calculates repo health score", () => {
    const staleDate = new Date(Date.now() - 20 * 86_400_000).toISOString();
    insertIssue("i1", "open", { repo: "org/bad-repo", labels: ["PRI::CRITICAL"], updated_at: staleDate });
    insertIssue("i2", "open", { repo: "org/bad-repo", updated_at: staleDate });
    insertIssue("i3", "open", { repo: "org/good-repo" });

    const iss = queryIssues(db)!;
    expect(iss.repoHealth.length).toBeGreaterThanOrEqual(2);
    const badRepo = iss.repoHealth.find((r) => r.repo === "org/bad-repo");
    expect(badRepo).toBeDefined();
    expect(badRepo!.stalePct).toBe(100);
    expect(badRepo!.criticalOpen).toBe(1);
    expect(badRepo!.healthScore).toBeLessThan(50);
    const goodRepo = iss.repoHealth.find((r) => r.repo === "org/good-repo");
    expect(goodRepo).toBeDefined();
    expect(goodRepo!.healthScore).toBeGreaterThan(badRepo!.healthScore);
  });

  it("generates backlog health score and grade", () => {
    const staleDate = new Date(Date.now() - 20 * 86_400_000).toISOString();
    insertIssue("i1", "open", { labels: ["PRI::CRITICAL"], updated_at: staleDate });
    insertIssue("i2", "open", { updated_at: staleDate });
    insertIssue("i3", "open");

    const iss = queryIssues(db)!;
    expect(iss.backlogHealth.score).toBeGreaterThanOrEqual(0);
    expect(iss.backlogHealth.score).toBeLessThanOrEqual(100);
    expect(["A", "B", "C", "D", "F"]).toContain(iss.backlogHealth.grade);
    expect(iss.backlogHealth.factors.length).toBeGreaterThanOrEqual(3);
  });

  it("generates insights for stale > 50%", () => {
    const staleDate = new Date(Date.now() - 20 * 86_400_000).toISOString();
    // 3 out of 4 open issues are stale (75%)
    insertIssue("i1", "open", { updated_at: staleDate });
    insertIssue("i2", "open", { updated_at: staleDate });
    insertIssue("i3", "open", { updated_at: staleDate });
    insertIssue("i4", "open");

    const iss = queryIssues(db)!;
    const staleInsight = iss.insights.find((i) => i.includes("stale"));
    expect(staleInsight).toBeDefined();
    expect(staleInsight).toContain("75%");
  });

  it("generates insights for critical open issues", () => {
    insertIssue("i1", "open", { labels: ["PRI::CRITICAL"] });

    const iss = queryIssues(db)!;
    const critInsight = iss.insights.find((i) => i.includes("critical"));
    expect(critInsight).toBeDefined();
  });

  it("generates type breakdown from Type:: labels", () => {
    insertIssue("i1", "open", { labels: ["Type::BUG"] });
    insertIssue("i2", "open", { labels: ["Type::FIX"] });
    insertIssue("i3", "closed", { labels: ["Type::BUG"] });

    const iss = queryIssues(db)!;
    expect(iss.typeBreakdown.length).toBeGreaterThanOrEqual(2);
    const bug = iss.typeBreakdown.find((t) => t.type === "BUG");
    expect(bug).toBeDefined();
    expect(bug!.open).toBe(1);
    expect(bug!.closed).toBe(1);
  });

  it("generates env breakdown from ENV:: labels", () => {
    insertIssue("i1", "open", { labels: ["ENV::PROD"] });
    insertIssue("i2", "open", { labels: ["ENV::DEV"] });

    const iss = queryIssues(db)!;
    expect(iss.envBreakdown.length).toBe(2);
    const prod = iss.envBreakdown.find((e) => e.env === "PROD");
    expect(prod).toBeDefined();
    expect(prod!.open).toBe(1);
  });

  it("handles labels without scope (no ::) in parseScopedLabels", () => {
    insertIssue("i1", "open", { labels: ["bug", "urgent", "PRI::1"] });

    const dims = parseScopedLabels(db);
    // Only PRI should appear, non-scoped labels are excluded
    expect(dims.length).toBe(1);
    expect(dims[0].scope).toBe("PRI");
  });

  it("returns empty scoped data without labels", () => {
    insertIssue("i1", "open");

    const iss = queryIssues(db)!;
    expect(iss.scopedDimensions).toEqual([]);
    expect(iss.workflowFunnel.stages).toEqual([]);
    expect(iss.workflowFunnel.bottleneck).toBeNull();
    expect(iss.priorityMatrix.byPriority).toEqual([]);
    expect(iss.priorityMatrix.criticalOpen).toBe(0);
    expect(iss.typeBreakdown).toEqual([]);
    expect(iss.envBreakdown).toEqual([]);
  });

  it("returns null without issues table", () => {
    const plainDb = setupDb();
    expect(queryIssues(plainDb)).toBeNull();
    plainDb.close();
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
      expect(summary.issuesClosed).toBe(0);
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

    it("gracefully handles missing issues table", () => {
      // setupDbWithLife doesn't include issues — should not throw
      const summary = queryDailySummary(db);
      expect(summary.issuesClosed).toBe(0);
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
