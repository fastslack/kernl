import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Community-curated movie directories, federated over Nostr.
 *
 * A directory is a small JSON object (~5-50 KB typical):
 *   {
 *     id, owner_pubkey, title, description, category, cover_identifier,
 *     visibility, items: [{identifier, note?, added_at}],
 *     collaborators: [pubkey, ...],
 *     version, created_at, updated_at
 *   }
 *
 * Lifecycle:
 *   - local-create (origin='local')           → owner_pubkey = our nostr pubkey
 *   - publish to Nostr kind 30079             → discoverable by others
 *   - someone follows it (subscription row)   → cron pulls latest events,
 *                                                upserts as origin='federated'
 *   - co-signers (collaborators[]) can publish updated versions; receiver
 *     validates that the signer is either owner OR in the previous
 *     version's collaborators list. Last-write-wins by event.created_at.
 *
 * The items_json carries identifiers only — hydration with the full row
 * (poster, year, etc.) happens at read time via JOIN to cinema_titles.
 * That keeps the federated payload tiny and lets each peer hydrate from
 * its own catalog, which may differ from the publisher's.
 */
export const cinemaDirectoriesMigration: Migration = {
  version: 5,
  sql: `
    CREATE TABLE IF NOT EXISTS cinema_directories (
      id                TEXT PRIMARY KEY,
      owner_pubkey      TEXT NOT NULL,                   -- secp256k1 hex
      title             TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      category          TEXT NOT NULL DEFAULT '',
      cover_identifier  TEXT NOT NULL DEFAULT '',
      visibility        TEXT NOT NULL DEFAULT 'public'
                        CHECK(visibility IN ('public','unlisted','private')),
      items_json        TEXT NOT NULL DEFAULT '[]',       -- [{identifier, note?, added_at}]
      collaborators_json TEXT NOT NULL DEFAULT '[]',      -- [pubkey, ...]
      origin            TEXT NOT NULL DEFAULT 'local'
                        CHECK(origin IN ('local','federated')),
      nostr_event_id    TEXT NOT NULL DEFAULT '',
      version           INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      published_at      TEXT,
      deleted_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cinema_dirs_owner    ON cinema_directories(owner_pubkey) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cinema_dirs_origin   ON cinema_directories(origin) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cinema_dirs_category ON cinema_directories(category) WHERE deleted_at IS NULL;

    -- A subscription is just a "follow" — we want this directory's
    -- updates to keep streaming in from Nostr. The local row is
    -- mirrored as origin='federated'.
    CREATE TABLE IF NOT EXISTS cinema_directory_subscriptions (
      directory_id    TEXT NOT NULL,
      owner_pubkey    TEXT NOT NULL,
      subscribed_at   TEXT NOT NULL,
      last_synced_at  TEXT,
      PRIMARY KEY (directory_id, owner_pubkey)
    );
  `,
};
