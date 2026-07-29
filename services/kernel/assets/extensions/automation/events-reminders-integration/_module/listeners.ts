/**
 * Cross-extension event listeners (events ↔ reminders ↔ notifications).
 *
 * Subscribes to:
 *   - events:confirmed   → notify when min attendees reached
 *   - events:opened      → create reminder 24h before event start
 *   - events:full        → notify when max capacity reached
 *   - events:cancelled   → notify cancellation
 *   - events:waitlist_promoted → notify promotion
 *   - events:completed   → summary notification
 *   - email:urgent       → notify on urgent/critical email triage
 */

import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { Notifier } from "../../../../../src/core/notify/notifier.js";
import type { ReminderServiceLike } from "../../../../../src/core/types/extensions/reminders.js";
import type { KernelEventsModuleEvents } from "../../../../../src/core/types/extensions/events.js";
import type { SystemRegistry } from "../../../../../src/core/system-registry.js";
import { log } from "../../../../../src/core/logger.js";
import { formatCents } from "../../../../../src/core/formatting.js";

export interface EventListenerDeps {
  events: EventBus;
  notifier: Notifier;
  reminderService: ReminderServiceLike | null;
  systemRegistry?: SystemRegistry;
}

/**
 * Set up all cross-module event listeners.
 * Called once from the extension's `initialize()`.
 */
export function setupEventListeners(deps: EventListenerDeps): void {
  const { events, notifier, reminderService } = deps;

  // ── events:confirmed → Send notification when event reaches min attendees ──
  events.on(
    "events:confirmed",
    async (payload) => {
      const { event } = payload as unknown as KernelEventsModuleEvents["events:confirmed"];
      log.info(`Event confirmed: "${event.title}" (id=${event.id})`);

      const yes = event.summary.yes;
      const min = event.min_attendees;
      const startDate = new Date(event.start_at).toLocaleString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });

      const title = `Event Confirmed: ${event.title}`;
      const body = [
        `${yes}/${min} confirmed attendees`,
        `Date: ${startDate}`,
        event.location ? `Location: ${event.location}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      await notifier.send({
        title,
        body,
        priority: "normal",
      });
    },
    { module: "events", description: "Notify when event reaches min attendees" },
  );

  // ── events:opened → Create reminder 24h before event start ──
  if (reminderService) {
    events.on(
      "events:opened",
      async (payload) => {
        const { event } = payload as unknown as KernelEventsModuleEvents["events:opened"];
        log.info(`Event opened: "${event.title}" (id=${event.id})`);

        // Calculate trigger time: 24h before event start
        const eventStart = new Date(event.start_at);
        const triggerAt = new Date(eventStart.getTime() - 24 * 60 * 60 * 1000);

        // Only create reminder if it's in the future
        if (triggerAt.getTime() > Date.now()) {
          const reminder = reminderService.create({
            title: `Event tomorrow: ${event.title}`,
            body: formatReminderBody(event),
            trigger_at: triggerAt.toISOString(),
            repeat: "none",
            notify_mattermost: true,
            notify_telegram: true,
          });

          log.info(`Created reminder ${reminder.id} for event "${event.title}" at ${triggerAt.toISOString()}`);
        } else {
          log.debug(`Event "${event.title}" starts within 24h, skipping auto-reminder`);
        }
      },
      { module: "events", description: "Create reminder 24h before opened events" },
    );
  }

  // ── events:full → Notify when event reaches max capacity ──
  events.on(
    "events:full",
    async (payload) => {
      const { event } = payload as unknown as KernelEventsModuleEvents["events:full"];
      log.info(`Event full: "${event.title}" (id=${event.id})`);

      const title = `Event Full: ${event.title}`;
      const body = `Max capacity of ${event.max_attendees} reached. New RSVPs will be waitlisted.`;

      await notifier.send({
        title,
        body,
        priority: "low",
      });
    },
    { module: "events", description: "Notify when event reaches max capacity" },
  );

  // ── events:cancelled → Notify when event is cancelled ──
  events.on(
    "events:cancelled",
    async (payload) => {
      const { event } = payload as unknown as KernelEventsModuleEvents["events:cancelled"];
      log.info(`Event cancelled: "${event.title}" (id=${event.id})`);

      const startDate = new Date(event.start_at).toLocaleString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
      });

      await notifier.send({
        title: `Event Cancelled: ${event.title}`,
        body: `The event scheduled for ${startDate} has been cancelled.`,
        priority: "high",
      });
    },
    { module: "events", description: "Notify when event is cancelled" },
  );

  // ── events:waitlist_promoted → Notify when someone moves from waitlist to confirmed ──
  events.on(
    "events:waitlist_promoted",
    async (payload) => {
      const { event, attendee } = payload as unknown as KernelEventsModuleEvents["events:waitlist_promoted"];
      log.info(`Attendee promoted from waitlist: "${attendee.name}" for event "${event.title}"`);

      await notifier.send({
        title: `Waitlist Update: ${event.title}`,
        body: `${attendee.name} has been promoted from the waitlist!`,
        priority: "normal",
      });
    },
    { module: "events", description: "Notify when attendee promoted from waitlist" },
  );

  // ── events:completed → Summary notification when event is marked complete ──
  events.on(
    "events:completed",
    async (payload) => {
      const { event, summary } = payload as unknown as KernelEventsModuleEvents["events:completed"];
      log.info(`Event completed: "${event.title}" (id=${event.id})`);

      const attendanceRate = (summary.attendance_rate * 100).toFixed(0);
      const body = [
        `Attendance: ${summary.final_attendance}/${summary.total_invited} (${attendanceRate}%)`,
        summary.total_cost_cents > 0
          ? `Total cost: ${formatCents(summary.total_cost_cents)} ${summary.cost_currency}`
          : null,
        summary.no_shows.length > 0 ? `No-shows: ${summary.no_shows.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      await notifier.send({
        title: `Event Summary: ${event.title}`,
        body,
        priority: "low",
      });
    },
    { module: "events", description: "Send summary when event is completed" },
  );

  // ── email:urgent → Notify when triage finds critical/high emails ──
  events.on(
    "email:urgent",
    async (payload) => {
      const { subject, from, urgency, summary } = payload as {
        subject: string;
        from: string;
        urgency: string;
        summary: string;
      };
      log.info(`Urgent email: "${subject}" from ${from} (${urgency})`);

      await notifier.send({
        title: `${urgency === "critical" ? "CRITICAL" : "Important"} Email: ${subject}`,
        body: `From: ${from}\n${summary}`,
        priority: urgency === "critical" ? "high" : "normal",
      });
    },
    { module: "comms", description: "Notify on urgent/critical email triage" },
  );

  log.info("Event listeners initialized (events-reminders-integration)");
}

// ── Helper functions ──────────────────────────────────────────

function formatReminderBody(event: KernelEventsModuleEvents["events:opened"]["event"]): string {
  const startDate = new Date(event.start_at).toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const lines: string[] = [];
  lines.push(`Date: ${startDate}`);

  if (event.location) {
    lines.push(`Location: ${event.location}`);
  }

  const yes = event.summary.yes;
  const min = event.min_attendees;
  const max = event.max_attendees;

  if (max) {
    lines.push(`Attendees: ${yes}/${max} (min ${min})`);
  } else {
    lines.push(`Attendees: ${yes} confirmed (min ${min})`);
  }

  if (!event.summary.is_confirmed) {
    lines.push(`Still need ${event.summary.needs_more} more people!`);
  }

  if (event.summary.pending > 0) {
    lines.push(`${event.summary.pending} people haven't responded yet.`);
  }

  return lines.join("\n");
}
