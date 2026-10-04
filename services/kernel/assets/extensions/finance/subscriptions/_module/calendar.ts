/**
 * Subscriptions on the dashboard calendar: the next billing date of each
 * active one. Registered through the module's dashboard descriptor; `order`
 * is the slot the calendar has always shown them in (see `queryCalendar`).
 */

import { type CalendarSource, safeAll } from "@kernl/extension-sdk";

export const subscriptionsCalendarSource: CalendarSource = {
  id: "subscriptions",
  order: 30,
  query(db, { start, end }) {
    const rows = safeAll<{ id: string; name: string; next_billing: string; amount_cents: number; currency: string }>(db,
      `SELECT id, name, next_billing, amount_cents, currency FROM subscriptions
       WHERE status = 'active' AND next_billing >= ? AND next_billing < ?
       ORDER BY next_billing`,
      [start, end],
    );
    return {
      events: rows.map((r) => ({
        date: r.next_billing,
        id: r.id, type: "subscription", title: r.name, time: null,
        color: "#3DD68C", extra: (r.amount_cents / 100).toFixed(2) + " " + r.currency,
      })),
    };
  },
};
