import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Progress cursors for the SQLite → Neo4j catalogue projection.
 *
 * The projection walks ~1.2M rows across four tables. That is far too much for
 * one transaction and far too slow to redo from scratch every tick, so each
 * entity keeps its own cursor: the last primary key written. A pass resumes
 * where it stopped, whether it stopped because the batch ended, the runner was
 * stopped, or the kernel restarted mid-sweep.
 *
 * `done` marks an entity that has walked its table to the end. It is not
 * permanent — the runner clears it to sweep again and pick up rows that
 * changed since, which is what makes this a projection rather than a one-off
 * import.
 */
export const cinemaGraphProjectionMigration: Migration = {
  version: 16,
  sql: `
    CREATE TABLE IF NOT EXISTS cinema_graph_cursors (
      entity     TEXT PRIMARY KEY,
      cursor     TEXT NOT NULL DEFAULT '',
      projected  INTEGER NOT NULL DEFAULT 0,
      done       INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `,
};
