/**
 * MediaProbeRunner — walks the catalogue asking archive.org what each item
 * actually contains.
 *
 * Separate from the canonical runner because the two answer unrelated
 * questions and neither needs the other: identity comes from Wikidata,
 * contents come from the item itself. Chaining them would only mean a
 * network stall on one blocking the other.
 *
 * Ordered by downloads, so the items a user is most likely to open are
 * probed first and the feature becomes useful long before the walk finishes.
 *
 * Probes run in small concurrent batches. This is a per-item HTTP call
 * against a public endpoint — serial would be needlessly slow, and anything
 * wide would be rude to infrastructure the project depends on.
 */

import { log } from "../../../../../src/core/logger.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import {
  probeItem,
  recordFacts,
  recordProbeError,
  pendingProbes,
  countPendingProbes,
} from "./archive-files.js";

export type MediaRunnerStatus =
  | "idle" | "running" | "stopping" | "stopped" | "done" | "failed";

export interface MediaRunnerSnapshot {
  status: MediaRunnerStatus;
  total_titles: number;
  probed: number;
  pending: number;
  /** What the probes have found so far, catalogue-wide. */
  playable: number;
  no_video: number;
  with_subtitles: number;
  this_run_probed: number;
  concurrency: number;
  rate: number;
  eta_seconds: number | null;
  started_at: string | null;
  finished_at: string | null;
  error: string;
}

export interface MediaRunnerStartOptions {
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const MAX_CONSECUTIVE_FAILURES = 5;
/** Breather between batches — this is free infrastructure. */
const BATCH_DELAY_MS = 250;

export class MediaProbeRunner {
  private status: MediaRunnerStatus = "idle";
  private runPromise: Promise<void> | null = null;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private startedAtMs = 0;
  private thisRunProbed = 0;
  private concurrency = DEFAULT_CONCURRENCY;
  private error = "";
  private stopRequested = false;
  private consecutiveFailures = 0;

  constructor(private db: SqliteDb) {}

  snapshot(): MediaRunnerSnapshot {
    const one = (sql: string): number =>
      ((this.db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);

    const total = one(
      `SELECT COUNT(*) AS n FROM cinema_titles WHERE deleted_at IS NULL AND hidden = 0`,
    );
    const pending = countPendingProbes(this.db);
    const elapsedSec = this.startedAtMs ? (Date.now() - this.startedAtMs) / 1000 : 0;
    const rate = elapsedSec > 0 ? this.thisRunProbed / elapsedSec : 0;

    return {
      status: this.status,
      total_titles: total,
      probed: total - pending,
      pending,
      playable: one(`SELECT COUNT(*) AS n FROM cinema_title_media WHERE has_streamable = 1`),
      no_video: one(`SELECT COUNT(*) AS n FROM cinema_title_media WHERE has_video = 0 AND error = ''`),
      with_subtitles: one(`SELECT COUNT(*) AS n FROM cinema_title_media WHERE has_subtitles = 1`),
      this_run_probed: this.thisRunProbed,
      concurrency: this.concurrency,
      rate,
      eta_seconds: this.status === "running" && rate > 0 ? pending / rate : null,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      error: this.error,
    };
  }

  /** Idempotent: starting an already-running runner is a no-op. */
  start(opts: MediaRunnerStartOptions = {}): MediaRunnerSnapshot {
    if (this.status === "running" || this.status === "stopping") return this.snapshot();

    this.concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY));
    this.status = "running";
    this.startedAt = new Date().toISOString();
    this.startedAtMs = Date.now();
    this.finishedAt = null;
    this.thisRunProbed = 0;
    this.error = "";
    this.stopRequested = false;
    this.consecutiveFailures = 0;

    this.runPromise = this.runLoop().catch((err) => {
      this.error = err instanceof Error ? err.message : String(err);
      this.status = "failed";
      this.finishedAt = new Date().toISOString();
      log.error("cinema: media probe runner crashed", err);
    });
    return this.snapshot();
  }

  async stop(): Promise<MediaRunnerSnapshot> {
    if (this.status !== "running") return this.snapshot();
    this.stopRequested = true;
    this.status = "stopping";
    if (this.runPromise) await this.runPromise;
    return this.snapshot();
  }

  private async runLoop(): Promise<void> {
    while (true) {
      if (this.stopRequested) {
        this.status = "stopped";
        this.finishedAt = new Date().toISOString();
        return;
      }

      const batch = pendingProbes(this.db, this.concurrency);
      if (batch.length === 0) {
        this.status = "done";
        this.finishedAt = new Date().toISOString();
        log.info(`cinema media: probing complete (${this.thisRunProbed} this run)`);
        return;
      }

      // Every probe settles. A single item that 404s or times out is recorded
      // as failed and dropped from the pending set — otherwise it would be
      // handed back on the next iteration forever and the walk would never
      // reach the rest of the catalogue.
      const results = await Promise.allSettled(
        batch.map(async (id) => {
          try {
            recordFacts(this.db, id, await probeItem(id));
          } catch (err) {
            recordProbeError(this.db, id, err instanceof Error ? err.message : String(err));
            throw err;
          }
        }),
      );
      this.thisRunProbed += batch.length;

      // Only a whole batch failing suggests the endpoint is down rather than
      // the items being bad; individual failures are expected and already
      // recorded.
      if (results.every((r) => r.status === "rejected")) {
        this.consecutiveFailures++;
        log.warn(
          `cinema media: entire batch failed ` +
          `(${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.error = "archive.org metadata endpoint unreachable";
          this.status = "failed";
          this.finishedAt = new Date().toISOString();
          return;
        }
        await new Promise((r) => setTimeout(r, 5_000));
      } else {
        this.consecutiveFailures = 0;
      }

      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }
}
