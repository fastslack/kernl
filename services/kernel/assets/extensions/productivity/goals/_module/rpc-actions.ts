/**
 * Goals RPC Actions — OKR management via mtwRequest.
 */

import crypto from "node:crypto";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";

export function goalsRpcActions(db: SqliteDb): RpcAction[] {
  return [
    {
      name: "goals.list",
      handler: async (args) => {
        const status = typeof args.status === "string" ? args.status : "";
        let where = "1=1";
        const params: unknown[] = [];
        if (status) { where += " AND g.status = ?"; params.push(status); }

        const rows = db.prepare(
          `SELECT g.id, g.title, g.description, g.type, g.status, g.parent_id, g.target_date,
                  g.created_at, g.updated_at,
                  (SELECT COUNT(*) FROM key_results kr WHERE kr.goal_id = g.id) as kr_count,
                  (SELECT CASE WHEN COUNT(*) = 0 THEN 0
                    ELSE ROUND(AVG(CASE WHEN kr2.target_value > 0 THEN MIN(kr2.current_value / kr2.target_value * 100, 100) ELSE 0 END))
                   END FROM key_results kr2 WHERE kr2.goal_id = g.id) as progress
           FROM goals g WHERE ${where}
           ORDER BY CASE g.status WHEN 'active' THEN 0 ELSE 1 END, g.updated_at DESC`,
        ).all(...params);
        return { goals: rows };
      },
    },
    {
      name: "goals.detail",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(id);
        if (!goal) throw new Error("Not found");
        const keyResults = db.prepare(
          "SELECT id, title, target_value, current_value, unit, task_id, created_at, updated_at FROM key_results WHERE goal_id = ? ORDER BY created_at",
        ).all(id);
        const children = db.prepare(
          "SELECT id, title, status, type FROM goals WHERE parent_id = ? ORDER BY created_at",
        ).all(id);
        return { goal, keyResults, children };
      },
    },
    {
      name: "goals.create",
      handler: async (args) => {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title) throw new Error("Title required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO goals (id, title, description, type, status, parent_id, target_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        ).run(id, title, args.description ?? "", args.type ?? "goal", args.parent_id ?? null, args.target_date ?? null, now, now);
        return { ok: true, id };
      },
    },
    {
      name: "goals.update",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const fields: string[] = [];
        const vals: unknown[] = [];
        for (const f of ["title", "description", "type", "status", "parent_id", "target_date"]) {
          if (args[f] !== undefined) { fields.push(`${f} = ?`); vals.push(args[f]); }
        }
        if (!fields.length) throw new Error("No fields");
        const now = new Date().toISOString();
        fields.push("updated_at = ?"); vals.push(now);
        vals.push(id);
        db.prepare(`UPDATE goals SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
        return { ok: true };
      },
    },
    {
      name: "goals.addKeyResult",
      handler: async (args) => {
        const goalId = typeof args.goal_id === "string" ? args.goal_id : "";
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!goalId || !title) throw new Error("goal_id and title required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO key_results (id, goal_id, title, target_value, current_value, unit, task_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, goalId, title, args.target_value ?? 100, args.current_value ?? 0, args.unit ?? "%", args.task_id ?? null, now, now);
        return { ok: true, id };
      },
    },
    {
      name: "goals.updateKeyResult",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const fields: string[] = [];
        const vals: unknown[] = [];
        for (const f of ["title", "target_value", "current_value", "unit", "task_id"]) {
          if (args[f] !== undefined) { fields.push(`${f} = ?`); vals.push(args[f]); }
        }
        if (!fields.length) throw new Error("No fields");
        const now = new Date().toISOString();
        fields.push("updated_at = ?"); vals.push(now);
        vals.push(id);
        db.prepare(`UPDATE key_results SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
        return { ok: true };
      },
    },
  ];
}
