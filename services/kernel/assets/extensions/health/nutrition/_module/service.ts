import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type {
  NutritionFood, NutritionEntry, NutritionGoal, NutritionFasting,
  NutritionWater, NutritionBodyStats, DailyNutritionSummary,
  MealType, FoodSource, FastingProtocol,
} from "./types.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

export class NutritionService {
  constructor(private db: SqliteDb) {}

  // ── Food Database ─────────────────────────────────────────────────────────

  addFood(input: {
    name: string; brand?: string; barcode?: string;
    calories_per_100g?: number; protein_per_100g?: number;
    carbs_per_100g?: number; fat_per_100g?: number;
    fiber_per_100g?: number; sugar_per_100g?: number;
    sodium_per_100g?: number; serving_size_g?: number;
    serving_unit?: string; source?: FoodSource; notes?: string;
  }): NutritionFood {
    const now = isoNow();
    const food: NutritionFood = {
      id: newId(), name: input.name, brand: input.brand ?? "",
      barcode: input.barcode ?? "",
      calories_per_100g: input.calories_per_100g ?? 0,
      protein_per_100g: input.protein_per_100g ?? 0,
      carbs_per_100g: input.carbs_per_100g ?? 0,
      fat_per_100g: input.fat_per_100g ?? 0,
      fiber_per_100g: input.fiber_per_100g ?? 0,
      sugar_per_100g: input.sugar_per_100g ?? 0,
      sodium_per_100g: input.sodium_per_100g ?? 0,
      serving_size_g: input.serving_size_g ?? 100,
      serving_unit: input.serving_unit ?? "g",
      source: input.source ?? "custom",
      notes: input.notes ?? "",
      created_at: now, updated_at: now,
    };

    this.db.prepare(`
      INSERT INTO nutrition_foods
        (id,name,brand,barcode,calories_per_100g,protein_per_100g,carbs_per_100g,
         fat_per_100g,fiber_per_100g,sugar_per_100g,sodium_per_100g,
         serving_size_g,serving_unit,source,notes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(food.id,food.name,food.brand,food.barcode,food.calories_per_100g,
           food.protein_per_100g,food.carbs_per_100g,food.fat_per_100g,
           food.fiber_per_100g,food.sugar_per_100g,food.sodium_per_100g,
           food.serving_size_g,food.serving_unit,food.source,food.notes,
           food.created_at,food.updated_at);

    this.db.prepare(`
      INSERT INTO nutrition_foods_fts(food_id, name, brand)
      VALUES (?, ?, ?)
    `).run(food.id, food.name, food.brand);

    return food;
  }

  searchFoods(query: string, limit = 20): NutritionFood[] {
    const ids = this.db.prepare(`
      SELECT food_id FROM nutrition_foods_fts WHERE nutrition_foods_fts MATCH ? LIMIT ?
    `).all(query + "*", limit) as { food_id: string }[];

    if (ids.length === 0) {
      return this.db.prepare(
        `SELECT * FROM nutrition_foods WHERE name LIKE ? OR brand LIKE ? ORDER BY name LIMIT ?`
      ).all(`%${query}%`, `%${query}%`, limit) as NutritionFood[];
    }

    const placeholders = ids.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT * FROM nutrition_foods WHERE id IN (${placeholders})`
    ).all(...ids.map(r => r.food_id)) as NutritionFood[];
  }

  getFoodByBarcode(barcode: string): NutritionFood | undefined {
    return this.db.prepare(
      "SELECT * FROM nutrition_foods WHERE barcode = ? AND barcode != ''"
    ).get(barcode) as NutritionFood | undefined;
  }

  // ── Log Entries ───────────────────────────────────────────────────────────

  logEntry(input: {
    food_id?: string; food_name?: string; meal_type?: MealType;
    quantity_g?: number; calories?: number; protein_g?: number;
    carbs_g?: number; fat_g?: number; fiber_g?: number;
    sugar_g?: number; sodium_mg?: number; date?: string; notes?: string;
  }): NutritionEntry {
    const now = isoNow();
    const today = now.split("T")[0];
    let food: NutritionFood | undefined;

    if (input.food_id) {
      food = this.db.prepare("SELECT * FROM nutrition_foods WHERE id = ?").get(input.food_id) as NutritionFood | undefined;
    }

    const qty = input.quantity_g ?? 100;
    const scale = qty / 100;

    const entry: NutritionEntry = {
      id: newId(),
      food_id: input.food_id ?? null,
      food_name: input.food_name ?? food?.name ?? "Unknown",
      meal_type: input.meal_type ?? "other",
      quantity_g: qty,
      calories: input.calories ?? (food ? food.calories_per_100g * scale : 0),
      protein_g: input.protein_g ?? (food ? food.protein_per_100g * scale : 0),
      carbs_g: input.carbs_g ?? (food ? food.carbs_per_100g * scale : 0),
      fat_g: input.fat_g ?? (food ? food.fat_per_100g * scale : 0),
      fiber_g: input.fiber_g ?? (food ? food.fiber_per_100g * scale : 0),
      sugar_g: input.sugar_g ?? (food ? food.sugar_per_100g * scale : 0),
      sodium_mg: input.sodium_mg ?? (food ? food.sodium_per_100g * scale * 10 : 0),
      date: input.date ?? today,
      notes: input.notes ?? "",
      created_at: now,
    };

    this.db.prepare(`
      INSERT INTO nutrition_entries
        (id,food_id,food_name,meal_type,quantity_g,calories,protein_g,carbs_g,
         fat_g,fiber_g,sugar_g,sodium_mg,date,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(entry.id,entry.food_id,entry.food_name,entry.meal_type,entry.quantity_g,
           entry.calories,entry.protein_g,entry.carbs_g,entry.fat_g,entry.fiber_g,
           entry.sugar_g,entry.sodium_mg,entry.date,entry.notes,entry.created_at);

    return entry;
  }

  listEntries(date: string, meal_type?: MealType): NutritionEntry[] {
    if (meal_type) {
      return this.db.prepare(
        "SELECT * FROM nutrition_entries WHERE date = ? AND meal_type = ? ORDER BY created_at ASC"
      ).all(date, meal_type) as NutritionEntry[];
    }
    return this.db.prepare(
      "SELECT * FROM nutrition_entries WHERE date = ? ORDER BY meal_type, created_at ASC"
    ).all(date) as NutritionEntry[];
  }

  deleteEntry(id: string): boolean {
    const r = this.db.prepare("DELETE FROM nutrition_entries WHERE id = ?").run(id);
    return r.changes > 0;
  }

  // ── Goals ─────────────────────────────────────────────────────────────────

  setGoal(input: {
    calories?: number; protein_g?: number; carbs_g?: number;
    fat_g?: number; fiber_g?: number; water_ml?: number; notes?: string;
  }): NutritionGoal {
    const now = isoNow();
    // Deactivate existing goals
    this.db.prepare("UPDATE nutrition_goals SET active = 0").run();

    const goal: NutritionGoal = {
      id: newId(),
      calories: input.calories ?? 2000,
      protein_g: input.protein_g ?? 150,
      carbs_g: input.carbs_g ?? 250,
      fat_g: input.fat_g ?? 65,
      fiber_g: input.fiber_g ?? 30,
      water_ml: input.water_ml ?? 2500,
      active: 1,
      notes: input.notes ?? "",
      created_at: now, updated_at: now,
    };

    this.db.prepare(`
      INSERT INTO nutrition_goals (id,calories,protein_g,carbs_g,fat_g,fiber_g,water_ml,active,notes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(goal.id,goal.calories,goal.protein_g,goal.carbs_g,goal.fat_g,
           goal.fiber_g,goal.water_ml,goal.active,goal.notes,goal.created_at,goal.updated_at);

    return goal;
  }

  getActiveGoal(): NutritionGoal | undefined {
    return this.db.prepare("SELECT * FROM nutrition_goals WHERE active = 1 ORDER BY created_at DESC LIMIT 1").get() as NutritionGoal | undefined;
  }

  // ── Fasting ───────────────────────────────────────────────────────────────

  startFast(input: { protocol?: FastingProtocol; target_hours?: number; notes?: string }): NutritionFasting {
    // Auto-break any active fast
    const active = this.getActiveFast();
    if (active) {
      this.breakFast(active.id, "broken");
    }

    const fast: NutritionFasting = {
      id: newId(),
      protocol: input.protocol ?? "16:8",
      start_time: isoNow(),
      end_time: null,
      target_hours: input.target_hours ?? this.protocolToHours(input.protocol ?? "16:8"),
      actual_hours: null,
      status: "active",
      notes: input.notes ?? "",
      created_at: isoNow(),
    };

    this.db.prepare(`
      INSERT INTO nutrition_fasting (id,protocol,start_time,end_time,target_hours,actual_hours,status,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(fast.id,fast.protocol,fast.start_time,fast.end_time,fast.target_hours,
           fast.actual_hours,fast.status,fast.notes,fast.created_at);

    return fast;
  }

  breakFast(id: string, status: "completed" | "broken" = "completed"): NutritionFasting | undefined {
    const fast = this.db.prepare("SELECT * FROM nutrition_fasting WHERE id = ?").get(id) as NutritionFasting | undefined;
    if (!fast || fast.status !== "active") return fast;

    const endTime = isoNow();
    const startMs = new Date(fast.start_time).getTime();
    const endMs = new Date(endTime).getTime();
    const actualHours = Math.round((endMs - startMs) / 1000 / 60 / 60 * 10) / 10;

    this.db.prepare(`
      UPDATE nutrition_fasting SET end_time=?, actual_hours=?, status=? WHERE id=?
    `).run(endTime, actualHours, status, id);

    return { ...fast, end_time: endTime, actual_hours: actualHours, status };
  }

  getActiveFast(): NutritionFasting | undefined {
    return this.db.prepare("SELECT * FROM nutrition_fasting WHERE status = 'active' ORDER BY start_time DESC LIMIT 1").get() as NutritionFasting | undefined;
  }

  listFasts(limit = 30): NutritionFasting[] {
    return this.db.prepare("SELECT * FROM nutrition_fasting ORDER BY start_time DESC LIMIT ?").all(limit) as NutritionFasting[];
  }

  private protocolToHours(protocol: FastingProtocol): number {
    const map: Record<FastingProtocol, number> = {
      "16:8": 16, "18:6": 18, "20:4": 20, "24h": 24,
      "5:2": 20, "omad": 23, "custom": 16,
    };
    return map[protocol] ?? 16;
  }

  // ── Water ─────────────────────────────────────────────────────────────────

  logWater(amount_ml: number, notes?: string): NutritionWater {
    const now = isoNow();
    const entry: NutritionWater = {
      id: newId(), amount_ml,
      date: now.split("T")[0], time: now,
      notes: notes ?? "", created_at: now,
    };
    this.db.prepare(`
      INSERT INTO nutrition_water (id,amount_ml,date,time,notes,created_at)
      VALUES (?,?,?,?,?,?)
    `).run(entry.id,entry.amount_ml,entry.date,entry.time,entry.notes,entry.created_at);
    return entry;
  }

  getWaterToday(date?: string): { total_ml: number; goal_ml: number; pct: number; entries: NutritionWater[] } {
    const today = date ?? isoNow().split("T")[0];
    const entries = this.db.prepare(
      "SELECT * FROM nutrition_water WHERE date = ? ORDER BY time ASC"
    ).all(today) as NutritionWater[];
    const total_ml = entries.reduce((s, e) => s + e.amount_ml, 0);
    const goal = this.getActiveGoal();
    const goal_ml = goal?.water_ml ?? 2500;
    return { total_ml, goal_ml, pct: Math.round(total_ml / goal_ml * 100), entries };
  }

  // ── Body Stats ────────────────────────────────────────────────────────────

  logBodyStats(input: {
    weight_kg?: number; body_fat_pct?: number; muscle_mass_kg?: number;
    water_pct?: number; waist_cm?: number; hip_cm?: number; chest_cm?: number;
    date?: string; notes?: string;
  }): NutritionBodyStats {
    const now = isoNow();
    const bmi = input.weight_kg ? Math.round((input.weight_kg / Math.pow(1.75, 2)) * 10) / 10 : null;
    const stats: NutritionBodyStats = {
      id: newId(), ...input,
      bmi,
      date: input.date ?? now.split("T")[0],
      notes: input.notes ?? "",
      created_at: now,
      weight_kg: input.weight_kg ?? null,
      body_fat_pct: input.body_fat_pct ?? null,
      muscle_mass_kg: input.muscle_mass_kg ?? null,
      water_pct: input.water_pct ?? null,
      waist_cm: input.waist_cm ?? null,
      hip_cm: input.hip_cm ?? null,
      chest_cm: input.chest_cm ?? null,
    };

    this.db.prepare(`
      INSERT INTO nutrition_body_stats
        (id,weight_kg,body_fat_pct,muscle_mass_kg,water_pct,bmi,waist_cm,hip_cm,chest_cm,date,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(stats.id,stats.weight_kg,stats.body_fat_pct,stats.muscle_mass_kg,
           stats.water_pct,stats.bmi,stats.waist_cm,stats.hip_cm,stats.chest_cm,
           stats.date,stats.notes,stats.created_at);

    return stats;
  }

  listBodyStats(limit = 30): NutritionBodyStats[] {
    return this.db.prepare(
      "SELECT * FROM nutrition_body_stats ORDER BY date DESC LIMIT ?"
    ).all(limit) as NutritionBodyStats[];
  }

  // ── Daily Summary ─────────────────────────────────────────────────────────

  getDailySummary(date?: string): DailyNutritionSummary {
    const today = date ?? isoNow().split("T")[0];
    const entries = this.listEntries(today);
    const totals = {
      calories: 0, protein_g: 0, carbs_g: 0,
      fat_g: 0, fiber_g: 0, water_ml: 0,
    };
    for (const e of entries) {
      totals.calories += e.calories;
      totals.protein_g += e.protein_g;
      totals.carbs_g += e.carbs_g;
      totals.fat_g += e.fat_g;
      totals.fiber_g += e.fiber_g;
    }

    const water = this.getWaterToday(today);
    totals.water_ml = water.total_ml;

    const goal = this.getActiveGoal();
    const goal_progress = goal ? {
      calories_pct: Math.round(totals.calories / goal.calories * 100),
      protein_pct: Math.round(totals.protein_g / goal.protein_g * 100),
      carbs_pct: Math.round(totals.carbs_g / goal.carbs_g * 100),
      fat_pct: Math.round(totals.fat_g / goal.fat_g * 100),
      water_pct: Math.round(totals.water_ml / goal.water_ml * 100),
    } : undefined;

    const fasting = this.getActiveFast() ?? null;

    return { date: today, entries, totals, goal, goal_progress, fasting };
  }

  getWeeklyTrend(days = 7): Array<{ date: string; calories: number; protein_g: number; weight_kg: number | null }> {
    const result: Array<{ date: string; calories: number; protein_g: number; weight_kg: number | null }> = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      const entries = this.listEntries(dateStr);
      const calories = entries.reduce((s, e) => s + e.calories, 0);
      const protein_g = entries.reduce((s, e) => s + e.protein_g, 0);
      const bodyStats = this.db.prepare(
        "SELECT weight_kg FROM nutrition_body_stats WHERE date = ? ORDER BY created_at DESC LIMIT 1"
      ).get(dateStr) as { weight_kg: number | null } | undefined;
      result.push({ date: dateStr, calories, protein_g, weight_kg: bodyStats?.weight_kg ?? null });
    }
    return result;
  }
}
