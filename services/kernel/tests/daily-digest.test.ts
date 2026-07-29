import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { remindersMigrations } from "../assets/extensions/productivity/reminders/_module/migrations/001_reminders.js";
import { eventsMigrations } from "../assets/extensions/people/events/_module/migrations/001_events.js";
import {
  buildEveningDigest,
  buildMorningDigest,
} from "../assets/extensions/automation/daily-digest/_module/digest-service.js";
import {
  amsterdamParts,
  dueDigests,
} from "../assets/extensions/automation/daily-digest/_module/scheduler.js";
import { deliverDigest } from "../assets/extensions/automation/daily-digest/_module/delivery.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = OFF"); // events FKs to contacts; not under test
  runMigrations(db, "tasks", tasksMigrations);
  runMigrations(db, "reminders", remindersMigrations);
  runMigrations(db, "events", eventsMigrations);
  return db;
}

function task(db: Database, fields: Record<string, unknown>) {
  const base = {
    id: fields.id ?? `t-${Math.random().toString(36).slice(2)}`,
    title: "T", description: "", status: "todo", priority: "medium", context: "",
    due_date: null, started_at: null, completed_at: null, target_date: null,
    estimated_minutes: 0, progress: 0, tags: "", project_id: null, parent_task_id: null,
    sort_order: 0, recurrence: "", recurrence_parent_id: null, reminder_id: "",
    deleted_at: null, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z",
    ...fields,
  };
  const cols = Object.keys(base);
  db.prepare(`INSERT INTO tasks (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...cols.map((c) => (base as any)[c]));
}

describe("digest builders", () => {
  let db: Database;
  const now = new Date("2026-06-26T12:00:00Z"); // Amsterdam 14:00 CEST, date 2026-06-26
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it("evening digest lists tomorrow's tasks and excludes done/deleted", () => {
    task(db, { title: "Ship report", due_date: "2026-06-27", priority: "high" });
    task(db, { title: "Already done", due_date: "2026-06-27", status: "done" });
    task(db, { title: "Deleted one", due_date: "2026-06-27", deleted_at: "2026-06-25T00:00:00Z" });
    task(db, { title: "Not tomorrow", due_date: "2026-06-29" });
    const { title, markdown } = buildEveningDigest(db, now);
    expect(title.toLowerCase()).toContain("tomorrow");
    expect(markdown).toContain("Ship report");
    expect(markdown).not.toContain("Already done");
    expect(markdown).not.toContain("Deleted one");
    expect(markdown).not.toContain("Not tomorrow");
  });

  it("morning digest lists today's tasks and overdue", () => {
    task(db, { title: "Due today", due_date: "2026-06-26" });
    task(db, { title: "Overdue thing", due_date: "2026-06-20" });
    task(db, { title: "Future task", due_date: "2026-07-01" });
    const { markdown } = buildMorningDigest(db, now);
    expect(markdown).toContain("Due today");
    expect(markdown).toContain("Overdue thing");
    expect(markdown).not.toContain("Future task");
  });
});

describe("amsterdam timezone + scheduling", () => {
  it("maps a UTC instant to the right Amsterdam hour (CEST summer)", () => {
    const p = amsterdamParts(new Date("2026-06-26T19:00:00Z")); // CEST = UTC+2
    expect(p.hour).toBe(21);
    expect(p.dateKey).toBe("2026-06-26");
  });

  it("maps a UTC instant to the right Amsterdam hour (CET winter)", () => {
    const p = amsterdamParts(new Date("2026-01-15T20:00:00Z")); // CET = UTC+1
    expect(p.hour).toBe(21);
    expect(p.dateKey).toBe("2026-01-15");
  });

  it("fires each kind once per day at its hour", () => {
    const cfg = { eveningHour: 21, morningHour: 7 };
    const evening = { hour: 21, minute: 3, dateKey: "2026-06-26" };
    expect(dueDigests(evening, {}, cfg)).toEqual(["evening"]);
    // already sent today → not again
    expect(dueDigests(evening, { evening: "2026-06-26" }, cfg)).toEqual([]);
    // morning hour fires morning
    expect(dueDigests({ hour: 7, minute: 0, dateKey: "2026-06-26" }, {}, cfg)).toEqual(["morning"]);
    // off-hour fires nothing
    expect(dueDigests({ hour: 13, minute: 0, dateKey: "2026-06-26" }, {}, cfg)).toEqual([]);
  });
});

describe("delivery", () => {
  it("targets configured channels + always the dashboard, skipping unready ones", async () => {
    const calls: string[] = [];
    const registry = {
      send: async (slug: string) => {
        calls.push(slug);
        return slug !== "whatsapp"; // whatsapp not active → false
      },
    };
    const res = await deliverDigest(registry as any, ["telegram", "whatsapp"], {
      title: "Hi", body: "x", format: "markdown",
    });
    expect(calls).toContain("telegram");
    expect(calls).toContain("whatsapp");
    expect(calls).toContain("dashboard-notifications");
    expect(res.telegram).toBe(true);
    expect(res.whatsapp).toBe(false);
  });
});
