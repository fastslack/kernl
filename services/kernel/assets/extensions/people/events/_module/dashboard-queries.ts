import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { tableExists, toRecord } from "../../../../../src/core/db/query-helpers.js";

export interface DashboardEventsAttendee {
  id: string;
  name: string;
  phone: string;
  rsvp_status: string;
  waitlist_position: number | null;
  notes: string;
}

export interface DashboardEventsEvent {
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
  yes_count: number;
  no_count: number;
  maybe_count: number;
  pending_count: number;
  waitlist_count: number;
  is_confirmed: boolean;
  is_full: boolean;
  needs_more: number;
  attendees: DashboardEventsAttendee[];
}

export interface DashboardEvents {
  kpis: {
    totalEvents: number;
    upcomingEvents: number;
    confirmedEvents: number;
    needsAttention: number;
  };
  upcoming: DashboardEventsEvent[];
  needingAttention: DashboardEventsEvent[];
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  recentlyCompleted: Array<{
    id: string;
    title: string;
    start_at: string;
    attendee_count: number;
  }>;
}

export function queryEvents(db: SqliteDb): DashboardEvents | null {
  if (!tableExists(db, "events")) return null;

  const now = new Date().toISOString();

  // KPIs
  const totalEvents = (db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number }).c;
  const upcomingEvents = (db.prepare(
    "SELECT COUNT(*) as c FROM events WHERE start_at >= ? AND status NOT IN ('cancelled', 'completed')"
  ).get(now) as { c: number }).c;
  const confirmedEvents = (db.prepare(
    "SELECT COUNT(*) as c FROM events WHERE status = 'confirmed' AND start_at >= ?"
  ).get(now) as { c: number }).c;

  // Count events needing attention (pending RSVPs or not enough people)
  const needsAttentionCount = db.prepare(`
    SELECT COUNT(DISTINCT e.id) as c
    FROM events e
    LEFT JOIN event_attendees a ON e.id = a.event_id
    WHERE e.start_at >= ?
      AND e.status NOT IN ('cancelled', 'completed')
      AND (
        a.rsvp_status = 'pending'
        OR (SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id AND rsvp_status = 'yes') < e.min_attendees
      )
  `).get(now) as { c: number };

  // Upcoming events with attendee counts
  const upcomingRows = db.prepare(`
    SELECT e.*,
      COALESCE((SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id AND rsvp_status = 'yes'), 0) as yes_count,
      COALESCE((SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id AND rsvp_status = 'no'), 0) as no_count,
      COALESCE((SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id AND rsvp_status = 'maybe'), 0) as maybe_count,
      COALESCE((SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id AND rsvp_status = 'pending'), 0) as pending_count,
      COALESCE((SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id AND rsvp_status = 'waitlist'), 0) as waitlist_count
    FROM events e
    WHERE e.start_at >= ?
      AND e.status NOT IN ('cancelled', 'completed')
    ORDER BY e.start_at ASC
    LIMIT 20
  `).all(now) as Array<{
    id: string; title: string; description: string; type: string; status: string;
    start_at: string; end_at: string | null; duration_minutes: number;
    location: string; location_url: string; min_attendees: number; max_attendees: number | null;
    cost_per_person_cents: number; cost_currency: string;
    yes_count: number; no_count: number; maybe_count: number; pending_count: number; waitlist_count: number;
  }>;

  const upcoming: DashboardEventsEvent[] = upcomingRows.map((e) => {
    const attendees = db.prepare(`
      SELECT id, name, phone, rsvp_status, waitlist_position, notes
      FROM event_attendees
      WHERE event_id = ?
      ORDER BY
        CASE rsvp_status
          WHEN 'yes' THEN 1
          WHEN 'maybe' THEN 2
          WHEN 'pending' THEN 3
          WHEN 'waitlist' THEN 4
          WHEN 'no' THEN 5
        END,
        waitlist_position ASC NULLS LAST
    `).all(e.id) as DashboardEventsAttendee[];

    const isConfirmed = e.yes_count >= e.min_attendees;
    const isFull = e.max_attendees !== null && e.yes_count >= e.max_attendees;
    const needsMore = Math.max(0, e.min_attendees - e.yes_count);

    return {
      ...e,
      is_confirmed: isConfirmed,
      is_full: isFull,
      needs_more: needsMore,
      attendees,
    };
  });

  // Events needing attention
  const needingAttention = upcoming.filter(
    (e) => e.pending_count > 0 || e.needs_more > 0
  );

  // By status
  const statusRows = db.prepare(
    "SELECT status as key, COUNT(*) as count FROM events GROUP BY status"
  ).all() as Array<{ key: string; count: number }>;
  const byStatus = toRecord(statusRows);

  // By type
  const typeRows = db.prepare(
    "SELECT type as key, COUNT(*) as count FROM events GROUP BY type"
  ).all() as Array<{ key: string; count: number }>;
  const byType = toRecord(typeRows);

  // Recently completed
  const recentlyCompleted = db.prepare(`
    SELECT e.id, e.title, e.start_at,
      (SELECT COUNT(*) FROM event_attendees WHERE event_id = e.id AND rsvp_status = 'yes') as attendee_count
    FROM events e
    WHERE e.status = 'completed'
    ORDER BY e.start_at DESC
    LIMIT 5
  `).all() as Array<{ id: string; title: string; start_at: string; attendee_count: number }>;

  return {
    kpis: {
      totalEvents,
      upcomingEvents,
      confirmedEvents,
      needsAttention: needsAttentionCount.c,
    },
    upcoming,
    needingAttention,
    byStatus,
    byType,
    recentlyCompleted,
  };
}
