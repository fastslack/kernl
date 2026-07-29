import type { Migration } from "../../core/db/migrations.js";

export const notificationMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS notifications (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL DEFAULT '',
        priority   TEXT NOT NULL DEFAULT 'normal'
                   CHECK(priority IN ('low','normal','high')),
        source     TEXT NOT NULL DEFAULT '',
        read       INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
      CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);
    `,
  },
];
