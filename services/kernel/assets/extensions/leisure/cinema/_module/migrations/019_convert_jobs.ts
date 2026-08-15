import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Conversions of items no browser can decode.
 *
 * The player's first answer to an undecodable file was a live transcode: one
 * ffmpeg reading the source over HTTPS and muxing fragmented MP4 straight into
 * the response. It cannot work on this material and the numbers say why —
 * archive.org serves these originals at roughly 200 KB/s against a 2291 kb/s
 * source, and because ffmpeg seeks constantly it opens a fresh TLS connection
 * per seek (a single ffprobe of one of these files takes 17-21 seconds).
 * Measured end to end the encode ran at 0.0665x realtime. The viewer got a
 * spinner that never resolved, and nothing was kept: every reopen started over.
 *
 * So the fallback stops streaming and starts finishing. Fetch the file once,
 * sequentially, which is the access pattern the CDN is fast at; convert from
 * local disk, where ffmpeg is no longer network-bound; keep the result. The
 * conversion is slower to first frame and better at everything after it — the
 * cached MP4 is seekable (the live stream never was, hence "no se puede
 * adelantar mientras convierte") and the second viewing costs nothing.
 *
 * `key` is sha1(convert|url), the same identity the file on disk carries, so
 * a finished conversion needs no row to stay useful. As with transcription,
 * `running` rows are swept at boot: the process that owned them is gone.
 */
export const cinemaConvertJobsMigration: Migration = {
  version: 19,
  sql: `
    CREATE TABLE IF NOT EXISTS cinema_convert_jobs (
      key          TEXT PRIMARY KEY,            -- sha1(convert|url)
      url          TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'running'
                   CHECK(status IN ('running','ready','error','interrupted')),
      -- download | convert. The two have very different rates, so the UI
      -- shows which one is running rather than one meaningless bar.
      phase        TEXT NOT NULL DEFAULT '',
      frac         REAL NOT NULL DEFAULT 0,
      -- Bytes for the download phase, seconds of media for the convert phase.
      done_units   REAL NOT NULL DEFAULT 0,
      total_units  REAL NOT NULL DEFAULT 0,
      out_bytes    INTEGER NOT NULL DEFAULT 0,
      error        TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cinema_convert_jobs_url
      ON cinema_convert_jobs(url);
  `,
};
