import type { Migration } from "../../../../../src/core/db/migrations.js";

export const giteaChannelMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS gitea_connections (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        host            TEXT NOT NULL,
        token           TEXT NOT NULL,
        last_test_at    TEXT,
        last_test_ok    INTEGER,
        last_test_error TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        deleted_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gitea_connections_active
        ON gitea_connections(deleted_at);
    `,
  },
];
