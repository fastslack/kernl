/**
 * Characterization test for the dashboard calendar and system timeline.
 *
 * Pins the full payload of `queryCalendar()` and `querySystemTimeline()` for a
 * seeded database — every event, its order inside each day, the order of the
 * days themselves and of the overdue list, and every field (ids, titles,
 * colors, extras). The snapshot is serialized with JSON.stringify so key order
 * is part of it too.
 *
 * The calendar composes sources that live in extensions (tasks, reminders,
 * subscriptions, health, goals, events) and sources that stay in the core.
 * Extension sources reach the calendar through their module's dashboard
 * descriptor, so the test registers the same modules in a DashboardRegistry,
 * exactly as bootstrap does, and hands the collected sources to the query.
 *
 * The window sits in 2090 so "now"-relative filters (overdue reminders,
 * overdue research runs) split the seeded rows the same way for decades.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { DashboardRegistry } from "../src/core/dashboard-registry.js";
import type { SystemRegistry, SystemProcess } from "../src/core/system-registry.js";
import { queryCalendar, querySystemTimeline } from "../src/modules/dashboard/api.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { remindersMigrations } from "../assets/extensions/productivity/reminders/_module/migrations/001_reminders.js";
import { subscriptionsMigrations } from "../assets/extensions/finance/subscriptions/_module/migrations/001_subscriptions.js";
import { healthMigrations } from "../assets/extensions/health/health/_module/migrations/001_health.js";
import { goalsMigrations } from "../assets/extensions/productivity/goals/_module/migrations/001_goals.js";
import { eventsMigrations } from "../assets/extensions/people/events/_module/migrations/001_events.js";
import { createTasksModule } from "../assets/extensions/productivity/tasks/_module/index.js";
import { createRemindersModule } from "../assets/extensions/productivity/reminders/_module/index.js";
import { createSubscriptionsModule } from "../assets/extensions/finance/subscriptions/_module/index.js";
import { createHealthModule } from "../assets/extensions/health/health/_module/index.js";
import { createGoalsModule } from "../assets/extensions/productivity/goals/_module/index.js";
import { createEventsModule } from "../assets/extensions/people/events/_module/index.js";

const START = "2090-03-01";
const DAYS = 45;
const TS = "2090-01-01T00:00:00.000Z";

/**
 * Tables no migration in this repo creates (their extensions are gone or live
 * elsewhere), reduced to the columns the calendar reads.
 */
const ORPHAN_TABLES = `
  CREATE TABLE home_maintenance_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, next_due TEXT);
  CREATE TABLE vehicles (id TEXT PRIMARY KEY, name TEXT NOT NULL, next_inspection TEXT, deleted_at TEXT);
  CREATE TABLE vehicle_maintenance (id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL, name TEXT NOT NULL, next_due_date TEXT);
  CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, expiry_date TEXT, deleted_at TEXT);
  CREATE TABLE recipes (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE meal_plans (id TEXT PRIMARY KEY, meal_type TEXT NOT NULL, date TEXT NOT NULL, recipe_id TEXT);
  CREATE TABLE research_tasks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, next_run_at TEXT,
    interval_minutes INTEGER NOT NULL DEFAULT 60, status TEXT NOT NULL DEFAULT 'active', last_run_at TEXT
  );
  CREATE TABLE home_house (id TEXT PRIMARY KEY, insurance_expiry TEXT);
`;

function seededDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db, "tasks", tasksMigrations);
  runMigrations(db, "reminders", remindersMigrations);
  runMigrations(db, "subscriptions", subscriptionsMigrations);
  runMigrations(db, "health", healthMigrations);
  runMigrations(db, "goals", goalsMigrations);
  runMigrations(db, "events", eventsMigrations);
  runMigrations(db, "agents", agentsMigrations);
  db.exec(ORPHAN_TABLES);

  const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...(params as never[]));

  // Tasks: in range, done (excluded), deleted (excluded), out of range, overdue ×2.
  const task = (id: string, title: string, due: string | null, status = "todo", priority = "medium", deleted: string | null = null) =>
    run(`INSERT INTO tasks (id, title, due_date, status, priority, deleted_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      id, title, due, status, priority, deleted, TS, TS);
  task("t-in", "Pay rent", "2090-03-10", "todo", "high");
  task("t-in2", "Call plumber", "2090-03-02", "in_progress", "low");
  task("t-done", "Done already", "2090-03-10", "done");
  task("t-del", "Deleted", "2090-03-10", "todo", "medium", TS);
  task("t-out", "Later", "2090-05-01");
  task("t-over", "Overdue task", "2090-02-01", "blocked", "urgent");
  task("t-over2", "Older overdue", "2089-12-24");
  task("t-nodue", "No due date", null);

  // Reminders: one-shot in range, recurring daily/weekly/monthly, past (overdue), fired (excluded).
  const reminder = (id: string, title: string, at: string, repeat = "none", status = "active") =>
    run(`INSERT INTO reminders (id, title, trigger_at, repeat, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
      id, title, at, repeat, status, TS, TS);
  reminder("r-one", "Dentist call", "2090-03-10T09:30:00");
  reminder("r-snz", "Snoozed one", "2090-03-12T18:05:00", "none", "snoozed");
  reminder("r-daily", "Vitamins", "2090-03-08T08:00:00.000Z", "daily");
  reminder("r-weekly", "Trash out", "2090-02-20T20:00:00.000Z", "weekly");
  reminder("r-monthly", "Budget review", "2090-01-15T10:00:00.000Z", "monthly");
  reminder("r-past", "Old reminder", "2020-01-01T10:00:00");
  reminder("r-fired", "Fired", "2090-03-10T10:00:00", "none", "fired");

  // Subscriptions.
  const sub = (id: string, name: string, next: string, cents: number, currency: string, status = "active") =>
    run(`INSERT INTO subscriptions (id, name, amount_cents, currency, status, start_date, next_billing, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, name, cents, currency, status, "2089-01-01", next, TS, TS);
  sub("s-1", "Streaming", "2090-03-10", 1299, "EUR");
  sub("s-2", "Cloud", "2090-04-01", 500, "USD");
  sub("s-off", "Cancelled", "2090-03-10", 999, "EUR", "cancelled");

  // Health appointments.
  const appt = (id: string, title: string, date: string, provider: string, status = "scheduled") =>
    run(`INSERT INTO health_appointments (id, title, provider, date, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
      id, title, provider, date, status, TS, TS);
  appt("h-1", "Checkup", "2090-03-10", "Dr. Ruiz");
  appt("h-2", "Done visit", "2090-03-10", "Dr. Old", "completed");

  // Home maintenance.
  run(`INSERT INTO home_maintenance_items VALUES ('hm-1', 'Boiler service', '2090-03-10')`);
  run(`INSERT INTO home_maintenance_items VALUES ('hm-2', 'Gutters', NULL)`);

  // Vehicles + maintenance + inspections.
  run(`INSERT INTO vehicles VALUES ('v-1', 'Golf', '2090-03-10', NULL)`);
  run(`INSERT INTO vehicles VALUES ('v-del', 'Sold car', '2090-03-11', '2089-01-01')`);
  run(`INSERT INTO vehicle_maintenance VALUES ('vm-1', 'v-1', 'Oil change', '2090-03-10')`);
  run(`INSERT INTO vehicle_maintenance VALUES ('vm-2', 'v-del', 'Tyres', '2090-03-11')`);

  // Documents.
  run(`INSERT INTO documents VALUES ('d-1', 'Passport', '2090-03-10', NULL)`);
  run(`INSERT INTO documents VALUES ('d-del', 'Old ID', '2090-03-10', '2089-01-01')`);

  // Goals.
  const goal = (id: string, title: string, target: string | null, status = "active") =>
    run(`INSERT INTO goals (id, title, status, target_date, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
      id, title, status, target, TS, TS);
  goal("g-1", "Run a marathon", "2090-03-10");
  goal("g-2", "Finished goal", "2090-03-20", "completed");

  // Meal plans (with and without a recipe).
  run(`INSERT INTO recipes VALUES ('rc-1', 'Paella')`);
  run(`INSERT INTO meal_plans VALUES ('mp-1', 'lunch', '2090-03-10', 'rc-1')`);
  run(`INSERT INTO meal_plans VALUES ('mp-2', 'dinner', '2090-03-10', NULL)`);

  // Research tasks (in range, overdue with a previous run, paused).
  run(`INSERT INTO research_tasks VALUES ('rt-1', 'Market scan', '2090-03-10T06:15:00', 1440, 'active', '2090-03-09T06:15:00')`);
  run(`INSERT INTO research_tasks VALUES ('rt-over', 'Stale scan', '2020-01-01T00:00:00', 90, 'active', '2019-12-31T22:30:00')`);
  run(`INSERT INTO research_tasks VALUES ('rt-p', 'Paused scan', '2090-03-10T07:00:00', 60, 'paused', NULL)`);

  // Home insurance singleton.
  run(`INSERT INTO home_house VALUES ('house-profile', '2090-03-10')`);

  // Events: draft + confirmed in range, cancelled (excluded), overdue.
  const event = (id: string, title: string, start: string, type: string, status: string) =>
    run(`INSERT INTO events (id, title, start_at, type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
      id, title, start, type, status, TS, TS);
  event("e-1", "Padel", "2090-03-10T19:00:00", "sports", "draft");
  event("e-2", "Conference", "2090-03-15T09:00:00", "professional", "confirmed");
  event("e-off", "Cancelled", "2090-03-10T12:00:00", "social", "cancelled");
  event("e-over", "Past party", "2090-02-14T21:00:00", "social", "open");

  // Agents with cron schedules (user agent, builtin agent, inactive, invalid cron).
  const agent = (id: string, name: string, builtin: string, active = 1) =>
    run(`INSERT INTO agents (id, name, builtin_handler, active, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
      id, name, builtin, active, TS, TS);
  const schedule = (id: string, agentId: string, cron: string, active = 1) =>
    run(`INSERT INTO agent_schedules (id, agent_id, interval_ms, next_run_at, active, cron_expression, created_at) VALUES (?,?,?,?,?,?,?)`,
      id, agentId, 0, "2090-03-01T00:00:00.000Z", active, cron, TS);
  agent("a-1", "Weekly digest", "");
  agent("a-2", "Monthly cleanup", "cleanup_handler");
  agent("a-3", "Disabled agent", "", 0);
  agent("a-4", "Broken cron", "");
  schedule("sc-1", "a-1", "0 12 * * 1");
  schedule("sc-2", "a-2", "30 3 1 * *");
  schedule("sc-3", "a-3", "0 * * * *");
  schedule("sc-4", "a-4", "not a cron");

  return db;
}

function fakeSystemRegistry(): SystemRegistry {
  const base = { status: "idle", startedAt: TS, runCount: 3, description: "d" } as const;
  const processes: SystemProcess[] = [
    { ...base, id: "p-int-week", name: "Weekly backup", type: "interval", module: "backup", intervalMs: 7 * 86_400_000, nextRunAt: "2090-03-03T02:00:00.000Z", lastRunAt: "2090-02-24T02:00:00.000Z" },
    { ...base, id: "p-int-min", name: "Heartbeat", type: "interval", module: "core", intervalMs: 60_000, nextRunAt: "2090-03-01T00:01:00.000Z" },
    { ...base, id: "p-cache", name: "Feed cache", type: "cache", module: "news", ttlMs: 3_600_000, nextRunAt: "2090-03-05T13:45:00.000Z" },
    { ...base, id: "p-listener", name: "Mail listener", type: "listener", module: "comms", event: "mail.in" },
  ] as SystemProcess[];
  return { list: () => processes } as unknown as SystemRegistry;
}

/** A DashboardRegistry holding the descriptors of every extension the calendar reads. */
function registryWithModules(): DashboardRegistry {
  const registry = new DashboardRegistry();
  for (const mod of [
    createTasksModule(),
    createRemindersModule(),
    createSubscriptionsModule(),
    createHealthModule(),
    createGoalsModule(),
    createEventsModule(),
  ]) {
    registry.registerModule(mod);
  }
  return registry;
}

function calendar(db: Database) {
  const registry = registryWithModules();
  return queryCalendar(db, START, DAYS, fakeSystemRegistry(), registry.getCalendarSources());
}

describe("dashboard calendar (characterization)", () => {
  it("returns the same full payload for a seeded database", () => {
    const db = seededDb();
    const payload = calendar(db);

    // Sanity: every source contributes, so the snapshot is not vacuous.
    const types = new Set(Object.values(payload.days).flat().map((e) => e.type));
    expect([...types].sort()).toEqual(
      ["automation", "document", "event", "goal", "health", "meal", "reminder", "research", "subscription", "task", "vehicle", "maintenance"].sort(),
    );
    expect(payload.overdue.map((e) => e.type)).toEqual(["task", "task", "reminder", "event"]);

    expect(JSON.stringify(payload, null, 1)).toMatchSnapshot();
  });

  it("yields no events when no source table exists (extensions not installed)", () => {
    const db = new Database(":memory:");
    const payload = calendar(db);
    expect(payload.days).toEqual({});
    expect(payload.overdue).toEqual([]);
    expect(payload.systemProcesses).toEqual([
      { name: "Weekly backup", module: "backup", intervalMs: 7 * 86_400_000, nextRunAt: "2090-03-03T02:00:00.000Z" },
      { name: "Heartbeat", module: "core", intervalMs: 60_000, nextRunAt: "2090-03-01T00:01:00.000Z" },
    ]);
  });
});

describe("dashboard system timeline (characterization)", () => {
  it("returns the same full payload for a seeded database", () => {
    const db = seededDb();
    const payload = querySystemTimeline(db, START, DAYS, fakeSystemRegistry());
    expect(Object.keys(payload.days).length).toBeGreaterThan(0);
    expect(payload.overdue.map((e) => e.id)).toEqual(["rt-over"]);
    expect(JSON.stringify(payload, null, 1)).toMatchSnapshot();
  });
});
