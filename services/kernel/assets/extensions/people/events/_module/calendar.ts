/**
 * Events on the dashboard calendar: events not cancelled/completed in the
 * window, plus the overdue ones. Registered through the module's dashboard
 * descriptor; `order` is the slot the calendar has always shown them in (see
 * `queryCalendar`).
 */

import { type CalendarSource, safeAll } from "@kernl/extension-sdk";

export const eventsCalendarSource: CalendarSource = {
  id: "events",
  order: 130,
  query(db, { start, end }) {
    const rows = safeAll<{ id: string; title: string; start_at: string; type: string; status: string; duration_minutes: number }>(db,
      `SELECT id, title, start_at, type, status, duration_minutes FROM events
       WHERE status NOT IN ('cancelled','completed') AND start_at >= ? AND start_at < ?
       ORDER BY start_at`,
      [start + "T00:00:00", end + "T00:00:00"],
    );
    // Overdue events (not cancelled/completed, start_at in the past)
    const od = safeAll<{ id: string; title: string; start_at: string; type: string }>(db,
      `SELECT id, title, start_at, type FROM events
       WHERE status NOT IN ('cancelled','completed') AND start_at < ?
       ORDER BY start_at DESC LIMIT 20`,
      [start + "T00:00:00"],
    );
    return {
      events: rows.map((r) => ({
        date: r.start_at.split("T")[0],
        id: r.id, type: "event", title: r.title, time: r.start_at.split("T")[1]?.slice(0, 5) ?? null,
        color: "#E879A8", extra: r.status === "draft" ? `${r.type} · draft` : r.type,
      })),
      overdue: od.map((r) => ({ id: r.id, type: "event", title: r.title, time: r.start_at, color: "#E879A8", extra: r.type })),
    };
  },
};
