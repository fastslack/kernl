import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const timeTrackingMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS time_entries (
        id                TEXT PRIMARY KEY,
        task_id           TEXT,
        description       TEXT NOT NULL DEFAULT '',
        start_time        TEXT NOT NULL,
        end_time          TEXT,
        duration_minutes  INTEGER,
        tags              TEXT NOT NULL DEFAULT '',
        created_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_time_task ON time_entries(task_id);
      CREATE INDEX IF NOT EXISTS idx_time_start ON time_entries(start_time);
    `,
  },
];
