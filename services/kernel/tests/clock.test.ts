import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  today, daysFromNow, localDate, localDateTime, addDays, localDayRange, kernelTimezone,
  toInstant, localParts, localDateOf,
} from "../src/sdk/clock.js";
import { normalizeInstants } from "../src/sdk/query-helpers.js";
import { useTimezone } from "../src/core/host-runtime.js";
import { computeNextTrigger } from "../assets/extensions/productivity/reminders/_module/service.js";
import { parseReminderText } from "../src/modules/agents/orchestrator-commands.js";

const BA = "America/Argentina/Buenos_Aires"; // UTC-3, no DST

afterEach(() => useTimezone(() => "UTC"));

// 2026-09-23 22:30 in Buenos Aires (UTC-3) is already the 24th in UTC.
const lateEvening = new Date("2026-09-24T01:30:00Z");

describe("clock", () => {
  it("answers in UTC while no TIMEZONE is set, as before", () => {
    expect(kernelTimezone()).toBe("UTC");
    expect(today(lateEvening)).toBe("2026-09-24");
  });

  it("follows the kernel's TIMEZONE, read live", () => {
    let tz = "America/Argentina/Buenos_Aires";
    useTimezone(() => tz);
    expect(today(lateEvening)).toBe("2026-09-23");
    expect(daysFromNow(1, lateEvening)).toBe("2026-09-24");
    expect(daysFromNow(-7, lateEvening)).toBe("2026-09-16");
    tz = "Asia/Tokyo"; // UTC+9: 10:30 on the 24th
    expect(today(lateEvening)).toBe("2026-09-24");
  });

  it("falls back to UTC for a zone name Intl does not know", () => {
    useTimezone(() => "Mars/Olympus_Mons");
    expect(kernelTimezone()).toBe("UTC");
    expect(localDate(lateEvening)).toBe("2026-09-24");
  });

  it("adds calendar days across month ends and DST changes", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    useTimezone(() => "Europe/Madrid");
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29"); // spring forward is the 29th
  });

  it("bounds a local day in UTC instants", () => {
    useTimezone(() => "America/Argentina/Buenos_Aires");
    expect(localDayRange("2026-09-23")).toEqual(["2026-09-23T03:00:00.000Z", "2026-09-24T03:00:00.000Z"]);
  });

  it("bounds a day with a DST change by its real length", () => {
    useTimezone(() => "Europe/Madrid");
    // 2026-03-29 has 23 hours in Madrid: +01:00 at midnight, +02:00 by the end.
    expect(localDayRange("2026-03-29")).toEqual(["2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"]);
  });
});

describe("toInstant", () => {
  it("keeps instants and reads SQLite's format as UTC", () => {
    useTimezone(() => BA);
    expect(toInstant("2026-09-23T12:00:00Z")).toBe("2026-09-23T12:00:00.000Z");
    expect(toInstant("2026-09-23T12:00:00+02:00")).toBe("2026-09-23T10:00:00.000Z");
    expect(toInstant("2026-09-23 12:00:00")).toBe("2026-09-23T12:00:00.000Z");
  });

  it("reads a time without a zone as the kernel's local time", () => {
    useTimezone(() => BA);
    expect(toInstant("2026-09-23T09:30")).toBe("2026-09-23T12:30:00.000Z");
    expect(toInstant("2026-09-23T09:30:15")).toBe("2026-09-23T12:30:15.000Z");
    expect(toInstant("2026-09-23")).toBe("2026-09-23T03:00:00.000Z");
  });

  it("answers null for something that is not a date", () => {
    expect(toInstant("soon")).toBeNull();
  });
});

describe("localParts", () => {
  it("puts a late-evening instant on its local day", () => {
    useTimezone(() => BA);
    expect(localParts("2026-09-24T01:30:00.000Z")).toEqual({ date: "2026-09-23", time: "22:30" });
    expect(localDateOf("2026-09-24T01:30:00.000Z")).toBe("2026-09-23");
    expect(localDateTime(new Date("2026-09-24T01:30:05Z"))).toBe("2026-09-23T22:30:05");
  });

  it("is the old split in UTC, and a bare date has no time", () => {
    expect(localParts("2026-09-24T01:30:00.000Z")).toEqual({ date: "2026-09-24", time: "01:30" });
    expect(localParts("2026-09-24")).toEqual({ date: "2026-09-24", time: null });
  });
});

describe("normalizeInstants", () => {
  it("rewrites values without a zone and leaves instants alone, once", () => {
    useTimezone(() => BA);
    const db = new Database(":memory:");
    db.run("CREATE TABLE t (id TEXT, at TEXT)");
    db.run("INSERT INTO t VALUES ('a', '2026-09-23T09:00'), ('b', '2026-09-23T12:00:00.000Z'), ('c', ''), ('d', NULL)");
    expect(normalizeInstants(db, "t", ["at", "missing"])).toBe(1);
    expect(normalizeInstants(db, "t", ["at"])).toBe(0);
    expect(normalizeInstants(db, "no_such_table", ["at"])).toBe(0);
    const rows = db.prepare("SELECT id, at FROM t ORDER BY id").all();
    expect(rows).toEqual([
      { id: "a", at: "2026-09-23T12:00:00.000Z" },
      { id: "b", at: "2026-09-23T12:00:00.000Z" },
      { id: "c", at: "" },
      { id: "d", at: null },
    ]);
  });
});

describe("recurring reminders", () => {
  it("keep their local wall-clock time across a DST change", () => {
    useTimezone(() => "Europe/Madrid");
    // 09:00 in Madrid on the 28th (+01:00); the clocks go forward on the 29th.
    expect(computeNextTrigger("2026-03-28T08:00:00.000Z", "daily")).toBe("2026-03-29T07:00:00.000Z");
    expect(computeNextTrigger("2026-03-28T08:00:00.000Z", "weekly")).toBe("2026-04-04T07:00:00.000Z");
  });

  it("advance exactly as before in UTC", () => {
    expect(computeNextTrigger("2026-01-31T09:00:00.000Z", "daily")).toBe("2026-02-01T09:00:00.000Z");
    expect(computeNextTrigger("2026-01-31T09:00:00.000Z", "monthly")).toBe("2026-03-03T09:00:00.000Z");
    expect(computeNextTrigger("2026-01-31T09:00:00.000Z", "none")).toBe("2026-01-31T09:00:00.000Z");
  });
});

describe("/remind with a clock time", () => {
  it("means the user's local time", () => {
    useTimezone(() => BA);
    const parsed = parseReminderText("Buy milk tomorrow at 9am");
    expect(parsed.title).toBe("Buy milk");
    expect(parsed.triggerAt).toBe(`${daysFromNow(1)}T12:00:00.000Z`);
  });
});

describe("calendar and lists in a non-UTC zone", () => {
  it("puts a late-evening reminder on its local day and time", async () => {
    useTimezone(() => BA);
    const { runMigrations } = await import("../src/core/db/migrations.js");
    const { remindersMigrations } = await import("../assets/extensions/productivity/reminders/_module/migrations/001_reminders.js");
    const { remindersCalendarSource } = await import("../assets/extensions/productivity/reminders/_module/calendar.js");
    const db = new Database(":memory:");
    runMigrations(db, "reminders", remindersMigrations);
    db.run(`INSERT INTO reminders (id, title, body, trigger_at, status, repeat, created_at, updated_at)
            VALUES ('r1', 'Late call', '', '2026-09-24T01:30:00.000Z', 'active', 'none', '', '')`);
    const { events } = remindersCalendarSource.query(db, { start: "2026-09-23", end: "2026-09-24" });
    expect(events.map((e) => [e.date, e.time])).toEqual([["2026-09-23", "22:30"]]);
    // The next local day does not show it.
    expect(remindersCalendarSource.query(db, { start: "2026-09-24", end: "2026-09-25" }).events).toEqual([]);
  });

  it("lists every event of the to_date day", async () => {
    useTimezone(() => BA);
    const { runMigrations } = await import("../src/core/db/migrations.js");
    const { eventsMigrations } = await import("../assets/extensions/people/events/_module/migrations/001_events.js");
    const { crmMigrations } = await import("../assets/extensions/people/crm/_module/migrations/001_crm.js");
    const { EventsService } = await import("../assets/extensions/people/events/_module/service.js");
    const db = new Database(":memory:");
    runMigrations(db, "crm", crmMigrations);
    runMigrations(db, "events", eventsMigrations);
    const service = new EventsService(db);
    service.create({ title: "Dinner", start_at: "2026-09-23T21:00" }); // local; 00:00Z on the 24th
    service.create({ title: "Tomorrow", start_at: "2026-09-24T10:00" });
    const titles = service.list({ from_date: "2026-09-23", to_date: "2026-09-23" }).map((e) => e.title);
    expect(titles).toEqual(["Dinner"]);
  });
});
