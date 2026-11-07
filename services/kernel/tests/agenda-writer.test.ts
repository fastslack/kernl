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

  // 07/11: one lab closure (10/11) became nine events — the triage reworded it in every mail of the thread, the
  // auto-replies came in their own threads, and the lookup wanted the exact same title in the same thread.
  describe("the same thing mentioned again", () => {
    const lab = { source_table: "communications" as const, source_id: "m1", thread_key: "lab", subject: "Turno", from: "Laboratorio <lab@hospital.example>" };
    const closed = (title: string): AgendaItem => ({ kind: "event", title, start_at: "2030-11-10", all_day: true, confidence: "high", evidence: "lunes cerrado" });

    it("reworded in a later mail of the thread is still one event", () => {
      writer.write(lab, [closed("Laboratorio cerrado por feriado extraordinario")]);
      const r = writer.write({ ...lab, source_id: "m2" }, [closed("Cierre del laboratorio por visita del Papa")]);
      expect(r.created).toBe(0);
      expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 1 });
    });

    it("the sender's auto-reply in another thread, same day, is the same item", () => {
      writer.write(lab, [closed("Laboratorio cerrado por feriado extraordinario")]);
      writer.write({ ...lab, source_id: "m3", thread_key: "auto", from: "lab@hospital.example" }, [closed("El laboratorio permanecerá cerrado")]);
      expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 1 });
    });

    it("another sender with nearly the same title, same day, is the same item", () => {
      writer.write(lab, [closed("Laboratorio central cerrado por feriado")]);
      writer.write({ ...lab, source_id: "m4", thread_key: "x", from: "otro@example.com" }, [closed("Laboratorio cerrado por feriado")]);
      expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 1 });
    });

    it("two appointments of one sender on the same day at different times stay two", () => {
      const at = (title: string, t: string): AgendaItem => ({ kind: "appointment", title, start_at: `2030-11-10T${t}`, all_day: false, confidence: "high", evidence: t });
      writer.write(lab, [at("Extracción de sangre", "08:00")]);
      writer.write({ ...lab, source_id: "m5" }, [at("Consulta con el médico", "15:00")]);
      expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 2 });
    });

    it("singular and plural are the same words", () => {
      writer.write(lab, [closed("Laboratorio cerrado por feriados extraordinarios")]);
      writer.write({ ...lab, source_id: "m9", thread_key: "z", from: "" }, [closed("Laboratorio cerrado por feriado extraordinario")]);
      expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 1 });
    });

    it("one sender's two different items on the same day stay two (two stock lots expiring)", () => {
      const lot = (title: string): AgendaItem => ({ kind: "expiry", title, start_at: "2030-11-10", all_day: true, confidence: "high", evidence: "x" });
      const wh = { ...lab, from: "stock@warehouse.example" };
      writer.write({ ...wh, thread_key: "a" }, [lot("YOG-1KG L2999-Q expires (30 @ E-01-02-A) — quarantine")]);
      writer.write({ ...wh, thread_key: "b", source_id: "m7" }, [lot("ALC-500 L2743-1 expires (40 @ B-02-03-C) — promote")]);
      writer.write({ ...wh, thread_key: "a", source_id: "m8" }, [lot("GRN-2KG L3001-B expires (12 @ C-04-01-A) — sell first")]);
      expect(db.query("SELECT COUNT(*) n FROM reminders").get()).toEqual({ n: 3 });
    });

    it("an unrelated sender and title on the same day stays separate", () => {
      writer.write(lab, [closed("Laboratorio cerrado por feriado")]);
      writer.write({ ...lab, source_id: "m6", thread_key: "y", from: "amigo@example.com" }, [closed("Cumpleaños de Juan")]);
      expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 2 });
    });
  });
});
