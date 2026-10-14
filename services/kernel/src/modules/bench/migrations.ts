import type { Migration } from "../../core/db/migrations.js";

export const benchMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS bench_runs (
        id            TEXT PRIMARY KEY,
        suite_version INTEGER NOT NULL,
        status        TEXT NOT NULL,              -- running | done | cancelled | interrupted | failed
        targets       TEXT NOT NULL DEFAULT '[]', -- [{slug, name, model, supportsTools}]
        planned       INTEGER NOT NULL DEFAULT 0, -- attempts the run will make
        done          INTEGER NOT NULL DEFAULT 0,
        current       TEXT NOT NULL DEFAULT '',   -- "<slug>/<model> · <task id>" while running
        error         TEXT NOT NULL DEFAULT '',
        started_at    TEXT NOT NULL,
        finished_at   TEXT
      );
      CREATE TABLE IF NOT EXISTS bench_results (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL REFERENCES bench_runs(id) ON DELETE CASCADE,
        slug          TEXT NOT NULL,
        model         TEXT NOT NULL,
        task_id       TEXT NOT NULL,
        category      TEXT NOT NULL,
        attempt       INTEGER NOT NULL,
        status        TEXT NOT NULL,              -- ok | provider_error | na
        score         REAL NOT NULL DEFAULT 0,
        detail        TEXT NOT NULL DEFAULT '',
        invalid       TEXT NOT NULL DEFAULT '',
        latency_ms    INTEGER NOT NULL DEFAULT 0,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd      REAL,
        iterations    INTEGER NOT NULL DEFAULT 0,
        output        TEXT NOT NULL DEFAULT '',
        calls         TEXT NOT NULL DEFAULT '[]',
        error         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bench_results_run ON bench_results(run_id, slug, model, task_id);
    `,
  },
];
