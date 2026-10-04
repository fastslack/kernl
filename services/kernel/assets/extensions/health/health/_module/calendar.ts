/**
 * Health appointments on the dashboard calendar: scheduled ones in the
 * window. Registered through the module's dashboard descriptor; `order` is
 * the slot the calendar has always shown them in (see `queryCalendar`).
 */

import { type CalendarSource, safeAll } from "@kernl/extension-sdk";

export const healthCalendarSource: CalendarSource = {
  id: "health",
  order: 40,
  query(db, { start, end }) {
    const rows = safeAll<{ id: string; title: string; date: string; provider: string }>(db,
      `SELECT id, title, date, provider FROM health_appointments
       WHERE status = 'scheduled' AND date >= ? AND date < ?
       ORDER BY date`,
      [start, end],
    );
    return {
      events: rows.map((r) => ({
        date: r.date,
        id: r.id, type: "health", title: r.title, time: null,
        color: "#F04770", extra: r.provider,
      })),
    };
  },
};
