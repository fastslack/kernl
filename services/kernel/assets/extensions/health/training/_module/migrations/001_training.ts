import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const trainingMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- Exercise library
      CREATE TABLE IF NOT EXISTS training_exercises (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        category        TEXT NOT NULL DEFAULT 'strength'
                        CHECK(category IN ('strength','cardio','flexibility','balance','sport','custom')),
        muscle_groups   TEXT NOT NULL DEFAULT '[]',
        equipment       TEXT NOT NULL DEFAULT 'none'
                        CHECK(equipment IN ('none','barbell','dumbbell','kettlebell','machine','cable','bodyweight','bands','cardio_machine','custom')),
        instructions    TEXT NOT NULL DEFAULT '',
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_te_category ON training_exercises(category);

      -- Training programs / plans
      CREATE TABLE IF NOT EXISTS training_programs (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        goal            TEXT NOT NULL DEFAULT 'general'
                        CHECK(goal IN ('strength','hypertrophy','endurance','weight_loss','sport','general','rehab')),
        difficulty      TEXT NOT NULL DEFAULT 'intermediate'
                        CHECK(difficulty IN ('beginner','intermediate','advanced','elite')),
        days_per_week   INTEGER NOT NULL DEFAULT 3,
        duration_weeks  INTEGER NOT NULL DEFAULT 8,
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','completed','paused','archived')),
        start_date      TEXT,
        end_date        TEXT,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      -- Program sessions (template workouts within a program)
      CREATE TABLE IF NOT EXISTS training_sessions_template (
        id              TEXT PRIMARY KEY,
        program_id      TEXT NOT NULL REFERENCES training_programs(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        day_of_week     INTEGER,
        week_number     INTEGER,
        order_index     INTEGER NOT NULL DEFAULT 0,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tst_program ON training_sessions_template(program_id);

      -- Template exercises within a session template
      CREATE TABLE IF NOT EXISTS training_template_exercises (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES training_sessions_template(id) ON DELETE CASCADE,
        exercise_id     TEXT REFERENCES training_exercises(id) ON DELETE SET NULL,
        exercise_name   TEXT NOT NULL,
        sets            INTEGER NOT NULL DEFAULT 3,
        reps            TEXT NOT NULL DEFAULT '8-12',
        weight_kg       REAL,
        duration_secs   INTEGER,
        rest_secs       INTEGER NOT NULL DEFAULT 60,
        rpe             INTEGER,
        notes           TEXT NOT NULL DEFAULT '',
        order_index     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tte_session ON training_template_exercises(session_id);

      -- Actual workout logs
      CREATE TABLE IF NOT EXISTS training_workouts (
        id              TEXT PRIMARY KEY,
        program_id      TEXT REFERENCES training_programs(id) ON DELETE SET NULL,
        template_id     TEXT REFERENCES training_sessions_template(id) ON DELETE SET NULL,
        name            TEXT NOT NULL,
        sport           TEXT NOT NULL DEFAULT 'strength',
        date            TEXT NOT NULL,
        start_time      TEXT NOT NULL,
        end_time        TEXT,
        duration_minutes INTEGER,
        calories_burned INTEGER,
        notes           TEXT NOT NULL DEFAULT '',
        mood_before     INTEGER,
        mood_after      INTEGER,
        fatigue_level   INTEGER,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tw_date ON training_workouts(date);
      CREATE INDEX IF NOT EXISTS idx_tw_program ON training_workouts(program_id);

      -- Exercise sets within a workout
      CREATE TABLE IF NOT EXISTS training_sets (
        id              TEXT PRIMARY KEY,
        workout_id      TEXT NOT NULL REFERENCES training_workouts(id) ON DELETE CASCADE,
        exercise_id     TEXT REFERENCES training_exercises(id) ON DELETE SET NULL,
        exercise_name   TEXT NOT NULL,
        set_number      INTEGER NOT NULL DEFAULT 1,
        reps            INTEGER,
        weight_kg       REAL,
        duration_secs   INTEGER,
        distance_m      REAL,
        rpe             INTEGER,
        is_warmup       INTEGER NOT NULL DEFAULT 0,
        is_pr           INTEGER NOT NULL DEFAULT 0,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ts_workout ON training_sets(workout_id);
      CREATE INDEX IF NOT EXISTS idx_ts_exercise ON training_sets(exercise_name, weight_kg);

      -- Personal records
      CREATE TABLE IF NOT EXISTS training_prs (
        id              TEXT PRIMARY KEY,
        exercise_name   TEXT NOT NULL,
        pr_type         TEXT NOT NULL DEFAULT 'weight'
                        CHECK(pr_type IN ('weight','reps','time','distance','volume')),
        value           REAL NOT NULL,
        unit            TEXT NOT NULL DEFAULT 'kg',
        workout_id      TEXT REFERENCES training_workouts(id) ON DELETE SET NULL,
        date            TEXT NOT NULL,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tpr_exercise ON training_prs(exercise_name);

      -- Cardio sessions (runs, cycling, swimming, etc.)
      CREATE TABLE IF NOT EXISTS training_cardio (
        id              TEXT PRIMARY KEY,
        workout_id      TEXT REFERENCES training_workouts(id) ON DELETE SET NULL,
        sport           TEXT NOT NULL DEFAULT 'running',
        date            TEXT NOT NULL,
        duration_minutes REAL NOT NULL,
        distance_m      REAL,
        avg_pace_min_km REAL,
        avg_hr          INTEGER,
        max_hr          INTEGER,
        calories        INTEGER,
        elevation_m     REAL,
        avg_power_w     REAL,
        avg_cadence     INTEGER,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tc_date ON training_cardio(date);
    `,
  },
];
