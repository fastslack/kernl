/**
 * Nutrition RPC Actions — meal logging, macros, water, fasting, body stats via mtwRequest.
 *
 * RPC-only (the wellness page falls back to POST /api/rpc/<action>, the same
 * handlers). Each one goes through NutritionService, so the RPC log gets what
 * the MCP tools get: macros scaled from a linked food, a new fast closing the
 * one still open, a BMI worked out from the weight.
 */

import { HttpError, pickArgs, rpcActionsFrom, type RpcAction } from "@kernl/extension-sdk";
import type { NutritionService } from "./service.js";
import type { FastingProtocol, MealType } from "./types.js";

const ENTRY_NUMBERS = {
  quantity_g: "number", calories: "number", protein_g: "number", carbs_g: "number",
  fat_g: "number", fiber_g: "number", sugar_g: "number", sodium_mg: "number",
} as const;

const BODY_STATS = {
  weight_kg: "number", body_fat_pct: "number", muscle_mass_kg: "number", water_pct: "number",
  bmi: "number", waist_cm: "number", hip_cm: "number", chest_cm: "number",
  date: "string", notes: "string",
} as const;

export function nutritionRpcActions(service: NutritionService): RpcAction[] {
  const today = () => new Date().toISOString().split("T")[0];
  const dateArg = (input: Record<string, unknown>) => pickArgs(input, { date: "string" }).date ?? today();

  return rpcActionsFrom({
    "nutrition.entries.list": (input) => {
      const mealType = pickArgs(input, { meal_type: "string" }).meal_type;
      return { entries: service.listEntries(dateArg(input), (mealType || undefined) as MealType | undefined) };
    },

    "nutrition.entries.log": (input) => {
      const args = pickArgs(input, { ...ENTRY_NUMBERS, food_id: "string", food_name: "string", meal_type: "string", date: "string", notes: "string" });
      const foodName = args.food_name?.trim() ?? "";
      // A linked food names the entry itself (and scales its macros).
      if (!foodName && !args.food_id) throw new HttpError(400, "food_name required");
      const entry = service.logEntry({
        ...args,
        food_name: foodName || undefined,
        meal_type: args.meal_type as MealType | undefined,
      });
      return { ok: true, id: entry.id };
    },

    "nutrition.entries.delete": (input) => {
      const id = pickArgs(input, { id: "string" }).id ?? "";
      if (!id) throw new HttpError(400, "Missing id");
      service.deleteEntry(id);
      return { ok: true };
    },

    "nutrition.dailySummary": (input) => {
      const summary = service.getDailySummary(dateArg(input));
      const { water_ml, ...totals } = summary.totals;
      return {
        date: summary.date,
        totals: { entries: summary.entries.length, ...totals },
        goal: summary.goal ?? null,
        water: { total_ml: water_ml },
      };
    },

    "nutrition.water.log": (input) => {
      const args = pickArgs(input, { amount_ml: "number", date: "string", notes: "string" });
      if (!args.amount_ml || args.amount_ml <= 0) throw new HttpError(400, "amount_ml required");
      const entry = service.logWater(args.amount_ml, args.notes, args.date);
      return { ok: true, id: entry.id };
    },

    "nutrition.water.today": (input) => service.getWaterToday(dateArg(input)),

    "nutrition.fasting.start": (input) => {
      const args = pickArgs(input, { protocol: "string", target_hours: "number", notes: "string" });
      const fast = service.startFast({ ...args, protocol: args.protocol as FastingProtocol | undefined });
      return { ok: true, id: fast.id };
    },

    "nutrition.fasting.stop": (input) => {
      const args = pickArgs(input, { id: "string", status: "string" });
      const status = args.status === "broken" ? "broken" : "completed";
      // Find active fast if no id
      const fastId = args.id || service.getActiveFast()?.id;
      if (!fastId) throw new HttpError(404, "No active fast");
      const fast = service.breakFast(fastId, status);
      if (!fast) throw new HttpError(404, "Fast not found");
      return { ok: true, actualHours: fast.actual_hours };
    },

    "nutrition.fasting.active": () => ({ fast: service.getActiveFast() ?? null }),

    "nutrition.bodyStats.log": (input) => {
      const stats = service.logBodyStats(pickArgs(input, BODY_STATS));
      return { ok: true, id: stats.id };
    },

    "nutrition.bodyStats.list": (input) => ({
      stats: service.listBodyStats(Math.min(100, pickArgs(input, { limit: "number" }).limit ?? 30)),
    }),

    "nutrition.foods.search": (input) => {
      const args = pickArgs(input, { q: "string", limit: "number" });
      const q = args.q?.trim() ?? "";
      if (!q) throw new HttpError(400, "Query required");
      return { foods: service.searchFoods(q, Math.min(50, args.limit ?? 20)) };
    },
  });
}
