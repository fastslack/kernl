import type { Migration } from "../../../../../src/core/db/migrations.js";

export const rssReaderMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS rss_reader_state (
        item_id    TEXT PRIMARY KEY,
        read       INTEGER NOT NULL DEFAULT 0,
        starred    INTEGER NOT NULL DEFAULT 0,
        read_at    TEXT,
        starred_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rss_reader_state_read    ON rss_reader_state(read);
      CREATE INDEX IF NOT EXISTS idx_rss_reader_state_starred ON rss_reader_state(starred);
    `,
  },
];
