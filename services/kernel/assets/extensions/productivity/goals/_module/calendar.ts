/**
 * Goals on the dashboard calendar: the target date of every goal not
 * cancelled. Registered through the module's dashboard descriptor; `order` is
 * the slot the calendar has always shown them in (see `queryCalendar`).
 */

import { type CalendarSource, safeAll } from "@kernl/extension-sdk";

export const goalsCalendarSource: CalendarSource = {
  id: "goals",
  order: 90,
  query(db, { start, end }) {
    const rows = safeAll<{ id: string; title: string; target_date: string }>(db,
      `SELECT id, title, target_date FROM goals
       WHERE status != 'cancelled' AND target_date IS NOT NULL
         AND target_date >= ? AND target_date < ?
       ORDER BY target_date`,
      [start, end],
    );
    return {
      events: rows.map((r) => ({
        date: r.target_date,
        id: r.id, type: "goal", title: r.title, time: null,
        color: "#3DD6C8", extra: null,
      })),
    };
  },
};
