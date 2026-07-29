/**
 * Health RPC Actions — metrics, medications, appointments via mtwRequest.
 */

import crypto from "node:crypto";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";

export function healthRpcActions(db: SqliteDb): RpcAction[] {
  return [
    {
      name: "health.metrics.list",
      handler: async (args) => {
        const type = typeof args.type === "string" ? args.type : "";
        const from = typeof args.from === "string" ? args.from : "";
        const limit = Math.min(200, Math.max(10, typeof args.limit === "number" ? args.limit : 50));

        let where = "1=1";
        const params: unknown[] = [];
        if (type) { where += " AND type = ?"; params.push(type); }
        if (from) { where += " AND date >= ?"; params.push(from); }

        const rows = db.prepare(
          `SELECT id, type, value, unit, date, notes, created_at
           FROM health_metrics WHERE ${where} ORDER BY date DESC, created_at DESC LIMIT ?`,
        ).all(...params, limit);
        return { metrics: rows };
      },
    },
    {
      name: "health.metrics.log",
      handler: async (args) => {
        const type = typeof args.type === "string" ? args.type : "";
        const value = typeof args.value === "string" ? args.value : typeof args.value === "number" ? String(args.value) : "";
        if (!type || !value) throw new Error("type and value required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO health_metrics (id, type, value, unit, date, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(id, type, value, args.unit ?? "", typeof args.date === "string" ? args.date : now.split("T")[0], args.notes ?? "", now);
        return { ok: true, id };
      },
    },
    {
      name: "health.medications.list",
      handler: async (args) => {
        const activeOnly = args.active_only !== false;
        const where = activeOnly ? "active = 1" : "1=1";
        const rows = db.prepare(
          `SELECT id, name, dosage, frequency, start_date, end_date, active, notes, created_at, updated_at
           FROM health_medications WHERE ${where} ORDER BY name COLLATE NOCASE`,
        ).all();
        return { medications: rows };
      },
    },
    {
      name: "health.medications.create",
      handler: async (args) => {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) throw new Error("Name required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO health_medications (id, name, dosage, frequency, start_date, end_date, active, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).run(id, name, args.dosage ?? "", args.frequency ?? "daily", args.start_date ?? now.split("T")[0], args.end_date ?? null, args.notes ?? "", now, now);
        return { ok: true, id };
      },
    },
    {
      name: "health.medications.update",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const fields: string[] = [];
        const vals: unknown[] = [];
        for (const f of ["name", "dosage", "frequency", "start_date", "end_date", "notes"]) {
          if (args[f] !== undefined) { fields.push(`${f} = ?`); vals.push(args[f]); }
        }
        if (args.active !== undefined) { fields.push("active = ?"); vals.push(args.active ? 1 : 0); }
        if (!fields.length) throw new Error("No fields");
        const now = new Date().toISOString();
        fields.push("updated_at = ?"); vals.push(now);
        vals.push(id);
        db.prepare(`UPDATE health_medications SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
        return { ok: true };
      },
    },
    {
      name: "health.appointments.list",
      handler: async (args) => {
        const status = typeof args.status === "string" ? args.status : "";
        const from = typeof args.from === "string" ? args.from : "";
        let where = "1=1";
        const params: unknown[] = [];
        if (status) { where += " AND status = ?"; params.push(status); }
        if (from) { where += " AND date >= ?"; params.push(from); }

        const rows = db.prepare(
          `SELECT id, title, provider, location, date, status, notes, created_at, updated_at
           FROM health_appointments WHERE ${where} ORDER BY date ASC`,
        ).all(...params);
        return { appointments: rows };
      },
    },
    {
      name: "health.appointments.create",
      handler: async (args) => {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const date = typeof args.date === "string" ? args.date : "";
        if (!title || !date) throw new Error("title and date required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO health_appointments (id, title, provider, location, date, status, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`,
        ).run(id, title, args.provider ?? "", args.location ?? "", date, args.notes ?? "", now, now);
        return { ok: true, id };
      },
    },
    {
      name: "health.summary",
      handler: async () => {
        const today = new Date().toISOString().split("T")[0];
        const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
        const latestMetrics = db.prepare(
          `SELECT type, value, unit, date FROM health_metrics
           WHERE id IN (SELECT id FROM health_metrics h2 WHERE h2.type = health_metrics.type ORDER BY date DESC LIMIT 1)
           GROUP BY type`,
        ).all();
        const activeMeds = (db.prepare("SELECT COUNT(*) as c FROM health_medications WHERE active = 1").get() as { c: number }).c;
        const upcomingAppts = db.prepare(
          "SELECT id, title, date, provider FROM health_appointments WHERE date >= ? AND status = 'scheduled' ORDER BY date ASC LIMIT 5",
        ).all(today);
        const weekMetrics = (db.prepare("SELECT COUNT(*) as c FROM health_metrics WHERE date >= ?").get(weekAgo) as { c: number }).c;
        return { latestMetrics, activeMeds, upcomingAppts, weekMetrics };
      },
    },
  ];
}
