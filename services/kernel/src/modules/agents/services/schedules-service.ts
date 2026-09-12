import type { SqliteDb } from "../../../core/db/sqlite.js";
import type { EventBus } from "../../../core/event-bus.js";
import type { KernelConfig } from "../../../core/config.js";
import { newId, isoNow } from "../../../core/helpers.js";
import { computeNextCronRun } from "../cron-utils.js";
import type { AgentSchedule } from "../types.js";

/**
 * Agent schedules — interval and cron cadences, plus the rate-limit floor.
 * Owns `agent_schedules`; `AgentService` delegates to it.
 */
export class AgentSchedulesService {
  constructor(
    private db: SqliteDb,
    private events: EventBus,
    /** Optional — see `addSchedule`; absent in demo scripts and older tests. */
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

    // Rate-limit floor: a schedule firing more often than every 5 minutes is
    // almost always a footgun — it's the cheapest exfil channel an attacker
    // gets if they ever land an agent_create. 5 min is more than enough for
    // human-perceived "near-real-time" workflows. Operators who really need
    // sub-5-min cadence can opt in with KERNEL_AGENT_MIN_SCHEDULE_SECONDS.
    // Prefer live config.agents.minScheduleSeconds (single source of truth,
    // reflects hot-reloaded settings) — fall back to a direct env read only
    // when this instance wasn't constructed with a KernelConfig (demo
    // scripts, older tests).
    const minSeconds = this.config
      ? this.config.agents.minScheduleSeconds
      : Math.max(1, Number(process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS ?? 300));
    if (intervalMs > 0 && intervalMs < minSeconds * 1000) {
      throw new Error(
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
          throw new Error(
            `agent schedule cron "${cronExpr}" fires every ${Math.round(deltaMs / 1000)}s, below minimum ${minSeconds}s. ` +
            `Raise KERNEL_AGENT_MIN_SCHEDULE_SECONDS to lower the floor.`,
          );
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("agent schedule cron")) throw e;
        // computeNextCronRun threw because the expression is malformed; let
        // the original code path reject below.
      }
    }

    // Compute initial next_run_at
    let nextRun: string;
    if (cronExpr) {
      nextRun = computeNextCronRun(cronExpr, "UTC");
    } else {
      nextRun = new Date(Date.now() + intervalMs).toISOString();
    }

    const schedule: AgentSchedule = {
      id: newId(),
      agent_id: input.agent_id,
      interval_ms: intervalMs,
      cron_expression: cronExpr,
      goal_override: input.goal_override ?? "",
      next_run_at: nextRun,
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
}
