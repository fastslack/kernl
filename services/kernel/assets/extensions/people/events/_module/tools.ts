import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { EventsService } from "./service.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import type { EventWithSummary, AttendanceSummary } from "./types.js";

import { formatCents } from "../../../../../src/core/formatting.js";

// Helper to format event summary
function formatEventSummary(e: EventWithSummary): string {
  const s = e.summary;
  const statusEmoji = {
    draft: "📝",
    open: "📢",
    confirmed: "✅",
    cancelled: "❌",
    completed: "🏁",
  }[e.status];

  let statusLine = `${statusEmoji} ${e.status.toUpperCase()}`;
  if (s.is_confirmed) statusLine += " (minimum reached)";
  if (s.is_full) statusLine += " (FULL)";

  const lines = [
    `**${e.title}**`,
    `ID: ${e.id}`,
    `Status: ${statusLine}`,
    `Type: ${e.type}`,
    `When: ${e.start_at}${e.duration_minutes ? ` (${e.duration_minutes} min)` : ""}`,
  ];

  if (e.location) lines.push(`Where: ${e.location}`);
  if (e.cost_per_person_cents > 0) {
    lines.push(`Cost: ${formatCents(e.cost_per_person_cents, e.cost_currency)} per person`);
  }

  lines.push("");
  lines.push("**Attendance:**");
  lines.push(`  ✅ Yes: ${s.yes}${e.max_attendees ? `/${e.max_attendees}` : ""}`);
  lines.push(`  ❓ Maybe: ${s.maybe}`);
  lines.push(`  ⏳ Pending: ${s.pending}`);
  lines.push(`  ❌ No: ${s.no}`);
  if (s.waitlist > 0) lines.push(`  📋 Waitlist: ${s.waitlist}`);

  if (s.needs_more > 0) {
    lines.push("");
    lines.push(`⚠️ Need ${s.needs_more} more to reach minimum (${e.min_attendees})`);
  }

  return lines.join("\n");
}

// Helper to format attendee list
function formatAttendeeList(e: EventWithSummary): string {
  if (e.attendees.length === 0) return "No attendees invited yet.";

  const byStatus: Record<string, string[]> = {
    yes: [],
    maybe: [],
    pending: [],
    waitlist: [],
    no: [],
  };

  for (const a of e.attendees) {
    const name = a.name || a.phone || a.contact_id || "Unknown";
    const extra = a.notes ? ` (${a.notes})` : "";
    const pos = a.waitlist_position ? ` #${a.waitlist_position}` : "";
    byStatus[a.rsvp_status].push(`${name}${pos}${extra}`);
  }

  const sections: string[] = [];
  if (byStatus.yes.length > 0) {
    sections.push(`✅ **Confirmed (${byStatus.yes.length}):**\n${byStatus.yes.map((n) => `  - ${n}`).join("\n")}`);
  }
  if (byStatus.maybe.length > 0) {
    sections.push(`❓ **Maybe (${byStatus.maybe.length}):**\n${byStatus.maybe.map((n) => `  - ${n}`).join("\n")}`);
  }
  if (byStatus.pending.length > 0) {
    sections.push(`⏳ **Pending (${byStatus.pending.length}):**\n${byStatus.pending.map((n) => `  - ${n}`).join("\n")}`);
  }
  if (byStatus.waitlist.length > 0) {
    sections.push(`📋 **Waitlist (${byStatus.waitlist.length}):**\n${byStatus.waitlist.map((n) => `  - ${n}`).join("\n")}`);
  }
  if (byStatus.no.length > 0) {
    sections.push(`❌ **Declined (${byStatus.no.length}):**\n${byStatus.no.map((n) => `  - ${n}`).join("\n")}`);
  }

  return sections.join("\n\n");
}

export function eventsTools(service: EventsService): ToolDefinition[] {
  return [
    // ============================================================
    // EVENT CRUD
    // ============================================================
    {
      name: "kernel_events_create",
      description:
        "Create a new event (e.g., futbol 5, dinner, meeting). Set min/max_attendees to enforce group size requirements. " +
        "[legacy CRUD] For agent flows that also invite contacts, prefer `kernel_event_schedule` — atomic create+invite with structured output.",
      inputSchema: z.object({
        title: z.string().describe("Event title (e.g., 'Fulbito del Jueves')"),
        description: z.string().optional().describe("Event description"),
        type: z
          .enum(["sports", "social", "professional", "family", "other"])
          .optional()
          .describe("Event type (default: social)"),
        start_at: z
          .string()
          .describe("Start time in ISO 8601 (e.g., 2025-03-06T20:00:00)"),
        duration_minutes: z
          .number()
          .optional()
          .describe("Duration in minutes (default: 90)"),
        location: z.string().optional().describe("Location name/address"),
        location_url: z.string().optional().describe("Google Maps or venue URL"),
        min_attendees: z
          .number()
          .optional()
          .describe("Minimum people needed (e.g., 10 for futbol 5)"),
        max_attendees: z
          .number()
          .optional()
          .describe("Maximum capacity (enables waitlist)"),
        cost_per_person_cents: z
          .number()
          .optional()
          .describe("Cost per person in cents (e.g., 500 = 5.00)"),
        cost_currency: z
          .string()
          .optional()
          .describe("Currency code (default: EUR)"),
        notes: z.string().optional().describe("Additional notes"),
      }),
      handler: async (args) => {
        const event = service.create(args as Parameters<typeof service.create>[0]);
        return textResult(
          `Event created:\n\n${formatEventSummary({ ...event, attendees: [], summary: { yes: 0, no: 0, maybe: 0, pending: 0, waitlist: 0, total_invited: 0, spots_available: event.max_attendees ?? Infinity, needs_more: event.min_attendees, is_confirmed: false, is_full: false } })}`
        );
      },
    },

    {
      name: "kernel_events_get",
      description: "Get event details with attendance summary and attendee list.",
      inputSchema: z.object({
        id: z.string().describe("Event ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const event = service.get(id);
        if (!event) return errorResult(`Event not found: ${id}`);

        return textResult(
          `${formatEventSummary(event)}\n\n---\n\n${formatAttendeeList(event)}`
        );
      },
    },

    {
      name: "kernel_events_list",
      description: "List events with optional filters.",
      inputSchema: z.object({
        status: z
          .enum(["draft", "open", "confirmed", "cancelled", "completed"])
          .optional()
          .describe("Filter by status"),
        type: z
          .enum(["sports", "social", "professional", "family", "other"])
          .optional()
          .describe("Filter by type"),
        from_date: z.string().optional().describe("From date (ISO)"),
        to_date: z.string().optional().describe("To date (ISO)"),
        limit: z.number().optional().describe("Max results (default: 50)"),
      }),
      handler: async (args) => {
        const events = service.list(args as Parameters<typeof service.list>[0]);
        if (events.length === 0) return textResult("No events found.");

        const lines = events.map(
          (e) => formatEventSummary(e)
        );
        return textResult(`${events.length} event(s):\n\n${lines.join("\n\n---\n\n")}`);
      },
    },

    {
      name: "kernel_events_update",
      description: "Update event details.",
      inputSchema: z.object({
        id: z.string().describe("Event ID"),
        title: z.string().optional(),
        description: z.string().optional(),
        type: z.enum(["sports", "social", "professional", "family", "other"]).optional(),
        status: z.enum(["draft", "open", "confirmed", "cancelled", "completed"]).optional(),
        start_at: z.string().optional(),
        duration_minutes: z.number().optional(),
        location: z.string().optional(),
        location_url: z.string().optional(),
        min_attendees: z.number().optional(),
        max_attendees: z.number().optional(),
        cost_per_person_cents: z.number().optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const { id, ...updates } = args as { id: string } & Record<string, unknown>;
        const event = service.update(id, updates);
        if (!event) return errorResult(`Event not found: ${id}`);
        return textResult(`Event updated:\n\n${formatEventSummary(event)}`);
      },
    },

    {
      name: "kernel_events_open",
      description:
        "Open event for RSVPs. Changes status from 'draft' to 'open'. " +
        "[legacy] Prefer `kernel_event_lifecycle` with action='open' — same effect, structured output, unified verb.",
      inputSchema: z.object({
        id: z.string().describe("Event ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const event = service.open(id);
        if (!event) return errorResult(`Event not found: ${id}`);
        return textResult(`Event opened for RSVPs:\n\n${formatEventSummary(event)}`);
      },
    },

    {
      name: "kernel_events_cancel",
      description:
        "Cancel an event. " +
        "[legacy] Prefer `kernel_event_lifecycle` with action='cancel'.",
      inputSchema: z.object({
        id: z.string().describe("Event ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const event = service.cancel(id);
        if (!event) return errorResult(`Event not found: ${id}`);
        return textResult(`Event cancelled:\n\n${formatEventSummary(event)}`);
      },
    },

    // ============================================================
    // INVITATIONS
    // ============================================================
    {
      name: "kernel_events_invite",
      description:
        "Invite someone to an event. Can use contact_id (from CRM) or manual name/phone.",
      inputSchema: z.object({
        event_id: z.string().describe("Event ID"),
        contact_id: z.string().optional().describe("Contact ID from CRM"),
        name: z.string().optional().describe("Name (if not from CRM)"),
        phone: z.string().optional().describe("Phone for notifications"),
      }),
      handler: async (args) => {
        const input = args as Parameters<typeof service.invite>[0];
        try {
          const attendee = service.invite(input);
          return textResult(
            `Invited: ${attendee.name || attendee.phone || attendee.contact_id}\n  Attendee ID: ${attendee.id}`
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    {
      name: "kernel_events_invite_contacts",
      description: "Bulk invite multiple CRM contacts to an event.",
      inputSchema: z.object({
        event_id: z.string().describe("Event ID"),
        contact_ids: z.array(z.string()).describe("Array of contact IDs"),
      }),
      handler: async (args) => {
        const { event_id, contact_ids } = args as {
          event_id: string;
          contact_ids: string[];
        };
        const attendees = service.inviteContacts(event_id, contact_ids);
        return textResult(
          `Invited ${attendees.length} contacts:\n${attendees.map((a) => `  - ${a.name || a.contact_id}`).join("\n")}`
        );
      },
    },

    // ============================================================
    // RSVP
    // ============================================================
    {
      name: "kernel_events_rsvp",
      description:
        "Record RSVP for an attendee. Identify by attendee_id, contact_id, or phone. Auto-handles waitlist if event is full.",
      inputSchema: z.object({
        event_id: z.string().describe("Event ID"),
        attendee_id: z.string().optional().describe("Attendee ID"),
        contact_id: z.string().optional().describe("Contact ID from CRM"),
        phone: z.string().optional().describe("Phone number"),
        status: z.enum(["yes", "no", "maybe"]).describe("RSVP response"),
        notes: z.string().optional().describe("Optional note (e.g., 'llego tarde')"),
      }),
      handler: async (args) => {
        const input = args as Parameters<typeof service.rsvp>[0];
        const attendee = service.rsvp(input);
        if (!attendee) {
          return errorResult(
            "Attendee not found. Must be invited first or check identifier."
          );
        }

        let msg = `RSVP recorded: ${attendee.name || attendee.phone} → ${attendee.rsvp_status.toUpperCase()}`;
        if (attendee.rsvp_status === "waitlist") {
          msg += `\n⚠️ Event is full. Added to waitlist position #${attendee.waitlist_position}`;
        }

        // Get updated event summary
        const event = service.get(input.event_id);
        if (event) {
          msg += `\n\nCurrent status: ${event.summary.yes}/${event.max_attendees ?? "∞"} confirmed`;
          if (event.summary.needs_more > 0) {
            msg += ` (need ${event.summary.needs_more} more)`;
          }
        }

        return textResult(msg);
      },
    },

    {
      name: "kernel_events_attendees",
      description: "List all attendees for an event grouped by RSVP status.",
      inputSchema: z.object({
        event_id: z.string().describe("Event ID"),
      }),
      handler: async (args) => {
        const { event_id } = args as { event_id: string };
        const event = service.get(event_id);
        if (!event) return errorResult(`Event not found: ${event_id}`);
        return textResult(formatAttendeeList(event));
      },
    },

    {
      name: "kernel_events_pending",
      description: "Get attendees who haven't responded yet (RSVP pending).",
      inputSchema: z.object({
        event_id: z.string().describe("Event ID"),
      }),
      handler: async (args) => {
        const { event_id } = args as { event_id: string };
        const pending = service.getPendingRSVPs(event_id);
        if (pending.length === 0) {
          return textResult("Everyone has responded! No pending RSVPs.");
        }

        const lines = pending.map(
          (a) => `- ${a.name || a.phone || a.contact_id}`
        );
        return textResult(
          `${pending.length} people haven't responded:\n${lines.join("\n")}\n\nConsider sending them a reminder.`
        );
      },
    },

    {
      name: "kernel_events_remove_attendee",
      description: "Remove an attendee from an event.",
      inputSchema: z.object({
        attendee_id: z.string().describe("Attendee ID"),
      }),
      handler: async (args) => {
        const { attendee_id } = args as { attendee_id: string };
        const removed = service.removeAttendee(attendee_id);
        if (!removed) return errorResult(`Attendee not found: ${attendee_id}`);
        return textResult("Attendee removed. Waitlist promoted if applicable.");
      },
    },

    // ============================================================
    // OVERVIEW & PLANNING
    // ============================================================
    {
      name: "kernel_events_upcoming",
      description:
        "Get upcoming events in the next N days with attendance status. " +
        "[legacy] Prefer `kernel_event_upcoming` — same data, structured output for code_run.",
      inputSchema: z.object({
        days: z.number().optional().describe("Days ahead to look (default: 7)"),
      }),
      handler: async (args) => {
        const { days } = args as { days?: number };
        const events = service.upcoming(days ?? 7);
        if (events.length === 0) {
          return textResult(`No upcoming events in the next ${days ?? 7} days.`);
        }

        const lines = events.map((e) => {
          const s = e.summary;
          const statusIcon = s.is_confirmed ? "✅" : s.needs_more > 0 ? "⚠️" : "📢";
          return `${statusIcon} **${e.title}** (${e.start_at})\n   ${s.yes}/${e.max_attendees ?? "∞"} confirmed${s.needs_more > 0 ? `, need ${s.needs_more} more` : ""}\n   ID: ${e.id}`;
        });

        return textResult(`Upcoming events:\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_events_needing_attention",
      description:
        "Get events that need attention: pending RSVPs or not enough confirmed attendees. " +
        "[legacy] Prefer `kernel_event_attention` — combines this with imminent (next-48h) events in one structured response.",
      inputSchema: z.object({}),
      handler: async () => {
        const events = service.needingAttention();
        if (events.length === 0) {
          return textResult("All events are on track! No action needed.");
        }

        const lines = events.map((e) => {
          const issues: string[] = [];
          if (e.summary.pending > 0) {
            issues.push(`${e.summary.pending} pending RSVPs`);
          }
          if (e.summary.needs_more > 0) {
            issues.push(`need ${e.summary.needs_more} more people`);
          }
          return `⚠️ **${e.title}** (${e.start_at})\n   Issues: ${issues.join(", ")}\n   ID: ${e.id}`;
        });

        return textResult(`Events needing attention:\n\n${lines.join("\n\n")}`);
      },
    },

    // ============================================================
    // DUPLICATION & RECURRENCE
    // ============================================================
    {
      name: "kernel_events_duplicate",
      description:
        "Duplicate an event for a new date (e.g., create next week's game). Copies all settings and optionally re-invites attendees. " +
        "[legacy] Prefer `kernel_event_lifecycle` with action='duplicate' — same effect via the unified verb.",
      inputSchema: z.object({
        event_id: z.string().describe("Source event ID to duplicate"),
        new_start_at: z.string().describe("New start time in ISO 8601"),
        reinvite_attendees: z
          .boolean()
          .optional()
          .describe("Re-invite all attendees (default: true)"),
        reinvite_only_confirmed: z
          .boolean()
          .optional()
          .describe("Only re-invite those who said 'yes' (default: false)"),
      }),
      handler: async (args) => {
        const { event_id, new_start_at, reinvite_attendees, reinvite_only_confirmed } =
          args as {
            event_id: string;
            new_start_at: string;
            reinvite_attendees?: boolean;
            reinvite_only_confirmed?: boolean;
          };

        const newEvent = service.duplicate(event_id, new_start_at, {
          reinviteAttendees: reinvite_attendees,
          reinviteOnlyConfirmed: reinvite_only_confirmed,
        });

        if (!newEvent) return errorResult(`Event not found: ${event_id}`);

        return textResult(
          `Event duplicated successfully!\n\n${formatEventSummary(newEvent)}\n\n${newEvent.attendees.length} attendees invited.`
        );
      },
    },

    {
      name: "kernel_events_next_recurrence",
      description:
        "Generate the next occurrence of a recurring event based on its recurrence rule.",
      inputSchema: z.object({
        event_id: z.string().describe("Event ID with recurrence rule"),
      }),
      handler: async (args) => {
        const { event_id } = args as { event_id: string };
        const newEvent = service.generateNextRecurrence(event_id);

        if (!newEvent) {
          const source = service.get(event_id);
          if (!source) return errorResult(`Event not found: ${event_id}`);
          if (!source.recurrence) return errorResult("Event has no recurrence rule set.");
          return errorResult("No more occurrences (past the 'until' date).");
        }

        return textResult(
          `Next occurrence created!\n\n${formatEventSummary(newEvent)}\n\n${newEvent.attendees.length} attendees invited.`
        );
      },
    },

    // ============================================================
    // COMPLETION & SUMMARY
    // ============================================================
    {
      name: "kernel_events_complete",
      description:
        "Mark event as completed and get final summary with attendance stats and costs. " +
        "[legacy] Prefer `kernel_event_lifecycle` with action='complete' for the lifecycle change. (Keep this tool for the FINAL completion-summary payload — the summary fields aren't part of the unified verb.)",
      inputSchema: z.object({
        event_id: z.string().describe("Event ID to complete"),
      }),
      handler: async (args) => {
        const { event_id } = args as { event_id: string };
        const summary = service.completeWithSummary(event_id);

        if (!summary) return errorResult(`Event not found: ${event_id}`);

        const lines = [
          `🏁 **${summary.title}** - COMPLETED`,
          "",
          `📅 ${summary.date}`,
          summary.location ? `📍 ${summary.location}` : "",
          "",
          `**Final Attendance:** ${summary.final_attendance}/${summary.total_invited} (${summary.attendance_rate}%)`,
          summary.met_minimum ? "✅ Minimum attendance was met" : "⚠️ Did not meet minimum attendance",
          "",
          `**Confirmed Attendees (${summary.confirmed_attendees.length}):**`,
          ...summary.confirmed_attendees.map((a, i) => `  ${i + 1}. ${a.name}`),
        ];

        if (summary.total_cost_cents > 0) {
          lines.push(
            "",
            `**Cost:**`,
            `  Per person: ${formatCents(summary.cost_per_person_cents, summary.cost_currency)}`,
            `  Total collected: ${formatCents(summary.total_cost_cents, summary.cost_currency)}`
          );
        }

        return textResult(lines.filter(Boolean).join("\n"));
      },
    },

    {
      name: "kernel_events_notification_text",
      description:
        "Get formatted notification text for an event (for Telegram, WhatsApp, Mattermost).",
      inputSchema: z.object({
        event_id: z.string().describe("Event ID"),
        format: z
          .enum(["short", "full", "attendees"])
          .optional()
          .describe("Text format: short (one-liner), full (detailed), attendees (list)"),
      }),
      handler: async (args) => {
        const { event_id, format } = args as { event_id: string; format?: string };
        const text = service.getNotificationText(event_id);

        if (!text) return errorResult(`Event not found: ${event_id}`);

        switch (format) {
          case "short":
            return textResult(text.short);
          case "attendees":
            return textResult(text.attendee_list);
          case "full":
          default:
            return textResult(text.full);
        }
      },
    },

    {
      name: "kernel_events_imminent",
      description:
        "Get events happening in the next N hours (for proactive notifications). " +
        "[legacy] Prefer `kernel_event_attention` — returns this list along with events still missing confirmations.",
      inputSchema: z.object({
        hours: z.number().optional().describe("Hours ahead to look (default: 48)"),
      }),
      handler: async (args) => {
        const { hours } = args as { hours?: number };
        const events = service.getImminent(hours ?? 48);

        if (events.length === 0) {
          return textResult(`No events in the next ${hours ?? 48} hours.`);
        }

        const lines = events.map((e) => {
          const notification = service.getNotificationText(e.id);
          return notification?.short ?? e.title;
        });

        return textResult(`**Events coming up:**\n\n${lines.join("\n\n")}`);
      },
    },

    // ============================================================
    // HISTORY & ANALYTICS
    // ============================================================
    {
      name: "kernel_events_contact_history",
      description:
        "Get a contact's event participation history with reliability score.",
      inputSchema: z.object({
        contact_id: z.string().describe("Contact ID from CRM"),
      }),
      handler: async (args) => {
        const { contact_id } = args as { contact_id: string };
        const history = service.getContactHistory(contact_id);

        if (history.events.length === 0) {
          return textResult("No event history for this contact.");
        }

        const lines = [
          `**Event History**`,
          "",
          `**Stats:**`,
          `  Total invitations: ${history.stats.total_invited}`,
          `  Yes: ${history.stats.yes_count}`,
          `  No: ${history.stats.no_count}`,
          `  Maybe: ${history.stats.maybe_count}`,
          `  Never responded: ${history.stats.pending_count}`,
          `  Reliability score: ${history.reliability_score}%`,
          "",
          `**Recent Events:**`,
          ...history.events.slice(0, 10).map((e) => {
            const emoji = { yes: "✅", no: "❌", maybe: "❓", pending: "⏳", waitlist: "📋" }[e.rsvp_status] ?? "•";
            return `  ${emoji} ${e.title} (${e.start_at.split("T")[0]})`;
          }),
        ];

        return textResult(lines.join("\n"));
      },
    },

    {
      name: "kernel_events_series",
      description: "Get all events in a recurring series.",
      inputSchema: z.object({
        event_id: z.string().describe("Any event ID in the series"),
      }),
      handler: async (args) => {
        const { event_id } = args as { event_id: string };
        const series = service.getRecurringSeries(event_id);

        if (series.length <= 1) {
          return textResult("This event is not part of a recurring series.");
        }

        const lines = series.map((e) => {
          const statusIcon = { draft: "📝", open: "📢", confirmed: "✅", cancelled: "❌", completed: "🏁" }[e.status];
          return `${statusIcon} ${e.start_at.split("T")[0]} - ${e.summary.yes}/${e.max_attendees ?? "∞"} confirmed`;
        });

        return textResult(`**Recurring Series: ${series[0].title}**\n\n${lines.join("\n")}`);
      },
    },

    // ============================================================
    // REMINDER INTEGRATION
    // ============================================================
    {
      name: "kernel_events_reminder_data",
      description:
        "Get data needed to create a reminder for an event. Returns trigger time and formatted body. Use this before creating a reminder with kernel_reminders_create.",
      inputSchema: z.object({
        event_id: z.string().describe("Event ID"),
        hours_before: z
          .number()
          .optional()
          .describe("Hours before event to trigger reminder (default: 24)"),
      }),
      handler: async (args) => {
        const { event_id, hours_before } = args as { event_id: string; hours_before?: number };
        const data = service.getReminderData(event_id, hours_before ?? 24);

        if (!data) {
          const event = service.get(event_id);
          if (!event) return errorResult(`Event not found: ${event_id}`);
          return errorResult("Cannot create reminder: event is in the past or reminder time has passed.");
        }

        const lines = [
          `**Reminder Data for "${data.title.replace("Reminder: ", "")}"**`,
          "",
          `To create a reminder, use kernel_reminders_create with:`,
          `- title: ${data.title}`,
          `- trigger_at: ${data.trigger_at}`,
          "",
          `**Details:**`,
          `- Event starts: ${data.event_start}`,
          `- Reminder fires: ${data.trigger_at} (${data.hours_before}h before)`,
          `- Location: ${data.location || "Not specified"}`,
          `- Attendees confirmed: ${data.attendee_count}`,
          `- Status: ${data.is_confirmed ? "✅ Confirmed" : "⏳ Not yet confirmed"}`,
          "",
          `**Suggested reminder body:**`,
          `\`\`\``,
          data.body,
          `\`\`\``,
        ];

        return textResult(lines.join("\n"));
      },
    },
  ];
}
