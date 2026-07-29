import crypto from "node:crypto";
import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";

export function registerEventsRoutes(
  server: KernelHttpServer,
  db: SqliteDb,
  events?: EventBus,
): void {
  server.post("/api/events/rsvp", async (req, res) => {
    try {
      const body = await server.parseBody<{
        event_id: string;
        attendee_id?: string;
        phone?: string;
        status: "yes" | "no" | "maybe";
        notes?: string;
      }>(req);

      if (!body.event_id || !body.status) {
        server.json(res, 400, { error: "event_id and status required" });
        return;
      }

      const now = new Date().toISOString();

      // Find attendee
      let attendeeId = body.attendee_id;
      if (!attendeeId && body.phone) {
        const row = db.prepare(
          "SELECT id FROM event_attendees WHERE event_id = ? AND phone = ?"
        ).get(body.event_id, body.phone) as { id: string } | undefined;
        if (row) attendeeId = row.id;
      }

      if (!attendeeId) {
        server.json(res, 404, { error: "Attendee not found" });
        return;
      }

      // Get event to check capacity
      const event = db.prepare(`
        SELECT e.*,
          (SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id AND rsvp_status = 'yes') as yes_count
        FROM events e WHERE e.id = ?
      `).get(body.event_id) as { max_attendees: number | null; yes_count: number; min_attendees: number } | undefined;

      if (!event) {
        server.json(res, 404, { error: "Event not found" });
        return;
      }

      let newStatus = body.status;
      let waitlistPosition: number | null = null;

      // If saying yes but event is full, put on waitlist
      if (body.status === "yes" && event.max_attendees !== null && event.yes_count >= event.max_attendees) {
        newStatus = "waitlist" as "yes" | "no" | "maybe";
        const maxPos = db.prepare(
          "SELECT MAX(waitlist_position) as pos FROM event_attendees WHERE event_id = ? AND rsvp_status = 'waitlist'"
        ).get(body.event_id) as { pos: number | null };
        waitlistPosition = (maxPos.pos ?? 0) + 1;
      }

      // Update RSVP
      db.prepare(`
        UPDATE event_attendees
        SET rsvp_status = ?, rsvp_at = ?, waitlist_position = ?, notes = COALESCE(?, notes), updated_at = ?
        WHERE id = ?
      `).run(newStatus, now, waitlistPosition, body.notes, now, attendeeId);

      // If someone said no, promote from waitlist
      if (body.status === "no") {
        const waitlisted = db.prepare(`
          SELECT id FROM event_attendees
          WHERE event_id = ? AND rsvp_status = 'waitlist'
          ORDER BY waitlist_position ASC LIMIT 1
        `).get(body.event_id) as { id: string } | undefined;

        if (waitlisted) {
          db.prepare(`
            UPDATE event_attendees
            SET rsvp_status = 'yes', waitlist_position = NULL, updated_at = ?
            WHERE id = ?
          `).run(now, waitlisted.id);
        }
      }

      // Check for auto-confirm
      const updatedEvent = db.prepare(`
        SELECT e.status, e.min_attendees,
          (SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id AND rsvp_status = 'yes') as yes_count
        FROM events e WHERE e.id = ?
      `).get(body.event_id) as { status: string; min_attendees: number; yes_count: number };

      if (updatedEvent.status === "open" && updatedEvent.yes_count >= updatedEvent.min_attendees) {
        db.prepare("UPDATE events SET status = 'confirmed', updated_at = ? WHERE id = ?")
          .run(now, body.event_id);
      }

      events?.emit("data.changed", { module: "events", action: "rsvp" });
      server.json(res, 200, { ok: true, status: newStatus, waitlist_position: waitlistPosition });
    } catch (err) {
      server.json(res, 400, { error: err instanceof Error ? err.message : "Invalid request" });
    }
  });

  server.post("/api/events/invite", async (req, res) => {
    try {
      const body = await server.parseBody<{
        event_id: string;
        name: string;
        phone?: string;
      }>(req);

      if (!body.event_id || !body.name) {
        server.json(res, 400, { error: "event_id and name required" });
        return;
      }

      const now = new Date().toISOString();
      const id = crypto.randomUUID();

      db.prepare(`
        INSERT INTO event_attendees (id, event_id, contact_id, name, phone, rsvp_status, rsvp_at, waitlist_position, notes, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, 'pending', NULL, NULL, '', ?, ?)
      `).run(id, body.event_id, body.name, body.phone ?? "", now, now);

      events?.emit("data.changed", { module: "events", action: "invite" });
      server.json(res, 200, { ok: true, id });
    } catch (err) {
      server.json(res, 400, { error: err instanceof Error ? err.message : "Invalid request" });
    }
  });

  server.post("/api/events/remove-attendee", async (req, res) => {
    try {
      const body = await server.parseBody<{ attendee_id: string }>(req);

      if (!body.attendee_id) {
        server.json(res, 400, { error: "attendee_id required" });
        return;
      }

      // Get event_id before deleting
      const attendee = db.prepare(
        "SELECT event_id FROM event_attendees WHERE id = ?"
      ).get(body.attendee_id) as { event_id: string } | undefined;

      db.prepare("DELETE FROM event_attendees WHERE id = ?").run(body.attendee_id);

      // Promote from waitlist if needed
      if (attendee) {
        const now = new Date().toISOString();
        const waitlisted = db.prepare(`
          SELECT id FROM event_attendees
          WHERE event_id = ? AND rsvp_status = 'waitlist'
          ORDER BY waitlist_position ASC LIMIT 1
        `).get(attendee.event_id) as { id: string } | undefined;

        if (waitlisted) {
          db.prepare(`
            UPDATE event_attendees
            SET rsvp_status = 'yes', waitlist_position = NULL, updated_at = ?
            WHERE id = ?
          `).run(now, waitlisted.id);
        }
      }

      events?.emit("data.changed", { module: "events", action: "remove_attendee" });
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 400, { error: err instanceof Error ? err.message : "Invalid request" });
    }
  });

  server.post("/api/events/open", async (req, res) => {
    try {
      const body = await server.parseBody<{ event_id: string }>(req);
      const now = new Date().toISOString();
      db.prepare("UPDATE events SET status = 'open', updated_at = ? WHERE id = ?")
        .run(now, body.event_id);
      events?.emit("data.changed", { module: "events", action: "open" });
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 400, { error: err instanceof Error ? err.message : "Invalid request" });
    }
  });

  server.post("/api/events/cancel", async (req, res) => {
    try {
      const body = await server.parseBody<{ event_id: string }>(req);
      const now = new Date().toISOString();
      db.prepare("UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ?")
        .run(now, body.event_id);
      events?.emit("data.changed", { module: "events", action: "cancel" });
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 400, { error: err instanceof Error ? err.message : "Invalid request" });
    }
  });

  server.post("/api/events/complete", async (req, res) => {
    try {
      const body = await server.parseBody<{ event_id: string }>(req);
      const now = new Date().toISOString();
      db.prepare("UPDATE events SET status = 'completed', updated_at = ? WHERE id = ?")
        .run(now, body.event_id);
      events?.emit("data.changed", { module: "events", action: "complete" });
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 400, { error: err instanceof Error ? err.message : "Invalid request" });
    }
  });
}
