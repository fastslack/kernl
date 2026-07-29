import type { Migration } from "../../../../../src/core/db/migrations.js";

export const githubChannelMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS github_connections (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        app_id          TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        private_key_pem TEXT NOT NULL,
        last_test_at    TEXT,
        last_test_ok    INTEGER,
        last_test_error TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        deleted_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_github_connections_active
        ON github_connections(deleted_at);
    `,
  },
];
