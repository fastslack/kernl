/**
 * CanonicalRunner — the background task that builds canonical identity for
 * the catalogue, driven over HTTP so the UI can show a progress bar.
 *
 * Three phases, in the only order they can happen:
 *
 *   corpus   pull Wikidata year slices into the local tables
 *   match    resolve catalogue titles against that corpus
 *   ratings  fetch TMDb scores for the works that got matched
 *
 * They are phases of one runner rather than three separate ones because
 * they are strictly sequential — matching against a half-built corpus
 * produces verdicts that a later slice would have changed — and because a
 * single status endpoint gives the UI one story to tell instead of three
 * bars the user has to sequence by hand.
 *
 * The ratings phase is skipped entirely when no TMDb key is configured. That
 * is not a failure: identification is the half of this feature that fixes the
 * ranking's signal problem, and it does not depend on anyone's API.
 *
 * Shape follows EmbedRunner deliberately — same state machine, same
 * start/stop/snapshot surface — so the two are read and operated the same way.
 */

import { log } from "../../../../../../src/core/logger.js";
import type { SqliteDb } from "../../../../../../src/core/db/sqlite.js";
import { CandidateIndex, matchTitle } from "./matcher.js";
import { CanonicalService } from "./service.js";
import { syncPass, pendingSlices, exhaustedSlices } from "./wikidata.js";
import { fetchRating, type TmdbConfig } from "./tmdb.js";

export type CanonicalRunnerStatus =
  | "idle" | "running" | "stopping" | "stopped" | "done" | "failed";

export type CanonicalPhase = "corpus" | "match" | "ratings";

export interface CanonicalRunnerSnapshot {
  status: CanonicalRunnerStatus;
  phase: CanonicalPhase;
  /** Corpus progress. */
  slices_done: number;
  slices_total: number;
  corpus_works: number;
  /** Match progress. */
  total_titles: number;
  matched: number;
  review: number;
  none: number;
  pending: number;
  /** Ratings progress. */
  ratings_pending: number;
  ratings_enabled: boolean;
  /** This run only; resets on start(). */
  this_run_matched: number;
  rate: number;
  eta_seconds: number | null;
  started_at: string | null;
  finished_at: string | null;
  error: string;
}

export interface CanonicalRunnerStartOptions {
  /** Skip straight to matching, e.g. after tuning the matcher. */
  phase?: CanonicalPhase;
  /** Year slices per corpus pass. */
  slicesPerPass?: number;
  /** Titles per match batch. */
  batchSize?: number;
}

const DEFAULT_SLICES_PER_PASS = 5;
const DEFAULT_BATCH_SIZE = 500;
const MAX_CONSECUTIVE_FAILURES = 5;
/** TMDb's documented ceiling is ~50 req/s; this stays well under it. */
const RATINGS_BATCH = 40;
const RATINGS_DELAY_MS = 1_000;

export class CanonicalRunner {
  private status: CanonicalRunnerStatus = "idle";
  private phase: CanonicalPhase = "corpus";
  private runPromise: Promise<void> | null = null;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private startedAtMs = 0;
  private thisRunMatched = 0;
  private error = "";
  private stopRequested = false;
  private consecutiveFailures = 0;
  private slicesPerPass = DEFAULT_SLICES_PER_PASS;
  private batchSize = DEFAULT_BATCH_SIZE;

  constructor(
    private db: SqliteDb,
    private service: CanonicalService,
    private getTmdb: () => TmdbConfig | null,
    private currentYear: number,
  ) {}

  snapshot(): CanonicalRunnerSnapshot {
    const s = this.service.stats();
    const elapsedSec = this.startedAtMs ? (Date.now() - this.startedAtMs) / 1000 : 0;
    const rate = elapsedSec > 0 ? this.thisRunMatched / elapsedSec : 0;
    return {
      status: this.status,
      phase: this.phase,
      slices_done: s.slices_done,
      slices_total: pendingSlices(this.db, this.currentYear).length + s.slices_done,
      corpus_works: s.corpus_works,
      total_titles: s.total_titles,
      matched: s.matched,
      review: s.review,
      none: s.none,
      pending: s.pending,
      ratings_pending: this.service.countWorksAwaitingRatings(),
      ratings_enabled: this.getTmdb() !== null,
      this_run_matched: this.thisRunMatched,
      rate,
      eta_seconds: this.status === "running" && rate > 0 ? s.pending / rate : null,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      error: this.error,
    };
  }

  /** Idempotent: starting an already-running runner is a no-op. */
  start(opts: CanonicalRunnerStartOptions = {}): CanonicalRunnerSnapshot {
    if (this.status === "running" || this.status === "stopping") return this.snapshot();

    this.slicesPerPass = Math.max(1, Math.min(opts.slicesPerPass ?? DEFAULT_SLICES_PER_PASS, 20));
    this.batchSize = Math.max(1, Math.min(opts.batchSize ?? DEFAULT_BATCH_SIZE, 5000));
    this.phase = opts.phase ?? "corpus";
    this.status = "running";
    this.startedAt = new Date().toISOString();
    this.startedAtMs = Date.now();
    this.finishedAt = null;
    this.thisRunMatched = 0;
    this.error = "";
    this.stopRequested = false;
    this.consecutiveFailures = 0;

    this.runPromise = this.runLoop().catch((err) => {
      this.error = err instanceof Error ? err.message : String(err);
      this.status = "failed";
      this.finishedAt = new Date().toISOString();
      log.error("cinema: canonical runner crashed", err);
    });
    return this.snapshot();
  }

  /** Stop after the current batch. Resolves once the loop has actually exited. */
  async stop(): Promise<CanonicalRunnerSnapshot> {
    if (this.status !== "running") return this.snapshot();
    this.stopRequested = true;
    this.status = "stopping";
    if (this.runPromise) await this.runPromise;
    return this.snapshot();
  }

  private finish(status: CanonicalRunnerStatus): void {
    this.status = status;
    this.finishedAt = new Date().toISOString();
  }

  private async runLoop(): Promise<void> {
    while (true) {
      if (this.stopRequested) return this.finish("stopped");

      try {
        const advanced = await this.step();
        this.consecutiveFailures = 0;
        if (!advanced) return this.finish("done");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.consecutiveFailures++;
        log.warn(
          `cinema canonical runner: ${this.phase} step failed ` +
          `(${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}) — ${msg}`,
        );
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.error = msg;
          return this.finish("failed");
        }
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  }

  /**
   * One unit of work. Returns false when there is nothing left to do at all,
   * which is what ends the run.
   */
  private async step(): Promise<boolean> {
    if (this.phase === "corpus") {
      const r = await syncPass(this.db, this.currentYear, this.slicesPerPass);
      if (!r.finished) {
        // A pass that completed no slices is not progress — it means every
        // attempt failed. Surface it as an error rather than spinning.
        if (r.slices.length === 0) throw new Error("corpus pass completed no slices");
        return true;
      }
      // Say plainly what was not covered. A silently incomplete corpus would
      // show up later as titles that "should have matched" and did not, with
      // nothing pointing at the reason.
      const gaps = exhaustedSlices(this.db);
      if (gaps.length > 0) {
        log.warn(
          `cinema canonical: corpus complete with ${gaps.length} year(s) abandoned — ` +
          gaps.map((g) => `${g.slice} (${g.error.slice(0, 60)})`).join("; "),
        );
      }
      log.info("cinema canonical: corpus complete, moving to matching");
      this.phase = "match";
      return true;
    }

    if (this.phase === "match") {
      const batch = this.service.pendingTitles(this.batchSize);
      if (batch.length === 0) {
        log.info(`cinema canonical: matching complete (${this.thisRunMatched} this run)`);
        this.phase = "ratings";
        return true;
      }
      // One index per batch: its year-block cache is sized for the sequential
      // order pendingTitles() returns, and a fresh one per batch keeps the
      // cached blocks from outliving their usefulness.
      const index = new CandidateIndex(this.db);
      for (const t of batch) {
        if (this.stopRequested) break;
        const outcome = matchTitle(index, t.title, t.year);
        this.service.recordMatch(t.identifier, outcome);
        this.thisRunMatched++;
      }
      return true;
    }

    // ── ratings ──
    const tmdb = this.getTmdb();
    if (!tmdb) {
      log.info("cinema canonical: no TMDb key configured — skipping ratings phase");
      return false;
    }
    const works = this.service.worksAwaitingRatings(RATINGS_BATCH);
    if (works.length === 0) return false;

    for (const w of works) {
      if (this.stopRequested) break;
      try {
        const r = await fetchRating(tmdb, w.imdb_id);
        this.service.recordRating(w.qid, r.rating, r.votes, r.source);
      } catch (err) {
        // A single lookup failing must not sink the pass; stamp it so the
        // work is not retried forever and move on.
        log.warn(`cinema canonical: rating lookup failed for ${w.imdb_id}`, err);
        this.service.recordRating(w.qid, 0, 0, "");
      }
    }
    await new Promise((r) => setTimeout(r, RATINGS_DELAY_MS));
    return true;
  }
}
