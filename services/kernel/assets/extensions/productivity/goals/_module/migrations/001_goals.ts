import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const goalsMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS goals (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        type            TEXT NOT NULL DEFAULT 'goal'
                        CHECK(type IN ('goal','objective')),
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','completed','abandoned')),
        parent_id       TEXT REFERENCES goals(id) ON DELETE SET NULL,
        target_date     TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
      CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_id);

      CREATE TABLE IF NOT EXISTS key_results (
        id              TEXT PRIMARY KEY,
        goal_id         TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        target_value    REAL NOT NULL DEFAULT 100,
        current_value   REAL NOT NULL DEFAULT 0,
        unit            TEXT NOT NULL DEFAULT '%',
        task_id         TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kr_goal ON key_results(goal_id);
    `,
  },
];
