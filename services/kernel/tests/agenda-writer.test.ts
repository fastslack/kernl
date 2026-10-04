import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { eventsMigrations } from "../assets/extensions/people/events/_module/migrations/001_events.js";
import { EventsService } from "../assets/extensions/people/events/_module/service.js";
import { tasksMigrations } from "../assets/extensions/productivity/tasks/_module/migrations/001_tasks.js";
import { TaskService } from "../assets/extensions/productivity/tasks/_module/service.js";
import { remindersMigrations } from "../assets/extensions/productivity/reminders/_module/migrations/001_reminders.js";
import { ReminderService } from "../assets/extensions/productivity/reminders/_module/service.js";
import { commsMigrations } from "../assets/extensions/people/comms/_module/migrations.js";
import { AgendaWriter, fingerprint } from "../assets/extensions/people/comms/_module/agenda-writer.js";
import type { EventsLike } from "../assets/extensions/people/comms/_module/agenda-writer.js";
import type { AgendaItem } from "../assets/extensions/people/comms/_module/agenda-extract.js";

let db: Database;
let writer: AgendaWriter;
const src = { source_table: "communications" as const, source_id: "c1", thread_key: "t1", subject: "Reunión", from: "ana@x.com" };
const meeting: AgendaItem = { kind: "appointment", title: "Reunión con Ana", start_at: "2030-10-02T10:00", all_day: false, confidence: "high", evidence: "jueves 10hs" };

beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "crm", crmMigrations);
  runMigrations(db, "events", eventsMigrations);
  runMigrations(db, "tasks", tasksMigrations);
  runMigrations(db, "reminders", remindersMigrations);
  // comms v1 references tasks(id); tasks exists now.
  runMigrations(db, "comms", commsMigrations);
  writer = new AgendaWriter(db as any, {
    events: new EventsService(db as any),
    tasks: new TaskService(db as any, () => null),
    reminders: new ReminderService(db as any, () => null),
  });
});
afterEach(() => db.close());

describe("AgendaWriter", () => {
  it("appointment → events, open when confident", () => {
    const r = writer.write(src, [meeting]);
    expect(r.created).toBe(1);
    const ev = db.query("SELECT title, status, type FROM events").get() as any;
    expect(ev).toEqual({ title: "Reunión con Ana", status: "open", type: "professional" });
  });

  it("low confidence stays draft", () => {
    writer.write(src, [{ ...meeting, confidence: "low" }]);
    expect((db.query("SELECT status FROM events").get() as any).status).toBe("draft");
  });

  it("deadline → task with due_date, expiry → reminder", () => {
    writer.write(src, [
      { kind: "deadline", title: "Entregar informe", start_at: "2030-10-05", all_day: true, confidence: "high", evidence: "antes del 5" },
      { kind: "expiry", title: "Vence factura luz", start_at: "2030-10-10", all_day: true, confidence: "high", evidence: "vence 10/10" },
    ]);
    expect((db.query("SELECT due_date FROM tasks").get() as any).due_date).toBe("2030-10-05");
    expect(db.query("SELECT COUNT(*) n FROM reminders").get()).toEqual({ n: 1 });
  });

  it("same thread and fingerprint updates instead of inserting", () => {
    writer.write(src, [meeting]);
    const r = writer.write({ ...src, source_id: "c2" }, [{ ...meeting, start_at: "2030-10-03T11:00" }]);
    expect(r.updated).toBe(1);
    expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 1 });
    const start = (db.query("SELECT start_at FROM events").get() as any).start_at as string;
    expect(start.startsWith("2030-10-03")).toBe(true);
  });

  it("same title with Re:/Fwd: prefixes is the same fingerprint", () => {
    writer.write(src, [meeting]);
    writer.write({ ...src, source_id: "c3" }, [{ ...meeting, title: "RE: Reunión con Ana" }]);
    expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 1 });
  });

  it("skips when a Google-imported reminder matches day+time+title", () => {
    db.run(`CREATE TABLE IF NOT EXISTS google_sync_map (id TEXT PRIMARY KEY, source TEXT, google_id TEXT, local_id TEXT, local_table TEXT, synced_at TEXT)`);
    const rem = new ReminderService(db as any, () => null).create({ title: "Reunión con Ana", trigger_at: "2030-10-02T10:00" } as any);
    db.run(`INSERT INTO google_sync_map VALUES ('m1','calendar','g1',?, 'reminders','2030-01-01')`, [rem.id]);
    const r = writer.write(src, [meeting]);
    expect(r.skipped).toBe(1);
    expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 0 });
  });

  it("missing target service skips that item without throwing", () => {
    const w = new AgendaWriter(db as any, { events: null, tasks: null, reminders: null });
    expect(w.write(src, [meeting]).skipped).toBe(1);
  });

  it("events.update throwing rolls back the created event and leaves no orphan link", () => {
    const realEvents = new EventsService(db as any);
    const throwingOnUpdate: EventsLike = {
      create: (input) => realEvents.create(input as any),
      update: () => { throw new Error("boom"); },
    };
    const w = new AgendaWriter(db as any, { events: throwingOnUpdate, tasks: null, reminders: null });

    const r = w.write(src, [meeting]);

    expect(r.skipped).toBe(1);
    expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) n FROM mail_agenda_links").get()).toEqual({ n: 0 });
  });

  it("a later write with a working service creates exactly one event after a prior rollback", () => {
    const realEvents = new EventsService(db as any);
    const throwingOnUpdate: EventsLike = {
      create: (input) => realEvents.create(input as any),
      update: () => { throw new Error("boom"); },
    };
    new AgendaWriter(db as any, { events: throwingOnUpdate, tasks: null, reminders: null }).write(src, [meeting]);

    const working = new AgendaWriter(db as any, { events: realEvents, tasks: null, reminders: null });
    const r = working.write(src, [meeting]);

    expect(r.created).toBe(1);
    expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) n FROM mail_agenda_links").get()).toEqual({ n: 1 });
  });

  it("fingerprint strips accents so the same title with/without diacritics matches", () => {
    expect(fingerprint({ ...meeting, title: "Reunión" })).toBe(fingerprint({ ...meeting, title: "Reunion" }));
  });
});
