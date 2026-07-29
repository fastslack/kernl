/**
 * EmbedRunner — long-running background task that batches embeddings
 * until the catalog is fully indexed. Singleton per cinema module
 * instance, started/stopped/queried over HTTP so the UI can drive it
 * with a progress bar.
 *
 * Why a singleton instead of a per-request task: the underlying work
 * (LMStudio bge-m3 → Neo4j vector index write) is bandwidth-bound on
 * one connection. Two parallel runs would just thrash. The singleton
 * also gives the UI a single source of truth to poll for progress.
 *
 * State machine:
 *   idle  → start() → running → done | failed | stopped
 *   running → stop() → stopping → stopped
 *
 * Errors during a batch don't kill the run by default; we tolerate up
 * to N consecutive failures before flipping to 'failed'. This handles
 * transient LMStudio glitches without forcing the user to manually
 * resume.
 */

import { log } from "../../../../../src/core/logger.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { EmbeddingsClient } from "../../../../../src/core/embeddings/index.js";
import type { CinemaService } from "./service.js";
import { embedPending } from "./embeddings.js";

export type EmbedRunnerStatus =
  | "idle"
  | "running"
  | "stopping"
  | "stopped"
  | "done"
  | "failed";

export interface EmbedRunnerSnapshot {
  status: EmbedRunnerStatus;
  total_titles: number;
  embedded: number;
  pending: number;
  /** How many titles this current run has embedded so far. Resets on start(). */
  this_run_embedded: number;
  /** Size of the embedding batch (configurable per start). */
  batch_size: number;
  /** Wall-clock duration (ms) of the most recent embedPending() call. */
  last_batch_ms: number;
  /** Average rate over this run, items/second. */
  rate: number;
  /** Estimated seconds remaining at current rate. null if not running. */
  eta_seconds: number | null;
  started_at: string | null;
  finished_at: string | null;
  error: string;
  model: string;
  dim: number;
}

export interface EmbedRunnerStartOptions {
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 128;
const MAX_CONSECUTIVE_FAILURES = 5;
/** Pause between batches when the embedder is healthy. Zero means run as
 *  fast as the embedder allows. */
const INTER_BATCH_DELAY_MS = 0;
/** Cooldown when the upstream returns 429. NVIDIA NIM free-tier limits are
 *  per-minute, so 60s clears most windows; we cap consecutive 429 cooldowns
 *  at 5min to avoid a runaway exponential. Does NOT tick the consecutive
 *  failure counter — rate limit is not a "provider down" signal. */
const RATE_LIMIT_BASE_COOLDOWN_MS = 60_000;
const RATE_LIMIT_MAX_COOLDOWN_MS  = 5 * 60_000;

export class EmbedRunner {
  private status: EmbedRunnerStatus = "idle";
  private runPromise: Promise<void> | null = null;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private startedAtMs = 0;
  private thisRunEmbedded = 0;
  private lastBatchMs = 0;
  private batchSize = DEFAULT_BATCH_SIZE;
  private error = "";
  private stopRequested = false;
  private consecutiveFailures = 0;

  constructor(
    private service: CinemaService,
    private getEmbedder: () => EmbeddingsClient | null,
    private getGraph: () => GraphDriver | null,
  ) {}

  snapshot(): EmbedRunnerSnapshot {
    const total = this.service.countAll();
    const embedder = this.getEmbedder();
    const pending = embedder
      ? this.service.pendingEmbeddingIds(embedder.model, embedder.dim, 999_999_999).length
      : 0;
    const elapsedSec = this.startedAtMs ? (Date.now() - this.startedAtMs) / 1000 : 0;
    const rate = elapsedSec > 0 ? this.thisRunEmbedded / elapsedSec : 0;
    const eta = (this.status === "running" && rate > 0)
      ? pending / rate
      : null;
    return {
      status: this.status,
      total_titles: total,
      embedded: total - pending,
      pending,
      this_run_embedded: this.thisRunEmbedded,
      batch_size: this.batchSize,
      last_batch_ms: this.lastBatchMs,
      rate,
      eta_seconds: eta,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      error: this.error,
      model: embedder?.model ?? "",
      dim: embedder?.dim ?? 0,
    };
  }

  /** Idempotent: calling start() while already running is a no-op. */
  start(opts: EmbedRunnerStartOptions = {}): EmbedRunnerSnapshot {
    if (this.status === "running" || this.status === "stopping") {
      return this.snapshot();
    }
    const embedder = this.getEmbedder();
    const graph = this.getGraph();
    if (!embedder) throw new Error("embeddings client not initialised");
    if (!graph?.capabilities.cypher) throw new Error("graph driver unavailable — neo4j down");

    this.batchSize = Math.max(1, Math.min(opts.batchSize ?? DEFAULT_BATCH_SIZE, 256));
    this.status = "running";
    this.startedAt = new Date().toISOString();
    this.startedAtMs = Date.now();
    this.finishedAt = null;
    this.thisRunEmbedded = 0;
    this.lastBatchMs = 0;
    this.error = "";
    this.stopRequested = false;
    this.consecutiveFailures = 0;
    this.runPromise = this.runLoop().catch((err) => {
      this.error = err instanceof Error ? err.message : String(err);
      this.status = "failed";
      this.finishedAt = new Date().toISOString();
      log.error("cinema: embed runner crashed", err);
    });
    return this.snapshot();
  }

  /** Request the loop to stop after the current batch. Resolves when the
   *  loop has actually exited (status=stopped). */
  async stop(): Promise<EmbedRunnerSnapshot> {
    if (this.status !== "running") return this.snapshot();
    this.stopRequested = true;
    this.status = "stopping";
    if (this.runPromise) await this.runPromise;
    return this.snapshot();
  }

  private async runLoop(): Promise<void> {
    const embedder = this.getEmbedder();
    const graph = this.getGraph();
    if (!embedder || !graph) {
      this.error = "missing embedder or graph at runtime";
      this.status = "failed";
      this.finishedAt = new Date().toISOString();
      return;
    }

    let consecutiveRateLimits = 0;

    while (true) {
      if (this.stopRequested) {
        this.status = "stopped";
        this.finishedAt = new Date().toISOString();
        return;
      }
      const t0 = Date.now();
      try {
        const r = await embedPending(this.service, embedder, graph, this.batchSize);
        this.lastBatchMs = Date.now() - t0;
        // `attempted === 0` is the only true "no more pending rows" signal.
        // `embedded === 0` used to double as a done check, but now a batch
        // may legitimately embed zero rows when every row was too long and
        // got skip-stamped — we still want to advance to the next batch.
        if (r.attempted === 0) {
          this.status = "done";
          this.finishedAt = new Date().toISOString();
          return;
        }
        this.thisRunEmbedded += r.embedded;
        this.consecutiveFailures = 0;
        consecutiveRateLimits = 0;
      } catch (err) {
        this.lastBatchMs = Date.now() - t0;
        const msg = err instanceof Error ? err.message : String(err);
        // Rate-limit is NOT a "provider down" signal — back off and resume
        // without ticking the consecutive-failure counter. Cooldown grows
        // exponentially per consecutive 429 burst and resets on first
        // success above.
        const isRateLimit =
          msg.includes("429") ||
          /Too Many Requests/i.test(msg) ||
          /rate.?limit/i.test(msg);
        if (isRateLimit) {
          consecutiveRateLimits++;
          const cooldown = Math.min(
            RATE_LIMIT_BASE_COOLDOWN_MS * Math.pow(2, consecutiveRateLimits - 1),
            RATE_LIMIT_MAX_COOLDOWN_MS,
          );
          log.warn(
            `cinema embed runner: rate-limited (burst #${consecutiveRateLimits}) — ` +
            `cooling down ${Math.round(cooldown / 1000)}s before retry`,
          );
          await new Promise((r) => setTimeout(r, cooldown));
          continue;
        }
        this.consecutiveFailures++;
        log.warn(`cinema embed runner: batch failed (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}) — ${msg}`);
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.error = msg;
          this.status = "failed";
          this.finishedAt = new Date().toISOString();
          return;
        }
        // Back off on transient errors so we don't hammer a flaky upstream.
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (INTER_BATCH_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, INTER_BATCH_DELAY_MS));
      }
    }
  }
}
