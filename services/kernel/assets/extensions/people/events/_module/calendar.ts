/**
 * Events on the dashboard calendar: events not cancelled/completed in the
 * window, plus the overdue ones. Registered through the module's dashboard
 * descriptor; `order` is the slot the calendar has always shown them in (see
 * `queryCalendar`).
 */

import { type CalendarSource, safeAll, localParts, localDateOf, dayStart } from "@kernl/extension-sdk";

export const eventsCalendarSource: CalendarSource = {
  id: "events",
  order: 130,
  query(db, { start, end }) {
    const rows = safeAll<{ id: string; title: string; start_at: string; type: string; status: string; duration_minutes: number }>(db,
      `SELECT id, title, start_at, type, status, duration_minutes FROM events
       WHERE status NOT IN ('cancelled','completed') AND start_at >= ? AND start_at < ?
       ORDER BY start_at`,
      [dayStart(start), dayStart(end)],
    );
    // Overdue events (not cancelled/completed, start_at in the past)
    const od = safeAll<{ id: string; title: string; start_at: string; type: string }>(db,
      `SELECT id, title, start_at, type FROM events
       WHERE status NOT IN ('cancelled','completed') AND start_at < ?
       ORDER BY start_at DESC LIMIT 20`,
      [dayStart(start)],
    );
    return {
      events: rows.map((r) => ({
        date: localDateOf(r.start_at),
        id: r.id, type: "event", title: r.title, time: localParts(r.start_at).time,
        color: "#E879A8", extra: r.status === "draft" ? `${r.type} · draft` : r.type,
      })),
      overdue: od.map((r) => ({ id: r.id, type: "event", title: r.title, time: r.start_at, color: "#E879A8", extra: r.type })),
    };
  },
};
