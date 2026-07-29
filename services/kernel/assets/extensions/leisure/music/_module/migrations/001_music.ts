import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const musicMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- User library — albums/tracks/vinyls saved from archive.org. Sparse:
      -- we only store what the user explicitly stars; everything else stays
      -- on archive.org and is fetched on demand.
      CREATE TABLE IF NOT EXISTS music_library (
        identifier      TEXT PRIMARY KEY,
        title           TEXT NOT NULL DEFAULT '',
        creator         TEXT NOT NULL DEFAULT '',
        year            INTEGER,
        cover_url       TEXT NOT NULL DEFAULT '',
        format_kind     TEXT NOT NULL DEFAULT '',  -- vinyl_78 | vinyl_lp | netlabel | live | radio | audio
        collection      TEXT NOT NULL DEFAULT '',  -- archive.org primary collection (informative)
        added_at        TEXT NOT NULL,
        play_count      INTEGER NOT NULL DEFAULT 0,
        last_played_at  TEXT,
        last_position   REAL NOT NULL DEFAULT 0    -- seconds into last-played track
      );

      CREATE INDEX IF NOT EXISTS idx_music_library_added ON music_library(added_at DESC);
      CREATE INDEX IF NOT EXISTS idx_music_library_format ON music_library(format_kind);

      -- Cache of archive.org search responses, 6h TTL — keeps the search
      -- box snappy without battering archive.org.
      CREATE TABLE IF NOT EXISTS music_search_cache (
        cache_key       TEXT PRIMARY KEY,
        payload_json    TEXT NOT NULL,
        cached_at       TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_music_cache_at ON music_search_cache(cached_at);

      -- Play history — written when the user opens the player. Lets us
      -- show "recently played" and feed simple per-creator recommendations.
      CREATE TABLE IF NOT EXISTS music_play_history (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        identifier      TEXT NOT NULL,
        track_name      TEXT NOT NULL DEFAULT '',
        played_at       TEXT NOT NULL,
        seconds         INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_music_history_id ON music_play_history(identifier);
      CREATE INDEX IF NOT EXISTS idx_music_history_at ON music_play_history(played_at DESC);
    `,
  },
];
