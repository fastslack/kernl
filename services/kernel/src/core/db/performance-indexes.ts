import type { SqliteDb } from "./sqlite.js";
import { log } from "../logger.js";

/**
 * Composite indexes for dashboard query performance.
 * All use IF NOT EXISTS — safe to run on every boot.
 * These target the most common WHERE clause patterns in api.ts queries.
 */
const INDEXES = [
  // tasks: status + date combos used by queryTasks() (17 queries → 3-4 with these)
  `CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_date)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status_completed ON tasks(status, completed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status_started ON tasks(status, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority)`,

  // contacts: stale contact queries sort by last_interaction
  `CREATE INDEX IF NOT EXISTS idx_contacts_last_interaction ON contacts(last_interaction)`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_relationship ON contacts(relationship)`,

  // interactions: recent interactions join + sort
  `CREATE INDEX IF NOT EXISTS idx_interactions_date ON interactions(date)`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_contact_date ON interactions(contact_id, date)`,

  // reminders: scheduler polls status + trigger_at constantly
  `CREATE INDEX IF NOT EXISTS idx_reminders_status_trigger ON reminders(status, trigger_at)`,
  `CREATE INDEX IF NOT EXISTS idx_reminders_last_fired ON reminders(last_fired_at)`,

  // communications: dashboard queries by status + sent_at
  `CREATE INDEX IF NOT EXISTS idx_comms_status_sent ON communications(status, sent_at)`,
  `CREATE INDEX IF NOT EXISTS idx_comms_channel_status ON communications(channel, status)`,

  // shopping: purchases by date for weekly spending
  `CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchased_at)`,
  `CREATE INDEX IF NOT EXISTS idx_products_stock ON products(current_stock, min_stock)`,

  // life_log: queried by type + date constantly
  `CREATE INDEX IF NOT EXISTS idx_life_log_date ON life_log(date)`,

  // time_entries: grouped by task_id for dashboard integration
  `CREATE INDEX IF NOT EXISTS idx_time_entries_task ON time_entries(task_id)`,

  // events: upcoming/imminent queries
  `CREATE INDEX IF NOT EXISTS idx_events_status_start ON events(status, start_at)`,

  // agents: run history queries
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_status ON agent_runs(agent_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at)`,
];

/**
 * Apply all performance indexes on boot.
 * Uses IF NOT EXISTS so it's idempotent and fast (~1ms if indexes exist).
 */
export function applyPerformanceIndexes(db: SqliteDb): void {
  const start = Date.now();
  let created = 0;

  for (const sql of INDEXES) {
    try {
      db.run(sql);
      created++;
    } catch {
      // Table may not exist yet — skip silently
    }
  }

  const elapsed = Date.now() - start;
  if (elapsed > 50) {
    log.info(`Performance indexes applied: ${created}/${INDEXES.length} (${elapsed}ms)`);
  }
}
