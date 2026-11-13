/**
 * Background runner for candidate proposal.
 *
 * One full-text query per unmatched title over ~120k titles is minutes of work,
 * so it is a loop that can be stopped, resumed, and watched; its cursor lives in
 * `cinema_graph_cursors` (the table the old graph projection kept its cursors
 * in). The component pass that follows is one read of the candidates and is
 * invoked directly rather than looped.
 */

import { log, type SqliteDb } from "@kernl/extension-sdk";
import { DEFAULT_RESOLVE_BATCH, proposeBatch } from "./alias-resolve.js";

const ENTITY = "resolve";

interface CursorRow { cursor: string; projected: number; done: number }

function readCursor(db: SqliteDb, entity: string): CursorRow {
  const row = db
    .prepare("SELECT cursor, projected, done FROM cinema_graph_cursors WHERE entity = ?")
    .get(entity) as CursorRow | undefined;
  return row ?? { cursor: "", projected: 0, done: 0 };
}

function writeCursor(db: SqliteDb, entity: string, cursor: string, projected: number, done: boolean): void {
  db.prepare(
    `INSERT INTO cinema_graph_cursors (entity, cursor, projected, done, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity) DO UPDATE SET
       cursor = excluded.cursor, projected = excluded.projected,
       done = excluded.done, updated_at = excluded.updated_at`,
  ).run(entity, cursor, projected, done ? 1 : 0, new Date().toISOString());
}
const MAX_CONSECUTIVE_FAILURES = 5;

export type ResolveStatus = "idle" | "running" | "stopping" | "stopped" | "done" | "failed";

export interface ResolveSnapshot {
  status: ResolveStatus;
  cursor: string;
  titles_scanned: number;
  titles_with_candidates: number;
  candidates_written: number;
  batch_size: number;
  rate: number;
  started_at: string | null;
  finished_at: string | null;
  error: string;
}

export class AliasResolveRunner {
  private status: ResolveStatus = "idle";
  private runPromise: Promise<void> | null = null;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private startedAtMs = 0;
  private scanned = 0;
  private withCandidates = 0;
  private candidates = 0;
  private batchSize = DEFAULT_RESOLVE_BATCH;
  private error = "";
  private stopRequested = false;
  private failures = 0;

  constructor(private db: SqliteDb) {}

  snapshot(): ResolveSnapshot {
    const elapsed = this.startedAtMs > 0 ? (Date.now() - this.startedAtMs) / 1000 : 0;
    return {
      status: this.status,
      cursor: readCursor(this.db, ENTITY).cursor,
      titles_scanned: this.scanned,
      titles_with_candidates: this.withCandidates,
      candidates_written: this.candidates,
      batch_size: this.batchSize,
      rate: elapsed > 0 ? this.scanned / elapsed : 0,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      error: this.error,
    };
  }

  start(opts: { batchSize?: number; reset?: boolean } = {}): ResolveSnapshot {
    if (this.status === "running" || this.status === "stopping") return this.snapshot();
    if (opts.reset) writeCursor(this.db, ENTITY, "", 0, false);

    this.batchSize = Math.max(50, Math.min(opts.batchSize ?? DEFAULT_RESOLVE_BATCH, 5000));
    this.status = "running";
    this.startedAt = new Date().toISOString();
    this.startedAtMs = Date.now();
    this.finishedAt = null;
    this.scanned = 0;
    this.withCandidates = 0;
    this.candidates = 0;
    this.error = "";
    this.stopRequested = false;
    this.failures = 0;
    this.runPromise = this.runLoop().catch((err) => {
      this.error = err instanceof Error ? err.message : String(err);
      this.status = "failed";
      this.finishedAt = new Date().toISOString();
      log.error("cinema: candidate proposal crashed", err);
    });
    return this.snapshot();
  }

  async stop(): Promise<ResolveSnapshot> {
    if (this.status !== "running") return this.snapshot();
    this.stopRequested = true;
    this.status = "stopping";
    if (this.runPromise) await this.runPromise;
    return this.snapshot();
  }

  private async runLoop(): Promise<void> {
    while (!this.stopRequested) {
      const state = readCursor(this.db, ENTITY);
      try {
        const batch = proposeBatch(this.db, state.cursor, this.batchSize);
        // Yield between batches: they are synchronous SQLite work.
        await new Promise((r) => setTimeout(r, 0));
        if (batch.titles === 0) {
          writeCursor(this.db, ENTITY, state.cursor, state.projected, true);
          this.status = "done";
          this.finishedAt = new Date().toISOString();
          log.info(
            `cinema resolve: proposal pass complete — ${this.scanned} titles scanned, ` +
            `${this.withCandidates} with candidates, ${this.candidates} candidates`,
          );
          return;
        }
        this.scanned += batch.titles;
        this.withCandidates += batch.withCandidates;
        this.candidates += batch.candidates;
        this.failures = 0;
        writeCursor(this.db, ENTITY, batch.cursor, state.projected + batch.titles, false);
      } catch (err) {
        this.failures++;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`cinema resolve: batch failed (${this.failures}/${MAX_CONSECUTIVE_FAILURES}) — ${msg}`);
        if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
          this.error = msg;
          this.status = "failed";
          this.finishedAt = new Date().toISOString();
          return;
        }
        await new Promise((r) => setTimeout(r, 2000 * this.failures));
      }
    }
    this.status = "stopped";
    this.finishedAt = new Date().toISOString();
  }
}
