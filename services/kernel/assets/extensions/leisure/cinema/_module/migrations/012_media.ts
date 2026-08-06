import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * File-level facts, probed from archive.org's metadata endpoint.
 *
 * The catalogue's `runtime_sec` comes from the scrape API and is 0 across a
 * large part of the table, and its only playability signal is `has_torrent`
 * — the presence of a `format:"Archive BitTorrent"` file. Both are weaker
 * than they look. `HisNewJobCharlesChaplin-1915` is in the top handful of
 * `feature_films` by downloads, has a torrent, and contains no video file at
 * all: the torrent bundles a thumbnail and five metadata files.
 *
 * A row here is the answer to "what is actually in this item". It enables the
 * filters that do more for perceived quality than any reranking — a minimum
 * duration removes the 40-second clips and test patterns, a minimum height
 * removes the unwatchable transfers, and `has_streamable` removes the items
 * that cannot be played at all.
 *
 * Absence of a row means "not probed yet", matching how `embedded_at IS NULL`
 * and the canonical match tables signal pending work. A probe that found
 * nothing still writes a row: "this item holds no video" is a finding, and
 * re-asking forever would starve the rest of the catalogue.
 */
export const cinemaMediaMigration: Migration = {
  version: 12,
  sql: `
    CREATE TABLE IF NOT EXISTS cinema_title_media (
      identifier     TEXT PRIMARY KEY,
      -- Real duration, from the longest video file. 0 when the item reported
      -- none, which is itself a weak signal that there is nothing there.
      duration_sec   INTEGER NOT NULL DEFAULT 0,
      width          INTEGER NOT NULL DEFAULT 0,
      height         INTEGER NOT NULL DEFAULT 0,
      -- Any video file, in any format.
      has_video      INTEGER NOT NULL DEFAULT 0,
      -- A format the player can stream (h.264 / MPEG4 / WebM / Ogg). An item
      -- whose only video is a RealMedia original is technically playable and
      -- practically is not.
      has_streamable INTEGER NOT NULL DEFAULT 0,
      has_subtitles  INTEGER NOT NULL DEFAULT 0,
      video_count    INTEGER NOT NULL DEFAULT 0,
      total_bytes    INTEGER NOT NULL DEFAULT 0,
      best_format    TEXT NOT NULL DEFAULT '',
      probed_at      TEXT NOT NULL,
      -- Non-empty when the probe itself failed, which is different from
      -- succeeding and finding nothing.
      error          TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_cinema_media_duration ON cinema_title_media(duration_sec);
    CREATE INDEX IF NOT EXISTS idx_cinema_media_height   ON cinema_title_media(height);
    CREATE INDEX IF NOT EXISTS idx_cinema_media_playable ON cinema_title_media(has_streamable);
  `,
};
