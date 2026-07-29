import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const googleSyncMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS google_tokens (
        id            INTEGER PRIMARY KEY CHECK(id = 1),
        access_token  TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        scopes        TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS google_sync_map (
        id            TEXT PRIMARY KEY,
        source        TEXT NOT NULL CHECK(source IN ('contacts','calendar','tasks','gmail','other_contacts','takeout_places')),
        google_id     TEXT NOT NULL,
        local_id      TEXT NOT NULL,
        local_table   TEXT NOT NULL,
        synced_at     TEXT NOT NULL,
        UNIQUE(source, google_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sync_map_source ON google_sync_map(source);
      CREATE INDEX IF NOT EXISTS idx_sync_map_local  ON google_sync_map(local_id);

      CREATE TABLE IF NOT EXISTS google_sync_meta (
        source        TEXT PRIMARY KEY CHECK(source IN ('contacts','calendar','tasks','gmail','other_contacts','takeout_places')),
        last_sync_at  TEXT NOT NULL,
        items_synced  INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];
