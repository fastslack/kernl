import type { SqliteDb } from "../../../core/db/sqlite.js";
import type { EventBus } from "../../../core/event-bus.js";
import type { KernelConfig } from "../../../core/config.js";
import { newId, isoNow } from "../../../core/helpers.js";
import { HttpError } from "../../../sdk/http-error.js";
import { computeNextCronRun } from "../cron-utils.js";
import type { AgentSchedule } from "../types.js";

/** A cadence the kernel refuses: below the rate-limit floor, or no cadence at all. */
export class ScheduleValidationError extends HttpError {
  constructor(message: string) {
    super(400, message);
    this.name = "ScheduleValidationError";
  }
}

/** What the office panel may change on an existing schedule. */
export interface SchedulePatch {
  interval_ms?: number;
  cron_expression?: string;
  active?: boolean;
}

export type SchedulePatchResult = { ok: true; patch: SchedulePatch } | { ok: false; error: string };

/**
 * Validate an untyped body (HTTP JSON or RPC args) into a typed `SchedulePatch`.
 * Shared by `PUT /api/agents/schedules/:id` and the `agents.schedule.update`
 * RPC action so both reject a wrong-typed field with the exact same message.
 */
export function parseSchedulePatch(body: unknown): SchedulePatchResult {
  const src = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const patch: SchedulePatch = {};
  if (src.interval_ms !== undefined) {
    if (typeof src.interval_ms !== "number") return { ok: false, error: "interval_ms must be a number" };
    patch.interval_ms = src.interval_ms;
  }
  if (src.cron_expression !== undefined) {
    if (typeof src.cron_expression !== "string") return { ok: false, error: "cron_expression must be a string" };
    patch.cron_expression = src.cron_expression;
  }
  if (src.active !== undefined) {
    if (typeof src.active !== "boolean") return { ok: false, error: "active must be a boolean" };
    patch.active = src.active;
  }
  return { ok: true, patch };
}

/**
 * Agent schedules — interval and cron cadences, plus the rate-limit floor.
 * Owns `agent_schedules`; `AgentService` delegates to it.
 */
export class AgentSchedulesService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
    /** Optional — see `assertCadence`; absent in demo scripts and older tests. */
    private config?: KernelConfig,
  ) {}

  addSchedule(input: {
    agent_id: string;
    interval_ms?: number;
    cron_expression?: string;
    goal_override?: string;
  }): AgentSchedule {
    const now = isoNow();
    const cronExpr = input.cron_expression ?? "";
    const intervalMs = input.interval_ms ?? 0;
    this.assertCadence(intervalMs, cronExpr);

    const schedule: AgentSchedule = {
      id: newId(),
      agent_id: input.agent_id,
      interval_ms: intervalMs,
      cron_expression: cronExpr,
      goal_override: input.goal_override ?? "",
      next_run_at: this.nextRunFor(intervalMs, cronExpr),
      last_run_at: null,
      active: 1,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO agent_schedules (id, agent_id, interval_ms, cron_expression, goal_override,
         next_run_at, last_run_at, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.id, schedule.agent_id, schedule.interval_ms, schedule.cron_expression,
        schedule.goal_override, schedule.next_run_at, schedule.last_run_at,
        schedule.active, schedule.created_at,
      );

    this.events.emit("data.changed", { module: "agents", action: "schedule_added" });
    return schedule;
  }

  getSchedule(id: string): AgentSchedule | undefined {
    return (this.db.prepare("SELECT * FROM agent_schedules WHERE id = ?").get(id) as AgentSchedule | null) ?? undefined;
  }

  /**
   * Change a schedule's cadence or pause it. A patch that names a cadence
   * replaces it whole: `interval_ms` alone clears `cron_expression` (cron wins
   * in the scheduler), `cron_expression` alone sets `interval_ms` to 0.
   * `next_run_at` is recomputed only when the cadence changes.
   */
  updateSchedule(id: string, patch: SchedulePatch): AgentSchedule | undefined {
    const current = this.getSchedule(id);
    if (!current) return undefined;
    if (patch.interval_ms !== undefined && (!Number.isFinite(patch.interval_ms) || patch.interval_ms < 0)) {
      throw new ScheduleValidationError("interval_ms must be a number of milliseconds, 0 or more");
    }

    let intervalMs = current.interval_ms;
    let cronExpr = current.cron_expression;
    let nextRun = current.next_run_at;
    if (patch.interval_ms !== undefined || patch.cron_expression !== undefined) {
      intervalMs = patch.interval_ms ?? 0;
      cronExpr = (patch.cron_expression ?? "").trim();
      if (!cronExpr && intervalMs <= 0) {
        throw new ScheduleValidationError("A schedule needs interval_ms or cron_expression");
      }
      this.assertCadence(intervalMs, cronExpr);
      nextRun = this.nextRunFor(intervalMs, cronExpr);
    }
    const active = patch.active === undefined ? current.active : patch.active ? 1 : 0;

    this.db
      .prepare("UPDATE agent_schedules SET interval_ms = ?, cron_expression = ?, next_run_at = ?, active = ? WHERE id = ?")
      .run(intervalMs, cronExpr, nextRun, active, id);
    this.events.emit("data.changed", { module: "agents", action: "schedule_updated" });
    return this.getSchedule(id);
  }

  listSchedules(agentId?: string): AgentSchedule[] {
    if (agentId) {
      return this.db
        .prepare("SELECT * FROM agent_schedules WHERE agent_id = ? ORDER BY created_at DESC")
        .all(agentId) as AgentSchedule[];
    }
    return this.db
      .prepare("SELECT * FROM agent_schedules ORDER BY created_at DESC")
      .all() as AgentSchedule[];
  }

  getDueSchedules(): Array<AgentSchedule & { agent_name: string }> {
    const now = isoNow();
    return this.db
      .prepare(
        `SELECT s.*, a.name as agent_name
         FROM agent_schedules s
         JOIN agents a ON s.agent_id = a.id
         WHERE s.next_run_at <= ? AND s.active = 1 AND a.active = 1`,
      )
      .all(now) as Array<AgentSchedule & { agent_name: string }>;
  }

  removeSchedule(id: string): boolean {
    const result = this.db.prepare("DELETE FROM agent_schedules WHERE id = ?").run(id);
    if (result.changes > 0) {
      this.events.emit("data.changed", { module: "agents", action: "schedule_removed" });
      return true;
    }
    return false;
  }

  updateScheduleNextRun(id: string, nextRunAt: string, lastRunAt: string): void {
    this.db
      .prepare("UPDATE agent_schedules SET next_run_at = ?, last_run_at = ? WHERE id = ?")
      .run(nextRunAt, lastRunAt, id);
  }

  /**
   * Rate-limit floor: a schedule firing more often than every 5 minutes is
   * almost always a footgun — it's the cheapest exfil channel an attacker gets
   * if they ever land an agent_create. Operators who really need sub-5-min
   * cadence can opt in with KERNEL_AGENT_MIN_SCHEDULE_SECONDS. Prefer live
   * config.agents.minScheduleSeconds (reflects hot-reloaded settings) — fall
   * back to a direct env read only when this instance wasn't constructed with
   * a KernelConfig (demo scripts, older tests).
   */
  private assertCadence(intervalMs: number, cronExpr: string): void {
    const minSeconds = this.config
      ? this.config.agents.minScheduleSeconds
      : Math.max(1, Number(process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS ?? 300));
    if (intervalMs > 0 && intervalMs < minSeconds * 1000) {
      throw new ScheduleValidationError(
        `agent schedule interval_ms=${intervalMs} is below minimum ${minSeconds * 1000}ms. ` +
        `Raise KERNEL_AGENT_MIN_SCHEDULE_SECONDS to lower the floor (default 300s).`,
      );
    }
    if (cronExpr) {
      // Estimate cadence from two consecutive cron fires.
      try {
        const first = new Date(computeNextCronRun(cronExpr, "UTC"));
        const second = new Date(computeNextCronRun(cronExpr, "UTC", first));
        const deltaMs = second.getTime() - first.getTime();
        if (deltaMs > 0 && deltaMs < minSeconds * 1000) {
          throw new ScheduleValidationError(
            `agent schedule cron "${cronExpr}" fires every ${Math.round(deltaMs / 1000)}s, below minimum ${minSeconds}s. ` +
            `Raise KERNEL_AGENT_MIN_SCHEDULE_SECONDS to lower the floor.`,
          );
        }
      } catch (e) {
        if (e instanceof ScheduleValidationError) throw e;
        // computeNextCronRun never throws — it catches a malformed expression
        // itself and falls back to one hour ahead. This branch only guards
        // against some other unexpected failure in the cadence estimate.
      }
    }
  }

  private nextRunFor(intervalMs: number, cronExpr: string): string {
    return cronExpr ? computeNextCronRun(cronExpr, "UTC") : new Date(Date.now() + intervalMs).toISOString();
  }
}
