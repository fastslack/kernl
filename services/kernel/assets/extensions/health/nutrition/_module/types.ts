export type FoodSource = "custom" | "openfoodfacts" | "usda";
export type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "other";
export type FastingProtocol = "16:8" | "18:6" | "20:4" | "24h" | "5:2" | "omad" | "custom";
export type FastingStatus = "active" | "completed" | "broken";

export interface NutritionFood {
  id: string;
  name: string;
  brand: string;
  barcode: string;
  calories_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  fiber_per_100g: number;
  sugar_per_100g: number;
  sodium_per_100g: number;
  serving_size_g: number;
  serving_unit: string;
  source: FoodSource;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface NutritionEntry {
  id: string;
  food_id: string | null;
  food_name: string;
  meal_type: MealType;
  quantity_g: number;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
  sodium_mg: number;
  date: string;
  notes: string;
  created_at: string;
}

export interface NutritionGoal {
  id: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  water_ml: number;
  active: number;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface NutritionFasting {
  id: string;
  protocol: FastingProtocol;
  start_time: string;
  end_time: string | null;
  target_hours: number;
  actual_hours: number | null;
  status: FastingStatus;
  notes: string;
  created_at: string;
}

export interface NutritionWater {
  id: string;
  amount_ml: number;
  date: string;
  time: string;
  notes: string;
  created_at: string;
}

export interface NutritionBodyStats {
  id: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  muscle_mass_kg: number | null;
  water_pct: number | null;
  bmi: number | null;
  waist_cm: number | null;
  hip_cm: number | null;
  chest_cm: number | null;
  date: string;
  notes: string;
  created_at: string;
}

export interface DailyNutritionSummary {
  date: string;
  entries: NutritionEntry[];
  totals: {
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g: number;
    water_ml: number;
  };
  goal?: NutritionGoal;
  goal_progress?: {
    calories_pct: number;
    protein_pct: number;
    carbs_pct: number;
    fat_pct: number;
    water_pct: number;
  };
  fasting?: NutritionFasting | null;
}
