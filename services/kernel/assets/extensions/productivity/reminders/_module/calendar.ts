/**
 * Reminders on the dashboard calendar: one-shot reminders in the window,
 * recurring ones expanded over it, and the overdue ones. Registered through
 * the module's dashboard descriptor; `order` is the slot the calendar has
 * always shown reminders in (see `queryCalendar`).
 */

import { type CalendarSource, type CalendarSourceEvent, safeAll, dayStart, localParts, localDateOf, addDays } from "@kernl/extension-sdk";

/** Days (`YYYY-MM-DD`) a recurring reminder fires on within [start, end), counted in local calendar days. */
function expandRecurring(
  triggeredAt: string,
  repeat: string,
  start: string,
  end: string,
): string[] {
  const dates: string[] = [];
  let day = localDateOf(triggeredAt);
  for (let i = 0; i < 200 && day < end; i++) {
    if (day >= start) dates.push(day);
    if (repeat === "daily") day = addDays(day, 1);
    else if (repeat === "weekly") day = addDays(day, 7);
    else if (repeat === "monthly") {
      // Same overflow as before: Jan 31 + 1 month is Mar 3 (or 2).
      const d = new Date(`${day}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + 1);
      day = d.toISOString().slice(0, 10);
    } else break;
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
      [dayStart(start), dayStart(end)],
    );
    for (const r of oneShot) {
      const { date: d, time: t } = localParts(r.trigger_at);
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
      const t = localParts(r.trigger_at).time;
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
      const t = localParts(r.trigger_at).time;
      return { id: r.id, type: "reminder", title: r.title, time: t, color: "#F0883E", extra: null };
    });

    return { events, overdue };
  },
};
