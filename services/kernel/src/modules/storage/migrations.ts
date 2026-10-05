import type { Migration } from "../../core/db/migrations.js";

export const storageMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- The user's choice per policy. A policy with no row runs on its own
      -- defaults, so a policy an extension adds later needs no seeding.
      CREATE TABLE IF NOT EXISTS retention_settings (
        policy_id  TEXT PRIMARY KEY,
        enabled    INTEGER NOT NULL DEFAULT 0,
        days       INTEGER,
        updated_at TEXT NOT NULL
      );

      -- One row per cleanup pass, cron or manual.
      CREATE TABLE IF NOT EXISTS retention_runs (
        id              TEXT PRIMARY KEY,
        trigger         TEXT NOT NULL CHECK(trigger IN ('cron','manual')),
        started_at      TEXT NOT NULL,
        finished_at     TEXT,
        deleted_rows    INTEGER NOT NULL DEFAULT 0,
        freed_bytes_est INTEGER NOT NULL DEFAULT 0,
        db_bytes_before INTEGER NOT NULL DEFAULT 0,
        db_bytes_after  INTEGER NOT NULL DEFAULT 0,
        vacuumed        INTEGER NOT NULL DEFAULT 0,
        details_json    TEXT NOT NULL DEFAULT '[]',
        error           TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_retention_runs_started ON retention_runs(started_at DESC);

      -- Daily size measurement, the source of the storage page and its trend.
      CREATE TABLE IF NOT EXISTS storage_snapshots (
        day             TEXT PRIMARY KEY,
        measured_at     TEXT NOT NULL,
        db_bytes        INTEGER NOT NULL DEFAULT 0,
        wal_bytes       INTEGER NOT NULL DEFAULT 0,
        freelist_bytes  INTEGER NOT NULL DEFAULT 0,
        disk_free_bytes INTEGER NOT NULL DEFAULT -1,
        exact           INTEGER NOT NULL DEFAULT 0,
        tables_json     TEXT NOT NULL DEFAULT '[]',
        policies_json   TEXT NOT NULL DEFAULT '[]'
      );
    `,
  },
  {
    // Ceiling for policies with a `capacity` (catalog ingesters). NULL = the
    // policy's default; 0 = explicitly no limit.
    version: 2,
    sql: `ALTER TABLE retention_settings ADD COLUMN cap INTEGER;`,
  },
];
