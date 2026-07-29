import { log } from "../../core/logger.js";
import { isoNow } from "../../core/helpers.js";
import type { EventBus, EventHandler } from "../../core/event-bus.js";
import type { SystemRegistry } from "../../core/system-registry.js";
import type { AgentService } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import { resolveGoal } from "./executor.js";

const MAX_CONCURRENT_EVENT_RUNS = 3;

export class ReactiveEngine {
  private handlers = new Map<string, EventHandler>();
  private activeRuns = 0;

  constructor(
    private service: AgentService,
    private executor: AgentExecutor,
    private events: EventBus,
    private systemRegistry?: SystemRegistry,
  ) {}

  start(): void {
    const triggers = this.service.getActiveEventTriggers();
    const eventNames = new Set(triggers.map((t) => t.event_name));

    for (const eventName of eventNames) {
      const handler: EventHandler = (payload) => this.handleEvent(eventName, payload);
      this.handlers.set(eventName, handler);
      this.events.on(eventName, handler, {
        module: "agents",
        description: `ReactiveEngine: auto-trigger agents on ${eventName}`,
      });
    }

    if (eventNames.size > 0) {
      log.info(`ReactiveEngine: listening to ${eventNames.size} event(s)`);
    }
  }

  stop(): void {
    for (const [eventName, handler] of this.handlers) {
      this.events.off(eventName, handler);
    }
    this.handlers.clear();
    log.info("ReactiveEngine: stopped");
  }

  /** Reload triggers from DB (call after adding/removing triggers) */
  reload(): void {
    this.stop();
    this.start();
  }

  private async handleEvent(eventName: string, payload: unknown): Promise<void> {
    if (this.activeRuns >= MAX_CONCURRENT_EVENT_RUNS) {
      log.warn(`ReactiveEngine: skipping event "${eventName}" — max concurrent runs reached`);
      return;
    }

    const triggers = this.service.getActiveEventTriggers()
      .filter((t) => t.event_name === eventName);

    for (const trigger of triggers) {
      // Check cooldown
      if (trigger.last_fired) {
        const elapsed = Date.now() - new Date(trigger.last_fired).getTime();
        if (elapsed < trigger.cooldown_ms) {
          log.debug(`ReactiveEngine: trigger ${trigger.id} in cooldown (${elapsed}ms < ${trigger.cooldown_ms}ms)`);
          continue;
        }
      }

      // Check filter match
      if (!matchFilter(trigger.filter, payload)) {
        continue;
      }

      // Get agent
      const agent = this.service.getAgent(trigger.agent_id);
      if (!agent || !agent.active) continue;

      // Resolve goal
      const variables = { event: payload as Record<string, unknown> };
      const goal = resolveGoal(agent.goal_template, variables) || `Triggered by event: ${eventName}`;

      // Create and execute run (fire-and-forget)
      this.activeRuns++;
      const run = this.service.createRun({
        agent_id: agent.id,
        trigger_type: "event",
        trigger_payload: payload as Record<string, unknown>,
        goal,
      });

      this.service.updateTriggerLastFired(trigger.id);

      this.events.emit("agent.run.started", {
        run_id: run.id,
        agent_id: agent.id,
        agent_name: agent.name,
        trigger_type: "event",
      });

      // Execute asynchronously
      this.executeAsync(agent, run, goal).catch(() => {});
    }
  }

  private async executeAsync(
    agent: import("./types.js").Agent,
    run: import("./types.js").AgentRun,
    goal: string,
  ): Promise<void> {
    try {
      this.service.updateRun(run.id, { status: "running", started_at: isoNow() });

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

      log.info(`ReactiveEngine: agent "${agent.name}" run completed (${result.steps_count} steps, ${result.tokens_used} tokens)`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.service.updateRun(run.id, {
        status: "failed",
        error: errorMsg,
        completed_at: isoNow(),
      });

      this.events.emit("agent.run.failed", {
        run_id: run.id,
        agent_id: agent.id,
        error: errorMsg,
      });

      log.error(`ReactiveEngine: agent "${agent.name}" run failed`, err);
    } finally {
      this.activeRuns--;
      this.events.emit("data.changed", { module: "agents", action: "run_completed" });
    }
  }
}

/** Check if a payload matches a JSON filter (shallow key-value match) */
function matchFilter(filterJson: string, payload: unknown): boolean {
  try {
    const filter = JSON.parse(filterJson);
    if (!filter || typeof filter !== "object" || Object.keys(filter).length === 0) {
      return true; // empty filter matches everything
    }

    if (!payload || typeof payload !== "object") return false;

    const p = payload as Record<string, unknown>;
    for (const [key, value] of Object.entries(filter)) {
      if (p[key] !== value) return false;
    }
    return true;
  } catch {
    return true; // invalid filter → match everything
  }
}
