/**
 * TranscribeJobService — captioning runs that outlive the request.
 *
 * The player used to ask for subtitles with one HTTP GET that stayed open for
 * the entire run and answered with the finished VTT. On a feature film that is
 * ten to fifteen minutes of held-open socket, and every way of losing it
 * looked identical from the browser: a proxy read timeout, a reload, a kernel
 * restart mid-run all arrived as a bare gateway error. Worse, the work went
 * with the socket — there was nothing to come back to.
 *
 * Here the request only *starts* the run. `start()` returns as soon as the job
 * is registered; the work continues server-side and its progress is written to
 * `cinema_transcribe_jobs`, so any tab (or the same tab after a reload) can ask
 * `status()` and get a real answer. The finished VTT goes where it always went
 * — the on-disk cache keyed by the same sha1 — which means a completed run
 * needs no row at all to stay durable.
 *
 * Three behaviours are load-bearing:
 *
 *  1. COALESCED. Two tabs asking for the same (url, engine, model, lang) join
 *     one run. The key is the cache key, so "already running" and "already
 *     cached" are the same question asked at different times.
 *  2. RESUMABLE. `sweepInterrupted()` runs at boot and marks rows that claim to
 *     be running but whose process is gone. That is a state the player can
 *     explain — "interrupted, retry?" — rather than a spinner waiting on a
 *     promise nobody is keeping.
 *  3. INJECTED RUNNER. The actual transcode is passed in, so tests never spawn
 *     ffmpeg or whisper.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";

export type TranscribeJobState = "running" | "ready" | "error" | "interrupted";

export interface TranscribeJobParams {
  key: string;
  url: string;
  engine: string;
  model: string;
  lang: string;
  /** SSE channel the requesting tab is listening on, when it is. */
  jobId?: string;
}

export interface TranscribeJobStatus {
  key: string;
  url: string;
  engine: string;
  model: string;
  lang: string;
  jobId: string;
  status: TranscribeJobState;
  phase: string;
  frac: number;
  processedSec: number;
  totalSec: number;
  hint: string;
  cueCount: number;
  error: string;
  updatedAt: string;
}

export interface TranscribeRunProgress {
  subPhase: string;
  frac: number;
  processedSec?: number;
  totalSec?: number;
  hint?: string;
}

/**
 * Does the work and persists the VTT wherever the cache lives. Returns the cue
 * count for the status row; the bytes themselves are read back through the
 * existing `/subs/file?key=` route, so they never pass through this service.
 */
export type TranscribeRunner = (
  params: TranscribeJobParams,
  onProgress: (p: TranscribeRunProgress) => void,
) => Promise<{ cueCount: number }>;

interface JobRow {
  key: string;
  url: string;
  engine: string;
  model: string;
  lang: string;
  job_id: string;
  status: TranscribeJobState;
  phase: string;
  frac: number;
  processed_sec: number;
  total_sec: number;
  hint: string;
  cue_count: number;
  error: string;
  updated_at: string;
}

/**
 * Progress arrives at roughly 10 Hz from ffmpeg and whisper. The SSE feed wants
 * every tick — it is what makes the bar move — but SQLite does not: a write per
 * tick is thousands of transactions per film for data whose only reader polls
 * every second or two. Ticks always update the in-memory job; the row is
 * written at most this often, plus unconditionally on every terminal state.
 */
const ROW_WRITE_INTERVAL_MS = 1_000;

interface LiveJob {
  status: TranscribeJobStatus;
  promise: Promise<void>;
  lastRowWrite: number;
}

export class TranscribeJobService {
  private readonly live = new Map<string, LiveJob>();

  constructor(
    private readonly db: SqliteDb,
    private readonly run: TranscribeRunner,
  ) {}

  /**
   * Mark rows left `running` by a process that is no longer here.
   *
   * Called once at startup. Anything still claiming to run at this point
   * cannot be — this process just started and owns no jobs yet — so the
   * distinction the sweep draws is simply "row says running, memory says
   * nothing", which is exactly what a restart mid-run leaves behind.
   *
   * Returns how many it corrected, for the boot log.
   */
  sweepInterrupted(): number {
    const now = isoNow();
    const rows = this.db
      .prepare(`SELECT key FROM cinema_transcribe_jobs WHERE status = 'running'`)
      .all() as Array<{ key: string }>;
    if (rows.length === 0) return 0;
    this.db
      .prepare(
        `UPDATE cinema_transcribe_jobs
            SET status = 'interrupted',
                error = 'the kernel restarted while this was running',
                updated_at = ?
          WHERE status = 'running'`,
      )
      .run(now);
    return rows.length;
  }

  /**
   * Register (or join) a run and return immediately.
   *
   * `alreadyDone` lets the caller answer the cache question — it owns the cache
   * directory, this service does not. When it says the VTT is on disk the job
   * is reported ready without touching the runner, which is what makes a
   * second tab, a reload, or a retry after a finished run free.
   */
  start(params: TranscribeJobParams, alreadyDone: { cueCount: number } | null): TranscribeJobStatus {
    const existing = this.live.get(params.key);
    if (existing) {
      // A second tab wants progress on its own SSE channel. Adopt the newer
      // channel id so the row points at a listener that actually exists.
      if (params.jobId && params.jobId !== existing.status.jobId) {
        existing.status.jobId = params.jobId;
      }
      return { ...existing.status };
    }

    if (alreadyDone) {
      const done = this.seed(params, "ready", alreadyDone.cueCount);
      this.writeRow(done);
      return done;
    }

    const status = this.seed(params, "running", 0);
    this.writeRow(status);

    const job: LiveJob = {
      status,
      lastRowWrite: Date.now(),
      promise: Promise.resolve(),
    };
    this.live.set(params.key, job);

    job.promise = (async () => {
      try {
        const { cueCount } = await this.run(params, (p) => {
          status.phase = p.subPhase;
          status.frac = p.frac;
          status.processedSec = p.processedSec ?? 0;
          status.totalSec = p.totalSec ?? 0;
          status.hint = p.hint ?? "";
          status.updatedAt = isoNow();
          const now = Date.now();
          if (now - job.lastRowWrite >= ROW_WRITE_INTERVAL_MS) {
            job.lastRowWrite = now;
            this.writeRow(status);
          }
        });
        status.status = "ready";
        status.cueCount = cueCount;
        status.frac = 1;
        status.error = "";
      } catch (err) {
        status.status = "error";
        status.error = err instanceof Error ? err.message : String(err);
        log.error(`cinema/transcribe: job ${params.key.slice(0, 8)} failed`, err);
      } finally {
        status.updatedAt = isoNow();
        this.writeRow(status);
        // Drop the in-memory entry only after the row is durable, so a status
        // poll landing in this window reads the terminal row rather than
        // finding neither.
        this.live.delete(params.key);
      }
    })();

    return { ...status };
  }

  /** Live job if one is running here, else the stored row, else null. */
  status(key: string): TranscribeJobStatus | null {
    const live = this.live.get(key);
    if (live) return { ...live.status };
    const row = this.db
      .prepare(`SELECT * FROM cinema_transcribe_jobs WHERE key = ?`)
      .get(key) as JobRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  /** Every job recorded for a source URL, newest first. Drives retry UI. */
  listForUrl(url: string): TranscribeJobStatus[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM cinema_transcribe_jobs WHERE url = ? ORDER BY updated_at DESC`,
      )
      .all(url) as JobRow[];
    return rows.map((r) => this.fromRow(r)).map((s) => {
      const live = this.live.get(s.key);
      return live ? { ...live.status } : s;
    });
  }

  /** Await the run — tests and the compatibility blocking route use this. */
  async join(key: string): Promise<void> {
    await this.live.get(key)?.promise;
  }

  /** True while this process is working on that key. */
  isRunning(key: string): boolean {
    return this.live.has(key);
  }

  private seed(
    params: TranscribeJobParams,
    status: TranscribeJobState,
    cueCount: number,
  ): TranscribeJobStatus {
    return {
      key: params.key,
      url: params.url,
      engine: params.engine,
      model: params.model,
      lang: params.lang,
      jobId: params.jobId ?? "",
      status,
      phase: "",
      frac: status === "ready" ? 1 : 0,
      processedSec: 0,
      totalSec: 0,
      hint: "",
      cueCount,
      error: "",
      updatedAt: isoNow(),
    };
  }

  private fromRow(r: JobRow): TranscribeJobStatus {
    return {
      key: r.key,
      url: r.url,
      engine: r.engine,
      model: r.model,
      lang: r.lang,
      jobId: r.job_id,
      status: r.status,
      phase: r.phase,
      frac: r.frac,
      processedSec: r.processed_sec,
      totalSec: r.total_sec,
      hint: r.hint,
      cueCount: r.cue_count,
      error: r.error,
      updatedAt: r.updated_at,
    };
  }

  private writeRow(s: TranscribeJobStatus): void {
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO cinema_transcribe_jobs
           (key, url, engine, model, lang, job_id, status, phase, frac,
            processed_sec, total_sec, hint, cue_count, error,
            created_at, updated_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
            job_id        = excluded.job_id,
            status        = excluded.status,
            phase         = excluded.phase,
            frac          = excluded.frac,
            processed_sec = excluded.processed_sec,
            total_sec     = excluded.total_sec,
            hint          = excluded.hint,
            cue_count     = excluded.cue_count,
            error         = excluded.error,
            updated_at    = excluded.updated_at,
            heartbeat_at  = excluded.heartbeat_at`,
      )
      .run(
        s.key, s.url, s.engine, s.model, s.lang, s.jobId, s.status, s.phase,
        s.frac, s.processedSec, s.totalSec, s.hint, s.cueCount, s.error,
        now, s.updatedAt, now,
      );
  }
}
