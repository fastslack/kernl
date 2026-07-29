import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const fullSyncMigrations: Migration[] = [
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS google_emails (
        id              TEXT PRIMARY KEY,
        gmail_id        TEXT NOT NULL UNIQUE,
        thread_id       TEXT NOT NULL DEFAULT '',
        from_email      TEXT NOT NULL DEFAULT '',
        from_name       TEXT NOT NULL DEFAULT '',
        to_emails       TEXT NOT NULL DEFAULT '',
        cc_emails       TEXT NOT NULL DEFAULT '',
        subject         TEXT NOT NULL DEFAULT '',
        snippet         TEXT NOT NULL DEFAULT '',
        body_text       TEXT NOT NULL DEFAULT '',
        labels          TEXT NOT NULL DEFAULT '',
        date            TEXT NOT NULL,
        size_bytes      INTEGER NOT NULL DEFAULT 0,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        is_read         INTEGER NOT NULL DEFAULT 0,
        is_starred      INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_google_emails_thread ON google_emails(thread_id);
      CREATE INDEX IF NOT EXISTS idx_google_emails_date ON google_emails(date);
      CREATE INDEX IF NOT EXISTS idx_google_emails_from ON google_emails(from_email);

      CREATE TABLE IF NOT EXISTS google_email_threads (
        id                TEXT PRIMARY KEY,
        gmail_thread_id   TEXT NOT NULL UNIQUE,
        subject           TEXT NOT NULL DEFAULT '',
        message_count     INTEGER NOT NULL DEFAULT 0,
        participants      TEXT NOT NULL DEFAULT '',
        last_message_date TEXT NOT NULL DEFAULT '',
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS google_calendar_events (
        id                  TEXT PRIMARY KEY,
        google_event_id     TEXT NOT NULL UNIQUE,
        calendar_id         TEXT NOT NULL DEFAULT 'primary',
        title               TEXT NOT NULL DEFAULT '',
        description         TEXT NOT NULL DEFAULT '',
        location            TEXT NOT NULL DEFAULT '',
        start_at            TEXT NOT NULL,
        end_at              TEXT NOT NULL DEFAULT '',
        all_day             INTEGER NOT NULL DEFAULT 0,
        status              TEXT NOT NULL DEFAULT 'confirmed',
        organizer_email     TEXT NOT NULL DEFAULT '',
        organizer_name      TEXT NOT NULL DEFAULT '',
        attendees           TEXT NOT NULL DEFAULT '',
        recurrence          TEXT NOT NULL DEFAULT '',
        recurring_event_id  TEXT NOT NULL DEFAULT '',
        hangout_link        TEXT NOT NULL DEFAULT '',
        visibility          TEXT NOT NULL DEFAULT 'default',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_google_cal_start ON google_calendar_events(start_at);
      CREATE INDEX IF NOT EXISTS idx_google_cal_organizer ON google_calendar_events(organizer_email);

      -- Recreate google_sync_meta without CHECK constraint for extensible source values
      -- SQLite doesn't support ALTER TABLE DROP CONSTRAINT, so we recreate
      CREATE TABLE IF NOT EXISTS google_sync_meta_v2 (
        source        TEXT PRIMARY KEY,
        last_sync_at  TEXT NOT NULL,
        items_synced  INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO google_sync_meta_v2 (source, last_sync_at, items_synced)
        SELECT source, last_sync_at, items_synced FROM google_sync_meta;
      DROP TABLE IF EXISTS google_sync_meta;
      ALTER TABLE google_sync_meta_v2 RENAME TO google_sync_meta;
    `,
  },
];
