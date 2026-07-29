import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { tableExists, safeAll, safeGet, today, daysFromNow } from "../../../../../src/core/db/query-helpers.js";

export interface DashboardNutrition {
  kpis: { logsToday: number; caloriestoday: number; proteinToday: number; waterTodayMl: number; waterGoalMl: number; activeFast: boolean };
  todayMacros: { calories: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
  goal: { calories: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number; water_ml: number } | null;
  todayMeals: Array<{ meal_type: string; food_name: string; quantity_g: number; calories: number }>;
  weeklyCalories: Array<{ date: string; calories: number; protein_g: number }>;
  activeFast: { protocol: string; start_time: string; target_hours: number; elapsed_hours: number } | null;
  recentBodyStats: Array<{ date: string; weight_kg: number | null; body_fat_pct: number | null; bmi: number | null }>;
}

export function queryNutrition(db: SqliteDb): DashboardNutrition | null {
  if (!tableExists(db, "nutrition_entries")) return null;

  const todayStr = today();
  const sevenDaysAgo = daysFromNow(-7);

  // Today's entries
  const todayEntries = db
    .prepare(
      `SELECT meal_type, food_name, quantity_g, calories FROM nutrition_entries
       WHERE date = ? ORDER BY created_at`,
    )
    .all(todayStr) as DashboardNutrition["todayMeals"];

  // Today's macro totals
  const macroRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(calories), 0) as calories,
         COALESCE(SUM(protein_g), 0) as protein_g,
         COALESCE(SUM(carbs_g), 0) as carbs_g,
         COALESCE(SUM(fat_g), 0) as fat_g,
         COALESCE(SUM(fiber_g), 0) as fiber_g
       FROM nutrition_entries WHERE date = ?`,
    )
    .get(todayStr) as { calories: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };

  const logsToday = todayEntries.length;

  // Active goal
  const goal = db
    .prepare(
      `SELECT calories, protein_g, carbs_g, fat_g, fiber_g, water_ml FROM nutrition_goals WHERE active = 1 LIMIT 1`,
    )
    .get() as DashboardNutrition["goal"] ?? null;

  // Water today
  const waterTodayMl = safeGet(db,
    `SELECT COALESCE(SUM(amount_ml), 0) as total FROM nutrition_water WHERE date = ?`,
    [todayStr],
    { total: 0 },
  ).total;

  // Active fast
  let activeFast: DashboardNutrition["activeFast"] = null;
  const fastRow = safeGet(db,
    `SELECT protocol, start_time, target_hours FROM nutrition_fasting WHERE status = 'active' LIMIT 1`,
    [],
    undefined as { protocol: string; start_time: string; target_hours: number } | undefined,
  );
  if (fastRow) {
    const elapsedMs = Date.now() - new Date(fastRow.start_time).getTime();
    const elapsedHours = Math.round(elapsedMs / 3_600_000 * 10) / 10;
    activeFast = { ...fastRow, elapsed_hours: elapsedHours };
  }

  // Weekly calories trend
  const weeklyCalories = db
    .prepare(
      `SELECT date,
              COALESCE(SUM(calories), 0) as calories,
              COALESCE(SUM(protein_g), 0) as protein_g
       FROM nutrition_entries WHERE date >= ?
       GROUP BY date ORDER BY date`,
    )
    .all(sevenDaysAgo) as DashboardNutrition["weeklyCalories"];

  // Recent body stats
  const recentBodyStats = safeAll<DashboardNutrition["recentBodyStats"][number]>(db,
    `SELECT date, weight_kg, body_fat_pct, bmi FROM nutrition_body_stats
     ORDER BY date DESC LIMIT 7`,
  );

  return {
    kpis: {
      logsToday,
      caloriestoday: Math.round(macroRow.calories),
      proteinToday: Math.round(macroRow.protein_g),
      waterTodayMl,
      waterGoalMl: goal?.water_ml ?? 2000,
      activeFast: !!activeFast,
    },
    todayMacros: {
      calories: Math.round(macroRow.calories),
      protein_g: Math.round(macroRow.protein_g * 10) / 10,
      carbs_g: Math.round(macroRow.carbs_g * 10) / 10,
      fat_g: Math.round(macroRow.fat_g * 10) / 10,
      fiber_g: Math.round(macroRow.fiber_g * 10) / 10,
    },
    goal,
    todayMeals: todayEntries,
    weeklyCalories,
    activeFast,
    recentBodyStats,
  };
}
