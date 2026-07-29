import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { eventsMigrations } from "../assets/extensions/people/events/_module/migrations/001_events.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { EventsService } from "../assets/extensions/people/events/_module/service.js";
import { agentEventsTools } from "../assets/extensions/people/events/_module/agent-tools.js";
import { EventBus } from "../src/core/event-bus.js";

function setup() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  // Events service joins to `contacts` for organizer/attendee resolution.
  runMigrations(db, "crm", crmMigrations);
  runMigrations(db, "events", eventsMigrations);
  const service = new EventsService(db, new EventBus());
  const tools = agentEventsTools(service);
  return { db, service, tools };
}

describe("agent-shaped events tools", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  afterEach(() => {
    ctx.db.close();
  });

  it("registers the expected agent-shaped tools", () => {
    const names = ctx.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "kernel_event_attention",
      "kernel_event_lifecycle",
      "kernel_event_rsvp_summary",
      "kernel_event_schedule",
      "kernel_event_today",
      "kernel_event_upcoming",
    ]);
  });

  it("every agent tool declares an outputSchema and tags", () => {
    for (const t of ctx.tools) {
      expect(t.outputSchema).toBeDefined();
      expect(Array.isArray(t.tags)).toBe(true);
      expect((t.tags ?? []).length).toBeGreaterThan(0);
    }
  });

  it("kernel_event_schedule creates an event and returns structured summary", async () => {
    const tool = ctx.tools.find((t) => t.name === "kernel_event_schedule")!;
    const start = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const result = await tool.handler({
      title: "Demo standup",
      start_at: start,
      duration_minutes: 30,
      min_attendees: 2,
    });
    const data = result.structuredContent as {
      id: string;
      title: string;
      attendance: { yes: number; pending: number };
      invited: number;
    };
    expect(data.title).toBe("Demo standup");
    expect(data.attendance.yes).toBe(0);
    expect(data.invited).toBe(0);
    expect(typeof data.id).toBe("string");
  });

  it("kernel_event_today returns today's events only", async () => {
    const todayStart = new Date();
    todayStart.setUTCHours(10, 0, 0, 0);
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);

    ctx.service.create({ title: "Today", start_at: todayStart.toISOString(), duration_minutes: 60 });
    ctx.service.create({ title: "Tomorrow", start_at: tomorrow.toISOString(), duration_minutes: 60 });

    const tool = ctx.tools.find((t) => t.name === "kernel_event_today")!;
    const result = await tool.handler({});
    const data = result.structuredContent as {
      total: number;
      events: Array<{ title: string }>;
    };
    expect(data.total).toBe(1);
    expect(data.events[0].title).toBe("Today");
  });

  it("kernel_event_upcoming returns events within the window", async () => {
    const future = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    ctx.service.create({ title: "In 3 days", start_at: future.toISOString(), duration_minutes: 60 });

    const tool = ctx.tools.find((t) => t.name === "kernel_event_upcoming")!;
    const result = await tool.handler({ days: 7 });
    const data = result.structuredContent as { total: number };
    expect(data.total).toBeGreaterThanOrEqual(1);
  });

  it("kernel_event_lifecycle dispatches to the right service method", async () => {
    const start = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const e = ctx.service.create({ title: "Lifecycle", start_at: start, duration_minutes: 30 });

    const tool = ctx.tools.find((t) => t.name === "kernel_event_lifecycle")!;
    const opened = await tool.handler({ action: "open", event_id: e.id });
    expect((opened.structuredContent as { event: { status: string } }).event.status).toBe("open");

    const cancelled = await tool.handler({ action: "cancel", event_id: e.id });
    expect((cancelled.structuredContent as { event: { status: string } }).event.status).toBe("cancelled");
  });

  it("kernel_event_attention surfaces events still under min_attendees", async () => {
    const start = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    const e = ctx.service.create({
      title: "Underbooked",
      start_at: start,
      duration_minutes: 60,
      min_attendees: 5,
    });
    ctx.service.open(e.id);

    const tool = ctx.tools.find((t) => t.name === "kernel_event_attention")!;
    const result = await tool.handler({ imminent_hours: 72 });
    const data = result.structuredContent as {
      needing_attention: Array<{ id: string }>;
      imminent: Array<{ id: string }>;
    };
    expect(data.needing_attention.some((ev) => ev.id === e.id)).toBe(true);
  });

  it("kernel_event_rsvp_summary returns event + attendees + pending", async () => {
    const start = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const e = ctx.service.create({ title: "Test", start_at: start, duration_minutes: 60 });
    ctx.service.invite({ event_id: e.id, name: "Alice", phone: "+5491100000001" });
    ctx.service.invite({ event_id: e.id, name: "Bob", phone: "+5491100000002" });

    const tool = ctx.tools.find((t) => t.name === "kernel_event_rsvp_summary")!;
    const result = await tool.handler({ event_id: e.id });
    const data = result.structuredContent as {
      event: { id: string };
      attendees: Array<{ name: string; rsvp_status: string }>;
      pending: Array<{ name: string }>;
    };
    expect(data.event.id).toBe(e.id);
    expect(data.attendees.length).toBe(2);
    expect(data.pending.length).toBe(2);
    expect(data.pending.map((a) => a.name).sort()).toEqual(["Alice", "Bob"]);
  });
});
