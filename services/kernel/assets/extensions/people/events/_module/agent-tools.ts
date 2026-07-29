/**
 * Agent-shaped events tools.
 *
 * Legacy `eventsTools(...)` is 22 CRUD-style tools (create/get/list/update +
 * separate invite/RSVP/lifecycle verbs). This file collapses the 90% case
 * into 6 intent-verbs:
 *
 *   - `kernel_event_schedule`        — atomic create+invite
 *   - `kernel_event_today`           — events happening today
 *   - `kernel_event_upcoming`        — typed upcoming list
 *   - `kernel_event_attention`       — what's overdue / imminent / needs RSVP
 *   - `kernel_event_lifecycle`       — unified open/cancel/complete/duplicate verb
 *   - `kernel_event_rsvp_summary`    — attendees + pending + summary in one call
 *
 * Each declares `tags` + `outputSchema`. Legacy tools are tagged with
 * `[legacy]` nudges in their description.
 */
import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { EventsService } from "./service.js";
import type { EventWithSummary, EventAttendee } from "./types.js";
import { errorResult, structuredResult, textResult } from "../../../../../src/core/helpers.js";

// ── Shared schemas ────────────────────────────────────────────

const AttendanceSummarySchema = z.object({
  yes: z.number().int(),
  no: z.number().int(),
  maybe: z.number().int(),
  pending: z.number().int(),
  waitlist: z.number().int(),
  total_invited: z.number().int(),
  needs_more: z.number().int(),
  is_confirmed: z.boolean(),
  is_full: z.boolean(),
});

const EventSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  status: z.string(),
  start_at: z.string(),
  end_at: z.string().nullable(),
  duration_minutes: z.number().int(),
  location: z.string(),
  min_attendees: z.number().int(),
  max_attendees: z.number().int().nullable(),
  organizer_contact_id: z.string().nullable(),
  attendance: AttendanceSummarySchema,
});

function eventSummary(e: EventWithSummary): z.infer<typeof EventSummarySchema> {
  return {
    id: e.id,
    title: e.title,
    type: e.type,
    status: e.status,
    start_at: e.start_at,
    end_at: e.end_at,
    duration_minutes: e.duration_minutes,
    location: e.location,
    min_attendees: e.min_attendees,
    max_attendees: e.max_attendees,
    organizer_contact_id: e.organizer_contact_id,
    attendance: {
      yes: e.summary.yes,
      no: e.summary.no,
      maybe: e.summary.maybe,
      pending: e.summary.pending,
      waitlist: e.summary.waitlist,
      total_invited: e.summary.total_invited,
      needs_more: e.summary.needs_more,
      is_confirmed: e.summary.is_confirmed,
      is_full: e.summary.is_full,
    },
  };
}

const AttendeeSummarySchema = z.object({
  id: z.string(),
  event_id: z.string(),
  contact_id: z.string().nullable(),
  name: z.string(),
  phone: z.string(),
  rsvp_status: z.string(),
  rsvp_at: z.string().nullable(),
  waitlist_position: z.number().int().nullable(),
});

function attendeeSummary(a: EventAttendee): z.infer<typeof AttendeeSummarySchema> {
  return {
    id: a.id,
    event_id: a.event_id,
    contact_id: a.contact_id,
    name: a.name,
    phone: a.phone,
    rsvp_status: a.rsvp_status,
    rsvp_at: a.rsvp_at,
    waitlist_position: a.waitlist_position,
  };
}

// ── Builder ───────────────────────────────────────────────────

export function agentEventsTools(service: EventsService): ToolDefinition[] {
  return [
    buildEventSchedule(service),
    buildEventToday(service),
    buildEventUpcoming(service),
    buildEventAttention(service),
    buildEventLifecycle(service),
    buildEventRsvpSummary(service),
  ];
}

// ── kernel_event_schedule ─────────────────────────────────────

const EventScheduleInput = z.object({
  title: z.string(),
  start_at: z.string().describe("ISO datetime."),
  end_at: z.string().optional(),
  duration_minutes: z.number().int().positive().optional(),
  type: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  location_url: z.string().optional(),
  min_attendees: z.number().int().nonnegative().optional(),
  max_attendees: z.number().int().positive().optional(),
  organizer_contact_id: z.string().optional(),
  attendee_contact_ids: z.array(z.string()).optional()
    .describe("CRM contact ids to invite atomically after creating the event."),
  notes: z.string().optional(),
});

const EventScheduleOutput = EventSummarySchema.extend({
  invited: z.number().int().describe("How many contacts were invited successfully."),
});

function buildEventSchedule(service: EventsService): ToolDefinition {
  return {
    name: "kernel_event_schedule",
    description:
      "Create an event and invite contacts in ONE call. Replaces the legacy create→invite_contacts " +
      "2-step. Returns the typed event with attendance summary plus the count of successful invites.",
    inputSchema: EventScheduleInput,
    outputSchema: EventScheduleOutput,
    tags: ["events", "schedule", "create", "invite", "calendar"],
    async handler(args) {
      const input = EventScheduleInput.parse(args);
      try {
        const created = service.create({
          title: input.title,
          start_at: input.start_at,
          end_at: input.end_at,
          duration_minutes: input.duration_minutes,
          type: input.type as never,
          description: input.description,
          location: input.location,
          location_url: input.location_url,
          min_attendees: input.min_attendees,
          max_attendees: input.max_attendees,
          organizer_contact_id: input.organizer_contact_id,
          notes: input.notes,
        });

        let invited = 0;
        if (input.attendee_contact_ids && input.attendee_contact_ids.length > 0) {
          const attendees = service.inviteContacts(created.id, input.attendee_contact_ids);
          invited = attendees.length;
        }

        const refreshed = service.get(created.id);
        if (!refreshed) {
          return errorResult(`Event ${created.id} not found after creation.`);
        }
        const out = { ...eventSummary(refreshed), invited };
        return structuredResult(
          out,
          `Event **${refreshed.title}** scheduled for ${refreshed.start_at}` +
          (invited > 0 ? ` · ${invited} contact(s) invited` : ""),
        );
      } catch (err) {
        return errorResult(`event_schedule failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ── kernel_event_today ────────────────────────────────────────

const EventTodayInput = z.object({
  include_cancelled: z.boolean().default(false),
});

const EventListOutput = z.object({
  total: z.number().int(),
  events: z.array(EventSummarySchema),
});

function buildEventToday(service: EventsService): ToolDefinition {
  return {
    name: "kernel_event_today",
    description:
      "Return every event that starts today (local UTC date). Skips cancelled events by default. " +
      "Use this for the 'what's on my calendar today' question — pair with `kernel_event_upcoming` " +
      "for a longer horizon.",
    inputSchema: EventTodayInput,
    outputSchema: EventListOutput,
    tags: ["events", "today", "list", "agenda", "calendar"],
    async handler(args) {
      const { include_cancelled } = EventTodayInput.parse(args);
      const today = new Date().toISOString().slice(0, 10);
      const events = service.list({
        from_date: `${today}T00:00:00Z`,
        to_date: `${today}T23:59:59Z`,
        limit: 100,
      });
      const filtered = include_cancelled ? events : events.filter((e) => e.status !== "cancelled");
      const out = { total: filtered.length, events: filtered.map(eventSummary) };
      if (filtered.length === 0) {
        return { ...textResult(`No events today (${today}).`), structuredContent: out };
      }
      const lines = [
        `**${filtered.length} event(s) today** (${today}):`,
        ...filtered.map((e) => {
          const t = e.start_at.slice(11, 16);
          return `- ${t} · ${e.title}${e.location ? ` _(${e.location})_` : ""} · ${e.summary.yes}/${e.min_attendees} confirmed`;
        }),
      ];
      return { ...textResult(lines.join("\n")), structuredContent: out };
    },
  };
}

// ── kernel_event_upcoming ─────────────────────────────────────

const EventUpcomingInput = z.object({
  days: z.number().int().min(1).max(90).default(7),
});

function buildEventUpcoming(service: EventsService): ToolDefinition {
  return {
    name: "kernel_event_upcoming",
    description:
      "Events scheduled within the next N days (default 7). Skips past and cancelled events. " +
      "Returns a structured list — easier to filter or roll up via `kernel_code_run`.",
    inputSchema: EventUpcomingInput,
    outputSchema: EventListOutput,
    tags: ["events", "upcoming", "list", "calendar"],
    async handler(args) {
      const { days } = EventUpcomingInput.parse(args);
      const events = service.upcoming(days);
      const out = { total: events.length, events: events.map(eventSummary) };
      if (events.length === 0) {
        return { ...textResult(`No upcoming events in the next ${days} day(s).`), structuredContent: out };
      }
      const lines = [
        `**${events.length} upcoming event(s)** (next ${days} day(s)):`,
        ...events.map((e) =>
          `- ${e.start_at.slice(0, 16).replace("T", " ")} · ${e.title} · ${e.summary.yes}/${e.min_attendees} confirmed`,
        ),
      ];
      return { ...textResult(lines.join("\n")), structuredContent: out };
    },
  };
}

// ── kernel_event_attention ────────────────────────────────────

const EventAttentionInput = z.object({
  imminent_hours: z.number().int().min(1).max(168).default(48),
});

const EventAttentionOutput = z.object({
  needing_attention: z.array(EventSummarySchema)
    .describe("Events not yet confirmed (yes < min_attendees) within the next 14 days."),
  imminent: z.array(EventSummarySchema)
    .describe("Events starting within `imminent_hours`."),
  imminent_hours: z.number().int(),
});

function buildEventAttention(service: EventsService): ToolDefinition {
  return {
    name: "kernel_event_attention",
    description:
      "What needs your attention RIGHT NOW: events that aren't yet confirmed (yes < min_attendees) " +
      "plus events starting within the imminent_hours window (default 48h). One call to know what " +
      "to chase before the day fills up.",
    inputSchema: EventAttentionInput,
    outputSchema: EventAttentionOutput,
    tags: ["events", "attention", "imminent", "follow-up", "calendar"],
    async handler(args) {
      const { imminent_hours } = EventAttentionInput.parse(args);
      const needing = service.needingAttention();
      const imminent = service.getImminent(imminent_hours);
      const out = {
        needing_attention: needing.map(eventSummary),
        imminent: imminent.map(eventSummary),
        imminent_hours,
      };
      const lines: string[] = [];
      if (needing.length > 0) {
        lines.push(`## Need confirmation (${needing.length}):`);
        for (const e of needing) {
          lines.push(`- ${e.title} on ${e.start_at.slice(0, 16).replace("T", " ")} — ${e.summary.yes}/${e.min_attendees} confirmed`);
        }
      }
      if (imminent.length > 0) {
        lines.push(`\n## Imminent (next ${imminent_hours}h, ${imminent.length}):`);
        for (const e of imminent) {
          lines.push(`- ${e.title} at ${e.start_at.slice(0, 16).replace("T", " ")}${e.location ? ` _(${e.location})_` : ""}`);
        }
      }
      const text = lines.length === 0
        ? "Nothing needs attention. Everything is confirmed and there's nothing imminent."
        : lines.join("\n");
      return { ...textResult(text), structuredContent: out };
    },
  };
}

// ── kernel_event_lifecycle ────────────────────────────────────

const EventLifecycleInput = z.object({
  action: z.enum(["open", "cancel", "complete", "duplicate"])
    .describe("Lifecycle action. 'duplicate' creates a new event from this one."),
  event_id: z.string(),
  // Args used only by 'duplicate'
  new_start_at: z.string().optional()
    .describe("Required when action='duplicate'. ISO datetime for the duplicate's start."),
  copy_attendees: z.boolean().optional().describe("Only relevant for action='duplicate'. Default false."),
});

const EventLifecycleOutput = z.object({
  event: EventSummarySchema,
  action: z.string(),
});

function buildEventLifecycle(service: EventsService): ToolDefinition {
  return {
    name: "kernel_event_lifecycle",
    description:
      "Unified verb for event lifecycle: open / cancel / complete / duplicate. Replaces the four " +
      "separate kernel_events_open / cancel / complete / duplicate tools. Returns the resulting " +
      "event (or the new duplicate) with attendance summary.",
    inputSchema: EventLifecycleInput,
    outputSchema: EventLifecycleOutput,
    tags: ["events", "lifecycle", "control", "calendar"],
    async handler(args) {
      const input = EventLifecycleInput.parse(args);
      try {
        let event: EventWithSummary | null = null;
        switch (input.action) {
          case "open":     event = service.open(input.event_id); break;
          case "cancel":   event = service.cancel(input.event_id); break;
          case "complete": event = service.complete(input.event_id); break;
          case "duplicate": {
            if (!input.new_start_at) {
              return errorResult("action='duplicate' requires `new_start_at`.");
            }
            event = service.duplicate(input.event_id, input.new_start_at, {
              reinviteAttendees: input.copy_attendees ?? false,
            });
            break;
          }
        }
        if (!event) return errorResult(`Event not found: ${input.event_id}`);
        return structuredResult(
          { event: eventSummary(event), action: input.action },
          `Event **${event.title}** → ${event.status}` +
          (input.action === "duplicate" ? ` (duplicated as ${event.id})` : ""),
        );
      } catch (err) {
        return errorResult(`event_lifecycle(${input.action}) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ── kernel_event_rsvp_summary ─────────────────────────────────

const EventRsvpSummaryInput = z.object({
  event_id: z.string(),
});

const EventRsvpSummaryOutput = z.object({
  event: EventSummarySchema,
  attendees: z.array(AttendeeSummarySchema),
  pending: z.array(AttendeeSummarySchema),
});

function buildEventRsvpSummary(service: EventsService): ToolDefinition {
  return {
    name: "kernel_event_rsvp_summary",
    description:
      "Full RSVP picture for one event: typed attendees[] + pending[] + the attendance summary. " +
      "Use before calling `kernel_email_send` to chase pending RSVPs — pending[].phone is the " +
      "list to ping.",
    inputSchema: EventRsvpSummaryInput,
    outputSchema: EventRsvpSummaryOutput,
    tags: ["events", "rsvp", "attendees", "follow-up", "calendar"],
    async handler(args) {
      const { event_id } = EventRsvpSummaryInput.parse(args);
      const event = service.get(event_id);
      if (!event) return errorResult(`Event not found: ${event_id}`);
      const attendees = service.getAttendees(event_id);
      const pending = service.getPendingRSVPs(event_id);
      const out = {
        event: eventSummary(event),
        attendees: attendees.map(attendeeSummary),
        pending: pending.map(attendeeSummary),
      };
      const lines = [
        `## ${event.title} — ${event.start_at.slice(0, 16).replace("T", " ")}`,
        `${event.summary.yes}/${event.min_attendees} confirmed · ` +
        `${event.summary.maybe} maybe · ${event.summary.pending} pending · ` +
        `${event.summary.no} no${event.max_attendees ? ` · ${event.summary.spots_available} spot(s) open` : ""}`,
      ];
      if (pending.length > 0) {
        lines.push("", "**Pending:**");
        for (const a of pending) lines.push(`- ${a.name}${a.phone ? ` (${a.phone})` : ""}`);
      }
      return { ...textResult(lines.join("\n")), structuredContent: out };
    },
  };
}
