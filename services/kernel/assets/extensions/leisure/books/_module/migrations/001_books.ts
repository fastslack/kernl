import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const booksMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- User-curated reading list. Sparse — we never copy archive.org
      -- metadata into our DB, only what the user explicitly adds.
      CREATE TABLE IF NOT EXISTS books_watchlist (
        identifier      TEXT PRIMARY KEY,
        title           TEXT NOT NULL DEFAULT '',
        creator         TEXT NOT NULL DEFAULT '',
        year            INTEGER,
        cover_url       TEXT NOT NULL DEFAULT '',
        added_at        TEXT NOT NULL,
        read_progress   REAL NOT NULL DEFAULT 0,
        last_opened_at  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_books_watchlist_added ON books_watchlist(added_at DESC);

      -- Cache of archive.org search responses to avoid re-hitting their
      -- advancedsearch.php on every keystroke. Keyed by the normalized
      -- query+filter signature; entries TTL'd at read time.
      CREATE TABLE IF NOT EXISTS books_search_cache (
        cache_key       TEXT PRIMARY KEY,
        payload_json    TEXT NOT NULL,
        cached_at       TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_books_cache_at ON books_search_cache(cached_at);
    `,
  },
];
