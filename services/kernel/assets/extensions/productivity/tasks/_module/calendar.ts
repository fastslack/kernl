/**
 * Tasks on the dashboard calendar: open tasks by due date, plus the overdue
 * ones. Registered through the module's dashboard descriptor; `order` is the
 * slot the calendar has always shown tasks in (see `queryCalendar`).
 */

import { type CalendarSource, safeAll } from "@kernl/extension-sdk";

export const tasksCalendarSource: CalendarSource = {
  id: "tasks",
  order: 10,
  query(db, { start, end }) {
    // Tasks with due_date (in range + overdue)
    const rows = safeAll<{ id: string; title: string; due_date: string; priority: string; status: string }>(db,
      `SELECT id, title, due_date, priority, status FROM tasks
       WHERE due_date IS NOT NULL AND due_date >= ? AND due_date < ? AND status != 'done' AND deleted_at IS NULL
       ORDER BY due_date`,
      [start, end],
    );
    // Overdue tasks
    const od = safeAll<{ id: string; title: string; due_date: string; priority: string }>(db,
      `SELECT id, title, due_date, priority FROM tasks
       WHERE status NOT IN ('done') AND due_date IS NOT NULL AND due_date < ? AND deleted_at IS NULL
       ORDER BY due_date LIMIT 30`,
      [start],
    );
    return {
      events: rows.map((r) => ({
        date: r.due_date,
        id: r.id, type: "task", title: r.title, time: null,
        color: "#5B9BF7", extra: r.priority,
      })),
      overdue: od.map((r) => ({ id: r.id, type: "task", title: r.title, time: r.due_date, color: "#5B9BF7", extra: r.priority })),
    };
  },
};
