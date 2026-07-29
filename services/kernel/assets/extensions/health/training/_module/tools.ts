import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { TrainingService } from "./service.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";

const CATEGORIES = ["strength", "cardio", "flexibility", "balance", "sport", "custom"] as const;
const EQUIPMENT = ["none", "barbell", "dumbbell", "kettlebell", "machine", "cable", "bodyweight", "bands", "cardio_machine", "custom"] as const;
const GOALS = ["strength", "hypertrophy", "endurance", "weight_loss", "sport", "general", "rehab"] as const;
const DIFFICULTIES = ["beginner", "intermediate", "advanced", "elite"] as const;

export function trainingTools(service: TrainingService): ToolDefinition[] {
  return [
    // ── Exercise Library ──────────────────────────────────────────────────
    {
      name: "kernel_training_add_exercise",
      description: "Add a custom exercise to the library. Default exercises (Squat, Bench, Deadlift, etc) are auto-seeded.",
      inputSchema: z.object({
        name: z.string().describe("Exercise name"),
        category: z.enum(CATEGORIES).optional(),
        muscle_groups: z.array(z.string()).optional().describe("Muscle groups targeted"),
        equipment: z.enum(EQUIPMENT).optional(),
        instructions: z.string().optional().describe("How to perform the exercise"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const ex = service.addExercise(args as any);
        return textResult(`Exercise added: **${ex.name}** (${ex.category}, ${ex.equipment})\n  Muscles: ${JSON.parse(ex.muscle_groups).join(", ") || "n/a"}\n  ID: ${ex.id}`);
      },
    },
    {
      name: "kernel_training_search_exercises",
      description: "Search the exercise library by name, category, or equipment.",
      inputSchema: z.object({
        query: z.string().optional().describe("Search by name"),
        category: z.enum(CATEGORIES).optional(),
        equipment: z.enum(EQUIPMENT).optional(),
      }),
      handler: async (args) => {
        const { query, category, equipment } = args as any;
        const exs = service.searchExercises(query, category, equipment);
        if (exs.length === 0) return textResult("No exercises found.");
        const lines = exs.map(e =>
          `**${e.name}** — ${e.category} | ${e.equipment} | muscles: ${JSON.parse(e.muscle_groups).join(", ") || "n/a"} | ID: ${e.id}`
        );
        return textResult(`${exs.length} exercise(s):\n\n${lines.join("\n")}`);
      },
    },

    // ── Programs ──────────────────────────────────────────────────────────
    {
      name: "kernel_training_create_program",
      description: "Create a structured training program (e.g. 5x5 Stronglifts, PPL, 16-week marathon plan). Defines the overall goal, duration, and frequency.",
      inputSchema: z.object({
        name: z.string().describe("Program name (e.g. '5x5 Strength', 'Marathon 16wk', 'PPL Hypertrophy')"),
        description: z.string().optional(),
        goal: z.enum(GOALS).optional().describe("Training goal (default: general)"),
        difficulty: z.enum(DIFFICULTIES).optional().describe("Difficulty level (default: intermediate)"),
        days_per_week: z.number().optional().describe("Workouts per week (default: 3)"),
        duration_weeks: z.number().optional().describe("Program duration in weeks (default: 8)"),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const prog = service.createProgram(args as any);
        return textResult(
          `Program created: **${prog.name}**\n  Goal: ${prog.goal} | Difficulty: ${prog.difficulty}\n  ${prog.days_per_week} days/week × ${prog.duration_weeks} weeks\n  ID: ${prog.id}`
        );
      },
    },
    {
      name: "kernel_training_list_programs",
      description: "List training programs with their status.",
      inputSchema: z.object({
        status: z.enum(["active", "completed", "paused", "archived"]).optional(),
      }),
      handler: async (args) => {
        const { status } = args as { status?: string };
        const programs = service.listPrograms(status);
        if (programs.length === 0) return textResult("No programs found. Create one with kernel_training_create_program.");
        const lines = programs.map(p =>
          `[${p.status.toUpperCase()}] **${p.name}** — ${p.goal} | ${p.difficulty} | ${p.days_per_week}d/wk × ${p.duration_weeks}wks\n  ID: ${p.id}`
        );
        return textResult(`${programs.length} program(s):\n\n${lines.join("\n\n")}`);
      },
    },
    {
      name: "kernel_training_add_session_template",
      description: "Add a workout session template to a program (e.g. 'Day A - Push', 'Day B - Pull', 'Long Run').",
      inputSchema: z.object({
        program_id: z.string().describe("Program ID"),
        name: z.string().describe("Session name (e.g. 'Day A - Push', 'Upper Body')"),
        day_of_week: z.number().optional().describe("Day of week (1=Mon, 7=Sun)"),
        week_number: z.number().optional().describe("Week number within program"),
        order_index: z.number().optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const session = service.addSessionTemplate(args as any);
        return textResult(`Session template added: **${session.name}** to program\n  ID: ${session.id}`);
      },
    },
    {
      name: "kernel_training_add_template_exercise",
      description: "Add an exercise to a session template with sets, reps, and weight prescription.",
      inputSchema: z.object({
        session_id: z.string().describe("Session template ID"),
        exercise_name: z.string().describe("Exercise name"),
        exercise_id: z.string().optional().describe("Exercise ID from library (optional)"),
        sets: z.number().optional().describe("Number of sets (default: 3)"),
        reps: z.string().optional().describe("Reps prescription (e.g. '8-12', '5', 'AMRAP', '60sec')"),
        weight_kg: z.number().optional().describe("Prescribed weight in kg"),
        duration_secs: z.number().optional().describe("Duration in seconds (for timed exercises)"),
        rest_secs: z.number().optional().describe("Rest between sets in seconds (default: 60)"),
        rpe: z.number().optional().describe("Target RPE 1-10"),
        order_index: z.number().optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const ex = service.addTemplateExercise(args as any);
        return textResult(`Added to session: **${ex.exercise_name}** — ${ex.sets}×${ex.reps}${ex.weight_kg ? ` @${ex.weight_kg}kg` : ""}`);
      },
    },

    // ── Workout Logging ───────────────────────────────────────────────────
    {
      name: "kernel_training_start_workout",
      description: "Start a workout session. Returns a workout_id used to log sets.",
      inputSchema: z.object({
        name: z.string().describe("Workout name (e.g. 'Push Day A', 'Morning Run', 'Leg Day')"),
        sport: z.string().optional().describe("Sport/type (e.g. 'strength', 'running', 'cycling', 'yoga')"),
        program_id: z.string().optional().describe("Link to program"),
        template_id: z.string().optional().describe("Link to session template"),
        mood_before: z.number().optional().describe("Mood before 1-10"),
        fatigue_level: z.number().optional().describe("Fatigue level 1-10"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const w = service.startWorkout(args as any);
        return textResult(
          `Workout started: **${w.name}**\n  Started: ${w.start_time}\n  ID: ${w.id}\n\nNow use kernel_training_log_set to record each set, and kernel_training_finish_workout when done.`
        );
      },
    },
    {
      name: "kernel_training_log_set",
      description: "Log a set within an active workout. Auto-detects PRs (new volume record).",
      inputSchema: z.object({
        workout_id: z.string().describe("Workout ID"),
        exercise_name: z.string().describe("Exercise name"),
        exercise_id: z.string().optional(),
        set_number: z.number().optional().describe("Set number (auto-increments per exercise if not specified)"),
        reps: z.number().optional().describe("Reps completed"),
        weight_kg: z.number().optional().describe("Weight in kg"),
        duration_secs: z.number().optional().describe("Duration in seconds (for timed)"),
        distance_m: z.number().optional().describe("Distance in meters"),
        rpe: z.number().optional().describe("RPE 1-10 (perceived exertion)"),
        is_warmup: z.boolean().optional().describe("Mark as warmup set (won't count for PRs)"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const set = service.logSet(args as any);
        let out = `Set ${set.set_number} logged: **${set.exercise_name}**`;
        if (set.reps && set.weight_kg) out += ` — ${set.reps}×${set.weight_kg}kg`;
        else if (set.reps) out += ` — ${set.reps} reps`;
        else if (set.duration_secs) out += ` — ${set.duration_secs}s`;
        if (set.rpe) out += ` @RPE${set.rpe}`;
        if (set.is_pr) out += " 🏆 **NEW PR!**";
        return textResult(out);
      },
    },
    {
      name: "kernel_training_finish_workout",
      description: "Complete a workout session. Calculates total duration automatically.",
      inputSchema: z.object({
        workout_id: z.string(),
        mood_after: z.number().optional().describe("Mood after workout 1-10"),
        calories_burned: z.number().optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const { workout_id, ...input } = args as any;
        const w = service.finishWorkout(workout_id, input);
        if (!w) return errorResult(`Workout not found: ${workout_id}`);
        return textResult(
          `Workout completed: **${w.name}**\n  Duration: ${w.duration_minutes}min\n  From: ${w.start_time}\n  To: ${w.end_time}`
        );
      },
    },
    {
      name: "kernel_training_get_workout",
      description: "Get full workout details including all sets logged.",
      inputSchema: z.object({
        workout_id: z.string(),
      }),
      handler: async (args) => {
        const { workout_id } = args as { workout_id: string };
        const w = service.getWorkout(workout_id);
        if (!w) return errorResult(`Workout not found: ${workout_id}`);

        let out = `**${w.name}** — ${w.date} (${w.duration_minutes ?? "in progress"}min)\n`;
        const byExercise: Record<string, typeof w.sets> = {};
        for (const s of w.sets) {
          if (!byExercise[s.exercise_name]) byExercise[s.exercise_name] = [];
          byExercise[s.exercise_name].push(s);
        }
        for (const [ex, sets] of Object.entries(byExercise)) {
          out += `\n**${ex}:**\n`;
          for (const s of sets) {
            let line = `  Set ${s.set_number}: `;
            if (s.reps && s.weight_kg) line += `${s.reps}×${s.weight_kg}kg`;
            else if (s.duration_secs) line += `${s.duration_secs}s`;
            if (s.is_warmup) line += " (warmup)";
            if (s.is_pr) line += " 🏆 PR";
            out += line + "\n";
          }
        }
        return textResult(out);
      },
    },
    {
      name: "kernel_training_list_workouts",
      description: "List recent workouts with optional filters.",
      inputSchema: z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        sport: z.string().optional(),
        limit: z.number().optional().describe("Max results (default: 20)"),
      }),
      handler: async (args) => {
        const workouts = service.listWorkouts({ ...(args as any), limit: (args as any).limit ?? 20 });
        if (workouts.length === 0) return textResult("No workouts found.");
        const lines = workouts.map(w =>
          `${w.date} — **${w.name}** (${w.sport}) ${w.duration_minutes ? `${w.duration_minutes}min` : "in progress"} | ID: ${w.id}`
        );
        return textResult(`${workouts.length} workout(s):\n\n${lines.join("\n")}`);
      },
    },

    // ── Cardio ────────────────────────────────────────────────────────────
    {
      name: "kernel_training_log_cardio",
      description: "Log a cardio session (run, cycle, swim, row, etc) with pace, HR, and distance.",
      inputSchema: z.object({
        sport: z.string().describe("Sport type (running, cycling, swimming, rowing, hiking, etc)"),
        duration_minutes: z.number().describe("Duration in minutes"),
        distance_m: z.number().optional().describe("Distance in meters (e.g. 5000 for 5km)"),
        avg_hr: z.number().optional().describe("Average heart rate (bpm)"),
        max_hr: z.number().optional().describe("Max heart rate (bpm)"),
        calories: z.number().optional(),
        elevation_m: z.number().optional().describe("Total elevation gain in meters"),
        avg_power_w: z.number().optional().describe("Average power in watts (cycling/rowing)"),
        avg_cadence: z.number().optional().describe("Average cadence (rpm or steps/min)"),
        date: z.string().optional().describe("Date (YYYY-MM-DD, default: today)"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const cardio = service.logCardio(args as any);
        let out = `Cardio logged: **${cardio.sport}** — ${cardio.duration_minutes}min`;
        if (cardio.distance_m) out += ` | ${(cardio.distance_m / 1000).toFixed(2)}km`;
        if (cardio.avg_pace_min_km) out += ` | ${cardio.avg_pace_min_km.toFixed(2)} min/km`;
        if (cardio.avg_hr) out += ` | HR ${cardio.avg_hr}bpm`;
        if (cardio.calories) out += ` | ${cardio.calories}cal`;
        return textResult(out);
      },
    },

    // ── PRs & Progress ────────────────────────────────────────────────────
    {
      name: "kernel_training_prs",
      description: "Show personal records. Optionally filter by exercise name.",
      inputSchema: z.object({
        exercise: z.string().optional().describe("Filter by exercise name"),
      }),
      handler: async (args) => {
        const { exercise } = args as { exercise?: string };
        const prs = service.getPrs(exercise);
        if (prs.length === 0) return textResult("No PRs recorded yet. Log workouts to track progress.");
        const lines = prs.map(p => `**${p.exercise_name}** — ${p.pr_type}: ${p.value} ${p.unit} (${p.date})`);
        return textResult(`${prs.length} PR(s):\n\n${lines.join("\n")}`);
      },
    },
    {
      name: "kernel_training_strength_progress",
      description: "Track strength progress for a specific exercise over recent weeks (max weight, volume, sets per session).",
      inputSchema: z.object({
        exercise: z.string().describe("Exercise name to track (e.g. 'Squat', 'Bench Press')"),
        weeks: z.number().optional().describe("Number of weeks to look back (default: 12)"),
      }),
      handler: async (args) => {
        const { exercise, weeks } = args as { exercise: string; weeks?: number };
        const { data } = service.getStrengthProgress(exercise, weeks);
        if (data.length === 0) return textResult(`No data found for "${exercise}".`);
        const lines = data.map(d =>
          `${d.date}: max ${d.max_weight}kg | vol ${d.max_volume}kg | ${d.sets} sets`
        );
        return textResult(`**${exercise} — ${weeks ?? 12}wk Progress:**\n\n${lines.join("\n")}`);
      },
    },
    {
      name: "kernel_training_weekly_summary",
      description: "Training volume and frequency summary by week.",
      inputSchema: z.object({
        weeks: z.number().optional().describe("Number of weeks (default: 4)"),
      }),
      handler: async (args) => {
        const { weeks } = args as { weeks?: number };
        const summary = service.getWeeklySummary(weeks);
        const lines = summary.map(w =>
          `Week of ${w.week}: ${w.workouts} workouts | ${w.total_sets} sets | ${w.total_volume_kg}kg volume | ${w.cardio_minutes}min cardio`
        );
        return textResult(`**Training — ${weeks ?? 4}wk Summary:**\n\n${lines.join("\n")}`);
      },
    },
  ];
}
