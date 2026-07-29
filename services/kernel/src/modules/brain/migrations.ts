import type { Migration } from "../../core/db/migrations.js";

/**
 * Schema for the `brain` module (unified semantic memory).
 *
 * v1 is the DDL that used to run inline in `BrainService`'s constructor via
 * raw `db.exec(...)` calls — moved verbatim here so it's tracked in
 * `_migrations` like every other module. `IF NOT EXISTS` is kept so
 * existing deployments (which already have these tables from the old
 * constructor path) are unaffected; `runMigrations` still records v1 as
 * applied for them.
 */
export const brainMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS brain_items (
        id                TEXT PRIMARY KEY,
        kind              TEXT NOT NULL,
        source_table      TEXT NOT NULL,
        source_id         TEXT NOT NULL,
        text              TEXT NOT NULL,
        embedding         BLOB NOT NULL,
        weight            REAL NOT NULL DEFAULT 1,
        source_updated_at TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        last_seen_at      TEXT,
        UNIQUE(source_table, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_brain_items_kind ON brain_items(kind);

      CREATE TABLE IF NOT EXISTS brain_watermarks (
        source_table TEXT PRIMARY KEY,
        watermark    TEXT NOT NULL DEFAULT '',
        updated_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS brain_signals (
        id           TEXT PRIMARY KEY,
        item_id      TEXT NOT NULL,
        signal       TEXT NOT NULL,
        weight_delta REAL NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_brain_signals_item ON brain_signals(item_id);
    `,
  },
];
