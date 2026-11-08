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
import { AgendaWriter } from "../assets/extensions/people/comms/_module/agenda-writer.js";
import { translateAgendaTitles } from "../assets/extensions/people/comms/_module/agenda-translate.js";

// 07/11: the calendar had Dutch titles from Dutch mail («Controleer je pensioenoverzicht via DigiD»).
let db: Database;
let writer: AgendaWriter;
const src = { source_table: "google_emails" as const, source_id: "g1", thread_key: "t1", subject: "s", from: "x@y.nl" };

beforeEach(() => {
  db = new Database(":memory:");
  for (const [n, m] of [["crm", crmMigrations], ["events", eventsMigrations], ["tasks", tasksMigrations], ["reminders", remindersMigrations], ["comms", commsMigrations]] as const) runMigrations(db, n, m as never);
  writer = new AgendaWriter(db as any, { events: new EventsService(db as any), tasks: new TaskService(db as any, () => null), reminders: new ReminderService(db as any, () => null) });
  writer.write(src, [
    { kind: "deadline", title: "Controleer je pensioenoverzicht via DigiD", start_at: "2030-11-10", all_day: true, confidence: "high", evidence: "e" },
    { kind: "event", title: "Cena con Ana", start_at: "2030-11-12", all_day: true, confidence: "high", evidence: "e" },
  ]);
});
afterEach(() => db.close());

describe("translateAgendaTitles", () => {
  it("rewrites the titles that are not in the language, once, in one call", async () => {
    const calls: string[] = [];
    const chat = async (_system: string, user: string) => { calls.push(user); return JSON.stringify(["Revisar tu resumen de pensión en DigiD", "Cena con Ana"]); };
    expect(await translateAgendaTitles(db as any, chat, "español")).toBe(1);
    expect((db.query("SELECT title FROM tasks").get() as any).title).toBe("Revisar tu resumen de pensión en DigiD");
    expect((db.query("SELECT title FROM events").get() as any).title).toBe("Cena con Ana");
    expect(calls.length).toBe(1);
    expect(await translateAgendaTitles(db as any, chat, "español")).toBe(0);
    expect(calls.length).toBe(1);
  });

  it("an answer that does not line up changes nothing and tries again later", async () => {
    expect(await translateAgendaTitles(db as any, async () => "[\"solo uno\"]", "español")).toBe(0);
    expect((db.query("SELECT title FROM tasks").get() as any).title).toBe("Controleer je pensioenoverzicht via DigiD");
    let called = false;
    await translateAgendaTitles(db as any, async () => { called = true; return JSON.stringify(["A", "B"]); }, "español");
    expect(called).toBe(true);
  });

  it("a failing model leaves everything as it was", async () => {
    expect(await translateAgendaTitles(db as any, async () => { throw new Error("down"); }, "español")).toBe(0);
    expect((db.query("SELECT COUNT(*) n FROM mail_agenda_links WHERE title_checked = 1").get() as any).n).toBe(0);
  });
});
