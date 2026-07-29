import type { Migration } from "../../../../../src/core/db/migrations.js";

export const fsCommanderMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS fs_bookmarks (
        id            TEXT PRIMARY KEY,
        label         TEXT NOT NULL,
        provider_id   TEXT NOT NULL,
        path          TEXT NOT NULL,
        sort_order    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fs_bookmarks_order ON fs_bookmarks(sort_order, created_at);

      CREATE TABLE IF NOT EXISTS fs_history (
        id            TEXT PRIMARY KEY,
        pane          TEXT NOT NULL CHECK(pane IN ('left','right')),
        provider_id   TEXT NOT NULL,
        path          TEXT NOT NULL,
        visited_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fs_history_pane_time ON fs_history(pane, visited_at DESC);

      CREATE TABLE IF NOT EXISTS fs_tabs (
        id            TEXT PRIMARY KEY,
        pane          TEXT NOT NULL CHECK(pane IN ('left','right')),
        provider_id   TEXT NOT NULL,
        path          TEXT NOT NULL,
        title         TEXT NOT NULL DEFAULT '',
        sort_order    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fs_tabs_pane_order ON fs_tabs(pane, sort_order);

      CREATE TABLE IF NOT EXISTS fs_remotes (
        id                 TEXT PRIMARY KEY,
        kind               TEXT NOT NULL CHECK(kind IN ('sftp','s3','webdav')),
        label              TEXT NOT NULL,
        config_encrypted   TEXT NOT NULL,
        created_at         TEXT NOT NULL
      );
    `,
  },
];
