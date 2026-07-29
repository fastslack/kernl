import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { eventsMigrations } from "../assets/extensions/people/events/_module/migrations/001_events.js";
import { EventsService } from "../assets/extensions/people/events/_module/service.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";

describe("EventsService", () => {
  let db: Database;
  let service: EventsService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    // CRM migrations needed for contacts FK
    runMigrations(db, "crm", crmMigrations);
    runMigrations(db, "events", eventsMigrations);
    service = new EventsService(db);
  });

  afterEach(() => db.close());

  describe("Event CRUD", () => {
    it("creates an event", () => {
      const event = service.create({
        title: "Fulbito del Jueves",
        type: "sports",
        start_at: "2025-03-06T20:00:00",
        min_attendees: 10,
        max_attendees: 10,
      });

      expect(event.id).toBeTruthy();
      expect(event.title).toBe("Fulbito del Jueves");
      expect(event.type).toBe("sports");
      expect(event.status).toBe("draft");
      expect(event.min_attendees).toBe(10);
      expect(event.max_attendees).toBe(10);
    });

    it("gets event with summary", () => {
      const created = service.create({
        title: "Test Event",
        start_at: "2025-03-10T18:00:00",
      });

      const event = service.get(created.id);
      expect(event).toBeTruthy();
      expect(event!.attendees).toEqual([]);
      expect(event!.summary.yes).toBe(0);
      expect(event!.summary.is_confirmed).toBe(false); // min_attendees defaults to 1, yes=0 < 1
    });

    it("updates event", () => {
      const event = service.create({
        title: "Original",
        start_at: "2025-03-10T18:00:00",
      });

      const updated = service.update(event.id, { title: "Updated Title" });
      expect(updated!.title).toBe("Updated Title");
    });

    it("opens event for RSVPs", () => {
      const event = service.create({
        title: "Test",
        start_at: "2025-03-10T18:00:00",
      });

      expect(event.status).toBe("draft");
      const opened = service.open(event.id);
      expect(opened!.status).toBe("open");
    });

    it("cancels event", () => {
      const event = service.create({
        title: "Test",
        start_at: "2025-03-10T18:00:00",
      });

      const cancelled = service.cancel(event.id);
      expect(cancelled!.status).toBe("cancelled");
    });
  });

  describe("Attendee Management", () => {
    it("invites attendee manually", () => {
      const event = service.create({
        title: "Test",
        start_at: "2025-03-10T18:00:00",
      });

      const attendee = service.invite({
        event_id: event.id,
        name: "Juan Pérez",
        phone: "+5491112345678",
      });

      expect(attendee.name).toBe("Juan Pérez");
      expect(attendee.phone).toBe("+5491112345678");
      expect(attendee.rsvp_status).toBe("pending");
    });

    it("invites from CRM contact", () => {
      // Create a contact first
      db.prepare(
        `INSERT INTO contacts (id, name, phone, email, company, notes, relationship, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("contact-1", "María García", "+5491198765432", "", "", "", "personal", new Date().toISOString(), new Date().toISOString());

      const event = service.create({
        title: "Test",
        start_at: "2025-03-10T18:00:00",
      });

      const attendee = service.invite({
        event_id: event.id,
        contact_id: "contact-1",
      });

      expect(attendee.name).toBe("María García");
      expect(attendee.phone).toBe("+5491198765432");
      expect(attendee.contact_id).toBe("contact-1");
    });

    it("bulk invites contacts", () => {
      // Create contacts
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO contacts (id, name, phone, email, company, notes, relationship, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("c1", "Player 1", "+1", "", "", "", "personal", now, now);
      db.prepare(
        `INSERT INTO contacts (id, name, phone, email, company, notes, relationship, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("c2", "Player 2", "+2", "", "", "", "personal", now, now);

      const event = service.create({
        title: "Fulbito",
        start_at: "2025-03-06T20:00:00",
      });

      const attendees = service.inviteContacts(event.id, ["c1", "c2"]);
      expect(attendees).toHaveLength(2);
    });
  });

  describe("RSVP Flow", () => {
    it("records yes RSVP", () => {
      const event = service.create({
        title: "Test",
        start_at: "2025-03-10T18:00:00",
        min_attendees: 2,
      });

      const attendee = service.invite({
        event_id: event.id,
        name: "Test Person",
        phone: "+1",
      });

      const rsvp = service.rsvp({
        event_id: event.id,
        attendee_id: attendee.id,
        status: "yes",
      });

      expect(rsvp!.rsvp_status).toBe("yes");
      expect(rsvp!.rsvp_at).toBeTruthy();
    });

    it("updates event summary on RSVP", () => {
      const event = service.create({
        title: "Test",
        start_at: "2025-03-10T18:00:00",
        min_attendees: 2,
      });

      service.invite({ event_id: event.id, name: "P1", phone: "+1" });
      service.invite({ event_id: event.id, name: "P2", phone: "+2" });

      // Before RSVPs
      let updated = service.get(event.id)!;
      expect(updated.summary.pending).toBe(2);
      expect(updated.summary.is_confirmed).toBe(false);

      // RSVP yes
      service.rsvp({ event_id: event.id, phone: "+1", status: "yes" });
      service.rsvp({ event_id: event.id, phone: "+2", status: "yes" });

      updated = service.get(event.id)!;
      expect(updated.summary.yes).toBe(2);
      expect(updated.summary.pending).toBe(0);
      expect(updated.summary.is_confirmed).toBe(true);
    });

    it("adds to waitlist when full", () => {
      const event = service.create({
        title: "Full Event",
        start_at: "2025-03-10T18:00:00",
        min_attendees: 2,
        max_attendees: 2,
      });

      service.invite({ event_id: event.id, name: "P1", phone: "+1" });
      service.invite({ event_id: event.id, name: "P2", phone: "+2" });
      service.invite({ event_id: event.id, name: "P3", phone: "+3" });

      service.rsvp({ event_id: event.id, phone: "+1", status: "yes" });
      service.rsvp({ event_id: event.id, phone: "+2", status: "yes" });

      // Event is now full
      const rsvp3 = service.rsvp({ event_id: event.id, phone: "+3", status: "yes" });
      expect(rsvp3!.rsvp_status).toBe("waitlist");
      expect(rsvp3!.waitlist_position).toBe(1);
    });

    it("promotes from waitlist when someone declines", () => {
      const event = service.create({
        title: "Full Event",
        start_at: "2025-03-10T18:00:00",
        max_attendees: 2,
      });

      service.invite({ event_id: event.id, name: "P1", phone: "+1" });
      service.invite({ event_id: event.id, name: "P2", phone: "+2" });
      service.invite({ event_id: event.id, name: "P3", phone: "+3" });

      service.rsvp({ event_id: event.id, phone: "+1", status: "yes" });
      service.rsvp({ event_id: event.id, phone: "+2", status: "yes" });
      service.rsvp({ event_id: event.id, phone: "+3", status: "yes" }); // Goes to waitlist

      // P2 declines
      service.rsvp({ event_id: event.id, phone: "+2", status: "no" });

      // P3 should be promoted
      const updated = service.get(event.id)!;
      const p3 = updated.attendees.find((a) => a.phone === "+3");
      expect(p3!.rsvp_status).toBe("yes");
      expect(p3!.waitlist_position).toBeNull();
    });

    it("tracks maybe responses", () => {
      const event = service.create({
        title: "Test",
        start_at: "2025-03-10T18:00:00",
      });

      service.invite({ event_id: event.id, name: "P1", phone: "+1" });
      service.rsvp({ event_id: event.id, phone: "+1", status: "maybe" });

      const updated = service.get(event.id)!;
      expect(updated.summary.maybe).toBe(1);
    });
  });

  describe("Queries", () => {
    it("lists events by status", () => {
      service.create({ title: "Draft", start_at: "2025-03-10T18:00:00" });
      const open = service.create({ title: "Open", start_at: "2025-03-11T18:00:00" });
      service.open(open.id);

      const drafts = service.list({ status: "draft" });
      const opened = service.list({ status: "open" });

      expect(drafts).toHaveLength(1);
      expect(opened).toHaveLength(1);
    });

    it("lists upcoming events", () => {
      // Create event in the past (won't show)
      service.create({ title: "Past", start_at: "2020-01-01T18:00:00" });

      // Create event in the future
      const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      service.create({ title: "Future", start_at: future });

      const upcoming = service.upcoming(7);
      expect(upcoming).toHaveLength(1);
      expect(upcoming[0].title).toBe("Future");
    });

    it("finds pending RSVPs", () => {
      const event = service.create({
        title: "Test",
        start_at: "2025-03-10T18:00:00",
      });

      service.invite({ event_id: event.id, name: "P1", phone: "+1" });
      service.invite({ event_id: event.id, name: "P2", phone: "+2" });
      service.rsvp({ event_id: event.id, phone: "+1", status: "yes" });

      const pending = service.getPendingRSVPs(event.id);
      expect(pending).toHaveLength(1);
      expect(pending[0].phone).toBe("+2");
    });

    it("finds events needing attention", () => {
      // Event with pending RSVPs
      const e1 = service.create({
        title: "Needs RSVPs",
        start_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        min_attendees: 5,
      });
      service.open(e1.id);
      service.invite({ event_id: e1.id, name: "P1", phone: "+1" });

      const needsAttention = service.needingAttention();
      expect(needsAttention.length).toBeGreaterThan(0);
    });
  });

  describe("Fulbito del Jueves scenario", () => {
    it("complete flow: create → invite 12 → collect RSVPs → confirm", () => {
      // 1. Create the weekly game
      const event = service.create({
        title: "Fulbito del Jueves",
        type: "sports",
        start_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 90,
        location: "Cancha El Gol",
        min_attendees: 10,
        max_attendees: 14, // 2 teams + subs
        cost_per_person_cents: 500,
        cost_currency: "EUR",
      });

      expect(event.status).toBe("draft");

      // 2. Open for RSVPs
      service.open(event.id);

      // 3. Invite 12 players
      for (let i = 1; i <= 12; i++) {
        service.invite({
          event_id: event.id,
          name: `Jugador ${i}`,
          phone: `+${i}`,
        });
      }

      let summary = service.get(event.id)!.summary;
      expect(summary.pending).toBe(12);
      expect(summary.is_confirmed).toBe(false);
      expect(summary.needs_more).toBe(10);

      // 4. 8 say yes, 2 say no, 2 pending
      for (let i = 1; i <= 8; i++) {
        service.rsvp({ event_id: event.id, phone: `+${i}`, status: "yes" });
      }
      service.rsvp({ event_id: event.id, phone: "+9", status: "no" });
      service.rsvp({ event_id: event.id, phone: "+10", status: "no" });

      summary = service.get(event.id)!.summary;
      expect(summary.yes).toBe(8);
      expect(summary.no).toBe(2);
      expect(summary.pending).toBe(2);
      expect(summary.is_confirmed).toBe(false);
      expect(summary.needs_more).toBe(2);

      // 5. 2 more say yes → confirmed!
      service.rsvp({ event_id: event.id, phone: "+11", status: "yes" });
      service.rsvp({ event_id: event.id, phone: "+12", status: "yes" });

      const final = service.get(event.id)!;
      expect(final.summary.yes).toBe(10);
      expect(final.summary.is_confirmed).toBe(true);
      expect(final.status).toBe("confirmed"); // Auto-confirmed
    });
  });

  describe("Duplication & Recurrence", () => {
    it("duplicates event with all attendees", () => {
      const event = service.create({
        title: "Fulbito",
        start_at: "2025-03-06T20:00:00",
        min_attendees: 10,
        location: "Cancha",
      });

      service.invite({ event_id: event.id, name: "P1", phone: "+1" });
      service.invite({ event_id: event.id, name: "P2", phone: "+2" });
      service.rsvp({ event_id: event.id, phone: "+1", status: "yes" });

      const duplicate = service.duplicate(event.id, "2025-03-13T20:00:00");
      expect(duplicate).toBeTruthy();
      expect(duplicate!.title).toBe("Fulbito");
      expect(duplicate!.start_at).toBe("2025-03-13T20:00:00");
      expect(duplicate!.location).toBe("Cancha");
      expect(duplicate!.attendees).toHaveLength(2);
      // All attendees start as pending in new event
      expect(duplicate!.attendees.every((a) => a.rsvp_status === "pending")).toBe(true);
    });

    it("duplicates only confirmed attendees when requested", () => {
      const event = service.create({
        title: "Test",
        start_at: "2025-03-06T20:00:00",
      });

      service.invite({ event_id: event.id, name: "P1", phone: "+1" });
      service.invite({ event_id: event.id, name: "P2", phone: "+2" });
      service.rsvp({ event_id: event.id, phone: "+1", status: "yes" });
      service.rsvp({ event_id: event.id, phone: "+2", status: "no" });

      const duplicate = service.duplicate(event.id, "2025-03-13T20:00:00", {
        reinviteOnlyConfirmed: true,
      });

      expect(duplicate!.attendees).toHaveLength(1);
      expect(duplicate!.attendees[0].name).toBe("P1");
    });

    it("calculates next weekly occurrence", () => {
      const event = service.create({
        title: "Weekly Game",
        start_at: "2025-03-06T20:00:00", // Thursday
        recurrence: { frequency: "weekly", day_of_week: 4, until: null },
      });

      const nextDate = service.calculateNextOccurrence(event.start_at, event.recurrence!);
      expect(nextDate).toContain("2025-03-13"); // Next Thursday
    });

    it("calculates next biweekly occurrence", () => {
      const event = service.create({
        title: "Biweekly",
        start_at: "2025-03-06T20:00:00",
        recurrence: { frequency: "biweekly", day_of_week: 4, until: null },
      });

      const nextDate = service.calculateNextOccurrence(event.start_at, event.recurrence!);
      expect(nextDate).toContain("2025-03-20"); // Two weeks later
    });

    it("generates next recurrence with attendees", () => {
      const event = service.create({
        title: "Recurring",
        start_at: "2025-03-06T20:00:00",
        recurrence: { frequency: "weekly", day_of_week: 4, until: null },
      });

      service.invite({ event_id: event.id, name: "P1", phone: "+1" });

      const next = service.generateNextRecurrence(event.id);
      expect(next).toBeTruthy();
      expect(next!.attendees).toHaveLength(1);
      expect(next!.parent_event_id).toBe(event.id);
    });
  });

  describe("Completion & Summary", () => {
    it("completes event with summary stats", () => {
      const event = service.create({
        title: "Completed Event",
        start_at: "2025-03-06T20:00:00",
        min_attendees: 2,
        cost_per_person_cents: 500,
        cost_currency: "EUR",
      });

      service.invite({ event_id: event.id, name: "P1", phone: "+1" });
      service.invite({ event_id: event.id, name: "P2", phone: "+2" });
      service.invite({ event_id: event.id, name: "P3", phone: "+3" });
      service.rsvp({ event_id: event.id, phone: "+1", status: "yes" });
      service.rsvp({ event_id: event.id, phone: "+2", status: "yes" });
      service.rsvp({ event_id: event.id, phone: "+3", status: "no" });

      const summary = service.completeWithSummary(event.id);
      expect(summary).toBeTruthy();
      expect(summary!.final_attendance).toBe(2);
      expect(summary!.total_invited).toBe(3);
      expect(summary!.attendance_rate).toBe(67); // 2/3 rounded
      expect(summary!.total_cost_cents).toBe(1000); // 2 * 500
      expect(summary!.met_minimum).toBe(true);

      // Verify event is marked completed
      const completed = service.get(event.id);
      expect(completed!.status).toBe("completed");
    });

    it("generates notification text", () => {
      const event = service.create({
        title: "Fulbito del Jueves",
        start_at: "2025-03-06T20:00:00",
        min_attendees: 10,
        max_attendees: 14,
        location: "Cancha El Gol",
        cost_per_person_cents: 500,
        cost_currency: "EUR",
      });

      service.invite({ event_id: event.id, name: "Juan", phone: "+1" });
      service.invite({ event_id: event.id, name: "Pedro", phone: "+2" });
      service.rsvp({ event_id: event.id, phone: "+1", status: "yes" });

      const text = service.getNotificationText(event.id);
      expect(text).toBeTruthy();
      expect(text!.short).toContain("Fulbito");
      expect(text!.full).toContain("Cancha El Gol");
      expect(text!.full).toContain("9 more needed"); // 10 min - 1 yes
      expect(text!.attendee_list).toContain("Juan");
      expect(text!.pending_names).toContain("Pedro");
    });
  });

  describe("History & Analytics", () => {
    it("tracks contact event history", () => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO contacts (id, name, phone, email, company, notes, relationship, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("contact-1", "Player", "+1", "", "", "", "personal", now, now);

      // Create multiple events
      const e1 = service.create({ title: "Game 1", start_at: "2025-03-01T20:00:00" });
      const e2 = service.create({ title: "Game 2", start_at: "2025-03-08T20:00:00" });
      const e3 = service.create({ title: "Game 3", start_at: "2025-03-15T20:00:00" });

      service.invite({ event_id: e1.id, contact_id: "contact-1" });
      service.invite({ event_id: e2.id, contact_id: "contact-1" });
      service.invite({ event_id: e3.id, contact_id: "contact-1" });

      service.rsvp({ event_id: e1.id, contact_id: "contact-1", status: "yes" });
      service.rsvp({ event_id: e2.id, contact_id: "contact-1", status: "yes" });
      service.rsvp({ event_id: e3.id, contact_id: "contact-1", status: "no" });

      const history = service.getContactHistory("contact-1");
      expect(history.events).toHaveLength(3);
      expect(history.stats.yes_count).toBe(2);
      expect(history.stats.no_count).toBe(1);
      expect(history.reliability_score).toBe(67); // 2/3 rounded
    });

    it("gets imminent events", () => {
      // Create event in 24 hours
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const event = service.create({ title: "Tomorrow", start_at: tomorrow });
      service.open(event.id);

      // Create event far in future (won't show)
      const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      service.create({ title: "Far", start_at: farFuture });

      const imminent = service.getImminent(48);
      expect(imminent).toHaveLength(1);
      expect(imminent[0].title).toBe("Tomorrow");
    });
  });
});
