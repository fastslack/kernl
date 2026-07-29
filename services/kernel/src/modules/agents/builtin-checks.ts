/**
 * Check probes — the SQL half of the `check:*` builtin agents.
 *
 * Each probe is a pure read: it runs one query and returns the markdown block
 * to notify, or `null` when there is nothing to report. Probes never notify on
 * their own — the caller decides.
 *
 * That split is what lets several checks share one agent: a *digest* runs N
 * probes in a single pass and emits ONE notification with every finding,
 * instead of N agents waking at the same cron and firing N notifications.
 * See `CHECK_DIGEST_DEFS` below for the groupings and
 * `builtin-handlers.ts` for the handlers that wrap them.
 *
 * Probe text is verbatim what the old per-check handlers produced — grouping
 * changes how many notifications you get, never what they say.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import { today, daysFromNow, safeQuery } from "../../core/db/query-helpers.js";

export interface CheckProbe {
  /** Stable key. Matches the legacy handler suffix (`check:<key>`). */
  key: string;
  /** Notification title when this probe runs as its own agent. */
  title: string;
  /** Run-log line when the probe finds nothing. */
  clear: string;
  /** Markdown block when something is found; `null` means all clear. */
  run(db: SqliteDb): string | null;
}

export interface CheckDigestDef {
  /** Builtin handler id. */
  handler: string;
  name: string;
  description: string;
  cron: string;
  flow: string;
  /** Notification title for the combined block. */
  title: string;
  /** `CHECK_PROBES` keys, in the order they appear in the notification. */
  members: string[];
}

// ── Probes ─────────────────────────────────────

const probes: CheckProbe[] = [
  {
    key: "overdue-tasks",
    title: "Overdue Tasks",
    clear: "All clear — no overdue tasks.",
    run(db) {
      const rows = safeQuery<{ title: string; due_date: string; priority: string }>(
        db,
        `SELECT title, due_date, priority FROM tasks
         WHERE status NOT IN ('done') AND due_date IS NOT NULL AND due_date < ?
         ORDER BY due_date LIMIT 15`,
        today(),
      );
      if (rows.length === 0) return null;
      const items = rows.map((r) => `• **${r.title}** (due ${r.due_date}, ${r.priority})`);
      return `:warning: ${rows.length} overdue task(s)\n${items.join("\n")}`;
    },
  },
  {
    key: "billing",
    title: "Billing Alert",
    clear: "All clear — no upcoming billing.",
    run(db) {
      const rows = safeQuery<{ name: string; next_billing: string; amount_cents: number; currency: string }>(
        db,
        `SELECT name, next_billing, amount_cents, currency FROM subscriptions
         WHERE status = 'active' AND next_billing >= ? AND next_billing <= ?
         ORDER BY next_billing`,
        today(), daysFromNow(3),
      );
      if (rows.length === 0) return null;
      const items = rows.map((r) => `• **${r.name}** — ${(r.amount_cents / 100).toFixed(2)} ${r.currency} on ${r.next_billing}`);
      return `:credit_card: ${rows.length} subscription(s) billing soon\n${items.join("\n")}`;
    },
  },
  {
    key: "home-maintenance",
    title: "Home Maintenance",
    clear: "All clear — no overdue maintenance.",
    run(db) {
      const rows = safeQuery<{ name: string; next_due: string; priority: string }>(
        db,
        `SELECT name, next_due, priority FROM home_maintenance_items
         WHERE next_due IS NOT NULL AND next_due < ?
         ORDER BY next_due LIMIT 10`,
        today(),
      );
      if (rows.length === 0) return null;
      const items = rows.map((r) => `• **${r.name}** (due ${r.next_due}, ${r.priority})`);
      return `:wrench: ${rows.length} overdue maintenance item(s)\n${items.join("\n")}`;
    },
  },
  {
    key: "vehicle-maintenance",
    title: "Vehicle Maintenance",
    clear: "All clear — no overdue vehicle maintenance.",
    run(db) {
      const rows = safeQuery<{ task_name: string; vehicle_name: string; next_due_date: string | null }>(
        db,
        `SELECT vm.task_name, v.name AS vehicle_name, vm.next_due_date
         FROM vehicle_maintenance vm JOIN vehicles v ON v.id = vm.vehicle_id
         WHERE v.deleted_at IS NULL AND vm.next_due_date IS NOT NULL AND vm.next_due_date < ?
         ORDER BY vm.next_due_date LIMIT 10`,
        today(),
      );
      if (rows.length === 0) return null;
      const items = rows.map((r) => `• **${r.task_name}** — ${r.vehicle_name} (due ${r.next_due_date})`);
      return `:car: ${rows.length} overdue vehicle maintenance\n${items.join("\n")}`;
    },
  },
  {
    key: "document-expiry",
    title: "Document Expiry",
    clear: "All clear — no documents expiring soon.",
    run(db) {
      const rows = safeQuery<{ title: string; expiry_date: string }>(
        db,
        `SELECT title, expiry_date FROM documents
         WHERE deleted_at IS NULL AND expiry_date IS NOT NULL
           AND expiry_date >= ? AND expiry_date <= ?
         ORDER BY expiry_date LIMIT 10`,
        today(), daysFromNow(14),
      );
      if (rows.length === 0) return null;
      const items = rows.map((r) => `• **${r.title}** — expires ${r.expiry_date}`);
      return `:page_facing_up: ${rows.length} document(s) expiring within 14 days\n${items.join("\n")}`;
    },
  },
  {
    key: "warranty-expiry",
    title: "Warranty Expiry",
    clear: "All clear — no warranties expiring soon.",
    run(db) {
      const rows = safeQuery<{ name: string; warranty_expiry: string }>(
        db,
        `SELECT name, warranty_expiry FROM home_appliances
         WHERE deleted_at IS NULL AND warranty_expiry IS NOT NULL
           AND warranty_expiry >= ? AND warranty_expiry <= ?
         ORDER BY warranty_expiry LIMIT 10`,
        today(), daysFromNow(30),
      );
      if (rows.length === 0) return null;
      const items = rows.map((r) => `• **${r.name}** — expires ${r.warranty_expiry}`);
      return `:shield: ${rows.length} appliance warranty(ies) expiring within 30 days\n${items.join("\n")}`;
    },
  },
  {
    key: "health-appointments",
    title: "Health Appointments",
    clear: "All clear — no upcoming health appointments.",
    run(db) {
      const rows = safeQuery<{ title: string; date: string; provider: string }>(
        db,
        `SELECT title, date, provider FROM health_appointments
         WHERE status = 'scheduled' AND date >= ? AND date <= ?
         ORDER BY date LIMIT 10`,
        today(), daysFromNow(2),
      );
      if (rows.length === 0) return null;
      const items = rows.map((r) => `• **${r.title}** — ${r.provider} on ${r.date}`);
      return `:hospital: ${rows.length} health appointment(s) in next 48h\n${items.join("\n")}`;
    },
  },
  {
    key: "low-stock",
    title: "Low Stock",
    clear: "All clear — no low stock items.",
    run(db) {
      const rows = safeQuery<{ name: string; current_stock: number; min_stock: number }>(
        db,
        `SELECT name, current_stock, min_stock FROM products
         WHERE min_stock > 0 AND current_stock <= min_stock
         ORDER BY (current_stock * 1.0 / min_stock) LIMIT 10`,
      );
      if (rows.length === 0) return null;
      const items = rows.map((r) => `• **${r.name}** — ${r.current_stock}/${r.min_stock}`);
      return `:package: ${rows.length} product(s) low on stock\n${items.join("\n")}`;
    },
  },
  {
    key: "stale-contacts",
    title: "Stale Contacts",
    clear: "All clear — no stale contacts.",
    run(db) {
      const rows = safeQuery<{ name: string; last_interaction: string | null }>(
        db,
        `SELECT name, last_interaction FROM contacts
         WHERE relationship IN ('personal','professional','family')
           AND (last_interaction IS NULL OR last_interaction < ?)
         ORDER BY last_interaction LIMIT 10`,
        daysFromNow(-60),
      );
      if (rows.length === 0) return null;
      const items = rows.map((r) => `• **${r.name}** — last: ${r.last_interaction ?? "never"}`);
      return `:bust_in_silhouette: ${rows.length} contact(s) with no interaction in 60+ days\n${items.join("\n")}`;
    },
  },
  {
    key: "goal-progress",
    title: "Goal Progress",
    clear: "All clear — all goals above 50%.",
    run(db) {
      const rows = safeQuery<{ title: string; progress: number; target_date: string | null }>(
        db,
        `SELECT title, progress, target_date FROM goals
         WHERE status = 'active' AND progress < 50
         ORDER BY progress LIMIT 10`,
      );
      if (rows.length === 0) return null;
      const items = rows.map((r) => `• **${r.title}** — ${r.progress}%${r.target_date ? " (target: " + r.target_date + ")" : ""}`);
      return `:dart: ${rows.length} goal(s) under 50% progress\n${items.join("\n")}`;
    },
  },
  {
    key: "medications",
    title: "Medication Reminder",
    clear: "All clear — no active medications.",
    run(db) {
      const rows = safeQuery<{ name: string; dosage: string; frequency: string }>(
        db,
        `SELECT name, dosage, frequency FROM health_medications
         WHERE status = 'active'
         ORDER BY name LIMIT 15`,
      );
      if (rows.length === 0) return null;
      const items = rows.map((r) => `• **${r.name}** — ${r.dosage} (${r.frequency})`);
      return `:pill: ${rows.length} active medication(s) for today\n${items.join("\n")}`;
    },
  },
  {
    key: "open-incidents",
    title: "Open Incidents",
    clear: "All clear — no open incidents.",
    run(db) {
      const rows = safeQuery<{ title: string; severity: string; date_reported: string }>(
        db,
        `SELECT title, severity, date_reported FROM home_incidents
         WHERE deleted_at IS NULL AND status IN ('open','in_progress')
         ORDER BY CASE severity
           WHEN 'emergency' THEN 1 WHEN 'urgent' THEN 2 WHEN 'soon' THEN 3 ELSE 4
         END LIMIT 10`,
      );
      if (rows.length === 0) return null;
      const items = rows.map((r) => `• **${r.title}** — ${r.severity} (reported ${r.date_reported})`);
      return `:rotating_light: ${rows.length} open home incident(s)\n${items.join("\n")}`;
    },
  },
  {
    key: "blocked-tasks",
    title: "Blocked Tasks",
    clear: "All clear — no blocked tasks.",
    run(db) {
      const rows = safeQuery<{ title: string }>(
        db,
        `SELECT title FROM tasks WHERE status = 'blocked' LIMIT 10`,
      );
      if (rows.length === 0) return null;
      const items = rows.map((r) => `• **${r.title}**`);
      return `:no_entry: ${rows.length} blocked task(s)\n${items.join("\n")}`;
    },
  },
];

export const CHECK_PROBES: Record<string, CheckProbe> = Object.fromEntries(
  probes.map((p) => [p.key, p]),
);

// ── Digests ────────────────────────────────────

/**
 * Checks that share a cadence AND a theme, folded into one agent each.
 *
 * The grouping is cadence-preserving on purpose: every member keeps the exact
 * cron it had as a standalone agent, so nothing is checked less (or more)
 * often than before. What changes is the notification count — the five 09:00
 * checks used to fire five separate notifications at the same minute.
 *
 * Checks with no cadence partner (`low-stock`, `medications`) stay standalone
 * in `KERNEL_AGENT_DEFS`.
 */
export const CHECK_DIGEST_DEFS: CheckDigestDef[] = [
  {
    handler: "digest:daily-expiry",
    name: "Daily Expiry Digest",
    title: "Daily Expiry Digest",
    description: "Everything that expires or falls overdue: subscriptions billing in 3d, documents expiring in 14d, appliance warranties in 30d, overdue home and vehicle maintenance.",
    cron: "0 9 * * *",
    flow: "Automations",
    members: ["billing", "document-expiry", "warranty-expiry", "home-maintenance", "vehicle-maintenance"],
  },
  {
    handler: "digest:agenda-pulse",
    name: "Agenda Pulse",
    title: "Agenda Pulse",
    description: "What is on top of you right now: tasks past their due date and health appointments in the next 48h.",
    cron: "0 */6 * * *",
    flow: "Automations",
    members: ["overdue-tasks", "health-appointments"],
  },
  {
    handler: "digest:stuck",
    name: "Stuck & Open",
    title: "Stuck & Open",
    description: "Things sitting unresolved: blocked tasks and open home incidents.",
    cron: "0 */12 * * *",
    flow: "Automations",
    members: ["blocked-tasks", "open-incidents"],
  },
  {
    handler: "digest:weekly-review",
    name: "Weekly Review",
    title: "Weekly Review",
    description: "Monday long-horizon review: contacts with no interaction in 60+ days and active goals under 50% progress.",
    cron: "0 10 * * 1",
    flow: "Automations",
    members: ["stale-contacts", "goal-progress"],
  },
];

/**
 * Handler ids retired by the digest grouping above. The driver seeder
 * deactivates any agent still carrying one of these so a stale DB row can
 * never fall through to the LLM executor (which would burn tokens running an
 * agent with an empty system prompt).
 */
export const RETIRED_CHECK_HANDLERS: string[] = CHECK_DIGEST_DEFS
  .flatMap((d) => d.members)
  .map((key) => `check:${key}`);

/**
 * Run every probe in one pass. Returns the combined markdown and how many
 * probes actually found something (`hits === 0` means: do not notify).
 */
export function composeDigest(
  db: SqliteDb,
  members: ReadonlyArray<CheckProbe>,
): { text: string; hits: number } {
  const blocks: string[] = [];
  const clears: string[] = [];

  for (const probe of members) {
    if (!probe) continue;
    const found = probe.run(db);
    if (found) blocks.push(found);
    else clears.push(probe.clear);
  }

  return blocks.length > 0
    ? { text: blocks.join("\n\n"), hits: blocks.length }
    : { text: clears.join("\n"), hits: 0 };
}
