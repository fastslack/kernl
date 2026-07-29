/**
 * Events RPC Actions — event management + RSVP via mtwRequest.
 */

import crypto from "node:crypto";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";

export function eventsRpcActions(db: SqliteDb): RpcAction[] {
  return [
    {
      name: "events.list",
      handler: async (args) => {
        const status = typeof args.status === "string" ? args.status : "";
        const type = typeof args.type === "string" ? args.type : "";
        const from = typeof args.from === "string" ? args.from : "";
        const limit = Math.min(200, Math.max(10, typeof args.limit === "number" ? args.limit : 50));

        let where = "1=1";
        const params: unknown[] = [];
        if (status) { where += " AND status = ?"; params.push(status); }
        if (type) { where += " AND type = ?"; params.push(type); }
        if (from) { where += " AND start_at >= ?"; params.push(from); }

        const rows = db.prepare(
          `SELECT id, title, description, type, status, start_at, end_at, duration_minutes,
                  location, location_url, min_attendees, max_attendees, cost_per_person_cents,
                  cost_currency, notes, created_at, updated_at
           FROM events WHERE ${where} ORDER BY start_at ASC LIMIT ?`,
        ).all(...params, limit);
        return { events: rows };
      },
    },
    {
      name: "events.detail",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const event = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
        if (!event) throw new Error("Not found");
        const attendees = db.prepare(
          "SELECT id, contact_id, name, phone, rsvp_status, rsvp_at, waitlist_position, notes FROM event_attendees WHERE event_id = ? ORDER BY created_at",
        ).all(id);
        return { event, attendees };
      },
    },
    {
      name: "events.create",
      handler: async (args) => {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title) throw new Error("Title required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO events (id, title, description, type, status, start_at, end_at, duration_minutes,
           location, location_url, min_attendees, max_attendees, cost_per_person_cents, cost_currency, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, title, args.description ?? "", args.type ?? "other",
          args.start_at ?? null, args.end_at ?? null, args.duration_minutes ?? 90,
          args.location ?? "", args.location_url ?? "",
          args.min_attendees ?? 1, args.max_attendees ?? null,
          args.cost_per_person_cents ?? 0, args.cost_currency ?? "EUR",
          args.notes ?? "", now, now,
        );
        return { ok: true, id };
      },
    },
    {
      name: "events.update",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const fields: string[] = [];
        const vals: unknown[] = [];
        for (const f of ["title", "description", "type", "status", "start_at", "end_at", "duration_minutes", "location", "location_url", "min_attendees", "max_attendees", "cost_per_person_cents", "notes"]) {
          if (args[f] !== undefined) { fields.push(`${f} = ?`); vals.push(args[f]); }
        }
        if (!fields.length) throw new Error("No fields");
        const now = new Date().toISOString();
        fields.push("updated_at = ?"); vals.push(now);
        vals.push(id);
        db.prepare(`UPDATE events SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
        return { ok: true };
      },
    },
    {
      name: "events.reschedule",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        const startAt = typeof args.start_at === "string" ? args.start_at : "";
        if (!id || !startAt) throw new Error("id and start_at required");
        const row = db.prepare("SELECT start_at, end_at FROM events WHERE id = ?").get(id) as
          | { start_at: string | null; end_at: string | null }
          | undefined;
        if (!row) throw new Error("Event not found");

        // Preserve duration: shift end_at by the same delta as start_at moved.
        let newEnd = row.end_at;
        if (row.start_at && row.end_at) {
          const delta = new Date(startAt).getTime() - new Date(row.start_at).getTime();
          newEnd = new Date(new Date(row.end_at).getTime() + delta).toISOString();
        }
        const now = new Date().toISOString();
        db.prepare("UPDATE events SET start_at = ?, end_at = ?, updated_at = ? WHERE id = ?")
          .run(startAt, newEnd, now, id);
        return { ok: true };
      },
    },
    {
      name: "events.rsvp",
      handler: async (args) => {
        const eventId = typeof args.event_id === "string" ? args.event_id : "";
        const rsvpStatus = typeof args.rsvp_status === "string" ? args.rsvp_status : "";
        if (!eventId || !["yes", "no", "maybe"].includes(rsvpStatus)) throw new Error("event_id and valid rsvp_status required");
        const now = new Date().toISOString();

        // Find or create attendee
        const contactId = typeof args.contact_id === "string" ? args.contact_id : null;
        const phone = typeof args.phone === "string" ? args.phone : "";
        const name = typeof args.name === "string" ? args.name : "";

        let attendee: any = null;
        if (contactId) {
          attendee = db.prepare("SELECT id FROM event_attendees WHERE event_id = ? AND contact_id = ?").get(eventId, contactId);
        } else if (phone) {
          attendee = db.prepare("SELECT id FROM event_attendees WHERE event_id = ? AND phone = ?").get(eventId, phone);
        }

        if (attendee) {
          db.prepare("UPDATE event_attendees SET rsvp_status = ?, rsvp_at = ?, updated_at = ? WHERE id = ?")
            .run(rsvpStatus, now, now, attendee.id);
          return { ok: true, id: attendee.id };
        }

        const id = crypto.randomUUID();
        db.prepare(
          `INSERT INTO event_attendees (id, event_id, contact_id, name, phone, rsvp_status, rsvp_at, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, eventId, contactId, name, phone, rsvpStatus, now, args.notes ?? "", now, now);
        return { ok: true, id };
      },
    },
    {
      name: "events.attendees.list",
      handler: async (args) => {
        const eventId = typeof args.event_id === "string" ? args.event_id : "";
        if (!eventId) throw new Error("Missing event_id");
        const rows = db.prepare(
          "SELECT id, contact_id, name, phone, rsvp_status, rsvp_at, waitlist_position, notes FROM event_attendees WHERE event_id = ? ORDER BY created_at",
        ).all(eventId);
        return { attendees: rows };
      },
    },
  ];
}
