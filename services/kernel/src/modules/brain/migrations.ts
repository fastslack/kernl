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
  {
    // Facts with two timelines: when each was true in the world (valid_from,
    // valid_to) and when Kernl knew it (recorded_at, superseded_at). See facts.ts.
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS facts (
        id             TEXT PRIMARY KEY,
        subject        TEXT NOT NULL,
        subject_name   TEXT NOT NULL DEFAULT '',
        predicate      TEXT NOT NULL,
        object         TEXT NOT NULL,
        multi          INTEGER NOT NULL DEFAULT 0,
        confidence     REAL NOT NULL DEFAULT 0.8,
        source         TEXT NOT NULL DEFAULT '',
        source_ref     TEXT NOT NULL DEFAULT '',
        valid_from     TEXT NOT NULL,
        valid_to       TEXT,
        ended_by       TEXT,
        recorded_at    TEXT NOT NULL,
        superseded_at  TEXT,
        superseded_by  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject, predicate);
      CREATE INDEX IF NOT EXISTS idx_facts_current ON facts(subject, predicate) WHERE valid_to IS NULL AND superseded_at IS NULL;
    `,
  },
  {
    // When Kernl learned that a fact had ended. valid_to is world time and is
    // set after the fact; without this, "what did Kernl believe on date K"
    // already saw endings it only learned later. Rows ended before this
    // column existed: the recording of the value that ended them, else the
    // end itself (the best that is known).
    version: 3,
    sql: `
      ALTER TABLE facts ADD COLUMN ended_at TEXT;
      UPDATE facts SET ended_at = COALESCE(
        (SELECT n.recorded_at FROM facts n WHERE n.id = facts.ended_by),
        valid_to
      ) WHERE valid_to IS NOT NULL;
    `,
  },
];
