/**
 * TranslateRunner — long-running background task that fills cinema_titles
 * .description_es by translating the original (English) description via
 * the kernel's LLM chain. Singleton per cinema module instance, driven
 * over HTTP so the UI can poll for progress.
 *
 * Why mirror EmbedRunner's shape: same operational surface (idle / running
 * / done / failed, start with options, stop, snapshot for the UI), same
 * tolerance for transient provider hiccups. Different work unit — one
 * LLM chat call per title instead of a batch embed call.
 *
 * Concurrency: per-title HTTP calls are network-bound, so we issue N in
 * parallel against the kernel chain. The chain itself sequentialises per
 * link's rate limit (NVIDIA NIM ~40 req/sec), so 4-8 in parallel is the
 * sweet spot on a single key. Caller picks via `concurrency`.
 *
 * setDescriptionEs() also NULLs the embed bookkeeping for that row, so
 * a translated title is re-picked by EmbedRunner on its next pass — this
 * is intentional: we want the vector to reflect the ES profile because
 * queries arrive in ES.
 */

import { log } from "../../../../../src/core/logger.js";
import { llm } from "../../../../../src/core/llm/client.js";
import type { CinemaService } from "./service.js";
import type { CinemaTitle } from "./types.js";

export type TranslateRunnerStatus =
  | "idle"
  | "running"
  | "stopping"
  | "stopped"
  | "done"
  | "failed";

export interface TranslateRunnerSnapshot {
  status: TranslateRunnerStatus;
  total_translatable: number;
  translated: number;
  pending: number;
  this_run_translated: number;
  this_run_failed: number;
  concurrency: number;
  last_provider: string;
  last_model: string;
  /** Wall-clock duration (ms) of the most recent batch (N titles in parallel). */
  last_batch_ms: number;
  /** Avg titles/second over the current run. */
  rate: number;
  eta_seconds: number | null;
  started_at: string | null;
  finished_at: string | null;
  error: string;
}

export interface TranslateRunnerStartOptions {
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;
const MAX_CONSECUTIVE_FAILURES = 10;
/** Trim source text fed to the LLM. Most movie descriptions on archive.org
 *  sit under 1500 chars; anything longer is usually credits/recap blocks
 *  that translate badly and waste tokens. */
const MAX_SOURCE_CHARS = 1500;
/** System prompt: stays terse to keep cost down. Neutral Latin American
 *  Spanish is deliberate — most users searching this catalog land here from
 *  Spain or LATAM, and rioplatense flavour would feel off on a movie database. */
const SYSTEM_PROMPT =
  "You are a professional translator. You translate film-catalog synopses and descriptions from English into neutral Latin American Spanish. Preserve proper nouns, film titles and cultural references. Do NOT invent facts, do not add commentary or headings — return ONLY the translated text as a single piece.";

export class TranslateRunner {
  private status: TranslateRunnerStatus = "idle";
  private runPromise: Promise<void> | null = null;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private startedAtMs = 0;
  private thisRunTranslated = 0;
  private thisRunFailed = 0;
  private lastBatchMs = 0;
  private lastProvider = "";
  private lastModel = "";
  private concurrency = DEFAULT_CONCURRENCY;
  private error = "";
  private stopRequested = false;
  private consecutiveFailures = 0;

  constructor(private service: CinemaService) {}

  snapshot(): TranslateRunnerSnapshot {
    const pending = this.service.pendingTranslationCount();
    const translatedTotal = this.service.translatedCount();
    const totalTranslatable = pending + translatedTotal;
    const elapsedSec = this.startedAtMs ? (Date.now() - this.startedAtMs) / 1000 : 0;
    const rate = elapsedSec > 0 ? this.thisRunTranslated / elapsedSec : 0;
    const eta = this.status === "running" && rate > 0 ? pending / rate : null;
    return {
      status: this.status,
      total_translatable: totalTranslatable,
      translated: translatedTotal,
      pending,
      this_run_translated: this.thisRunTranslated,
      this_run_failed: this.thisRunFailed,
      concurrency: this.concurrency,
      last_provider: this.lastProvider,
      last_model: this.lastModel,
      last_batch_ms: this.lastBatchMs,
      rate,
      eta_seconds: eta,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      error: this.error,
    };
  }

  start(opts: TranslateRunnerStartOptions = {}): TranslateRunnerSnapshot {
    if (this.status === "running" || this.status === "stopping") {
      return this.snapshot();
    }
    this.concurrency = Math.max(
      1,
      Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY),
    );
    this.status = "running";
    this.startedAt = new Date().toISOString();
    this.startedAtMs = Date.now();
    this.finishedAt = null;
    this.thisRunTranslated = 0;
    this.thisRunFailed = 0;
    this.lastBatchMs = 0;
    this.error = "";
    this.stopRequested = false;
    this.consecutiveFailures = 0;
    this.runPromise = this.runLoop().catch((err) => {
      this.error = err instanceof Error ? err.message : String(err);
      this.status = "failed";
      this.finishedAt = new Date().toISOString();
      log.error("cinema: translate runner crashed", err);
    });
    return this.snapshot();
  }

  async stop(): Promise<TranslateRunnerSnapshot> {
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
      const ids = this.service.pendingTranslationIds(this.concurrency);
      if (ids.length === 0) {
        this.status = "done";
        this.finishedAt = new Date().toISOString();
        return;
      }
      const titles = ids
        .map((id) => this.service.getByIdentifier(id))
        .filter((t): t is CinemaTitle => t !== null);

      const t0 = Date.now();
      let batchOk = 0;
      let batchFail = 0;
      try {
        // All N requests fire in parallel against the kernel chain — the
        // chain's per-link rate limiter is what actually paces us; we just
        // saturate it from one side.
        const results = await Promise.all(
          titles.map(async (t) => {
            const source = (t.description ?? "").slice(0, MAX_SOURCE_CHARS);
            try {
              const reply = await llm().chat({
                system: SYSTEM_PROMPT,
                user: source,
                temperature: 0.2,
                maxTokens: 800,
                caller: "cinema:translate-runner",
              });
              const text = (reply.text ?? "").trim();
              if (!text) return { id: t.identifier, ok: false as const };
              this.service.setDescriptionEs(t.identifier, text);
              this.lastProvider = reply.provider;
              this.lastModel = reply.model;
              return { id: t.identifier, ok: true as const };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log.warn(`cinema translate: ${t.identifier} failed — ${msg.slice(0, 160)}`);
              return { id: t.identifier, ok: false as const };
            }
          }),
        );
        for (const r of results) {
          if (r.ok) batchOk++;
          else batchFail++;
        }
        this.thisRunTranslated += batchOk;
        this.thisRunFailed += batchFail;
        this.lastBatchMs = Date.now() - t0;
        // A batch where every parallel call failed is "consecutive failure".
        // Any success resets the counter — partial failure is expected and
        // tolerated indefinitely.
        if (batchOk === 0) {
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            this.error = `${MAX_CONSECUTIVE_FAILURES} consecutive all-fail batches — chain looks down`;
            this.status = "failed";
            this.finishedAt = new Date().toISOString();
            return;
          }
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          this.consecutiveFailures = 0;
        }
      } catch (err) {
        this.lastBatchMs = Date.now() - t0;
        this.consecutiveFailures++;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`cinema translate runner: batch failed (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}) — ${msg}`);
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.error = msg;
          this.status = "failed";
          this.finishedAt = new Date().toISOString();
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}
