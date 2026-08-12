/**
 * Background runner for the catalogue → graph projection.
 *
 * Same lifecycle as `EmbedRunner` (idle → running → done|failed|stopped) and
 * for the same reason: projecting ~1.2M rows is minutes of work, so it cannot
 * happen inside a request, and it has to survive being interrupted.
 *
 * The projection itself is in `graph-projection.ts` and is a pure sequence of
 * batches. This owns only the loop, the failure backoff, and the numbers the
 * dashboard shows.
 */

import { log } from "../../../../../src/core/logger.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import {
  DEFAULT_BATCH_SIZE,
  ensureProjectionSchema,
  projectTick,
  projectionProgress,
  resetCursors,
  type CursorRow,
} from "./graph-projection.js";

export type GraphProjectionStatus =
  | "idle"
  | "running"
  | "stopping"
  | "stopped"
  | "done"
  | "failed";

export interface GraphProjectionSnapshot {
  status: GraphProjectionStatus;
  /** Per-entity cursors: where each table's walk currently stands. */
  entities: CursorRow[];
  nodes_written: number;
  rels_written: number;
  rows_read: number;
  batch_size: number;
  last_batch_ms: number;
  /** Rows/second over this run. */
  rate: number;
  started_at: string | null;
  finished_at: string | null;
  error: string;
}

export interface GraphProjectionStartOptions {
  batchSize?: number;
  /** Rewind every cursor first, to re-walk tables and pick up changed rows. */
  reset?: boolean;
}

const MAX_CONSECUTIVE_FAILURES = 5;
/** Breather between batches. The projection competes with the embedding worker
 *  and with live queries for the same Neo4j; running flat out would make the
 *  UI stutter for a job nobody is waiting on. */
const INTER_BATCH_DELAY_MS = 50;

export class GraphProjectionRunner {
  private status: GraphProjectionStatus = "idle";
  private runPromise: Promise<void> | null = null;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private startedAtMs = 0;
  private nodesWritten = 0;
  private relsWritten = 0;
  private rowsRead = 0;
  private lastBatchMs = 0;
  private batchSize = DEFAULT_BATCH_SIZE;
  private error = "";
  private stopRequested = false;
  private consecutiveFailures = 0;

  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
  ) {}

  snapshot(): GraphProjectionSnapshot {
    const elapsedSec = this.startedAtMs > 0 ? (Date.now() - this.startedAtMs) / 1000 : 0;
    return {
      status: this.status,
      entities: projectionProgress(this.db),
      nodes_written: this.nodesWritten,
      rels_written: this.relsWritten,
      rows_read: this.rowsRead,
      batch_size: this.batchSize,
      last_batch_ms: this.lastBatchMs,
      rate: elapsedSec > 0 ? this.rowsRead / elapsedSec : 0,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      error: this.error,
    };
  }

  /** Idempotent: starting an already-running projection is a no-op. */
  start(opts: GraphProjectionStartOptions = {}): GraphProjectionSnapshot {
    if (this.status === "running" || this.status === "stopping") {
      return this.snapshot();
    }
    const graph = this.getGraph();
    if (!graph?.capabilities.cypher) {
      throw new Error("graph driver unavailable — activate Neo4j in /extensions");
    }
    if (opts.reset) resetCursors(this.db);

    this.batchSize = Math.max(100, Math.min(opts.batchSize ?? DEFAULT_BATCH_SIZE, 10_000));
    this.status = "running";
    this.startedAt = new Date().toISOString();
    this.startedAtMs = Date.now();
    this.finishedAt = null;
    this.nodesWritten = 0;
    this.relsWritten = 0;
    this.rowsRead = 0;
    this.lastBatchMs = 0;
    this.error = "";
    this.stopRequested = false;
    this.consecutiveFailures = 0;
    this.runPromise = this.runLoop().catch((err) => {
      this.error = err instanceof Error ? err.message : String(err);
      this.status = "failed";
      this.finishedAt = new Date().toISOString();
      log.error("cinema: graph projection crashed", err);
    });
    return this.snapshot();
  }

  /** Ask the loop to stop after the current batch; resolves once it has. */
  async stop(): Promise<GraphProjectionSnapshot> {
    if (this.status !== "running") return this.snapshot();
    this.stopRequested = true;
    this.status = "stopping";
    if (this.runPromise) await this.runPromise;
    return this.snapshot();
  }

  private async runLoop(): Promise<void> {
    const graph = this.getGraph();
    if (!graph) {
      this.error = "graph driver vanished at runtime";
      this.status = "failed";
      this.finishedAt = new Date().toISOString();
      return;
    }

    // Constraints must exist before the first MERGE, or every write degrades
    // into a label scan and the run never finishes in reasonable time.
    await ensureProjectionSchema(graph);

    while (!this.stopRequested) {
      try {
        const t0 = Date.now();
        const tick = await projectTick(this.db, graph, this.batchSize);
        this.lastBatchMs = Date.now() - t0;

        if (tick === null) {
          this.status = "done";
          this.finishedAt = new Date().toISOString();
          log.info(
            `cinema graph: projection complete — ${this.rowsRead} rows, ` +
            `${this.nodesWritten} nodes, ${this.relsWritten} relationships`,
          );
          return;
        }

        this.rowsRead += tick.rows;
        this.nodesWritten += tick.nodes;
        this.relsWritten += tick.rels;
        this.consecutiveFailures = 0;

        if (tick.done) {
          log.info(`cinema graph: entity "${tick.entity}" finished its sweep`);
        }
      } catch (err) {
        this.consecutiveFailures++;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          `cinema graph: batch failed (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}) — ${msg}`,
        );
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.error = msg;
          this.status = "failed";
          this.finishedAt = new Date().toISOString();
          return;
        }
        // The cursor is only advanced on success, so a retry re-reads the same
        // page and MERGE makes that harmless.
        await new Promise((r) => setTimeout(r, 2000 * this.consecutiveFailures));
        continue;
      }

      if (INTER_BATCH_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, INTER_BATCH_DELAY_MS));
      }
    }

    this.status = "stopped";
    this.finishedAt = new Date().toISOString();
  }
}
