import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Transcription jobs that outlive the request that asked for them.
 *
 * Captioning a feature film is ten to fifteen minutes of wall clock, almost
 * all of it downloading the source and feeding it through ffmpeg — whisper
 * itself is seconds on a GPU. The original design held one HTTP request open
 * for that whole stretch and answered with the finished VTT, which made every
 * interruption fatal and indistinguishable: a proxy read timeout, a tab
 * reload, a kernel restart mid-run all surfaced in the player as a raw
 * gateway error with no way to tell what happened or whether the work was
 * salvageable.
 *
 * The row is the run's memory. `/transcribe/start` creates it and returns
 * immediately; `/transcribe/status` reads it; the finished VTT lands in the
 * existing on-disk cache under the same `key`, so a completed run is already
 * durable and the row only has to describe runs that are NOT finished.
 *
 * `key` is the sha1 the cache has always used — `transcribe|url|engine|model|
 * lang` — so a job, its VTT and its sidecar all share one identity, and
 * restarting a job that already finished is a cache hit rather than a
 * duplicate run.
 *
 * A `running` row whose process is gone (the kernel was restarted mid-run) is
 * a lie that only the next boot can detect, which is why `heartbeat_at`
 * exists: startup sweeps rows claiming to run, and any whose heartbeat
 * predates this process becomes `interrupted` — a state the player can
 * explain and offer to retry, instead of a spinner that never moves.
 */
export const cinemaTranscribeJobsMigration: Migration = {
  version: 18,
  sql: `
    CREATE TABLE IF NOT EXISTS cinema_transcribe_jobs (
      key           TEXT PRIMARY KEY,          -- sha1(transcribe|url|engine|model|lang)
      url           TEXT NOT NULL,
      engine        TEXT NOT NULL,
      model         TEXT NOT NULL,
      lang          TEXT NOT NULL DEFAULT '',
      -- Client-supplied SSE channel id. Progress still streams over
      -- /subs/progress for a watching tab; the row is what a tab that
      -- wasn't watching reads when it comes back.
      job_id        TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'running'
                    CHECK(status IN ('running','ready','error','interrupted')),
      -- Which step of the pipeline is running: probe | extract | load-model
      -- | transcribe. Empty before the first progress tick.
      phase         TEXT NOT NULL DEFAULT '',
      -- 0..1 within the current phase, mirroring what the SSE feed sends.
      frac          REAL NOT NULL DEFAULT 0,
      processed_sec REAL NOT NULL DEFAULT 0,
      total_sec     REAL NOT NULL DEFAULT 0,
      hint          TEXT NOT NULL DEFAULT '',
      cue_count     INTEGER NOT NULL DEFAULT 0,
      error         TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      -- Bumped by the runner as it works. Rows still 'running' with a
      -- heartbeat older than this process started did not survive a restart.
      heartbeat_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cinema_transcribe_jobs_url
      ON cinema_transcribe_jobs(url);
    CREATE INDEX IF NOT EXISTS idx_cinema_transcribe_jobs_status
      ON cinema_transcribe_jobs(status, updated_at DESC);
  `,
};
