/**
 * Time-Tracking RPC Actions — timer start/stop, entries via mtwRequest.
 */

import crypto from "node:crypto";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";

export function timeTrackingRpcActions(db: SqliteDb): RpcAction[] {
  return [
    {
      name: "timeTracking.running",
      handler: async () => {
        const entry = db.prepare(
          "SELECT id, task_id, description, start_time, tags, created_at FROM time_entries WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1",
        ).get();
        return { entry: entry ?? null };
      },
    },
    {
      name: "timeTracking.start",
      handler: async (args) => {
        // Stop any running timer first
        const running = db.prepare("SELECT id, start_time FROM time_entries WHERE end_time IS NULL").get() as { id: string; start_time: string } | undefined;
        const now = new Date().toISOString();
        if (running) {
          const minutes = Math.round((Date.now() - new Date(running.start_time).getTime()) / 60000);
          db.prepare("UPDATE time_entries SET end_time = ?, duration_minutes = ? WHERE id = ?")
            .run(now, minutes, running.id);
        }

        const id = crypto.randomUUID();
        db.prepare(
          "INSERT INTO time_entries (id, task_id, description, start_time, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, args.task_id ?? null, args.description ?? "", now, args.tags ?? "", now);
        return { ok: true, id, stoppedPrevious: running?.id ?? null };
      },
    },
    {
      name: "timeTracking.stop",
      handler: async (args) => {
        const now = new Date().toISOString();
        let entry: { id: string; start_time: string } | undefined;

        if (typeof args.id === "string" && args.id) {
          entry = db.prepare("SELECT id, start_time FROM time_entries WHERE id = ? AND end_time IS NULL").get(args.id) as typeof entry;
        } else {
          entry = db.prepare("SELECT id, start_time FROM time_entries WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1").get() as typeof entry;
        }
        if (!entry) throw new Error("No running timer");

        const minutes = Math.round((Date.now() - new Date(entry.start_time).getTime()) / 60000);
        db.prepare("UPDATE time_entries SET end_time = ?, duration_minutes = ? WHERE id = ?")
          .run(now, minutes, entry.id);
        return { ok: true, id: entry.id, duration_minutes: minutes };
      },
    },
    {
      name: "timeTracking.log",
      handler: async (args) => {
        const durationMinutes = typeof args.duration_minutes === "number" ? args.duration_minutes : 0;
        if (!durationMinutes) throw new Error("duration_minutes required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const startTime = typeof args.start_time === "string" ? args.start_time : now;
        const endTime = new Date(new Date(startTime).getTime() + durationMinutes * 60000).toISOString();
        db.prepare(
          "INSERT INTO time_entries (id, task_id, description, start_time, end_time, duration_minutes, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(id, args.task_id ?? null, args.description ?? "", startTime, endTime, durationMinutes, args.tags ?? "", now);
        return { ok: true, id };
      },
    },
    {
      name: "timeTracking.list",
      handler: async (args) => {
        const from = typeof args.from === "string" ? args.from : "";
        const taskId = typeof args.task_id === "string" ? args.task_id : "";
        const limit = Math.min(200, typeof args.limit === "number" ? args.limit : 50);

        let where = "end_time IS NOT NULL";
        const params: unknown[] = [];
        if (from) { where += " AND start_time >= ?"; params.push(from); }
        if (taskId) { where += " AND task_id = ?"; params.push(taskId); }

        const rows = db.prepare(
          `SELECT id, task_id, description, start_time, end_time, duration_minutes, tags, created_at
           FROM time_entries WHERE ${where} ORDER BY start_time DESC LIMIT ?`,
        ).all(...params, limit);
        return { entries: rows };
      },
    },
    {
      name: "timeTracking.report",
      handler: async (args) => {
        const from = typeof args.from === "string" ? args.from : new Date(Date.now() - 7 * 86400000).toISOString();
        const to = typeof args.to === "string" ? args.to : new Date().toISOString();
        const totals = db.prepare(
          `SELECT COUNT(*) as entries, COALESCE(SUM(duration_minutes), 0) as total_minutes
           FROM time_entries WHERE end_time IS NOT NULL AND start_time >= ? AND start_time <= ?`,
        ).get(from, to);
        const byTag = db.prepare(
          `SELECT tags, COUNT(*) as entries, SUM(duration_minutes) as minutes
           FROM time_entries WHERE end_time IS NOT NULL AND start_time >= ? AND start_time <= ? AND tags <> ''
           GROUP BY tags ORDER BY minutes DESC`,
        ).all(from, to);
        return { period: { from, to }, totals, byTag };
      },
    },
  ];
}
