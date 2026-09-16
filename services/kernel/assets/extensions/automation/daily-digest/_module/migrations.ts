import type { Migration } from "@kernl/extension-sdk";

export const dailyDigestMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS daily_digest_log (
        kind       TEXT NOT NULL,
        sent_date  TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(kind, sent_date)
      );
    `,
  },
];
