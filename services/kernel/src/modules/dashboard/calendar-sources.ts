/**
 * Calendar sources that stay in the core.
 *
 * Every other source lives with the extension that owns its table and reaches
 * the calendar through `getDashboardDescriptor().calendarSources` (tasks,
 * reminders, subscriptions, health, goals, events). What is left here:
 *
 *   - agent schedules — the agents module is core (src/modules/agents);
 *   - tables no module in this repo creates: home maintenance, vehicles,
 *     documents, meal plans, the home_house singleton, and research_tasks
 *     (owned by the web-intel extension, which ships outside this repo).
 *     They are read only when present, like any other source.
 *
 * `order` is each source's legacy position in `queryCalendar()`; the table of
 * all positions, extension ones included, is next to that function.
 */

import { CronExpressionParser } from "cron-parser";
import type { CalendarSource, CalendarSourceEvent } from "../../core/types.js";
import { tableExists, safeGet, safeAll } from "./query-helpers.js";

// 5. Home maintenance (next_due)
const homeMaintenance: CalendarSource = {
  id: "home-maintenance",
  order: 50,
  query(db, { start, end }) {
    const rows = safeAll<{ id: string; name: string; next_due: string }>(db,
      `SELECT id, name, next_due FROM home_maintenance_items
       WHERE next_due IS NOT NULL AND next_due >= ? AND next_due < ?
       ORDER BY next_due`,
      [start, end],
    );
    return {
      events: rows.map((r) => ({
        date: r.next_due,
        id: r.id, type: "maintenance", title: r.name, time: null,
        color: "#D4A84B", extra: "home",
      })),
    };
  },
};

// 6. Vehicle maintenance (next_due_date)
const vehicleMaintenance: CalendarSource = {
  id: "vehicle-maintenance",
  order: 60,
  query(db, { start, end }) {
    const rows = safeAll<{ id: string; name: string; next_due_date: string; vehicle_name: string }>(db,
      `SELECT vm.id, vm.name, vm.next_due_date, v.name AS vehicle_name
       FROM vehicle_maintenance vm
       JOIN vehicles v ON v.id = vm.vehicle_id
       WHERE vm.next_due_date IS NOT NULL AND vm.next_due_date >= ? AND vm.next_due_date < ?
         AND v.deleted_at IS NULL
       ORDER BY vm.next_due_date`,
      [start, end],
    );
    return {
      events: rows.map((r) => ({
        date: r.next_due_date,
        id: r.id, type: "vehicle", title: r.name, time: null,
        color: "#D4A84B", extra: r.vehicle_name,
      })),
    };
  },
};

// 7. Vehicle inspections
const vehicleInspections: CalendarSource = {
  id: "vehicle-inspections",
  order: 70,
  query(db, { start, end }) {
    const rows = safeAll<{ id: string; name: string; next_inspection: string }>(db,
      `SELECT id, name, next_inspection FROM vehicles
       WHERE deleted_at IS NULL AND next_inspection IS NOT NULL
         AND next_inspection >= ? AND next_inspection < ?`,
      [start, end],
    );
    return {
      events: rows.map((r) => ({
        date: r.next_inspection,
        id: r.id + "-insp", type: "vehicle", title: "Inspection: " + r.name, time: null,
        color: "#D4A84B", extra: null,
      })),
    };
  },
};

// 8. Documents (expiry_date)
const documents: CalendarSource = {
  id: "documents",
  order: 80,
  query(db, { start, end }) {
    const rows = safeAll<{ id: string; title: string; expiry_date: string }>(db,
      `SELECT id, title, expiry_date FROM documents
       WHERE deleted_at IS NULL AND expiry_date IS NOT NULL
         AND expiry_date >= ? AND expiry_date < ?
       ORDER BY expiry_date`,
      [start, end],
    );
    return {
      events: rows.map((r) => ({
        date: r.expiry_date,
        id: r.id, type: "document", title: r.title, time: null,
        color: "#6E738A", extra: "expires",
      })),
    };
  },
};

// 10. Meal plans
const mealPlans: CalendarSource = {
  id: "meal-plans",
  order: 100,
  query(db, { start, end }) {
    const rows = safeAll<{ id: string; meal_type: string; date: string; recipe_name: string | null }>(db,
      `SELECT mp.id, mp.meal_type, mp.date, r.name AS recipe_name
       FROM meal_plans mp
       LEFT JOIN recipes r ON r.id = mp.recipe_id
       WHERE mp.date >= ? AND mp.date < ?
       ORDER BY mp.date`,
      [start, end],
    );
    return {
      events: rows.map((r) => ({
        date: r.date,
        id: r.id, type: "meal", title: r.recipe_name ?? r.meal_type, time: null,
        color: "#da7756", extra: r.meal_type,
      })),
    };
  },
};

// 11. Research tasks (next_run_at)
const researchTasks: CalendarSource = {
  id: "research-tasks",
  order: 110,
  query(db, { start, end }) {
    const rows = safeAll<{ id: string; name: string; next_run_at: string }>(db,
      `SELECT id, name, next_run_at FROM research_tasks
       WHERE status = 'active' AND next_run_at IS NOT NULL
         AND next_run_at >= ? AND next_run_at < ?
       ORDER BY next_run_at`,
      [`${start}T00:00:00`, `${end}T00:00:00`],
    );
    return {
      events: rows.map((r) => ({
        date: r.next_run_at.split("T")[0],
        id: r.id, type: "research", title: r.name, time: r.next_run_at.split("T")[1]?.slice(0, 5) ?? null,
        color: "#8B7CF6", extra: null,
      })),
    };
  },
};

// 12. Insurance expiry (home_house singleton)
const homeInsurance: CalendarSource = {
  id: "home-insurance",
  order: 120,
  query(db, { start, end }) {
    const house = safeGet(db,
      `SELECT insurance_expiry FROM home_house WHERE id = 'house-profile'`,
      [],
      undefined as { insurance_expiry: string | null } | undefined,
    );
    if (!(house?.insurance_expiry && house.insurance_expiry >= start && house.insurance_expiry < end)) {
      return { events: [] };
    }
    return {
      events: [{
        date: house.insurance_expiry,
        id: "insurance-expiry", type: "document", title: "Home Insurance Expiry", time: null,
        color: "#6E738A", extra: "insurance",
      }],
    };
  },
};

// 14. Agent schedules (automation runs) — expand cron over the calendar window
// Cap expansions per agent so a `* * * * *` agent doesn't dump 43k events into the grid.
const agentSchedules: CalendarSource = {
  id: "agent-schedules",
  order: 140,
  query(db, { start, end }) {
    const events: CalendarSourceEvent[] = [];
    if (!tableExists(db, "agent_schedules") || !tableExists(db, "agents")) return { events };

    const rows = safeAll<{
      agent_id: string;
      agent_name: string;
      cron_expression: string;
      next_run_at: string;
      builtin_handler: string;
    }>(db,
      `SELECT s.agent_id, a.name AS agent_name, s.cron_expression, s.next_run_at, a.builtin_handler
       FROM agent_schedules s
       JOIN agents a ON a.id = s.agent_id
       WHERE s.active = 1 AND a.active = 1 AND s.cron_expression <> ''`,
    );

    const rangeStart = new Date(`${start}T00:00:00Z`);
    const rangeEnd = new Date(`${end}T00:00:00Z`);
    const MAX_PER_AGENT = 60; // hard cap per agent over the window

    for (const r of rows) {
      try {
        const interval = CronExpressionParser.parse(r.cron_expression, {
          tz: "UTC",
          currentDate: rangeStart,
          endDate: rangeEnd,
        });
        let count = 0;
        while (count < MAX_PER_AGENT) {
          let next: Date;
          try { next = interval.next().toDate(); } catch { break; }
          if (next >= rangeEnd) break;
          events.push({
            date: next.toISOString().split("T")[0],
            id: `sched-${r.agent_id}-${next.getTime()}`,
            type: "automation",
            title: r.agent_name,
            time: next.toISOString().split("T")[1].slice(0, 5),
            color: r.builtin_handler ? "#8B7CF6" : "#3DD68C",
            extra: r.cron_expression,
          });
          count++;
        }
      } catch {
        // invalid cron — skip
      }
    }
    return { events };
  },
};

/** The core's own calendar sources; `queryCalendar()` merges them with the modules' ones. */
export const CORE_CALENDAR_SOURCES: readonly CalendarSource[] = [
  homeMaintenance,
  vehicleMaintenance,
  vehicleInspections,
  documents,
  mealPlans,
  researchTasks,
  homeInsurance,
  agentSchedules,
];
