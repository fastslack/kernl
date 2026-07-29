import type { Migration } from "../../../../../src/core/db/migrations.js";

export const lifeMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS life_log (
        id         TEXT PRIMARY KEY,
        type       TEXT NOT NULL CHECK(type IN ('habit','water','mood','note','exercise')),
        value      TEXT NOT NULL DEFAULT '',
        date       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_life_log_type_date ON life_log(type, date);
    `,
  },
];
