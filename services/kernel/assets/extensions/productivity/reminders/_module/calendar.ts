/**
 * Reminders on the dashboard calendar: one-shot reminders in the window,
 * recurring ones expanded over it, and the overdue ones. Registered through
 * the module's dashboard descriptor; `order` is the slot the calendar has
 * always shown reminders in (see `queryCalendar`).
 */

import { type CalendarSource, type CalendarSourceEvent, safeAll } from "@kernl/extension-sdk";

/** Days (`YYYY-MM-DD`) a recurring reminder fires on within [start, end). */
function expandRecurring(
  triggeredAt: string,
  repeat: string,
  start: string,
  end: string,
): string[] {
  const dates: string[] = [];
  const base = new Date(triggeredAt);
  const endD = new Date(end + "T00:00:00Z");
  let cur = new Date(base);

  for (let i = 0; i < 200; i++) {
    const ds = cur.toISOString().split("T")[0];
    if (ds >= end) break;
    if (ds >= start) dates.push(ds);
    if (repeat === "daily") cur.setUTCDate(cur.getUTCDate() + 1);
    else if (repeat === "weekly") cur.setUTCDate(cur.getUTCDate() + 7);
    else if (repeat === "monthly") cur.setUTCMonth(cur.getUTCMonth() + 1);
    else break;
    if (cur > endD) break;
  }
  return dates;
}

export const remindersCalendarSource: CalendarSource = {
  id: "reminders",
  order: 20,
  query(db, { start, end }) {
    const events: CalendarSourceEvent[] = [];

    // One-shot reminders
    const oneShot = safeAll<{ id: string; title: string; trigger_at: string }>(db,
      `SELECT id, title, trigger_at FROM reminders
       WHERE status IN ('active','snoozed') AND repeat = 'none'
         AND trigger_at >= ? AND trigger_at < ?
       ORDER BY trigger_at`,
      [`${start}T00:00:00`, `${end}T00:00:00`],
    );
    for (const r of oneShot) {
      const d = r.trigger_at.split("T")[0];
      const t = r.trigger_at.split("T")[1]?.slice(0, 5) ?? null;
      events.push({
        date: d,
        id: r.id, type: "reminder", title: r.title, time: t,
        color: "#F0883E", extra: null,
      });
    }

    // Recurring reminders
    const recurring = safeAll<{ id: string; title: string; trigger_at: string; repeat: string }>(db,
      `SELECT id, title, trigger_at, repeat FROM reminders
       WHERE status IN ('active','snoozed') AND repeat != 'none'`,
    );
    for (const r of recurring) {
      const t = r.trigger_at.split("T")[1]?.slice(0, 5) ?? null;
      const expanded = expandRecurring(r.trigger_at, r.repeat, start, end);
      for (const d of expanded) {
        events.push({
          date: d,
          id: r.id + "-" + d, type: "reminder", title: r.title, time: t,
          color: "#F0883E", extra: r.repeat,
        });
      }
    }

    // Overdue reminders
    const odRem = safeAll<{ id: string; title: string; trigger_at: string }>(db,
      `SELECT id, title, trigger_at FROM reminders
       WHERE status IN ('active','snoozed') AND trigger_at < ?
       ORDER BY trigger_at LIMIT 20`,
      [new Date().toISOString()],
    );
    const overdue = odRem.map((r) => {
      const t = r.trigger_at.split("T")[1]?.slice(0, 5) ?? null;
      return { id: r.id, type: "reminder", title: r.title, time: t, color: "#F0883E", extra: null };
    });

    return { events, overdue };
  },
};
