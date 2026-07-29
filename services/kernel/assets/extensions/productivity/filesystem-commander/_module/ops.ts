/**
 * OpEngine — tracks long-running copy/move operations across providers.
 *
 * Operations stream from `readStream()` → `writeStream()` of the two
 * involved providers, so cross-provider transfers just work. Progress is
 * throttled to ~4 Hz and broadcast via EventEmitter — consumers attach
 * either SSE (dashboard) or plain `await waitForOp(id)` (MCP tool).
 */

import { EventEmitter } from "node:events";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { basename, join } from "node:path";
import type { FsProvider } from "./providers/provider.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";

export interface OpItem {
  from: string;
  to: string;
}

export interface OpInput {
  kind: "copy" | "move";
  src: FsProvider;
  dst: FsProvider;
  items: OpItem[];
  overwrite?: boolean;
}

export interface OpProgress {
  id: string;
  kind: "copy" | "move";
  status: "pending" | "running" | "done" | "error" | "cancelled";
  /** 0–1 based on bytes transferred / total estimated bytes. */
  progress: number;
  bytes: number;
  totalBytes: number;
  currentFile: string | null;
  startedAt: string;
  endedAt: string | null;
  errors: string[];
  /** Total entries to process (files and dirs). */
  itemsTotal: number;
  itemsDone: number;
}

interface InternalOp extends OpProgress {
  emitter: EventEmitter;
  abort: AbortController;
  input: OpInput;
}

const EMIT_THROTTLE_MS = 250;

export class OpEngine {
  private ops = new Map<string, InternalOp>();

  get(id: string): OpProgress | null {
    const op = this.ops.get(id);
    return op ? toProgress(op) : null;
  }

  list(): OpProgress[] {
    return [...this.ops.values()].map(toProgress);
  }

  /** Subscribe to progress events. Returns an unsubscribe function. */
  subscribe(id: string, listener: (p: OpProgress) => void): () => void {
    const op = this.ops.get(id);
    if (!op) return () => {};
    const onProgress = () => listener(toProgress(op));
    op.emitter.on("progress", onProgress);
    op.emitter.on("done", onProgress);
    op.emitter.on("error", onProgress);
    return () => {
      op.emitter.off("progress", onProgress);
      op.emitter.off("done", onProgress);
      op.emitter.off("error", onProgress);
    };
  }

  cancel(id: string): boolean {
    const op = this.ops.get(id);
    if (!op || op.status !== "running") return false;
    op.abort.abort();
    return true;
  }

  /** Start an op. Returns the opId immediately; work runs in background. */
  start(input: OpInput): string {
    const op: InternalOp = {
      id: newId(),
      kind: input.kind,
      status: "pending",
      progress: 0,
      bytes: 0,
      totalBytes: 0,
      currentFile: null,
      startedAt: isoNow(),
      endedAt: null,
      errors: [],
      itemsTotal: 0,
      itemsDone: 0,
      emitter: new EventEmitter(),
      abort: new AbortController(),
      input,
    };
    this.ops.set(op.id, op);
    // Drive the op asynchronously — caller gets the id right away.
    void this.run(op);
    // Auto-evict finished ops after 5 min so memory doesn't grow.
    setTimeout(() => {
      if (this.ops.get(op.id)?.status !== "running") this.ops.delete(op.id);
    }, 5 * 60_000).unref?.();
    return op.id;
  }

  private async run(op: InternalOp): Promise<void> {
    op.status = "running";
    const { src, dst, items, overwrite, kind } = op.input;
    let emitTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleEmit = () => {
      if (emitTimer) return;
      emitTimer = setTimeout(() => {
        emitTimer = null;
        op.progress = op.totalBytes > 0 ? op.bytes / op.totalBytes : 0;
        op.emitter.emit("progress");
      }, EMIT_THROTTLE_MS);
    };

    try {
      // ── Phase 1: enumerate everything that needs to move ──
      interface Plan {
        from: string;
        to: string;
        kind: "file" | "dir";
        size: number;
      }
      const plan: Plan[] = [];
      for (const item of items) {
        await enumerate(src, item.from, item.to, plan, op.abort.signal);
      }
      op.itemsTotal = plan.length;
      op.totalBytes = plan.reduce((s, p) => s + (p.kind === "file" ? p.size : 0), 0);
      scheduleEmit();

      // ── Phase 2: execute ──
      // Pre-create directories in order.
      for (const p of plan.filter((p) => p.kind === "dir")) {
        if (op.abort.signal.aborted) throw new AbortError();
        try {
          await dst.mkdir(p.to, { recursive: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/exist/i.test(msg)) throw err;
        }
        op.itemsDone++;
      }
      // Copy files, streaming.
      for (const p of plan.filter((p) => p.kind === "file")) {
        if (op.abort.signal.aborted) throw new AbortError();
        op.currentFile = p.from;
        scheduleEmit();
        const r = await src.readStream(p.from);
        const counter = new Transform({
          transform(chunk, _enc, cb) {
            op.bytes += chunk.length;
            scheduleEmit();
            cb(null, chunk);
          },
        });
        const w = await dst.writeStream(p.to, { overwrite, expectedSize: p.size });
        await pipeline(r, counter, w, { signal: op.abort.signal });
        op.itemsDone++;
      }

      // ── Phase 3 (move only): delete sources after success ──
      if (kind === "move") {
        for (const item of items) {
          if (op.abort.signal.aborted) throw new AbortError();
          await src.rm(item.from, { recursive: true });
        }
      }

      op.status = "done";
      op.progress = 1;
      op.endedAt = isoNow();
      op.emitter.emit("done");
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        op.status = "cancelled";
      } else {
        op.status = "error";
        const msg = err instanceof Error ? err.message : String(err);
        op.errors.push(msg);
        log.warn(`OpEngine ${op.id} failed: ${msg}`);
      }
      op.endedAt = isoNow();
      op.emitter.emit("error");
    }
  }
}

class AbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

async function enumerate(
  src: FsProvider,
  from: string,
  to: string,
  out: Array<{ from: string; to: string; kind: "file" | "dir"; size: number }>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new AbortError();
  const stat = await src.stat(from);
  if (stat.kind === "dir") {
    out.push({ from, to, kind: "dir", size: 0 });
    const listing = await src.list(from);
    for (const child of listing.entries) {
      // Skip symlinks on traversal — they'd explode scope. We still copy them
      // as entries (size 0) so users notice they existed.
      if (child.kind === "symlink") {
        out.push({
          from: joinSafe(from, child.name),
          to: joinSafe(to, child.name),
          kind: "file",
          size: 0,
        });
        continue;
      }
      await enumerate(
        src,
        joinSafe(from, child.name),
        joinSafe(to, child.name),
        out,
        signal,
      );
    }
  } else {
    out.push({ from, to, kind: "file", size: stat.size });
  }
}

function joinSafe(parent: string, name: string): string {
  // `join` from node:path handles both posix and windows; remote providers
  // (SFTP, S3, WebDAV) all use POSIX — callers in those providers normalize
  // separately. For phase 2 we only have local, so join() is correct.
  return join(parent, name);
}

function toProgress(op: InternalOp): OpProgress {
  return {
    id: op.id,
    kind: op.kind,
    status: op.status,
    progress: op.progress,
    bytes: op.bytes,
    totalBytes: op.totalBytes,
    currentFile: op.currentFile ? basename(op.currentFile) : null,
    startedAt: op.startedAt,
    endedAt: op.endedAt,
    errors: [...op.errors],
    itemsTotal: op.itemsTotal,
    itemsDone: op.itemsDone,
  };
}
