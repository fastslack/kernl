import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const notesMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS notes (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        body            TEXT NOT NULL DEFAULT '',
        tags            TEXT NOT NULL DEFAULT '',
        pinned          INTEGER NOT NULL DEFAULT 0,
        contact_id      TEXT,
        task_id         TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(pinned);
      CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_id);
      CREATE INDEX IF NOT EXISTS idx_notes_task ON notes(task_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        note_id UNINDEXED,
        title,
        body,
        tags
      );
    `,
  },
];
