/**
 * Re-embed queue — brings stored vectors in line with the active model.
 *
 * Every agent row that carries a vector also records the model that made it
 * (`embedding_model` / `goal_embedding_model`), and every search compares
 * only vectors of the same model. So when the active model changes — the
 * user picks another provider in /models, LM Studio comes back after the
 * in-process fallback served for a while, a new default ships — the rows
 * embedded under the old model drop out of semantic search until they are
 * embedded again. This queue does that in the background.
 *
 * It is the in-kernel form of scripts/backfill-agent-embeddings.ts
 * (`--rebuild`): same tables, same filters. Rows with no vector at all are
 * included, newest first, so recent context becomes searchable first.
 *
 * Cinema keeps its own catalog in step the same way (its embed-pending
 * driver picks titles whose (model, dim) differ from the client's), so it is
 * not listed here.
 *
 * Properties:
 *  - single flight: a run asked for while one is going is folded into a
 *    rerun when it ends;
 *  - follows the client: if the active model changes mid-run, the run stops
 *    and starts again under the new model;
 *  - polite: small batches, a pause between them;
 *  - never stuck: rows advance by a rowid cursor, so a row that will not
 *    embed is passed over (and retried on the next run) instead of blocking
 *    the rest; a provider that is down ends the run, to be retried later.
 */

import { log } from "../logger.js";
import type { SqliteDb } from "../db/sqlite.js";
import { vectorToBlob } from "../ranking/relevance.js";
import type { EmbeddingsClient } from "./client.js";

export interface ReembedTarget {
  table: string;
  textColumn: string;
  embedColumn: string;
  modelColumn: string;
  /** Rows with shorter text are not embedded at write time either. */
  minTextLen: number;
  /** Extra SQL condition (trusted, from this file). */
  extraFilter?: string;
}

/** The agent tables AgentService embeds at write time (memory-service.ts, runs-service.ts). */
export const AGENT_REEMBED_TARGETS: readonly ReembedTarget[] = [
  // Learnings first: they are what cross-agent recall searches.
  { table: "agent_learnings", textColumn: "content", embedColumn: "embedding", modelColumn: "embedding_model", minTextLen: 1, extraFilter: "active = 1" },
  { table: "agent_runs", textColumn: "goal", embedColumn: "goal_embedding", modelColumn: "goal_embedding_model", minTextLen: 5 },
  { table: "agent_memory", textColumn: "content", embedColumn: "embedding", modelColumn: "embedding_model", minTextLen: 1 },
  // Brain's cross-module index (brain/service.ts); same vector encoding.
  { table: "brain_items", textColumn: "text", embedColumn: "embedding", modelColumn: "embedding_model", minTextLen: 1 },
];

/**
 * A re-embed step for vectors that do not live in a SQLite table — chat
 * memory nodes in the graph. `run` converts everything it finds under the
 * client it chooses and resolves with how many it did; it must stop on its
 * own when that client's model changes.
 */
export interface ReembedPass {
  name: string;
  run(): Promise<number>;
}

const passes = new Map<string, ReembedPass>();

/** Register (or replace, by name) a pass every re-embed run ends with. */
export function registerReembedPass(pass: ReembedPass): () => void {
  passes.set(pass.name, pass);
  return () => { if (passes.get(pass.name) === pass) passes.delete(pass.name); };
}

export interface ReembedStatus {
  running: boolean;
  /** Model of the run in progress or of the last one. */
  model: string | null;
  /** Rows re-embedded by the current (or last) run, per table. */
  done: Record<string, number>;
  /** Rows still to do under `model`, as of the last count. */
  pending: Record<string, number>;
  lastError: string | null;
  finishedAt: string | null;
}

export interface ReembedOptions {
  targets?: readonly ReembedTarget[];
  batchSize?: number;
  /** Pause between batches, ms. */
  pauseMs?: number;
  /** Called after each committed batch. */
  onBatch?: (info: { table: string; ids: string[]; model: string }) => void;
  /** Called when a run ends with every target done. */
  onDone?: (info: { model: string; done: Record<string, number> }) => void;
  vectorToBlob?: (v: number[]) => Buffer;
  /** Passes to end each run with; default: the ones registered with registerReembedPass. */
  passes?: Iterable<ReembedPass>;
}

export class ReembedQueue {
  private readonly targets: readonly ReembedTarget[];
  private readonly batchSize: number;
  private readonly pauseMs: number;
  private readonly toBlob: (v: number[]) => Buffer;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private state: ReembedStatus = { running: false, model: null, done: {}, pending: {}, lastError: null, finishedAt: null };

  constructor(
    private readonly db: SqliteDb,
    private readonly getClient: () => EmbeddingsClient | null,
    private readonly opts: ReembedOptions = {},
  ) {
    this.targets = (opts.targets ?? AGENT_REEMBED_TARGETS).filter((t) => this.hasTable(t));
    this.batchSize = opts.batchSize ?? 32;
    this.pauseMs = opts.pauseMs ?? 50;
    this.toBlob = opts.vectorToBlob ?? vectorToBlob;
  }

  private hasTable(t: ReembedTarget): boolean {
    try {
      const cols = this.db.prepare(`PRAGMA table_info(${t.table})`).all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      return [t.textColumn, t.embedColumn, t.modelColumn].every((c) => names.has(c));
    } catch {
      return false;
    }
  }

  private where(t: ReembedTarget): string {
    return `(${t.embedColumn} IS NULL OR ${t.modelColumn} != ?) AND length(${t.textColumn}) >= ${t.minTextLen}` +
      (t.extraFilter ? ` AND ${t.extraFilter}` : "");
  }

  /** Rows that do not carry a vector of `model`, per table. */
  pending(model: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of this.targets) {
      const r = this.db.prepare(`SELECT COUNT(*) AS c FROM ${t.table} WHERE ${this.where(t)}`).get(model) as { c: number };
      out[t.table] = Number(r.c);
    }
    return out;
  }

  status(): ReembedStatus {
    const client = this.getClient();
    if (!this.state.running && client) {
      try { this.state.pending = this.pending(client.model); } catch { /* table gone mid-shutdown */ }
    }
    return { ...this.state, done: { ...this.state.done }, pending: { ...this.state.pending } };
  }

  /** Start a run (or schedule one after the current). Resolves when the queue is idle. */
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const pass = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && !this.stopped);
      } finally {
        this.running = null;
        this.state.running = false;
      }
    })();
    this.running = pass;
    return pass;
  }

  stop(): void {
    this.stopped = true;
  }

  private async pass(): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    const model = client.model;
    const dim = client.dim;
    const pending = this.pending(model);
    const total = Object.values(pending).reduce((a, b) => a + b, 0);
    this.state = { running: true, model, done: {}, pending, lastError: null, finishedAt: null };
    if (total === 0 && [...(this.opts.passes ?? passes.values())].length === 0) {
      this.state.finishedAt = new Date().toISOString();
      return;
    }
    if (total > 0) log.info(
      `embeddings: re-embedding ${total} row(s) with ${model} in the background ` +
      `(${Object.entries(pending).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(", ")})`,
    );
    const t0 = Date.now();

    for (const t of this.targets) {
      if (!pending[t.table]) continue;
      const select = this.db.prepare(
        `SELECT rowid AS rid, id, ${t.textColumn} AS text FROM ${t.table}
          WHERE ${this.where(t)} AND rowid < ? ORDER BY rowid DESC LIMIT ?`,
      );
      const update = this.db.prepare(
        `UPDATE ${t.table} SET ${t.embedColumn} = ?, ${t.modelColumn} = ? WHERE id = ?`,
      );
      let cursor = Number.MAX_SAFE_INTEGER;
      this.state.done[t.table] = 0;

      for (;;) {
        if (this.stopped) return;
        const live = this.getClient();
        if (!live || live.model !== model) {
          // The active model changed under us: this run's vectors would be stale on arrival.
          this.again = true;
          return;
        }
        const rows = select.all(model, cursor, this.batchSize) as Array<{ rid: number; id: string; text: string }>;
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1].rid;

        let vecs: Array<number[] | null>;
        try {
          vecs = await live.embed(rows.map((r) => r.text), { inputType: "passage" });
        } catch (err) {
          // One bad text, or the provider is down? Try the rows one by one once.
          vecs = [];
          let failures = 0;
          let lastErr: unknown = err;
          for (const r of rows) {
            try {
              const [v] = await live.embed([r.text], { inputType: "passage" });
              vecs.push(v ?? null);
            } catch (e) {
              failures++;
              lastErr = e;
              vecs.push(null);
            }
          }
          if (failures === rows.length) {
            const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
            this.state.lastError = msg.slice(0, 300);
            log.warn(`embeddings: re-embed paused — ${live.provider} failed (${msg.slice(0, 160)}); will retry later`);
            return;
          }
        }
        if (live.model !== model) {
          this.again = true;
          return;
        }

        const ids: string[] = [];
        this.db.exec("BEGIN");
        try {
          for (let i = 0; i < rows.length; i++) {
            const v = vecs[i];
            if (!v || v.length !== dim) continue;
            update.run(this.toBlob(v), model, rows[i].id);
            ids.push(rows[i].id);
          }
          this.db.exec("COMMIT");
        } catch (err) {
          this.db.exec("ROLLBACK");
          throw err;
        }
        this.state.done[t.table] += ids.length;
        this.state.pending[t.table] = Math.max(0, (this.state.pending[t.table] ?? 0) - rows.length);
        if (ids.length) this.opts.onBatch?.({ table: t.table, ids, model });
        if (this.pauseMs > 0) await new Promise((r) => setTimeout(r, this.pauseMs));
      }
    }

    for (const p of this.opts.passes ?? passes.values()) {
      if (this.stopped) return;
      try {
        this.state.done[p.name] = await p.run();
      } catch (err) {
        log.warn(`embeddings: re-embed pass ${p.name} failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const done = { ...this.state.done };
    const n = Object.values(done).reduce((a, b) => a + b, 0);
    this.state.finishedAt = new Date().toISOString();
    if (n > 0) log.info(`embeddings: re-embedded ${n} row(s) with ${model} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    this.opts.onDone?.({ model, done });
  }
}
