import type { Migration } from "../../../../../../src/core/db/migrations.js";
import { cinemaSubsMigration } from "./002_subs.js";
import { cinemaFtsMigration } from "./003_fts.js";
import { cinemaTagsMigration } from "./004_tags.js";
import { cinemaDirectoriesMigration } from "./005_directories.js";
import { cinemaFtsFixMigration } from "./006_fts_fix.js";
import { cinemaPurgeCollectionItemsMigration } from "./007_purge_collection_items.js";
import { cinemaPurgeNoiseCollectionsMigration } from "./008_purge_noise_collections.js";
import { cinemaResetMinilmEmbeddingsMigration } from "./009_reset_minilm_embeddings.js";
import { cinemaCanonicalMigration } from "./010_canonical.js";
import { cinemaWorksMigration } from "./011_works.js";
import { cinemaMediaMigration } from "./012_media.js";
import { cinemaCanonMigration } from "./013_canon.js";
import { cinemaSyncAttemptsMigration } from "./014_sync_attempts.js";
import { cinemaFriendsVisibilityMigration } from "./015_friends_visibility.js";
import { cinemaGraphProjectionMigration } from "./016_graph_projection.js";

export const cinemaMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- Local catalog of archive.org titles. Owned by the cinema module
      -- (the torrents module only stores titles the user explicitly
      -- imported as torrents — this table mirrors archive.org's catalog
      -- so /cinema can search/filter without round-tripping upstream).
      --
      -- Shape mirrors what the scrape API gives us, plus a few user-only
      -- columns (watchlist, watched_at, user_rating, hidden) and bookkeeping
      -- (ingested_at, embedded_at).
      CREATE TABLE IF NOT EXISTS cinema_titles (
        identifier      TEXT PRIMARY KEY,
        title           TEXT NOT NULL DEFAULT '',
        date            TEXT NOT NULL DEFAULT '',     -- raw upstream string
        year            INTEGER NOT NULL DEFAULT 0,    -- parsed from date for filtering
        creator         TEXT NOT NULL DEFAULT '',
        description     TEXT NOT NULL DEFAULT '',
        description_es  TEXT NOT NULL DEFAULT '',     -- translated on-demand later
        subject_json    TEXT NOT NULL DEFAULT '[]',
        collection_json TEXT NOT NULL DEFAULT '[]',
        language        TEXT NOT NULL DEFAULT '',
        licenseurl      TEXT NOT NULL DEFAULT '',
        runtime_sec     INTEGER NOT NULL DEFAULT 0,
        downloads       INTEGER NOT NULL DEFAULT 0,
        week_downloads  INTEGER NOT NULL DEFAULT 0,
        avg_rating      REAL NOT NULL DEFAULT 0,
        num_reviews     INTEGER NOT NULL DEFAULT 0,
        has_torrent     INTEGER NOT NULL DEFAULT 0,
        poster_url      TEXT NOT NULL DEFAULT '',
        addeddate       TEXT NOT NULL DEFAULT '',
        publicdate      TEXT NOT NULL DEFAULT '',
        -- user-only columns
        watchlist       INTEGER NOT NULL DEFAULT 0,
        watched_at      TEXT,
        user_rating     INTEGER NOT NULL DEFAULT 0,   -- 0..10, 0 = no rating
        user_tags       TEXT NOT NULL DEFAULT '',
        notes           TEXT NOT NULL DEFAULT '',
        hidden          INTEGER NOT NULL DEFAULT 0,
        -- embedding bookkeeping (Stage 2 fills these)
        embedded_at     TEXT,
        embedded_model  TEXT NOT NULL DEFAULT '',
        embedded_dim    INTEGER NOT NULL DEFAULT 0,
        -- ingest bookkeeping
        ingested_at     TEXT NOT NULL,
        last_seen_at    TEXT NOT NULL,
        deleted_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cinema_year       ON cinema_titles(year);
      CREATE INDEX IF NOT EXISTS idx_cinema_watchlist  ON cinema_titles(watchlist) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_cinema_pending_emb ON cinema_titles(embedded_at) WHERE deleted_at IS NULL AND embedded_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_cinema_addeddate  ON cinema_titles(addeddate);
      CREATE INDEX IF NOT EXISTS idx_cinema_downloads  ON cinema_titles(downloads DESC);

      -- Audit trail of ingest passes. The scrape API returns a cursor that
      -- lets us resume mid-collection across kernel restarts; we persist it
      -- here so the agent picks up where the previous tick left off.
      CREATE TABLE IF NOT EXISTS cinema_ingest_runs (
        id              TEXT PRIMARY KEY,
        collection      TEXT NOT NULL,
        cursor          TEXT NOT NULL DEFAULT '',     -- empty = start fresh
        fetched         INTEGER NOT NULL DEFAULT 0,
        upserted        INTEGER NOT NULL DEFAULT 0,
        embedded        INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'running'
                        CHECK(status IN ('running','done','failed','paused')),
        error           TEXT NOT NULL DEFAULT '',
        started_at      TEXT NOT NULL,
        finished_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cinema_runs_collection ON cinema_ingest_runs(collection, status);
      CREATE INDEX IF NOT EXISTS idx_cinema_runs_started    ON cinema_ingest_runs(started_at DESC);
    `,
  },
  cinemaSubsMigration,
  cinemaFtsMigration,
  cinemaTagsMigration,
  cinemaDirectoriesMigration,
  cinemaFtsFixMigration,
  cinemaPurgeCollectionItemsMigration,
  cinemaPurgeNoiseCollectionsMigration,
  cinemaResetMinilmEmbeddingsMigration,
  cinemaCanonicalMigration,
  cinemaWorksMigration,
  cinemaMediaMigration,
  cinemaCanonMigration,
  cinemaSyncAttemptsMigration,
  cinemaFriendsVisibilityMigration,
  cinemaGraphProjectionMigration,
];
