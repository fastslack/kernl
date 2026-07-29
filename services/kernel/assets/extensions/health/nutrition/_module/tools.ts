import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { NutritionService } from "./service.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";

export function nutritionTools(service: NutritionService): ToolDefinition[] {
  return [
    // ── Food Database ──────────────────────────────────────────────────────
    {
      name: "kernel_nutrition_add_food",
      description: "Add a food to the local database with nutritional info per 100g. Use this to create reusable food entries.",
      inputSchema: z.object({
        name: z.string().describe("Food name (e.g. 'Chicken Breast', 'Brown Rice')"),
        brand: z.string().optional().describe("Brand name if applicable"),
        barcode: z.string().optional().describe("EAN/UPC barcode for scanning"),
        calories_per_100g: z.number().optional().describe("Calories per 100g"),
        protein_per_100g: z.number().optional().describe("Protein grams per 100g"),
        carbs_per_100g: z.number().optional().describe("Carbohydrate grams per 100g"),
        fat_per_100g: z.number().optional().describe("Fat grams per 100g"),
        fiber_per_100g: z.number().optional().describe("Fiber grams per 100g"),
        sugar_per_100g: z.number().optional().describe("Sugar grams per 100g"),
        sodium_per_100g: z.number().optional().describe("Sodium mg per 100g"),
        serving_size_g: z.number().optional().describe("Typical serving size in grams (default: 100)"),
        serving_unit: z.string().optional().describe("Serving unit (g, ml, piece, etc)"),
        source: z.enum(["custom", "openfoodfacts", "usda"]).optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const food = service.addFood(args as any);
        return textResult(
          `Food added: **${food.name}**${food.brand ? ` (${food.brand})` : ""}\n` +
          `  Calories: ${food.calories_per_100g} kcal/100g\n` +
          `  Protein: ${food.protein_per_100g}g | Carbs: ${food.carbs_per_100g}g | Fat: ${food.fat_per_100g}g\n` +
          `  ID: ${food.id}`
        );
      },
    },
    {
      name: "kernel_nutrition_search_foods",
      description: "Search the food database by name or brand for logging meals.",
      inputSchema: z.object({
        query: z.string().describe("Search term (food name or brand)"),
        limit: z.number().optional().describe("Max results (default: 20)"),
      }),
      handler: async (args) => {
        const { query, limit } = args as { query: string; limit?: number };
        const foods = service.searchFoods(query, limit);
        if (foods.length === 0) return textResult("No foods found. Try adding it with kernel_nutrition_add_food.");
        const lines = foods.map(f =>
          `**${f.name}**${f.brand ? ` — ${f.brand}` : ""} | ${f.calories_per_100g} kcal | P:${f.protein_per_100g}g C:${f.carbs_per_100g}g F:${f.fat_per_100g}g | ID: ${f.id}`
        );
        return textResult(`${foods.length} food(s) found:\n\n${lines.join("\n")}`);
      },
    },

    // ── Log Entries ────────────────────────────────────────────────────────
    {
      name: "kernel_nutrition_log",
      description: "Log a food entry for a meal. Can reference a food_id from the database or specify macros directly. Auto-calculates macros from food database if food_id is provided.",
      inputSchema: z.object({
        food_id: z.string().optional().describe("Food ID from database (auto-calculates macros)"),
        food_name: z.string().optional().describe("Food name (required if no food_id)"),
        meal_type: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]).optional().describe("Meal type (default: other)"),
        quantity_g: z.number().optional().describe("Quantity in grams (default: 100)"),
        calories: z.number().optional().describe("Override calories (if not using food_id)"),
        protein_g: z.number().optional().describe("Override protein grams"),
        carbs_g: z.number().optional().describe("Override carbs grams"),
        fat_g: z.number().optional().describe("Override fat grams"),
        fiber_g: z.number().optional().describe("Fiber grams"),
        date: z.string().optional().describe("Date (YYYY-MM-DD, default: today)"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const entry = service.logEntry(args as any);
        return textResult(
          `Logged: **${entry.food_name}** (${entry.meal_type}) — ${entry.quantity_g}g\n` +
          `  Calories: ${Math.round(entry.calories)} kcal | Protein: ${Math.round(entry.protein_g)}g | Carbs: ${Math.round(entry.carbs_g)}g | Fat: ${Math.round(entry.fat_g)}g`
        );
      },
    },
    {
      name: "kernel_nutrition_daily",
      description: "Get full daily nutrition summary: all meals logged, macros totals vs goals, water intake, and active fasting window.",
      inputSchema: z.object({
        date: z.string().optional().describe("Date (YYYY-MM-DD, default: today)"),
      }),
      handler: async (args) => {
        const { date } = args as { date?: string };
        const s = service.getDailySummary(date);
        const g = s.goal;
        const gp = s.goal_progress;

        let out = `## Nutrition Summary — ${s.date}\n\n`;
        out += `**Macros:** ${Math.round(s.totals.calories)} kcal | P: ${Math.round(s.totals.protein_g)}g | C: ${Math.round(s.totals.carbs_g)}g | F: ${Math.round(s.totals.fat_g)}g | Fiber: ${Math.round(s.totals.fiber_g)}g\n`;
        out += `**Water:** ${s.totals.water_ml}ml`;
        if (g) out += ` / ${g.water_ml}ml (${gp!.water_pct}%)`;
        out += "\n";

        if (gp) {
          out += `**Goal progress:** ${gp.calories_pct}% cals | ${gp.protein_pct}% protein | ${gp.carbs_pct}% carbs | ${gp.fat_pct}% fat\n`;
        }

        if (s.fasting) {
          const elapsed = Math.round((Date.now() - new Date(s.fasting.start_time).getTime()) / 3600000 * 10) / 10;
          out += `\n**Fasting:** ${s.fasting.protocol} — ${elapsed}h elapsed / ${s.fasting.target_hours}h target (${Math.round(elapsed / s.fasting.target_hours * 100)}%)\n`;
        }

        if (s.entries.length > 0) {
          out += `\n**Meals (${s.entries.length} entries):**\n`;
          const byMeal: Record<string, typeof s.entries> = {};
          for (const e of s.entries) {
            if (!byMeal[e.meal_type]) byMeal[e.meal_type] = [];
            byMeal[e.meal_type].push(e);
          }
          for (const [meal, items] of Object.entries(byMeal)) {
            out += `\n*${meal}:*\n`;
            for (const item of items) {
              out += `  - ${item.food_name} ${item.quantity_g}g → ${Math.round(item.calories)} kcal\n`;
            }
          }
        } else {
          out += "\nNo food logged yet today.";
        }

        return textResult(out);
      },
    },
    {
      name: "kernel_nutrition_weekly_trend",
      description: "Get 7-day calorie, protein, and weight trend.",
      inputSchema: z.object({
        days: z.number().optional().describe("Number of days (default: 7)"),
      }),
      handler: async (args) => {
        const { days } = args as { days?: number };
        const trend = service.getWeeklyTrend(days);
        const lines = trend.map(d =>
          `${d.date}: ${Math.round(d.calories)} kcal | P: ${Math.round(d.protein_g)}g${d.weight_kg ? ` | ${d.weight_kg}kg` : ""}`
        );
        return textResult(`**${trend.length}-Day Nutrition Trend:**\n\n${lines.join("\n")}`);
      },
    },

    // ── Goals ──────────────────────────────────────────────────────────────
    {
      name: "kernel_nutrition_set_goal",
      description: "Set daily nutrition goals (calories, macros, water). Replaces the current active goal.",
      inputSchema: z.object({
        calories: z.number().optional().describe("Daily calorie goal (default: 2000)"),
        protein_g: z.number().optional().describe("Daily protein goal in grams (default: 150)"),
        carbs_g: z.number().optional().describe("Daily carbs goal in grams (default: 250)"),
        fat_g: z.number().optional().describe("Daily fat goal in grams (default: 65)"),
        fiber_g: z.number().optional().describe("Daily fiber goal in grams (default: 30)"),
        water_ml: z.number().optional().describe("Daily water goal in ml (default: 2500)"),
        notes: z.string().optional().describe("Notes about this goal (e.g. 'cutting phase', 'maintenance')"),
      }),
      handler: async (args) => {
        const goal = service.setGoal(args as any);
        return textResult(
          `Nutrition goal set:\n  Calories: ${goal.calories} kcal\n  Protein: ${goal.protein_g}g | Carbs: ${goal.carbs_g}g | Fat: ${goal.fat_g}g\n  Fiber: ${goal.fiber_g}g | Water: ${goal.water_ml}ml`
        );
      },
    },

    // ── Fasting ────────────────────────────────────────────────────────────
    {
      name: "kernel_nutrition_start_fast",
      description: "Start an intermittent fasting window. Supports 16:8, 18:6, 20:4, 24h, 5:2, OMAD protocols.",
      inputSchema: z.object({
        protocol: z.enum(["16:8", "18:6", "20:4", "24h", "5:2", "omad", "custom"]).optional().describe("Fasting protocol (default: 16:8)"),
        target_hours: z.number().optional().describe("Custom target hours (for 'custom' protocol)"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const fast = service.startFast(args as any);
        return textResult(
          `Fasting started!\n  Protocol: ${fast.protocol}\n  Started: ${fast.start_time}\n  Target: ${fast.target_hours}h\n  ID: ${fast.id}`
        );
      },
    },
    {
      name: "kernel_nutrition_break_fast",
      description: "End the current fasting window (complete or mark as broken).",
      inputSchema: z.object({
        id: z.string().optional().describe("Fast ID (omit to break the currently active fast)"),
        status: z.enum(["completed", "broken"]).optional().describe("How the fast ended (default: completed)"),
      }),
      handler: async (args) => {
        const { id, status } = args as { id?: string; status?: "completed" | "broken" };
        let fastId = id;
        if (!fastId) {
          const active = service.getActiveFast();
          if (!active) return textResult("No active fast to break.");
          fastId = active.id;
        }
        const fast = service.breakFast(fastId, status);
        if (!fast) return errorResult(`Fast not found: ${fastId}`);
        return textResult(
          `Fast ended (${fast.status})!\n  Protocol: ${fast.protocol}\n  Duration: ${fast.actual_hours}h / ${fast.target_hours}h target\n  Started: ${fast.start_time}\n  Ended: ${fast.end_time}`
        );
      },
    },
    {
      name: "kernel_nutrition_fasting_status",
      description: "Check active fasting window status and recent fasting history.",
      inputSchema: z.object({
        history: z.number().optional().describe("Number of recent fasts to show (default: 7)"),
      }),
      handler: async (args) => {
        const { history = 7 } = args as { history?: number };
        const active = service.getActiveFast();
        let out = "";
        if (active) {
          const elapsed = Math.round((Date.now() - new Date(active.start_time).getTime()) / 3600000 * 10) / 10;
          const pct = Math.round(elapsed / active.target_hours * 100);
          out += `**Active Fast (${active.protocol}):**\n  Elapsed: ${elapsed}h / ${active.target_hours}h (${pct}%)\n  Started: ${active.start_time}\n\n`;
        } else {
          out += "No active fast.\n\n";
        }
        const fasts = service.listFasts(history);
        const completed = fasts.filter(f => f.status === "completed");
        const success = completed.length;
        const avgHours = success > 0 ? Math.round(completed.reduce((s, f) => s + (f.actual_hours ?? 0), 0) / success * 10) / 10 : 0;
        out += `**Recent history (${fasts.length} fasts):** ${success} completed, avg ${avgHours}h`;
        return textResult(out);
      },
    },

    // ── Water ──────────────────────────────────────────────────────────────
    {
      name: "kernel_nutrition_log_water",
      description: "Log water intake in ml.",
      inputSchema: z.object({
        amount_ml: z.number().describe("Amount in ml (e.g. 250 for a glass, 500 for a bottle)"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const { amount_ml, notes } = args as { amount_ml: number; notes?: string };
        service.logWater(amount_ml, notes);
        const status = service.getWaterToday();
        return textResult(
          `Water logged: ${amount_ml}ml\nToday total: ${status.total_ml}ml / ${status.goal_ml}ml (${status.pct}%)`
        );
      },
    },

    // ── Body Stats ─────────────────────────────────────────────────────────
    {
      name: "kernel_nutrition_log_body_stats",
      description: "Log body measurements (weight, body fat %, muscle mass, measurements). Auto-calculates BMI from weight.",
      inputSchema: z.object({
        weight_kg: z.number().optional().describe("Body weight in kg"),
        body_fat_pct: z.number().optional().describe("Body fat percentage"),
        muscle_mass_kg: z.number().optional().describe("Muscle mass in kg"),
        water_pct: z.number().optional().describe("Body water percentage"),
        waist_cm: z.number().optional().describe("Waist circumference in cm"),
        hip_cm: z.number().optional().describe("Hip circumference in cm"),
        chest_cm: z.number().optional().describe("Chest circumference in cm"),
        date: z.string().optional().describe("Date (YYYY-MM-DD, default: today)"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const stats = service.logBodyStats(args as any);
        const lines: string[] = [];
        if (stats.weight_kg != null) lines.push(`Weight: ${stats.weight_kg}kg${stats.bmi ? ` (BMI: ${stats.bmi})` : ""}`);
        if (stats.body_fat_pct != null) lines.push(`Body fat: ${stats.body_fat_pct}%`);
        if (stats.muscle_mass_kg != null) lines.push(`Muscle mass: ${stats.muscle_mass_kg}kg`);
        if (stats.waist_cm != null) lines.push(`Waist: ${stats.waist_cm}cm`);
        return textResult(`Body stats logged (${stats.date}):\n  ${lines.join("\n  ")}`);
      },
    },
    {
      name: "kernel_nutrition_body_trend",
      description: "Get body composition trend (weight, body fat) over recent weeks.",
      inputSchema: z.object({
        limit: z.number().optional().describe("Number of entries (default: 30)"),
      }),
      handler: async (args) => {
        const { limit } = args as { limit?: number };
        const stats = service.listBodyStats(limit);
        if (stats.length === 0) return textResult("No body stats logged yet. Use kernel_nutrition_log_body_stats.");
        const lines = stats.map(s => {
          const parts = [`${s.date}`];
          if (s.weight_kg != null) parts.push(`${s.weight_kg}kg`);
          if (s.body_fat_pct != null) parts.push(`${s.body_fat_pct}% fat`);
          if (s.muscle_mass_kg != null) parts.push(`${s.muscle_mass_kg}kg muscle`);
          if (s.bmi != null) parts.push(`BMI ${s.bmi}`);
          return parts.join(" | ");
        });
        return textResult(`**Body Composition (${stats.length} entries):**\n\n${lines.join("\n")}`);
      },
    },
  ];
}
