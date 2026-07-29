import { log } from "../../core/logger.js";
import { isoNow } from "../../core/helpers.js";
import { computeNextCronRun } from "./cron-utils.js";
import type { EventBus } from "../../core/event-bus.js";
import type { SystemRegistry } from "../../core/system-registry.js";
import type { AgentService } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import type { BuiltinHandler } from "./builtin-handlers.js";
import { resolveGoal } from "./executor.js";

/** Max consecutive failures before auto-pausing a schedule (circuit breaker). */
const CIRCUIT_BREAKER_THRESHOLD = 5;

export class AgentScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private registryId: string | null = null;
  /** Consecutive failure counter per agent ID. Reset on success. */
  private consecutiveFails = new Map<string, number>();
  private cleanupRegistryId: string | null = null;
  private builtinHandlers = new Map<string, BuiltinHandler>();

  constructor(
    private service: AgentService,
    private executor: AgentExecutor,
    private events: EventBus,
    private pollIntervalMs: number,
    private timezone: string,
    private systemRegistry?: SystemRegistry,
    private learningCleanupIntervalMs: number = 3_600_000,
    private learningMinConfidence: number = 0.15,
  ) {}

  /** Register builtin handlers (called from bootstrap) */
  setBuiltinHandlers(handlers: Map<string, BuiltinHandler>): void {
    this.builtinHandlers = handlers;
  }

  start(): void {
    if (this.timer) return;

    log.info(`Agent scheduler started (poll every ${this.pollIntervalMs}ms)`);

    if (this.systemRegistry) {
      this.registryId = this.systemRegistry.register({
        name: "Agent Polling",
        type: "interval",
        module: "agents",
        description: `Polls for due agent schedules every ${this.pollIntervalMs}ms`,
        intervalMs: this.pollIntervalMs,
      });
    }

    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
    this.timer.unref();

    // Periodic cleanup of low-confidence learnings (dead knowledge hygiene)
    if (this.learningCleanupIntervalMs > 0) {
      if (this.systemRegistry) {
        this.cleanupRegistryId = this.systemRegistry.register({
          name: "Agent Learning Cleanup",
          type: "interval",
          module: "agents",
          description: `Deactivates learnings with confidence < ${this.learningMinConfidence} every ${Math.round(this.learningCleanupIntervalMs / 60000)}min`,
          intervalMs: this.learningCleanupIntervalMs,
        });
      }
      this.cleanupTimer = setInterval(() => this.cleanupLearningsTick(), this.learningCleanupIntervalMs);
      this.cleanupTimer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      if (this.registryId) {
        this.systemRegistry?.updateStatus(this.registryId, "stopped");
      }
      log.info("Agent scheduler stopped");
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      if (this.cleanupRegistryId) {
        this.systemRegistry?.updateStatus(this.cleanupRegistryId, "stopped");
      }
    }
  }

  private cleanupLearningsTick(): void {
    try {
      if (this.cleanupRegistryId) this.systemRegistry?.recordRun(this.cleanupRegistryId);
      const agents = this.service.listAgents();
      let totalDeactivated = 0;
      for (const a of agents) {
        totalDeactivated += this.service.cleanupLowConfidenceLearnings(a.id, this.learningMinConfidence);
      }
      if (totalDeactivated > 0) {
        log.info(`Agent learning cleanup: deactivated ${totalDeactivated} low-confidence learnings`);
      }
    } catch (err) {
      log.warn(`Agent learning cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      if (this.registryId) this.systemRegistry?.recordRun(this.registryId);

      const due = this.service.getDueSchedules();

      for (const schedule of due) {
        try {
          const agent = this.service.getAgent(schedule.agent_id);
          if (!agent || !agent.active) {
            // Advance next_run_at even if agent is inactive
            const nextRun = this.computeNextRun(schedule.cron_expression, schedule.interval_ms);
            this.service.updateScheduleNextRun(schedule.id, nextRun, isoNow());
            continue;
          }

          // Circuit breaker: skip agent if it has failed too many times in a row.
          const fails = this.consecutiveFails.get(agent.id) ?? 0;
          if (fails >= CIRCUIT_BREAKER_THRESHOLD) {
            log.warn(
              `Agent scheduler: "${agent.name}" auto-paused after ${fails} consecutive failures. ` +
              `Deactivating schedule ${schedule.id} to stop token burn.`,
            );
            this.service.deactivateSchedule?.(schedule.id);
            this.consecutiveFails.delete(agent.id);
            continue;
          }

          // Check if this agent has a builtin handler
          if (agent.builtin_handler && this.builtinHandlers.has(agent.builtin_handler)) {
            await this.executeBuiltin(agent, schedule);
          } else {
            await this.executeLlm(agent, schedule);
          }

          // Advance next_run_at
          const nextRun = this.computeNextRun(schedule.cron_expression, schedule.interval_ms);
          this.service.updateScheduleNextRun(schedule.id, nextRun, isoNow());

          this.events.emit("data.changed", { module: "agents", action: "schedule_run" });
        } catch (err) {
          // Error objects don't always have enumerable props — pull the
          // message explicitly so the log is actually useful.
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`Agent scheduler: schedule ${schedule.id} (agent "${schedule.agent_name ?? schedule.agent_id}") failed: ${msg}`);

          // Still advance next_run_at to avoid stuck loop
          const nextRun = this.computeNextRun(schedule.cron_expression, schedule.interval_ms);
          this.service.updateScheduleNextRun(schedule.id, nextRun, isoNow());
        }
      }
    } catch (err) {
      log.error("Agent scheduler tick failed", err);
    } finally {
      this.running = false;
    }
  }

  /** Execute a builtin handler (no LLM, no tokens) */
  private async executeBuiltin(
    agent: import("./types.js").Agent,
    schedule: import("./types.js").AgentSchedule & { agent_name: string },
  ): Promise<void> {
    const handler = this.builtinHandlers.get(agent.builtin_handler)!;
    const startedAt = isoNow();

    // Create run record
    const runGoal = schedule.goal_override || agent.description || `Scheduled run — ${agent.name}`;
    const run = this.service.createRun({
      agent_id: agent.id,
      trigger_type: "schedule",
      goal: runGoal,
    });

    this.service.updateRun(run.id, { status: "running", started_at: startedAt });

    this.events.emit("agent:flow:run_started", {
      run_id: run.id,
      agent_id: agent.id,
      agent_name: agent.name,
      trigger_type: "schedule",
      goal: runGoal,
      builtin: true,
    });

    try {
      const result = await handler();

      this.service.updateRun(run.id, {
        status: "completed",
        result,
        steps_count: 1,
        tokens_used: 0,
        completed_at: isoNow(),
      });

      this.events.emit("agent:flow:run_completed", {
        run_id: run.id,
        agent_id: agent.id,
        agent_name: agent.name,
        status: "completed",
        steps_count: 1,
        tokens_used: 0,
        result_preview: result.slice(0, 200),
        builtin: true,
      });

      log.debug(`Agent scheduler (builtin): "${agent.name}" completed`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.service.updateRun(run.id, {
        status: "failed",
        error: errorMsg,
        completed_at: isoNow(),
      });

      // Mirror the LLM path so the Error Auditor + UI see builtin failures too.
      this.events.emit("agent:flow:run_completed", {
        run_id: run.id,
        agent_id: agent.id,
        agent_name: agent.name,
        status: "failed",
        steps_count: 1,
        tokens_used: 0,
        error: errorMsg,
        builtin: true,
      });

      log.error(`Agent scheduler (builtin): "${agent.name}" failed`, err);
    }
  }

  /** Execute via LLM (standard executor) */
  private async executeLlm(
    agent: import("./types.js").Agent,
    schedule: import("./types.js").AgentSchedule & { agent_name: string },
  ): Promise<void> {
    // Resolve goal
    const goal = schedule.goal_override || resolveGoal(agent.goal_template, {}) || `Scheduled execution of agent "${agent.name}"`;

    // Create run
    const run = this.service.createRun({
      agent_id: agent.id,
      trigger_type: "schedule",
      goal,
    });

    this.service.updateRun(run.id, { status: "running", started_at: isoNow() });

    this.events.emit("agent.run.started", {
      run_id: run.id,
      agent_id: agent.id,
      agent_name: agent.name,
      trigger_type: "schedule",
    });

    // Execute
    const result = await this.executor.execute({
      agent,
      goal,
      run,
      service: this.service,
      events: this.events,
    });

    this.service.updateRun(run.id, {
      status: result.status,
      result: result.result,
      error: result.error,
      steps_count: result.steps_count,
      tokens_used: result.tokens_used,
      completed_at: isoNow(),
    });

    this.events.emit("agent.run.completed", {
      run_id: run.id,
      agent_id: agent.id,
      status: result.status,
      steps_count: result.steps_count,
      tokens_used: result.tokens_used,
    });

    // Circuit breaker tracking
    if (result.status === "failed") {
      const prev = this.consecutiveFails.get(agent.id) ?? 0;
      this.consecutiveFails.set(agent.id, prev + 1);
      log.warn(`Agent scheduler: "${agent.name}" failed (${prev + 1}/${CIRCUIT_BREAKER_THRESHOLD} before auto-pause)`);
    } else {
      this.consecutiveFails.delete(agent.id); // reset on success
    }

    log.info(`Agent scheduler: "${agent.name}" completed (${result.steps_count} steps, ${result.tokens_used}tk)`);
  }

  /** Compute next run time from cron expression or interval */
  private computeNextRun(cronExpression: string, intervalMs: number): string {
    if (cronExpression) {
      return computeNextCronRun(cronExpression, this.timezone);
    }
    return new Date(Date.now() + intervalMs).toISOString();
  }
}

// Re-export for backward compatibility
export { computeNextCronRun } from "./cron-utils.js";
