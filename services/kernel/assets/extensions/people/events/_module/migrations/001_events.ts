import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const eventsMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- Events table
      CREATE TABLE IF NOT EXISTS events (
        id                    TEXT PRIMARY KEY,
        title                 TEXT NOT NULL,
        description           TEXT NOT NULL DEFAULT '',
        type                  TEXT NOT NULL DEFAULT 'social'
                              CHECK(type IN ('sports','social','professional','family','other')),
        status                TEXT NOT NULL DEFAULT 'draft'
                              CHECK(status IN ('draft','open','confirmed','cancelled','completed')),
        start_at              TEXT NOT NULL,
        end_at                TEXT,
        duration_minutes      INTEGER NOT NULL DEFAULT 90,
        location              TEXT NOT NULL DEFAULT '',
        location_url          TEXT NOT NULL DEFAULT '',
        min_attendees         INTEGER NOT NULL DEFAULT 1,
        max_attendees         INTEGER,
        cost_per_person_cents INTEGER NOT NULL DEFAULT 0,
        cost_currency         TEXT NOT NULL DEFAULT 'EUR',
        organizer_contact_id  TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        recurrence            TEXT NOT NULL DEFAULT '',
        parent_event_id       TEXT REFERENCES events(id) ON DELETE CASCADE,
        notes                 TEXT NOT NULL DEFAULT '',
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_start_at ON events(start_at);
      CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_event_id);

      -- Event attendees table
      CREATE TABLE IF NOT EXISTS event_attendees (
        id                TEXT PRIMARY KEY,
        event_id          TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        contact_id        TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        name              TEXT NOT NULL DEFAULT '',
        phone             TEXT NOT NULL DEFAULT '',
        rsvp_status       TEXT NOT NULL DEFAULT 'pending'
                          CHECK(rsvp_status IN ('pending','yes','no','maybe','waitlist')),
        rsvp_at           TEXT,
        waitlist_position INTEGER,
        notes             TEXT NOT NULL DEFAULT '',
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        UNIQUE(event_id, contact_id),
        UNIQUE(event_id, phone)
      );

      CREATE INDEX IF NOT EXISTS idx_event_attendees_event ON event_attendees(event_id);
      CREATE INDEX IF NOT EXISTS idx_event_attendees_contact ON event_attendees(contact_id);
      CREATE INDEX IF NOT EXISTS idx_event_attendees_rsvp ON event_attendees(event_id, rsvp_status);
      CREATE INDEX IF NOT EXISTS idx_event_attendees_phone ON event_attendees(phone);
    `,
  },
];
