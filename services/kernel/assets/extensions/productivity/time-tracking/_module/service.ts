import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { TimeEntry } from "./types.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

export class TimeTrackingService {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
  ) {}

  getRunning(): TimeEntry | undefined {
    return this.db
      .prepare("SELECT * FROM time_entries WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1")
      .get() as TimeEntry | undefined;
  }

  start(input: {
    task_id?: string;
    description?: string;
    tags?: string;
  }): TimeEntry {
    // Stop any running timer first
    const running = this.getRunning();
    if (running) {
      this.stop(running.id);
    }

    const now = isoNow();
    const entry: TimeEntry = {
      id: newId(),
      task_id: input.task_id ?? null,
      description: input.description ?? "",
      start_time: now,
      end_time: null,
      duration_minutes: null,
      tags: input.tags ?? "",
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO time_entries (id, task_id, description, start_time, end_time, duration_minutes, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.task_id, entry.description, entry.start_time, entry.end_time, entry.duration_minutes, entry.tags, entry.created_at);

    return entry;
  }

  stop(id?: string): TimeEntry | undefined {
    const entry = id
      ? (this.db.prepare("SELECT * FROM time_entries WHERE id = ?").get(id) as TimeEntry | undefined)
      : this.getRunning();

    if (!entry || entry.end_time) return entry;

    const now = isoNow();
    const startMs = new Date(entry.start_time).getTime();
    const endMs = new Date(now).getTime();
    const duration = Math.round((endMs - startMs) / 60000);

    this.db
      .prepare("UPDATE time_entries SET end_time = ?, duration_minutes = ? WHERE id = ?")
      .run(now, duration, entry.id);

    return { ...entry, end_time: now, duration_minutes: duration };
  }

  log(input: {
    task_id?: string;
    description?: string;
    start_time: string;
    end_time: string;
    tags?: string;
  }): TimeEntry {
    const startMs = new Date(input.start_time).getTime();
    const endMs = new Date(input.end_time).getTime();
    const duration = Math.round((endMs - startMs) / 60000);

    const entry: TimeEntry = {
      id: newId(),
      task_id: input.task_id ?? null,
      description: input.description ?? "",
      start_time: input.start_time,
      end_time: input.end_time,
      duration_minutes: duration,
      tags: input.tags ?? "",
      created_at: isoNow(),
    };

    this.db
      .prepare(
        `INSERT INTO time_entries (id, task_id, description, start_time, end_time, duration_minutes, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.task_id, entry.description, entry.start_time, entry.end_time, entry.duration_minutes, entry.tags, entry.created_at);

    return entry;
  }

  list(filters?: {
    task_id?: string;
    from_date?: string;
    to_date?: string;
    tag?: string;
    limit?: number;
  }): TimeEntry[] {
    let sql = "SELECT * FROM time_entries WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.task_id) { sql += " AND task_id = ?"; params.push(filters.task_id); }
    if (filters?.from_date) { sql += " AND start_time >= ?"; params.push(filters.from_date); }
    if (filters?.to_date) { sql += " AND start_time <= ?"; params.push(filters.to_date); }
    if (filters?.tag) {
      sql += " AND (',' || tags || ',') LIKE ?";
      params.push(`%,${filters.tag},%`);
    }

    sql += " ORDER BY start_time DESC";
    if (filters?.limit) { sql += " LIMIT ?"; params.push(filters.limit); }

    return this.db.prepare(sql).all(...params) as TimeEntry[];
  }

  report(filters?: {
    from_date?: string;
    to_date?: string;
    task_id?: string;
  }): {
    total_minutes: number;
    entries_count: number;
    by_task: { task_id: string | null; minutes: number; count: number }[];
    by_tag: { tag: string; minutes: number }[];
    by_day: { date: string; minutes: number }[];
  } {
    const entries = this.list(filters);

    let totalMinutes = 0;
    const taskMap = new Map<string, { minutes: number; count: number }>();
    const tagMap = new Map<string, number>();
    const dayMap = new Map<string, number>();

    for (const entry of entries) {
      const mins = entry.duration_minutes ?? 0;
      totalMinutes += mins;

      const taskKey = entry.task_id ?? "(no task)";
      const existing = taskMap.get(taskKey) ?? { minutes: 0, count: 0 };
      existing.minutes += mins;
      existing.count++;
      taskMap.set(taskKey, existing);

      if (entry.tags) {
        for (const tag of entry.tags.split(",").map((t) => t.trim()).filter(Boolean)) {
          tagMap.set(tag, (tagMap.get(tag) ?? 0) + mins);
        }
      }

      const day = entry.start_time.split("T")[0];
      dayMap.set(day, (dayMap.get(day) ?? 0) + mins);
    }

    return {
      total_minutes: totalMinutes,
      entries_count: entries.length,
      by_task: [...taskMap.entries()]
        .map(([task_id, data]) => ({ task_id: task_id === "(no task)" ? null : task_id, ...data }))
        .sort((a, b) => b.minutes - a.minutes),
      by_tag: [...tagMap.entries()]
        .map(([tag, minutes]) => ({ tag, minutes }))
        .sort((a, b) => b.minutes - a.minutes),
      by_day: [...dayMap.entries()]
        .map(([date, minutes]) => ({ date, minutes }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
}
