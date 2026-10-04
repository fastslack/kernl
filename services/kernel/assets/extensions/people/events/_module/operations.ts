/**
 * Event operations the dashboard reaches over the WS RPC (`events.*`).
 *
 * None of these has an HTTP twin: the dashboard calls them with `rpc`, not
 * `rpcOrCall`, and the /api/events/* routes are a different surface. They
 * used to be raw SQL against the events tables, so they skipped everything
 * EventsService does — the waitlist and auto-confirm on RSVP, the
 * events:created/rsvp/confirmed/full bus events, recurrence parsing — and
 * `events.create` without a start_at hit the NOT NULL column as a raw
 * SQLite error. Now each one calls the service.
 */

import { HttpError, pickArgs, type Operation } from "@kernl/extension-sdk";
import type { EventsService } from "./service.js";
import type { EventStatus, EventType, CreateEventInput, UpdateEventInput } from "./types.js";

const TYPES: ReadonlyArray<EventType> = ["sports", "social", "professional", "family", "other"];
const STATUSES: ReadonlyArray<EventStatus> = ["draft", "open", "confirmed", "cancelled", "completed"];
const RSVP_STATUSES = ["yes", "no", "maybe"] as const;

/** Everything the service lets a caller write on an event. */
const EVENT_FIELDS = {
  title: "string",
  description: "string",
  type: "string",
  status: "string",
  start_at: "string",
  end_at: "string",
  duration_minutes: "number",
  location: "string",
  location_url: "string",
  min_attendees: "number",
  max_attendees: "number",
  cost_per_person_cents: "number",
  cost_currency: "string",
  notes: "string",
} as const;

export function eventOperations(service: EventsService): Record<string, Operation> {
  const required = (input: Record<string, unknown>, key: string, message = `Missing ${key}`): string => {
    const value = pickArgs(input, { [key]: "string" } as Record<string, "string">)[key];
    if (!value) throw new HttpError(400, message);
    return value;
  };
  const checkEnums = (fields: { type?: string; status?: string }) => {
    if (fields.type !== undefined && !TYPES.includes(fields.type as EventType)) {
      throw new HttpError(400, `Invalid type. Allowed: ${TYPES.join(", ")}`);
    }
    if (fields.status !== undefined && !STATUSES.includes(fields.status as EventStatus)) {
      throw new HttpError(400, `Invalid status. Allowed: ${STATUSES.join(", ")}`);
    }
  };

  return {
    "events.list": (input) => {
      const args = pickArgs(input, { status: "string", type: "string", from: "string", limit: "number" });
      return {
        events: service.list({
          status: (args.status || undefined) as EventStatus | undefined,
          type: (args.type || undefined) as EventType | undefined,
          from_date: args.from || undefined,
          limit: Math.min(200, Math.max(10, args.limit ?? 50)),
        }),
      };
    },

    "events.detail": (input) => {
      const event = service.get(required(input, "id"));
      if (!event) throw new HttpError(404, "Not found");
      return { event, attendees: event.attendees };
    },

    "events.create": (input) => {
      const { status: _status, ...fields } = pickArgs(input, { ...EVENT_FIELDS, organizer_contact_id: "string" });
      const title = fields.title?.trim() ?? "";
      if (!title) throw new HttpError(400, "Title required");
      if (!fields.start_at) throw new HttpError(400, "start_at required");
      checkEnums(fields);
      // The dashboard's quick-add has always defaulted to "other"; the
      // service's own default ("social") is for the MCP tools.
      const event = service.create({ ...fields, title, type: fields.type ?? "other" } as CreateEventInput);
      return { ok: true, id: event.id };
    },

    "events.update": (input) => {
      const id = required(input, "id");
      const fields = pickArgs(input, EVENT_FIELDS);
      if (Object.keys(fields).length === 0) throw new HttpError(400, "No fields");
      checkEnums(fields);
      if (!service.update(id, fields as UpdateEventInput)) throw new HttpError(404, "Event not found");
      return { ok: true };
    },

    "events.reschedule": (input) => {
      const { id, start_at } = pickArgs(input, { id: "string", start_at: "string" });
      if (!id || !start_at) throw new HttpError(400, "id and start_at required");
      if (!service.reschedule(id, start_at)) throw new HttpError(404, "Event not found");
      return { ok: true };
    },

    "events.rsvp": (input) => {
      const args = pickArgs(input, {
        event_id: "string", rsvp_status: "string", contact_id: "string", phone: "string", name: "string", notes: "string",
      });
      const status = args.rsvp_status as (typeof RSVP_STATUSES)[number];
      if (!args.event_id || !RSVP_STATUSES.includes(status)) {
        throw new HttpError(400, "event_id and valid rsvp_status required");
      }
      if (!service.get(args.event_id)) throw new HttpError(404, "Event not found");
      // Find the attendee by contact or phone; someone not on the list yet is
      // invited first, so the answer goes through the same waitlist and
      // auto-confirm rules either way.
      const who = args.contact_id ? { contact_id: args.contact_id } : args.phone ? { phone: args.phone } : null;
      let attendee = who ? service.rsvp({ event_id: args.event_id, ...who, status, notes: args.notes }) : null;
      if (!attendee) {
        const invited = service.invite({
          event_id: args.event_id,
          contact_id: args.contact_id,
          name: args.name,
          phone: args.phone,
        });
        attendee = service.rsvp({ event_id: args.event_id, attendee_id: invited.id, status, notes: args.notes });
      }
      if (!attendee) throw new HttpError(404, "Attendee not found");
      return { ok: true, id: attendee.id };
    },

    "events.attendees.list": (input) =>
      ({ attendees: service.getAttendees(required(input, "event_id")) }),
  };
}
