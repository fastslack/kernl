import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Canonical identification — giving a catalogue row an identity beyond the
 * archive.org identifier it was uploaded under.
 *
 * The problem this exists to solve: `cinema_titles` ranks "best" with a
 * weighted rating over `avg_rating`/`num_reviews`, and the overwhelming
 * majority of rows carry zero reviews. With v=0 that score collapses to the
 * global mean for the entire catalogue, so the sort silently degenerates into
 * "whatever happened to get commented on". There is no quality signal in the
 * data to rank by.
 *
 * Wikidata has one, indirectly: a film that exists there as a work has been
 * catalogued by someone, with a director, a country, and an IMDb id. An
 * uploader's home movie has not. That distinction is the strongest
 * signal/noise lever available, and it is CC0, so it can ship.
 *
 * Three tables:
 *
 *   cinema_canonical_works    the corpus, pulled from Wikidata once and then
 *                             refreshed. Local, so the matcher can be
 *                             re-run and improved without touching the
 *                             network.
 *   cinema_canonical_aliases  one row per title the work is known by, in any
 *                             language. This is what makes the European
 *                             silent era matchable at all — those films are
 *                             uploaded under their original titles, and an
 *                             English-label-only match misses nearly all of
 *                             them.
 *   cinema_title_matches      the decision for each catalogue row, including
 *                             the grey zone awaiting human review.
 *
 * The corpus is deliberately NOT merged into cinema_titles. A work exists
 * whether or not the archive holds a copy, and the same work can be claimed
 * by several uploads — the relationship is many-to-one, and flattening it
 * would make the dedupe pass that follows impossible to express.
 */
export const cinemaCanonicalMigration: Migration = {
  version: 10,
  sql: `
    -- ── The canonical corpus ────────────────────────────────────────
    -- One row per film-as-work. Sourced from Wikidata (CC0); ext_* is a
    -- separate, optional layer written by the TMDb pass, keyed by imdb_id.
    CREATE TABLE IF NOT EXISTS cinema_canonical_works (
      qid            TEXT PRIMARY KEY,          -- e.g. Q151895
      label          TEXT NOT NULL DEFAULT '',  -- display title
      label_norm     TEXT NOT NULL DEFAULT '',  -- normalized display title
      year           INTEGER NOT NULL DEFAULT 0,
      imdb_id        TEXT NOT NULL DEFAULT '',
      director       TEXT NOT NULL DEFAULT '',
      country        TEXT NOT NULL DEFAULT '',
      genre_json     TEXT NOT NULL DEFAULT '[]',
      duration_min   INTEGER NOT NULL DEFAULT 0,
      -- Ratings layer. Absent until the TMDb pass runs, and absent forever
      -- if no API key is configured — the identification half of this
      -- feature does not depend on it.
      ext_rating     REAL NOT NULL DEFAULT 0,
      ext_votes      INTEGER NOT NULL DEFAULT 0,
      ext_source     TEXT NOT NULL DEFAULT '',
      ext_fetched_at TEXT,
      fetched_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cinema_works_year ON cinema_canonical_works(year);
    CREATE INDEX IF NOT EXISTS idx_cinema_works_imdb ON cinema_canonical_works(imdb_id)
      WHERE imdb_id <> '';
    -- Rows still owed a TMDb lookup.
    CREATE INDEX IF NOT EXISTS idx_cinema_works_ext_pending ON cinema_canonical_works(ext_fetched_at)
      WHERE ext_fetched_at IS NULL AND imdb_id <> '';

    -- ── Every title a work is known by ──────────────────────────────
    -- alias_norm is the output of normalizeTitle(), stored so the matcher's
    -- blocking step is an index seek rather than a scan.
    CREATE TABLE IF NOT EXISTS cinema_canonical_aliases (
      qid        TEXT NOT NULL,
      alias_norm TEXT NOT NULL,
      alias_raw  TEXT NOT NULL DEFAULT '',
      lang       TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (qid, alias_norm)
    );
    -- The hot path: given a normalized upload title, which works claim it.
    CREATE INDEX IF NOT EXISTS idx_cinema_alias_norm ON cinema_canonical_aliases(alias_norm);

    -- ── The per-title decision ──────────────────────────────────────
    -- A row here means the matcher has already considered this identifier;
    -- its ABSENCE is the pending signal, mirroring how embedded_at drives
    -- the embedding runner.
    --
    -- state:
    --   auto      cleared the automatic floor, accepted without review
    --   confirmed a human said yes
    --   review    the grey zone, waiting on a human
    --   rejected  a human said no — never re-proposed
    --   none      considered, nothing scored above the floor
    --
    -- "Identified" for ranking and filtering means state IN ('auto','confirmed').
    CREATE TABLE IF NOT EXISTS cinema_title_matches (
      identifier      TEXT PRIMARY KEY,
      qid             TEXT NOT NULL DEFAULT '',
      score           REAL NOT NULL DEFAULT 0,
      state           TEXT NOT NULL DEFAULT 'none'
                      CHECK(state IN ('auto','confirmed','review','rejected','none')),
      -- Ranked runners-up, so the review UI can offer alternatives without
      -- re-running the matcher.
      candidates_json TEXT NOT NULL DEFAULT '[]',
      -- Bumped when the matcher's logic changes; lets a re-run invalidate
      -- machine decisions while leaving human ones alone.
      matcher_version INTEGER NOT NULL DEFAULT 1,
      matched_at      TEXT NOT NULL,
      decided_at      TEXT,
      decided_by      TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_cinema_matches_state ON cinema_title_matches(state);
    CREATE INDEX IF NOT EXISTS idx_cinema_matches_qid   ON cinema_title_matches(qid)
      WHERE qid <> '';

    -- ── Corpus sync bookkeeping ─────────────────────────────────────
    -- Wikidata's SPARQL endpoint times out on a single unbounded film query,
    -- so the pull is sliced (by year) and each slice tracked separately.
    -- A slice that fails is retried on the next pass without redoing the
    -- ones that succeeded.
    CREATE TABLE IF NOT EXISTS cinema_canonical_sync (
      slice      TEXT PRIMARY KEY,          -- e.g. "1927" or "pre-1900"
      works      INTEGER NOT NULL DEFAULT 0,
      aliases    INTEGER NOT NULL DEFAULT 0,
      status     TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending','done','failed')),
      error      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `,
};
