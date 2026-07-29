export type ExerciseCategory = "strength" | "cardio" | "flexibility" | "balance" | "sport" | "custom";
export type Equipment = "none" | "barbell" | "dumbbell" | "kettlebell" | "machine" | "cable" | "bodyweight" | "bands" | "cardio_machine" | "custom";
export type ProgramGoal = "strength" | "hypertrophy" | "endurance" | "weight_loss" | "sport" | "general" | "rehab";
export type ProgramDifficulty = "beginner" | "intermediate" | "advanced" | "elite";
export type ProgramStatus = "active" | "completed" | "paused" | "archived";
export type PrType = "weight" | "reps" | "time" | "distance" | "volume";

export interface TrainingExercise {
  id: string;
  name: string;
  category: ExerciseCategory;
  muscle_groups: string; // JSON array
  equipment: Equipment;
  instructions: string;
  notes: string;
  created_at: string;
}

export interface TrainingProgram {
  id: string;
  name: string;
  description: string;
  goal: ProgramGoal;
  difficulty: ProgramDifficulty;
  days_per_week: number;
  duration_weeks: number;
  status: ProgramStatus;
  start_date: string | null;
  end_date: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface TrainingSessionTemplate {
  id: string;
  program_id: string;
  name: string;
  day_of_week: number | null;
  week_number: number | null;
  order_index: number;
  notes: string;
  created_at: string;
}

export interface TrainingTemplateExercise {
  id: string;
  session_id: string;
  exercise_id: string | null;
  exercise_name: string;
  sets: number;
  reps: string;
  weight_kg: number | null;
  duration_secs: number | null;
  rest_secs: number;
  rpe: number | null;
  notes: string;
  order_index: number;
}

export interface TrainingWorkout {
  id: string;
  program_id: string | null;
  template_id: string | null;
  name: string;
  sport: string;
  date: string;
  start_time: string;
  end_time: string | null;
  duration_minutes: number | null;
  calories_burned: number | null;
  notes: string;
  mood_before: number | null;
  mood_after: number | null;
  fatigue_level: number | null;
  created_at: string;
}

export interface TrainingSet {
  id: string;
  workout_id: string;
  exercise_id: string | null;
  exercise_name: string;
  set_number: number;
  reps: number | null;
  weight_kg: number | null;
  duration_secs: number | null;
  distance_m: number | null;
  rpe: number | null;
  is_warmup: number;
  is_pr: number;
  notes: string;
  created_at: string;
}

export interface TrainingPr {
  id: string;
  exercise_name: string;
  pr_type: PrType;
  value: number;
  unit: string;
  workout_id: string | null;
  date: string;
  notes: string;
  created_at: string;
}

export interface TrainingCardio {
  id: string;
  workout_id: string | null;
  sport: string;
  date: string;
  duration_minutes: number;
  distance_m: number | null;
  avg_pace_min_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  calories: number | null;
  elevation_m: number | null;
  avg_power_w: number | null;
  avg_cadence: number | null;
  notes: string;
  created_at: string;
}
