/**
 * Minimal event-bus payload shapes the kernel framework needs to subscribe
 * to the events module's lifecycle stream. The events module (an extension
 * under `assets/extensions/people/events/_module/`) emits richer types, but the
 * kernel only consumes the fields used by `event-listeners.ts`.
 *
 * Keeping these here decouples `src/core/` from the events extension's
 * source tree.
 */

export interface EventAttendanceSummaryLike {
  yes: number;
  pending: number;
  needs_more: number;
  is_confirmed: boolean;
}

export interface EventAttendeeLike {
  name: string;
}

export interface EventLike {
  id: string;
  title: string;
  start_at: string;
  location: string;
  min_attendees: number;
  max_attendees: number | null;
  summary: EventAttendanceSummaryLike;
}

export interface EventCompletionSummaryLike {
  attendance_rate: number;
  final_attendance: number;
  total_invited: number;
  total_cost_cents: number;
  cost_currency: string;
  no_shows: string[];
}

/**
 * Payload map the kernel event-listeners subscribe to. The concrete
 * `EventsModuleEvents` exported by the events extension is structurally
 * compatible with this shape (extra fields are fine — TS casts widen).
 */
export interface KernelEventsModuleEvents {
  "events:confirmed": { event: EventLike };
  "events:opened": { event: EventLike };
  "events:full": { event: EventLike };
  "events:cancelled": { event: EventLike };
  "events:waitlist_promoted": { event: EventLike; attendee: EventAttendeeLike };
  "events:completed": { event: EventLike; summary: EventCompletionSummaryLike };
}
