import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const nutritionMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- Food database (local + custom entries)
      CREATE TABLE IF NOT EXISTS nutrition_foods (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        brand           TEXT NOT NULL DEFAULT '',
        barcode         TEXT NOT NULL DEFAULT '',
        calories_per_100g REAL NOT NULL DEFAULT 0,
        protein_per_100g  REAL NOT NULL DEFAULT 0,
        carbs_per_100g    REAL NOT NULL DEFAULT 0,
        fat_per_100g      REAL NOT NULL DEFAULT 0,
        fiber_per_100g    REAL NOT NULL DEFAULT 0,
        sugar_per_100g    REAL NOT NULL DEFAULT 0,
        sodium_per_100g   REAL NOT NULL DEFAULT 0,
        serving_size_g    REAL NOT NULL DEFAULT 100,
        serving_unit      TEXT NOT NULL DEFAULT 'g',
        source            TEXT NOT NULL DEFAULT 'custom'
                          CHECK(source IN ('custom','openfoodfacts','usda')),
        notes             TEXT NOT NULL DEFAULT '',
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nf_name ON nutrition_foods(name);
      CREATE INDEX IF NOT EXISTS idx_nf_barcode ON nutrition_foods(barcode);

      -- Full-text search on food names/brands
      CREATE VIRTUAL TABLE IF NOT EXISTS nutrition_foods_fts
        USING fts5(food_id UNINDEXED, name, brand, content='nutrition_foods', content_rowid='rowid');

      -- Daily food entries (what you actually ate)
      CREATE TABLE IF NOT EXISTS nutrition_entries (
        id              TEXT PRIMARY KEY,
        food_id         TEXT REFERENCES nutrition_foods(id) ON DELETE SET NULL,
        food_name       TEXT NOT NULL,
        meal_type       TEXT NOT NULL DEFAULT 'other'
                        CHECK(meal_type IN ('breakfast','lunch','dinner','snack','other')),
        quantity_g      REAL NOT NULL DEFAULT 100,
        calories        REAL NOT NULL DEFAULT 0,
        protein_g       REAL NOT NULL DEFAULT 0,
        carbs_g         REAL NOT NULL DEFAULT 0,
        fat_g           REAL NOT NULL DEFAULT 0,
        fiber_g         REAL NOT NULL DEFAULT 0,
        sugar_g         REAL NOT NULL DEFAULT 0,
        sodium_mg       REAL NOT NULL DEFAULT 0,
        date            TEXT NOT NULL,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ne_date ON nutrition_entries(date);
      CREATE INDEX IF NOT EXISTS idx_ne_meal ON nutrition_entries(meal_type, date);

      -- Daily nutrition goals
      CREATE TABLE IF NOT EXISTS nutrition_goals (
        id              TEXT PRIMARY KEY,
        calories        REAL NOT NULL DEFAULT 2000,
        protein_g       REAL NOT NULL DEFAULT 150,
        carbs_g         REAL NOT NULL DEFAULT 250,
        fat_g           REAL NOT NULL DEFAULT 65,
        fiber_g         REAL NOT NULL DEFAULT 30,
        water_ml        REAL NOT NULL DEFAULT 2500,
        active          INTEGER NOT NULL DEFAULT 1,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      -- Fasting windows
      CREATE TABLE IF NOT EXISTS nutrition_fasting (
        id              TEXT PRIMARY KEY,
        protocol        TEXT NOT NULL DEFAULT '16:8'
                        CHECK(protocol IN ('16:8','18:6','20:4','24h','5:2','omad','custom')),
        start_time      TEXT NOT NULL,
        end_time        TEXT,
        target_hours    REAL NOT NULL DEFAULT 16,
        actual_hours    REAL,
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','completed','broken')),
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nfasting_status ON nutrition_fasting(status);
      CREATE INDEX IF NOT EXISTS idx_nfasting_start ON nutrition_fasting(start_time);

      -- Water intake tracking (granular, beyond life_log)
      CREATE TABLE IF NOT EXISTS nutrition_water (
        id              TEXT PRIMARY KEY,
        amount_ml       REAL NOT NULL,
        date            TEXT NOT NULL,
        time            TEXT NOT NULL,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nwater_date ON nutrition_water(date);

      -- Body weight & composition over time
      CREATE TABLE IF NOT EXISTS nutrition_body_stats (
        id              TEXT PRIMARY KEY,
        weight_kg       REAL,
        body_fat_pct    REAL,
        muscle_mass_kg  REAL,
        water_pct       REAL,
        bmi             REAL,
        waist_cm        REAL,
        hip_cm          REAL,
        chest_cm        REAL,
        date            TEXT NOT NULL,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nbs_date ON nutrition_body_stats(date);
    `,
  },
];
