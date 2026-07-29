import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const reposMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS repos (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        path            TEXT NOT NULL UNIQUE,
        description     TEXT NOT NULL DEFAULT '',
        tags            TEXT NOT NULL DEFAULT '',
        default_branch  TEXT NOT NULL DEFAULT '',
        remote_url      TEXT NOT NULL DEFAULT '',
        language        TEXT NOT NULL DEFAULT '',
        shared          INTEGER NOT NULL DEFAULT 1,
        last_seen_at    TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        deleted_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_repos_shared ON repos(shared);
      CREATE INDEX IF NOT EXISTS idx_repos_deleted ON repos(deleted_at);
    `,
  },
];
