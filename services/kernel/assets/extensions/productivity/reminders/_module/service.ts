import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { Reminder, ReminderStatus, RepeatInterval } from "./types.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

export function computeNextTrigger(current: string, repeat: RepeatInterval): string {
  const d = new Date(current);
  switch (repeat) {
    case "daily":
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    default:
      return current;
  }
  return d.toISOString();
}

export class ReminderService {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
  ) {}

  create(input: {
    title: string;
    body?: string;
    trigger_at: string;
    repeat?: RepeatInterval;
    task_id?: string;
    notify_mattermost?: boolean;
    notify_telegram?: boolean;
  }): Reminder {
    const now = isoNow();
    const reminder: Reminder = {
      id: newId(),
      title: input.title,
      body: input.body ?? "",
      trigger_at: input.trigger_at,
      status: "active",
      repeat: input.repeat ?? "none",
      task_id: input.task_id ?? null,
      snoozed_until: null,
      last_fired_at: null,
      notify_mattermost: input.notify_mattermost === false ? 0 : 1,
      notify_telegram: input.notify_telegram === false ? 0 : 1,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO reminders (id, title, body, trigger_at, status, repeat, task_id,
         snoozed_until, last_fired_at, notify_mattermost, notify_telegram, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reminder.id,
        reminder.title,
        reminder.body,
        reminder.trigger_at,
        reminder.status,
        reminder.repeat,
        reminder.task_id,
        reminder.snoozed_until,
        reminder.last_fired_at,
        reminder.notify_mattermost,
        reminder.notify_telegram,
        reminder.created_at,
        reminder.updated_at,
      );

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MERGE (r:Reminder {id: $id})
           SET r.title = $title, r.status = $status, r.trigger_at = $trigger_at`,
          { id: reminder.id, title: reminder.title, status: reminder.status, trigger_at: reminder.trigger_at },
        )
        .catch(() => {});

      if (reminder.task_id) {
        graph
          .run(
            `MATCH (r:Reminder {id: $rid}), (t:Task {id: $tid})
             MERGE (r)-[:REMINDS_ABOUT]->(t)`,
            { rid: reminder.id, tid: reminder.task_id },
          )
          .catch(() => {});
      }
    }

    return reminder;
  }

  getById(id: string): Reminder | undefined {
    return this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as
      | Reminder
      | undefined;
  }

  update(
    id: string,
    changes: Partial<Pick<Reminder, "title" | "body" | "trigger_at" | "repeat" | "task_id" | "notify_mattermost" | "notify_telegram">>,
  ): Reminder | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;

    const updated = { ...existing, ...changes, updated_at: isoNow() };

    this.db
      .prepare(
        `UPDATE reminders SET title=?, body=?, trigger_at=?, repeat=?, task_id=?,
         notify_mattermost=?, notify_telegram=?, updated_at=? WHERE id=?`,
      )
      .run(
        updated.title,
        updated.body,
        updated.trigger_at,
        updated.repeat,
        updated.task_id,
        updated.notify_mattermost,
        updated.notify_telegram,
        updated.updated_at,
        id,
      );

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MATCH (r:Reminder {id: $id})
           SET r.title = $title, r.status = $status, r.trigger_at = $trigger_at`,
          { id, title: updated.title, status: updated.status, trigger_at: updated.trigger_at },
        )
        .catch(() => {});
    }

    return updated;
  }

  dismiss(id: string): Reminder | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;

    const now = isoNow();
    this.db
      .prepare(`UPDATE reminders SET status='dismissed', updated_at=? WHERE id=?`)
      .run(now, id);

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(`MATCH (r:Reminder {id: $id}) SET r.status = 'dismissed'`, { id })
        .catch(() => {});
    }

    return { ...existing, status: "dismissed", updated_at: now };
  }

  snooze(id: string, until: string): Reminder | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;

    const now = isoNow();
    this.db
      .prepare(`UPDATE reminders SET status='snoozed', snoozed_until=?, updated_at=? WHERE id=?`)
      .run(until, now, id);

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(`MATCH (r:Reminder {id: $id}) SET r.status = 'snoozed'`, { id })
        .catch(() => {});
    }

    return { ...existing, status: "snoozed", snoozed_until: until, updated_at: now };
  }

  list(filters?: { status?: ReminderStatus; task_id?: string }): Reminder[] {
    let sql = "SELECT * FROM reminders WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters?.task_id) {
      sql += " AND task_id = ?";
      params.push(filters.task_id);
    }

    sql += " ORDER BY trigger_at ASC";
    return this.db.prepare(sql).all(...params) as Reminder[];
  }

  queryDue(asOf?: string): Reminder[] {
    const now = asOf ?? isoNow();
    return this.db
      .prepare(
        `SELECT * FROM reminders
         WHERE (status = 'active' AND trigger_at <= ?)
            OR (status = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ?)
         ORDER BY trigger_at ASC`,
      )
      .all(now, now) as Reminder[];
  }

  markFired(id: string): Reminder | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;

    const now = isoNow();

    if (existing.repeat === "none") {
      // One-shot: mark as fired
      this.db
        .prepare(`UPDATE reminders SET status='fired', last_fired_at=?, updated_at=? WHERE id=?`)
        .run(now, now, id);

      const graph = this.getGraph();
      if (graph?.capabilities.cypher) {
        graph
          .run(`MATCH (r:Reminder {id: $id}) SET r.status = 'fired'`, { id })
          .catch(() => {});
      }

      return { ...existing, status: "fired", last_fired_at: now, updated_at: now };
    }

    // Recurring: advance trigger_at to next occurrence
    let nextTrigger = computeNextTrigger(existing.trigger_at, existing.repeat);
    // Fast-forward if we've been down for multiple intervals
    const nowMs = Date.now();
    while (new Date(nextTrigger).getTime() <= nowMs) {
      nextTrigger = computeNextTrigger(nextTrigger, existing.repeat);
    }

    this.db
      .prepare(
        `UPDATE reminders SET status='active', trigger_at=?, snoozed_until=NULL,
         last_fired_at=?, updated_at=? WHERE id=?`,
      )
      .run(nextTrigger, now, now, id);

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MATCH (r:Reminder {id: $id}) SET r.status = 'active', r.trigger_at = $trigger_at`,
          { id, trigger_at: nextTrigger },
        )
        .catch(() => {});
    }

    return {
      ...existing,
      status: "active",
      trigger_at: nextTrigger,
      snoozed_until: null,
      last_fired_at: now,
      updated_at: now,
    };
  }

  queryMissed(): Reminder[] {
    const now = isoNow();
    return this.db
      .prepare(
        `SELECT * FROM reminders
         WHERE status = 'active' AND trigger_at < ?
         ORDER BY trigger_at ASC`,
      )
      .all(now) as Reminder[];
  }

  upcoming(withinHours: number = 24): Reminder[] {
    const now = new Date();
    const cutoff = new Date(now.getTime() + withinHours * 3600000).toISOString();
    return this.db
      .prepare(
        `SELECT * FROM reminders
         WHERE status IN ('active', 'snoozed')
         AND trigger_at <= ?
         ORDER BY trigger_at ASC`,
      )
      .all(cutoff) as Reminder[];
  }
}
