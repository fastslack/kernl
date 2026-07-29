/**
 * Events Module Types
 *
 * Designed for group events like "fulbito del jueves" where you need to:
 * - Track who's coming (RSVP)
 * - Know when you have enough people (min_attendees)
 * - Handle waitlists when full (max_attendees)
 * - Send reminders to people who haven't responded
 */

// Event types - extensible for different use cases
export type EventType = "sports" | "social" | "professional" | "family" | "other";

// Event lifecycle
export type EventStatus = "draft" | "open" | "confirmed" | "cancelled" | "completed";

// RSVP responses
export type RSVPStatus = "pending" | "yes" | "no" | "maybe" | "waitlist";

/**
 * Main event entity
 */
export interface Event {
  id: string;
  title: string;
  description: string;
  type: EventType;
  status: EventStatus;

  // Timing
  start_at: string; // ISO datetime
  end_at: string | null; // ISO datetime (optional)
  duration_minutes: number; // Default 90 for sports

  // Location
  location: string;
  location_url: string; // Google Maps link

  // Capacity - key for organizing group activities
  min_attendees: number; // Minimum needed (e.g., 10 for futbol 5)
  max_attendees: number | null; // Maximum allowed (null = unlimited)

  // Cost splitting
  cost_per_person_cents: number;
  cost_currency: string;

  // Organizer
  organizer_contact_id: string | null; // FK to contacts

  // Recurrence (for weekly games)
  recurrence: RecurrenceRule | null;
  parent_event_id: string | null; // For recurring instances

  // Metadata
  notes: string;
  created_at: string;
  updated_at: string;
}

/**
 * Simple recurrence rule for weekly events
 */
export interface RecurrenceRule {
  frequency: "weekly" | "biweekly" | "monthly";
  day_of_week: number; // 0=Sunday, 1=Monday, ..., 4=Thursday
  until: string | null; // ISO date or null for indefinite
}

/**
 * Event attendee with RSVP status
 */
export interface EventAttendee {
  id: string;
  event_id: string;
  contact_id: string | null; // FK to contacts (null for external people)
  name: string; // Denormalized or manual entry
  phone: string; // For WhatsApp notifications
  rsvp_status: RSVPStatus;
  rsvp_at: string | null; // When they responded
  waitlist_position: number | null; // Position in waitlist (1-based)
  notes: string; // "Llego 10 min tarde", etc.
  created_at: string;
  updated_at: string;
}

/**
 * Event with computed attendance summary
 */
export interface EventWithSummary extends Event {
  attendees: EventAttendee[];
  summary: AttendanceSummary;
}

/**
 * Attendance breakdown for quick status check
 */
export interface AttendanceSummary {
  yes: number;
  no: number;
  maybe: number;
  pending: number;
  waitlist: number;
  total_invited: number;
  spots_available: number; // max_attendees - yes (or Infinity if no max)
  needs_more: number; // min_attendees - yes (0 if met)
  is_confirmed: boolean; // yes >= min_attendees
  is_full: boolean; // yes >= max_attendees
}

// Input types for service methods

export interface CreateEventInput {
  title: string;
  description?: string;
  type?: EventType;
  start_at: string;
  end_at?: string;
  duration_minutes?: number;
  location?: string;
  location_url?: string;
  min_attendees?: number;
  max_attendees?: number;
  cost_per_person_cents?: number;
  cost_currency?: string;
  organizer_contact_id?: string;
  recurrence?: RecurrenceRule;
  notes?: string;
}

export interface UpdateEventInput {
  title?: string;
  description?: string;
  type?: EventType;
  status?: EventStatus;
  start_at?: string;
  end_at?: string;
  duration_minutes?: number;
  location?: string;
  location_url?: string;
  min_attendees?: number;
  max_attendees?: number;
  cost_per_person_cents?: number;
  cost_currency?: string;
  notes?: string;
}

export interface InviteInput {
  event_id: string;
  contact_id?: string; // From CRM
  name?: string; // Manual entry
  phone?: string; // For notifications
}

export interface RSVPInput {
  event_id: string;
  attendee_id?: string; // By attendee ID
  contact_id?: string; // By contact ID
  phone?: string; // By phone number
  status: "yes" | "no" | "maybe";
  notes?: string;
}

export interface ListEventsFilter {
  status?: EventStatus | EventStatus[];
  type?: EventType;
  from_date?: string;
  to_date?: string;
  limit?: number;
}

// Output types for completion and notifications

/**
 * Summary returned when completing an event
 */
export interface EventCompletionSummary {
  event_id: string;
  title: string;
  date: string;
  location: string;
  final_attendance: number;
  total_invited: number;
  attendance_rate: number;
  confirmed_attendees: Array<{ name: string; contact_id: string | null }>;
  no_shows: string[];
  total_cost_cents: number;
  cost_per_person_cents: number;
  cost_currency: string;
  met_minimum: boolean;
}

/**
 * Formatted text for various notification channels
 */
export interface EventNotificationText {
  short: string;        // One-liner for quick status
  full: string;         // Full markdown-formatted details
  attendee_list: string; // Formatted list of attendees
  pending_names: string[]; // Names of people who haven't responded
}

/**
 * Contact's event participation history
 */
export interface ContactEventHistory {
  contact_id: string;
  events: Array<{
    id: string;
    title: string;
    type: string;
    start_at: string;
    status: string;
    rsvp_status: string;
  }>;
  stats: {
    total_invited: number;
    yes_count: number;
    no_count: number;
    maybe_count: number;
    pending_count: number;
  };
  reliability_score: number; // 0-100, percentage of "yes" responses
}

/**
 * Data for creating a reminder from an event
 */
export interface EventReminderData {
  event_id: string;
  title: string;
  body: string;
  trigger_at: string; // ISO datetime for when to fire reminder
  hours_before: number;
  event_start: string;
  location: string;
  attendee_count: number;
  is_confirmed: boolean;
}
