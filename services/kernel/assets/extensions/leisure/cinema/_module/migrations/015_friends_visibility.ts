import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * A fourth visibility: `friends`.
 *
 * Public directories go out over Nostr relays, where anyone can read them.
 * That is the wrong lane for a list you only want to share with the people you
 * actually know. A `friends` directory never reaches a relay: it stays here
 * and is handed, on request, to instances that authenticate as trusted friends
 * of this kernel.
 *
 * SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
 * `source_npub` arrives with it: a directory pulled from a friend needs to
 * record who it came from, which the Nostr path never had to answer because
 * the owner pubkey was the whole story there.
 */
export const cinemaFriendsVisibilityMigration: Migration = {
  version: 15,
  sql: `
    CREATE TABLE IF NOT EXISTS cinema_directories_new (
      id                TEXT PRIMARY KEY,
      owner_pubkey      TEXT NOT NULL,
      title             TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      category          TEXT NOT NULL DEFAULT '',
      cover_identifier  TEXT NOT NULL DEFAULT '',
      visibility        TEXT NOT NULL DEFAULT 'public'
                        CHECK(visibility IN ('public','unlisted','private','friends')),
      items_json        TEXT NOT NULL DEFAULT '[]',
      collaborators_json TEXT NOT NULL DEFAULT '[]',
      origin            TEXT NOT NULL DEFAULT 'local'
                        CHECK(origin IN ('local','federated')),
      nostr_event_id    TEXT NOT NULL DEFAULT '',
      source_npub       TEXT NOT NULL DEFAULT '',
      version           INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      published_at      TEXT,
      deleted_at        TEXT
    );

    INSERT INTO cinema_directories_new
      (id, owner_pubkey, title, description, category, cover_identifier, visibility,
       items_json, collaborators_json, origin, nostr_event_id, source_npub, version,
       created_at, updated_at, published_at, deleted_at)
    SELECT
       id, owner_pubkey, title, description, category, cover_identifier, visibility,
       items_json, collaborators_json, origin, nostr_event_id, '', version,
       created_at, updated_at, published_at, deleted_at
    FROM cinema_directories;

    DROP TABLE cinema_directories;
    ALTER TABLE cinema_directories_new RENAME TO cinema_directories;

    CREATE INDEX IF NOT EXISTS idx_cinema_dirs_owner    ON cinema_directories(owner_pubkey) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cinema_dirs_origin   ON cinema_directories(origin) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cinema_dirs_category ON cinema_directories(category) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cinema_dirs_source   ON cinema_directories(source_npub) WHERE deleted_at IS NULL;
  `,
};
