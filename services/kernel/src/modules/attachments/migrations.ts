import type { Migration } from "../../core/db/migrations.js";

export const attachmentsMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- Files attached to a chat message. The bytes live on disk under
      -- <data>/attachments/<id>/; this row is the only way to reach them.
      CREATE TABLE IF NOT EXISTS attachments (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL CHECK(kind IN ('image','document','video')),
        mime        TEXT NOT NULL,
        filename    TEXT NOT NULL DEFAULT '',
        size_bytes  INTEGER NOT NULL DEFAULT 0,
        path        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','ready','failed')),
        derived     TEXT NOT NULL DEFAULT '{}',
        error       TEXT,
        bound_at    TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_status ON attachments(status);
      CREATE INDEX IF NOT EXISTS idx_attachments_unbound ON attachments(created_at) WHERE bound_at IS NULL;
    `,
  },
];
