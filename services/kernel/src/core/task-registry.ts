/**
 * In-process registry for MCP "task-augmented" requests.
 *
 * Implements the task primitive surface introduced in the talk:
 *   * Clients send a `tools/call` (or other supported request) with
 *     `params.task = { ttl, pollInterval }`.
 *   * The server responds *immediately* with a `CreateTaskResult` carrying
 *     a `taskId` and `status: "working"`.
 *   * The server keeps executing in the background; the client polls
 *     `tasks/get` for status and `tasks/result` for the final payload, or
 *     cancels with `tasks/cancel`.
 *
 * State is in-memory and per-server-instance (each Streamable-HTTP session
 * gets its own server, so per-session). TTL is enforced by a periodic
 * sweep that drops completed tasks past their TTL.
 *
 * Persistence isn't part of this iteration — when a session disconnects,
 * its tasks vanish, exactly like every other session-scoped object.
 */

import { newId, isoNow } from "./helpers.js";
import { log } from "./logger.js";

/**
 * Default TTL (ms) applied when a client omits `task.ttl`. Without it, tasks
 * created with `ttl:null` are never reaped (sweepExpired skips them) and
 * accumulate in memory for the life of the session — an unbounded leak.
 */
const DEFAULT_TASK_TTL_MS = 30 * 60 * 1000;

/** Wire-format task status — matches `TaskStatusSchema` from the SDK. */
export type TaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

/** A single tracked task. The `payload` field carries the eventual result
 *  (whatever the original request would have returned) once status moves to
 *  completed/failed. */
export interface TaskRecord {
  taskId: string;
  status: TaskStatus;
  ttl: number | null;
  createdAt: string;
  lastUpdatedAt: string;
  pollInterval?: number;
  statusMessage?: string;
  /** Underlying payload — written by the background worker on completion. */
  payload?: unknown;
  /** Cancel hook — set by the worker so `tasks/cancel` can interrupt. */
  cancel?: () => void;
}

/** Public projection of `TaskRecord` matching `TaskSchema`. Strips internal
 *  fields the wire format shouldn't expose (payload, cancel hook). */
export interface TaskWire {
  taskId: string;
  status: TaskStatus;
  ttl: number | null;
  createdAt: string;
  lastUpdatedAt: string;
  pollInterval?: number;
  statusMessage?: string;
}

export interface CreateTaskOptions {
  /** Time in ms to keep the result available after completion. `null` = forever. */
  ttl?: number | null;
  /** Hint to the client about how often to poll, in ms. */
  pollInterval?: number;
}

export class TaskRegistry {
  private tasks = new Map<string, TaskRecord>();
  private sweepHandle: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Run a TTL sweep every 30s. Cheap (Map iteration) and self-throttling.
    this.sweepHandle = setInterval(() => this.sweepExpired(), 30_000);
    if (this.sweepHandle.unref) this.sweepHandle.unref();
  }

  /**
   * Register a new task and kick off `worker` on the next tick. The caller
   * gets back the wire-format record to ship to the client immediately.
   *
   * Errors raised inside `worker` are caught and recorded on the task —
   * they do NOT crash the calling handler (the client already has its
   * `CreateTaskResult` and will surface the failure on the next poll).
   */
  create(opts: CreateTaskOptions, worker: (signal: AbortSignal) => Promise<unknown>): TaskWire {
    const taskId = newId();
    const now = isoNow();
    const record: TaskRecord = {
      taskId,
      status: "working",
      ttl: opts.ttl ?? DEFAULT_TASK_TTL_MS,
      createdAt: now,
      lastUpdatedAt: now,
      pollInterval: opts.pollInterval,
    };

    const controller = new AbortController();
    record.cancel = () => controller.abort();
    this.tasks.set(taskId, record);

    // Detach: the worker runs without blocking the JSON-RPC reply.
    queueMicrotask(() => {
      worker(controller.signal)
        .then((payload) => {
          const cur = this.tasks.get(taskId);
          if (!cur || cur.status === "cancelled") return;
          cur.status = "completed";
          cur.payload = payload;
          cur.lastUpdatedAt = isoNow();
        })
        .catch((err: unknown) => {
          const cur = this.tasks.get(taskId);
          if (!cur || cur.status === "cancelled") return;
          cur.status = "failed";
          cur.statusMessage = err instanceof Error ? err.message : String(err);
          cur.lastUpdatedAt = isoNow();
          log.warn(`task ${taskId} failed`, err);
        });
    });

    return this.toWire(record);
  }

  /** Get a task in wire format, or null if not found / TTL'd out. */
  get(taskId: string): TaskWire | null {
    const r = this.tasks.get(taskId);
    return r ? this.toWire(r) : null;
  }

  /**
   * Get the result payload of a task. Returns `{ found: false }` if the
   * task is unknown, `{ found: true, ready: false }` if it's still
   * working, and `{ found: true, ready: true, payload }` once done.
   *
   * The `payload` shape matches whatever the original request would have
   * returned (e.g. `CallToolResult` for a `tools/call`).
   */
  result(
    taskId: string,
  ): { found: false } | { found: true; ready: false; status: TaskStatus } | {
    found: true;
    ready: true;
    status: TaskStatus;
    payload: unknown;
    statusMessage?: string;
  } {
    const r = this.tasks.get(taskId);
    if (!r) return { found: false };
    if (r.status === "working" || r.status === "input_required") {
      return { found: true, ready: false, status: r.status };
    }
    return {
      found: true,
      ready: true,
      status: r.status,
      payload: r.payload,
      statusMessage: r.statusMessage,
    };
  }

  /** Paginated list. Cursor is just the index into the iteration order;
   *  good enough for an in-memory registry capped by TTL sweeps. */
  list(cursor?: string, limit = 50): { tasks: TaskWire[]; nextCursor?: string } {
    const all = [...this.tasks.values()].map((r) => this.toWire(r));
    const start = cursor ? Number.parseInt(cursor, 10) : 0;
    const slice = all.slice(start, start + limit);
    const next = start + slice.length < all.length ? String(start + slice.length) : undefined;
    return { tasks: slice, nextCursor: next };
  }

  /** Cancel a task. If the worker honours the AbortSignal, it stops
   *  promptly; otherwise the task continues in the background but its
   *  eventual completion is ignored (status stays at `cancelled`). */
  cancel(taskId: string): TaskWire | null {
    const r = this.tasks.get(taskId);
    if (!r) return null;
    if (r.status === "working" || r.status === "input_required") {
      r.status = "cancelled";
      r.lastUpdatedAt = isoNow();
      try {
        r.cancel?.();
      } catch { /* worker doesn't care about cancel hook */ }
    }
    return this.toWire(r);
  }

  /** Stop the TTL sweeper. Used at server shutdown. */
  shutdown(): void {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
  }

  // ── Internals ────────────────────────────────────────────

  private toWire(r: TaskRecord): TaskWire {
    const out: TaskWire = {
      taskId: r.taskId,
      status: r.status,
      ttl: r.ttl,
      createdAt: r.createdAt,
      lastUpdatedAt: r.lastUpdatedAt,
    };
    if (r.pollInterval !== undefined) out.pollInterval = r.pollInterval;
    if (r.statusMessage !== undefined) out.statusMessage = r.statusMessage;
    return out;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, r] of this.tasks) {
      if (r.ttl == null) continue;
      if (r.status !== "completed" && r.status !== "failed" && r.status !== "cancelled") continue;
      const finished = Date.parse(r.lastUpdatedAt);
      if (Number.isNaN(finished)) continue;
      if (now - finished > r.ttl) {
        this.tasks.delete(id);
      }
    }
  }
}
