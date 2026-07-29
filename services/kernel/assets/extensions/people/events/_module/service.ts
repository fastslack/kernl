import type { SqliteDb as Database } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type {
  Event,
  EventAttendee,
  EventWithSummary,
  AttendanceSummary,
  CreateEventInput,
  UpdateEventInput,
  InviteInput,
  RSVPInput,
  ListEventsFilter,
  RSVPStatus,
  RecurrenceRule,
  EventCompletionSummary,
  EventNotificationText,
  ContactEventHistory,
  EventReminderData,
} from "./types.js";

// Event bus event types for external listeners
export interface EventsModuleEvents {
  "events:created": { event: Event };
  "events:opened": { event: EventWithSummary };
  "events:confirmed": { event: EventWithSummary }; // When min_attendees reached
  "events:full": { event: EventWithSummary }; // When max_attendees reached
  "events:cancelled": { event: EventWithSummary };
  "events:completed": { event: EventWithSummary; summary: EventCompletionSummary };
  "events:rsvp": { event: EventWithSummary; attendee: EventAttendee; previousStatus: RSVPStatus | null };
  "events:waitlist_promoted": { event: EventWithSummary; attendee: EventAttendee };
  "events:imminent": { event: EventWithSummary; hoursUntil: number }; // For proactive notifications
}

export class EventsService {
  private eventBus: EventBus | null = null;

  constructor(private sqlite: Database, eventBus?: EventBus) {
    this.eventBus = eventBus ?? null;
  }

  /**
   * Emit an event to the bus (fire-and-forget)
   */
  private emit<K extends keyof EventsModuleEvents>(event: K, payload: EventsModuleEvents[K]): void {
    if (this.eventBus) {
      this.eventBus.emit(event, payload).catch(() => {});
    }
  }

  // ============================================================
  // EVENT CRUD
  // ============================================================

  create(input: CreateEventInput): Event {
    const id = newId();
    const now = isoNow();

    const event: Event = {
      id,
      title: input.title,
      description: input.description ?? "",
      type: input.type ?? "social",
      status: "draft",
      start_at: input.start_at,
      end_at: input.end_at ?? null,
      duration_minutes: input.duration_minutes ?? 90,
      location: input.location ?? "",
      location_url: input.location_url ?? "",
      min_attendees: input.min_attendees ?? 1,
      max_attendees: input.max_attendees ?? null,
      cost_per_person_cents: input.cost_per_person_cents ?? 0,
      cost_currency: input.cost_currency ?? "EUR",
      organizer_contact_id: input.organizer_contact_id ?? null,
      recurrence: input.recurrence ?? null,
      parent_event_id: null,
      notes: input.notes ?? "",
      created_at: now,
      updated_at: now,
    };

    this.sqlite
      .prepare(
        `INSERT INTO events (
          id, title, description, type, status,
          start_at, end_at, duration_minutes,
          location, location_url,
          min_attendees, max_attendees,
          cost_per_person_cents, cost_currency,
          organizer_contact_id, recurrence, parent_event_id,
          notes, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?,
          ?, ?,
          ?, ?, ?,
          ?, ?, ?
        )`
      )
      .run(
        event.id,
        event.title,
        event.description,
        event.type,
        event.status,
        event.start_at,
        event.end_at,
        event.duration_minutes,
        event.location,
        event.location_url,
        event.min_attendees,
        event.max_attendees,
        event.cost_per_person_cents,
        event.cost_currency,
        event.organizer_contact_id,
        event.recurrence ? JSON.stringify(event.recurrence) : "",
        event.parent_event_id,
        event.notes,
        event.created_at,
        event.updated_at
      );

    this.emit("events:created", { event });
    return event;
  }

  get(id: string): EventWithSummary | null {
    const row = this.sqlite
      .prepare("SELECT * FROM events WHERE id = ?")
      .get(id) as EventRow | undefined;

    if (!row) return null;

    const event = this.rowToEvent(row);
    const attendees = this.getAttendees(id);
    const summary = this.computeSummary(event, attendees);

    return { ...event, attendees, summary };
  }

  update(id: string, input: UpdateEventInput): EventWithSummary | null {
    const existing = this.sqlite
      .prepare("SELECT id FROM events WHERE id = ?")
      .get(id);

    if (!existing) return null;

    const sets: string[] = [];
    const values: unknown[] = [];

    const fields: (keyof UpdateEventInput)[] = [
      "title",
      "description",
      "type",
      "status",
      "start_at",
      "end_at",
      "duration_minutes",
      "location",
      "location_url",
      "min_attendees",
      "max_attendees",
      "cost_per_person_cents",
      "cost_currency",
      "notes",
    ];

    for (const field of fields) {
      if (input[field] !== undefined) {
        sets.push(`${field} = ?`);
        values.push(input[field]);
      }
    }

    if (sets.length === 0) {
      return this.get(id);
    }

    sets.push("updated_at = ?");
    values.push(isoNow());
    values.push(id);

    this.sqlite
      .prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);

    // If status changed to 'open', check if we need to auto-confirm
    if (input.status === "open") {
      this.checkAutoConfirm(id);
    }

    return this.get(id);
  }

  list(filter: ListEventsFilter = {}): EventWithSummary[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.status) {
      if (Array.isArray(filter.status)) {
        conditions.push(
          `status IN (${filter.status.map(() => "?").join(",")})`
        );
        values.push(...filter.status);
      } else {
        conditions.push("status = ?");
        values.push(filter.status);
      }
    }

    if (filter.type) {
      conditions.push("type = ?");
      values.push(filter.type);
    }

    if (filter.from_date) {
      conditions.push("start_at >= ?");
      values.push(filter.from_date);
    }

    if (filter.to_date) {
      conditions.push("start_at <= ?");
      values.push(filter.to_date);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit ?? 50;

    const rows = this.sqlite
      .prepare(
        `SELECT * FROM events ${where} ORDER BY start_at ASC LIMIT ?`
      )
      .all(...values, limit) as EventRow[];

    return rows.map((row) => {
      const event = this.rowToEvent(row);
      const attendees = this.getAttendees(event.id);
      const summary = this.computeSummary(event, attendees);
      return { ...event, attendees, summary };
    });
  }

  /**
   * Open event for RSVPs
   */
  open(id: string): EventWithSummary | null {
    this.update(id, { status: "open" });
    const event = this.get(id);
    if (event) {
      this.emit("events:opened", { event });
    }
    return event;
  }

  /**
   * Cancel event
   */
  cancel(id: string): EventWithSummary | null {
    this.update(id, { status: "cancelled" });
    const event = this.get(id);
    if (event) {
      this.emit("events:cancelled", { event });
    }
    return event;
  }

  /**
   * Mark event as completed
   */
  complete(id: string): EventWithSummary | null {
    this.update(id, { status: "completed" });
    return this.get(id);
  }

  // ============================================================
  // ATTENDEE MANAGEMENT
  // ============================================================

  /**
   * Invite someone to an event
   * Can be by contact_id (from CRM) or manual name/phone
   */
  invite(input: InviteInput): EventAttendee {
    const id = newId();
    const now = isoNow();

    // If contact_id provided, get contact details
    let name = input.name ?? "";
    let phone = input.phone ?? "";

    if (input.contact_id) {
      const contact = this.sqlite
        .prepare("SELECT name, phone FROM contacts WHERE id = ?")
        .get(input.contact_id) as { name: string; phone: string } | undefined;

      if (contact) {
        name = name || contact.name;
        phone = phone || contact.phone;
      }
    }

    const attendee: EventAttendee = {
      id,
      event_id: input.event_id,
      contact_id: input.contact_id ?? null,
      name,
      phone,
      rsvp_status: "pending",
      rsvp_at: null,
      waitlist_position: null,
      notes: "",
      created_at: now,
      updated_at: now,
    };

    this.sqlite
      .prepare(
        `INSERT INTO event_attendees (
          id, event_id, contact_id, name, phone,
          rsvp_status, rsvp_at, waitlist_position, notes,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        attendee.id,
        attendee.event_id,
        attendee.contact_id,
        attendee.name,
        attendee.phone,
        attendee.rsvp_status,
        attendee.rsvp_at,
        attendee.waitlist_position,
        attendee.notes,
        attendee.created_at,
        attendee.updated_at
      );

    return attendee;
  }

  /**
   * Bulk invite from CRM contacts
   */
  inviteContacts(eventId: string, contactIds: string[]): EventAttendee[] {
    return contactIds.map((contactId) =>
      this.invite({ event_id: eventId, contact_id: contactId })
    );
  }

  /**
   * RSVP to an event
   * Can identify attendee by: attendee_id, contact_id, or phone
   */
  rsvp(input: RSVPInput): EventAttendee | null {
    // Find the attendee
    let attendee: AttendeeRow | undefined;

    if (input.attendee_id) {
      attendee = this.sqlite
        .prepare("SELECT * FROM event_attendees WHERE id = ? AND event_id = ?")
        .get(input.attendee_id, input.event_id) as AttendeeRow | undefined;
    } else if (input.contact_id) {
      attendee = this.sqlite
        .prepare(
          "SELECT * FROM event_attendees WHERE contact_id = ? AND event_id = ?"
        )
        .get(input.contact_id, input.event_id) as AttendeeRow | undefined;
    } else if (input.phone) {
      attendee = this.sqlite
        .prepare(
          "SELECT * FROM event_attendees WHERE phone = ? AND event_id = ?"
        )
        .get(input.phone, input.event_id) as AttendeeRow | undefined;
    }

    if (!attendee) return null;

    const now = isoNow();
    const eventBefore = this.get(input.event_id);
    if (!eventBefore) return null;

    const previousStatus = attendee.rsvp_status as RSVPStatus;
    let newStatus: RSVPStatus = input.status;
    let waitlistPosition: number | null = null;

    // If saying "yes" but event is full, put on waitlist
    if (input.status === "yes" && eventBefore.summary.is_full) {
      newStatus = "waitlist";
      waitlistPosition = eventBefore.summary.waitlist + 1;
    }

    this.sqlite
      .prepare(
        `UPDATE event_attendees 
         SET rsvp_status = ?, rsvp_at = ?, waitlist_position = ?, notes = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        newStatus,
        now,
        waitlistPosition,
        input.notes ?? attendee.notes,
        now,
        attendee.id
      );

    // If someone said "no", promote from waitlist
    if (input.status === "no") {
      this.promoteFromWaitlist(input.event_id);
    }

    // Check if event should auto-confirm
    const wasConfirmed = eventBefore.summary.is_confirmed;
    const wasFull = eventBefore.summary.is_full;
    this.checkAutoConfirm(input.event_id);

    const updatedAttendee = this.getAttendee(attendee.id);
    const eventAfter = this.get(input.event_id);

    // Emit RSVP event
    if (updatedAttendee && eventAfter) {
      this.emit("events:rsvp", {
        event: eventAfter,
        attendee: updatedAttendee,
        previousStatus,
      });

      // Emit confirmed event if just reached minimum
      if (!wasConfirmed && eventAfter.summary.is_confirmed) {
        this.emit("events:confirmed", { event: eventAfter });
      }

      // Emit full event if just reached maximum
      if (!wasFull && eventAfter.summary.is_full) {
        this.emit("events:full", { event: eventAfter });
      }
    }

    return updatedAttendee;
  }

  /**
   * Get single attendee
   */
  getAttendee(id: string): EventAttendee | null {
    const row = this.sqlite
      .prepare("SELECT * FROM event_attendees WHERE id = ?")
      .get(id) as AttendeeRow | undefined;

    return row ? this.rowToAttendee(row) : null;
  }

  /**
   * Get all attendees for an event
   */
  getAttendees(eventId: string): EventAttendee[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM event_attendees 
         WHERE event_id = ? 
         ORDER BY 
           CASE rsvp_status 
             WHEN 'yes' THEN 1 
             WHEN 'maybe' THEN 2 
             WHEN 'pending' THEN 3 
             WHEN 'waitlist' THEN 4 
             WHEN 'no' THEN 5 
           END,
           waitlist_position ASC NULLS LAST,
           created_at ASC`
      )
      .all(eventId) as AttendeeRow[];

    return rows.map((row) => this.rowToAttendee(row));
  }

  /**
   * Remove attendee from event
   */
  removeAttendee(attendeeId: string): boolean {
    const attendee = this.getAttendee(attendeeId);
    if (!attendee) return false;

    this.sqlite
      .prepare("DELETE FROM event_attendees WHERE id = ?")
      .run(attendeeId);

    // Promote from waitlist if needed
    this.promoteFromWaitlist(attendee.event_id);

    return true;
  }

  // ============================================================
  // WAITLIST & AUTO-CONFIRM LOGIC
  // ============================================================

  /**
   * Promote first person from waitlist when a spot opens
   */
  private promoteFromWaitlist(eventId: string): void {
    const event = this.get(eventId);
    if (!event || event.summary.is_full) return;

    // Get first person on waitlist
    const waitlisted = this.sqlite
      .prepare(
        `SELECT id FROM event_attendees 
         WHERE event_id = ? AND rsvp_status = 'waitlist'
         ORDER BY waitlist_position ASC
         LIMIT 1`
      )
      .get(eventId) as { id: string } | undefined;

    if (waitlisted) {
      this.sqlite
        .prepare(
          `UPDATE event_attendees 
           SET rsvp_status = 'yes', waitlist_position = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(isoNow(), waitlisted.id);

      // Reorder remaining waitlist
      this.reorderWaitlist(eventId);

      // Emit promotion event
      const promotedAttendee = this.getAttendee(waitlisted.id);
      const updatedEvent = this.get(eventId);
      if (promotedAttendee && updatedEvent) {
        this.emit("events:waitlist_promoted", {
          event: updatedEvent,
          attendee: promotedAttendee,
        });
      }
    }
  }

  /**
   * Reorder waitlist positions after changes
   */
  private reorderWaitlist(eventId: string): void {
    const waitlisted = this.sqlite
      .prepare(
        `SELECT id FROM event_attendees 
         WHERE event_id = ? AND rsvp_status = 'waitlist'
         ORDER BY waitlist_position ASC NULLS LAST, created_at ASC`
      )
      .all(eventId) as { id: string }[];

    waitlisted.forEach((row, index) => {
      this.sqlite
        .prepare(
          "UPDATE event_attendees SET waitlist_position = ? WHERE id = ?"
        )
        .run(index + 1, row.id);
    });
  }

  /**
   * Auto-confirm event when minimum attendees reached
   */
  private checkAutoConfirm(eventId: string): void {
    const event = this.get(eventId);
    if (!event) return;

    // Only auto-confirm if event is "open" and has enough people
    if (event.status === "open" && event.summary.is_confirmed) {
      this.sqlite
        .prepare("UPDATE events SET status = 'confirmed', updated_at = ? WHERE id = ?")
        .run(isoNow(), eventId);
    }
  }

  // ============================================================
  // SUMMARY & ANALYTICS
  // ============================================================

  /**
   * Compute attendance summary for an event
   */
  private computeSummary(
    event: Event,
    attendees: EventAttendee[]
  ): AttendanceSummary {
    const counts = {
      yes: 0,
      no: 0,
      maybe: 0,
      pending: 0,
      waitlist: 0,
    };

    for (const a of attendees) {
      counts[a.rsvp_status]++;
    }

    const spotsAvailable =
      event.max_attendees !== null
        ? Math.max(0, event.max_attendees - counts.yes)
        : Infinity;

    const needsMore = Math.max(0, event.min_attendees - counts.yes);

    return {
      yes: counts.yes,
      no: counts.no,
      maybe: counts.maybe,
      pending: counts.pending,
      waitlist: counts.waitlist,
      total_invited: attendees.length,
      spots_available: spotsAvailable,
      needs_more: needsMore,
      is_confirmed: counts.yes >= event.min_attendees,
      is_full:
        event.max_attendees !== null && counts.yes >= event.max_attendees,
    };
  }

  /**
   * Get upcoming events with RSVP status
   */
  upcoming(days: number = 7): EventWithSummary[] {
    const now = isoNow();
    const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    return this.list({
      from_date: now,
      to_date: until,
      status: ["draft", "open", "confirmed"],
    });
  }

  /**
   * Get events needing attention (pending RSVPs, not enough people)
   */
  needingAttention(): EventWithSummary[] {
    const upcoming = this.upcoming(14);
    return upcoming.filter(
      (e) =>
        e.summary.pending > 0 || // People haven't responded
        e.summary.needs_more > 0 // Need more people
    );
  }

  /**
   * Get contacts who haven't responded to an event
   */
  getPendingRSVPs(eventId: string): EventAttendee[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM event_attendees 
         WHERE event_id = ? AND rsvp_status = 'pending'
         ORDER BY created_at ASC`
      )
      .all(eventId) as AttendeeRow[];

    return rows.map((row) => this.rowToAttendee(row));
  }

  // ============================================================
  // DUPLICATION & RECURRENCE
  // ============================================================

  /**
   * Duplicate an event for the next occurrence
   * Copies all settings and optionally re-invites the same people
   */
  duplicate(
    eventId: string,
    newStartAt: string,
    options: { reinviteAttendees?: boolean; reinviteOnlyConfirmed?: boolean } = {}
  ): EventWithSummary | null {
    const source = this.get(eventId);
    if (!source) return null;

    const { reinviteAttendees = true, reinviteOnlyConfirmed = false } = options;

    // Create the new event
    const newEvent = this.create({
      title: source.title,
      description: source.description,
      type: source.type,
      start_at: newStartAt,
      end_at: source.end_at ? this.shiftDateTime(source.start_at, source.end_at, newStartAt) : undefined,
      duration_minutes: source.duration_minutes,
      location: source.location,
      location_url: source.location_url,
      min_attendees: source.min_attendees,
      max_attendees: source.max_attendees ?? undefined,
      cost_per_person_cents: source.cost_per_person_cents,
      cost_currency: source.cost_currency,
      organizer_contact_id: source.organizer_contact_id ?? undefined,
      recurrence: source.recurrence ?? undefined,
      notes: source.notes,
    });

    // Re-invite attendees if requested
    if (reinviteAttendees) {
      const attendeesToInvite = reinviteOnlyConfirmed
        ? source.attendees.filter((a) => a.rsvp_status === "yes")
        : source.attendees;

      for (const attendee of attendeesToInvite) {
        this.invite({
          event_id: newEvent.id,
          contact_id: attendee.contact_id ?? undefined,
          name: attendee.name,
          phone: attendee.phone,
        });
      }
    }

    // Link as child if source has recurrence
    if (source.recurrence) {
      this.sqlite
        .prepare("UPDATE events SET parent_event_id = ? WHERE id = ?")
        .run(eventId, newEvent.id);
    }

    return this.get(newEvent.id);
  }

  /**
   * Calculate the next occurrence date based on recurrence rule
   */
  calculateNextOccurrence(startAt: string, rule: RecurrenceRule): string {
    const start = new Date(startAt);
    let next = new Date(start);

    switch (rule.frequency) {
      case "weekly":
        next.setDate(next.getDate() + 7);
        break;
      case "biweekly":
        next.setDate(next.getDate() + 14);
        break;
      case "monthly":
        next.setMonth(next.getMonth() + 1);
        break;
    }

    // If we have a specific day_of_week, adjust to that day
    if (rule.day_of_week !== undefined) {
      const currentDay = next.getDay();
      const targetDay = rule.day_of_week;
      const daysUntilTarget = (targetDay - currentDay + 7) % 7;
      if (daysUntilTarget > 0 || rule.frequency !== "weekly") {
        next.setDate(next.getDate() + daysUntilTarget);
      }
    }

    // Check if we've passed the "until" date
    if (rule.until && next.toISOString() > rule.until) {
      return ""; // No more occurrences
    }

    return next.toISOString();
  }

  /**
   * Generate the next recurring event instance
   */
  generateNextRecurrence(eventId: string): EventWithSummary | null {
    const source = this.get(eventId);
    if (!source || !source.recurrence) return null;

    const nextStartAt = this.calculateNextOccurrence(source.start_at, source.recurrence);
    if (!nextStartAt) return null; // Past the "until" date

    return this.duplicate(eventId, nextStartAt, { reinviteAttendees: true });
  }

  // ============================================================
  // COMPLETION & SUMMARY
  // ============================================================

  /**
   * Complete event and return final summary with statistics
   */
  completeWithSummary(eventId: string): EventCompletionSummary | null {
    const event = this.get(eventId);
    if (!event) return null;

    // Mark as completed
    this.complete(eventId);

    // Calculate final stats
    const confirmedAttendees = event.attendees.filter((a) => a.rsvp_status === "yes");
    const totalCost = event.cost_per_person_cents * confirmedAttendees.length;

    const summary: EventCompletionSummary = {
      event_id: eventId,
      title: event.title,
      date: event.start_at,
      location: event.location,
      final_attendance: confirmedAttendees.length,
      total_invited: event.attendees.length,
      attendance_rate: event.attendees.length > 0
        ? Math.round((confirmedAttendees.length / event.attendees.length) * 100)
        : 0,
      confirmed_attendees: confirmedAttendees.map((a) => ({
        name: a.name || a.phone,
        contact_id: a.contact_id,
      })),
      no_shows: event.attendees
        .filter((a) => a.rsvp_status === "yes" && !a.notes?.toLowerCase().includes("arrived"))
        .map((a) => a.name || a.phone), // This would need actual attendance tracking
      total_cost_cents: totalCost,
      cost_per_person_cents: event.cost_per_person_cents,
      cost_currency: event.cost_currency,
      met_minimum: confirmedAttendees.length >= event.min_attendees,
    };

    // Get updated event after completion
    const completedEvent = this.get(eventId);
    if (completedEvent) {
      this.emit("events:completed", { event: completedEvent, summary });
    }

    return summary;
  }

  /**
   * Get formatted text for notifications (Telegram/Mattermost)
   */
  getNotificationText(eventId: string): EventNotificationText | null {
    const event = this.get(eventId);
    if (!event) return null;

    const s = event.summary;
    const statusEmoji: Record<string, string> = {
      draft: "📝",
      open: "📢",
      confirmed: "✅",
      cancelled: "❌",
      completed: "🏁",
    };

    // Short summary for quick notifications
    let shortText = `${statusEmoji[event.status]} ${event.title}\n`;
    shortText += `📅 ${this.formatDateTime(event.start_at)}\n`;
    if (event.location) shortText += `📍 ${event.location}\n`;
    shortText += `👥 ${s.yes}/${event.max_attendees ?? "∞"}`;
    if (s.needs_more > 0) shortText += ` (${s.needs_more} more needed)`;

    // Full details for detailed notifications
    let fullText = `**${event.title}**\n\n`;
    fullText += `📅 ${this.formatDateTime(event.start_at)}`;
    if (event.duration_minutes) fullText += ` (${event.duration_minutes} min)`;
    fullText += "\n";
    if (event.location) {
      fullText += `📍 ${event.location}`;
      if (event.location_url) fullText += ` [View map](${event.location_url})`;
      fullText += "\n";
    }
    fullText += "\n";
    fullText += `**Attendance:**\n`;
    fullText += `  ✅ Confirmed: ${s.yes}${event.max_attendees ? `/${event.max_attendees}` : ""}\n`;
    fullText += `  ❓ Maybe: ${s.maybe}\n`;
    fullText += `  ⏳ No reply: ${s.pending}\n`;
    fullText += `  ❌ Not coming: ${s.no}\n`;
    if (s.waitlist > 0) fullText += `  📋 Waitlist: ${s.waitlist}\n`;

    if (s.needs_more > 0) {
      fullText += `\n⚠️ ${s.needs_more} more needed to reach the minimum (${event.min_attendees})`;
    } else if (s.is_confirmed) {
      fullText += `\n✅ Minimum reached — the event is confirmed.`;
    }

    if (event.cost_per_person_cents > 0) {
      fullText += `\n\n💰 Cost: ${(event.cost_per_person_cents / 100).toFixed(2)} ${event.cost_currency} per person`;
    }

    // Attendee list for WhatsApp/Telegram
    let attendeeList = "**Attendee list:**\n";
    const confirmed = event.attendees.filter((a) => a.rsvp_status === "yes");
    const maybe = event.attendees.filter((a) => a.rsvp_status === "maybe");
    const pending = event.attendees.filter((a) => a.rsvp_status === "pending");

    if (confirmed.length > 0) {
      attendeeList += `✅ Confirmed (${confirmed.length}):\n`;
      confirmed.forEach((a, i) => {
        attendeeList += `  ${i + 1}. ${a.name || a.phone}${a.notes ? ` - ${a.notes}` : ""}\n`;
      });
    }
    if (maybe.length > 0) {
      attendeeList += `❓ Maybe (${maybe.length}):\n`;
      maybe.forEach((a) => {
        attendeeList += `  - ${a.name || a.phone}\n`;
      });
    }
    if (pending.length > 0) {
      attendeeList += `⏳ No reply (${pending.length}):\n`;
      pending.forEach((a) => {
        attendeeList += `  - ${a.name || a.phone}\n`;
      });
    }

    return {
      short: shortText,
      full: fullText,
      attendee_list: attendeeList,
      pending_names: pending.map((a) => a.name || a.phone),
    };
  }

  /**
   * Get events happening today or tomorrow
   */
  getImminent(hoursAhead: number = 48): EventWithSummary[] {
    const now = new Date();
    const until = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

    return this.list({
      from_date: now.toISOString(),
      to_date: until.toISOString(),
      status: ["open", "confirmed"],
    });
  }

  /**
   * Generate reminder data for an event
   * Returns the data needed to create a reminder N hours before the event
   */
  getReminderData(eventId: string, hoursBefore: number = 24): EventReminderData | null {
    const event = this.get(eventId);
    if (!event) return null;

    const eventTime = new Date(event.start_at);
    const triggerAt = new Date(eventTime.getTime() - hoursBefore * 60 * 60 * 1000);

    // Don't create reminders for past events
    if (triggerAt < new Date()) {
      return null;
    }

    const notification = this.getNotificationText(eventId);

    return {
      event_id: eventId,
      title: `Reminder: ${event.title}`,
      body: notification?.full ?? `Event "${event.title}" starts at ${this.formatDateTime(event.start_at)}`,
      trigger_at: triggerAt.toISOString(),
      hours_before: hoursBefore,
      event_start: event.start_at,
      location: event.location,
      attendee_count: event.summary.yes,
      is_confirmed: event.summary.is_confirmed,
    };
  }

  // ============================================================
  // STATISTICS & HISTORY
  // ============================================================

  /**
   * Get attendance history for a contact across events
   */
  getContactHistory(contactId: string): ContactEventHistory {
    const rows = this.sqlite.prepare(`
      SELECT 
        e.id, e.title, e.type, e.start_at, e.status,
        a.rsvp_status
      FROM event_attendees a
      JOIN events e ON e.id = a.event_id
      WHERE a.contact_id = ?
      ORDER BY e.start_at DESC
      LIMIT 50
    `).all(contactId) as Array<{
      id: string;
      title: string;
      type: string;
      start_at: string;
      status: string;
      rsvp_status: string;
    }>;

    const stats = {
      total_invited: rows.length,
      yes_count: rows.filter((r) => r.rsvp_status === "yes").length,
      no_count: rows.filter((r) => r.rsvp_status === "no").length,
      maybe_count: rows.filter((r) => r.rsvp_status === "maybe").length,
      pending_count: rows.filter((r) => r.rsvp_status === "pending").length,
    };

    return {
      contact_id: contactId,
      events: rows,
      stats,
      reliability_score: stats.total_invited > 0
        ? Math.round((stats.yes_count / stats.total_invited) * 100)
        : 0,
    };
  }

  /**
   * Get recurring event series
   */
  getRecurringSeries(parentEventId: string): EventWithSummary[] {
    const rows = this.sqlite.prepare(`
      SELECT id FROM events 
      WHERE parent_event_id = ? OR id = ?
      ORDER BY start_at ASC
    `).all(parentEventId, parentEventId) as Array<{ id: string }>;

    return rows.map((r) => this.get(r.id)!).filter(Boolean);
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private shiftDateTime(oldStart: string, oldEnd: string, newStart: string): string {
    const oldStartMs = new Date(oldStart).getTime();
    const oldEndMs = new Date(oldEnd).getTime();
    const durationMs = oldEndMs - oldStartMs;
    const newStartMs = new Date(newStart).getTime();
    return new Date(newStartMs + durationMs).toISOString();
  }

  private formatDateTime(isoString: string): string {
    const date = new Date(isoString);
    const days = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
    return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]} ${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
  }

  private rowToEvent(row: EventRow): Event {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      type: row.type as Event["type"],
      status: row.status as Event["status"],
      start_at: row.start_at,
      end_at: row.end_at,
      duration_minutes: row.duration_minutes,
      location: row.location,
      location_url: row.location_url,
      min_attendees: row.min_attendees,
      max_attendees: row.max_attendees,
      cost_per_person_cents: row.cost_per_person_cents,
      cost_currency: row.cost_currency,
      organizer_contact_id: row.organizer_contact_id,
      recurrence: row.recurrence ? (() => { try { return JSON.parse(row.recurrence); } catch { return null; } })() : null,
      parent_event_id: row.parent_event_id,
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private rowToAttendee(row: AttendeeRow): EventAttendee {
    return {
      id: row.id,
      event_id: row.event_id,
      contact_id: row.contact_id,
      name: row.name,
      phone: row.phone,
      rsvp_status: row.rsvp_status as RSVPStatus,
      rsvp_at: row.rsvp_at,
      waitlist_position: row.waitlist_position,
      notes: row.notes,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

// Raw SQLite row types
interface EventRow {
  id: string;
  title: string;
  description: string;
  type: string;
  status: string;
  start_at: string;
  end_at: string | null;
  duration_minutes: number;
  location: string;
  location_url: string;
  min_attendees: number;
  max_attendees: number | null;
  cost_per_person_cents: number;
  cost_currency: string;
  organizer_contact_id: string | null;
  recurrence: string;
  parent_event_id: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

interface AttendeeRow {
  id: string;
  event_id: string;
  contact_id: string | null;
  name: string;
  phone: string;
  rsvp_status: string;
  rsvp_at: string | null;
  waitlist_position: number | null;
  notes: string;
  created_at: string;
  updated_at: string;
}
