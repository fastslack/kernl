/**
 * Nutrition RPC Actions — meal logging, macros, water, fasting, body stats via mtwRequest.
 */

import crypto from "node:crypto";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";

export function nutritionRpcActions(db: SqliteDb): RpcAction[] {
  return [
    {
      name: "nutrition.entries.list",
      handler: async (args) => {
        const date = typeof args.date === "string" ? args.date : new Date().toISOString().split("T")[0];
        const mealType = typeof args.meal_type === "string" ? args.meal_type : "";
        let where = "date = ?";
        const params: unknown[] = [date];
        if (mealType) { where += " AND meal_type = ?"; params.push(mealType); }

        const rows = db.prepare(
          `SELECT id, food_id, food_name, meal_type, quantity_g, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, date, notes, created_at
           FROM nutrition_entries WHERE ${where} ORDER BY created_at`,
        ).all(...params);
        return { entries: rows };
      },
    },
    {
      name: "nutrition.entries.log",
      handler: async (args) => {
        const foodName = typeof args.food_name === "string" ? args.food_name.trim() : "";
        if (!foodName) throw new Error("food_name required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO nutrition_entries (id, food_id, food_name, meal_type, quantity_g, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, date, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, args.food_id ?? null, foodName, args.meal_type ?? "other",
          args.quantity_g ?? 0, args.calories ?? 0, args.protein_g ?? 0,
          args.carbs_g ?? 0, args.fat_g ?? 0, args.fiber_g ?? 0,
          args.sugar_g ?? 0, args.sodium_mg ?? 0,
          typeof args.date === "string" ? args.date : now.split("T")[0],
          args.notes ?? "", now,
        );
        return { ok: true, id };
      },
    },
    {
      name: "nutrition.entries.delete",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        db.prepare("DELETE FROM nutrition_entries WHERE id = ?").run(id);
        return { ok: true };
      },
    },
    {
      name: "nutrition.dailySummary",
      handler: async (args) => {
        const date = typeof args.date === "string" ? args.date : new Date().toISOString().split("T")[0];
        const totals = db.prepare(
          `SELECT COUNT(*) as entries,
                  COALESCE(SUM(calories), 0) as calories,
                  COALESCE(SUM(protein_g), 0) as protein_g,
                  COALESCE(SUM(carbs_g), 0) as carbs_g,
                  COALESCE(SUM(fat_g), 0) as fat_g,
                  COALESCE(SUM(fiber_g), 0) as fiber_g
           FROM nutrition_entries WHERE date = ?`,
        ).get(date);
        const goal = db.prepare("SELECT * FROM nutrition_goals WHERE active = 1 LIMIT 1").get();
        const water = db.prepare(
          "SELECT COALESCE(SUM(amount_ml), 0) as total_ml FROM nutrition_water WHERE date = ?",
        ).get(date);
        return { date, totals, goal: goal ?? null, water };
      },
    },
    {
      name: "nutrition.water.log",
      handler: async (args) => {
        const amountMl = typeof args.amount_ml === "number" ? args.amount_ml : 0;
        if (!amountMl) throw new Error("amount_ml required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const date = typeof args.date === "string" ? args.date : now.split("T")[0];
        db.prepare(
          "INSERT INTO nutrition_water (id, amount_ml, date, time, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, amountMl, date, now.split("T")[1]?.slice(0, 5) ?? "", args.notes ?? "", now);
        return { ok: true, id };
      },
    },
    {
      name: "nutrition.water.today",
      handler: async (args) => {
        const date = typeof args.date === "string" ? args.date : new Date().toISOString().split("T")[0];
        const total = db.prepare(
          "SELECT COALESCE(SUM(amount_ml), 0) as total_ml FROM nutrition_water WHERE date = ?",
        ).get(date);
        const entries = db.prepare(
          "SELECT id, amount_ml, time, notes FROM nutrition_water WHERE date = ? ORDER BY created_at",
        ).all(date);
        return { ...(total as Record<string, unknown>), entries };
      },
    },
    {
      name: "nutrition.fasting.start",
      handler: async (args) => {
        const protocol = typeof args.protocol === "string" ? args.protocol : "16:8";
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const targetHours = typeof args.target_hours === "number" ? args.target_hours : parseInt(protocol) || 16;
        db.prepare(
          `INSERT INTO nutrition_fasting (id, protocol, start_time, target_hours, status, notes, created_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        ).run(id, protocol, now, targetHours, args.notes ?? "", now);
        return { ok: true, id };
      },
    },
    {
      name: "nutrition.fasting.stop",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        const status = typeof args.status === "string" && ["completed", "broken"].includes(args.status) ? args.status : "completed";
        const now = new Date().toISOString();

        // Find active fast if no id
        let fastId = id;
        if (!fastId) {
          const active = db.prepare("SELECT id FROM nutrition_fasting WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined;
          if (!active) throw new Error("No active fast");
          fastId = active.id;
        }

        const fast = db.prepare("SELECT start_time FROM nutrition_fasting WHERE id = ?").get(fastId) as { start_time: string } | undefined;
        if (!fast) throw new Error("Fast not found");
        const actualHours = Math.round((Date.now() - new Date(fast.start_time).getTime()) / 3600000 * 10) / 10;

        db.prepare("UPDATE nutrition_fasting SET end_time = ?, actual_hours = ?, status = ? WHERE id = ?")
          .run(now, actualHours, status, fastId);
        return { ok: true, actualHours };
      },
    },
    {
      name: "nutrition.fasting.active",
      handler: async () => {
        const fast = db.prepare(
          "SELECT id, protocol, start_time, target_hours, notes, created_at FROM nutrition_fasting WHERE status = 'active' ORDER BY created_at DESC LIMIT 1",
        ).get();
        return { fast: fast ?? null };
      },
    },
    {
      name: "nutrition.bodyStats.log",
      handler: async (args) => {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO nutrition_body_stats (id, weight_kg, body_fat_pct, muscle_mass_kg, water_pct, bmi, waist_cm, hip_cm, chest_cm, date, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, args.weight_kg ?? null, args.body_fat_pct ?? null, args.muscle_mass_kg ?? null,
          args.water_pct ?? null, args.bmi ?? null, args.waist_cm ?? null,
          args.hip_cm ?? null, args.chest_cm ?? null,
          typeof args.date === "string" ? args.date : now.split("T")[0],
          args.notes ?? "", now,
        );
        return { ok: true, id };
      },
    },
    {
      name: "nutrition.bodyStats.list",
      handler: async (args) => {
        const limit = Math.min(100, typeof args.limit === "number" ? args.limit : 30);
        const rows = db.prepare(
          "SELECT * FROM nutrition_body_stats ORDER BY date DESC LIMIT ?",
        ).all(limit);
        return { stats: rows };
      },
    },
    {
      name: "nutrition.foods.search",
      handler: async (args) => {
        const q = typeof args.q === "string" ? args.q.trim() : "";
        if (!q) throw new Error("Query required");
        const limit = Math.min(50, typeof args.limit === "number" ? args.limit : 20);
        const rows = db.prepare(
          `SELECT f.* FROM nutrition_foods_fts fts JOIN nutrition_foods f ON fts.rowid = f.rowid
           WHERE nutrition_foods_fts MATCH ? LIMIT ?`,
        ).all(q, limit);
        return { foods: rows };
      },
    },
  ];
}
