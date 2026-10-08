import { log } from "../../core/logger.js";
import { isoNow } from "../../core/helpers.js";
import type { EventBus, EventHandler } from "../../core/event-bus.js";
import type { SystemRegistry } from "../../core/system-registry.js";
import type { AgentService } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import { resolveGoal } from "./executor.js";

const MAX_CONCURRENT_EVENT_RUNS = 3;

/**
 * Events Kernl emits about its own state (agents, tasks, projects, the
 * outbox, reminders, schedules, the kernel itself, goals, offices, meetings,
 * plans). Their payloads come from Kernl, so a goal built from them is not
 * wrapped. Everything else — mail/comms, rss, twitter, reddit, social, irc,
 * chat, mesh, federation, webhooks and any event name we don't recognise —
 * is wrapped by default: an unknown event is treated as third-party text
 * until someone adds its prefix here on purpose.
 * Note: project:* events carry webhook payloads from the project's app (e.g. waitlist sign-ups), so they stay wrapped.
 */
export const INTERNAL_EVENT_PREFIXES: readonly string[] = [
  "agent:", "agents.", "agent.", "task:", "tasks.", "task.", "projects.", "outbox:",
  "reminder", "schedule", "kernel:", "kernel.", "system", "goal", "office", "meeting", "plan",
];

export function isInternalEvent(eventName: string): boolean {
  return INTERNAL_EVENT_PREFIXES.some((p) => eventName.startsWith(p));
}

/** The goal of a run an event triggers: external events' values reach the model wrapped. */
export function eventGoal(template: string, eventName: string, payload: unknown): string {
  const variables = { event: payload as Record<string, unknown> };
  const opts = isInternalEvent(eventName) ? {} : { external: { source: `event:${eventName}` } };
  return resolveGoal(template, variables, opts) || `Triggered by event: ${eventName}`;
}

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
      if (!agent || !agent.active || this.service.isAgentOfficePaused(agent.id)) continue;

      // Resolve goal
      const goal = eventGoal(agent.goal_template, eventName, payload);

      // An event about a project (project:* from src/modules/projects) runs
      // for that project; the gate in createRun refuses offices not serving it.
      const projectId = typeof (payload as Record<string, unknown> | null)?.project_id === "string"
        ? ((payload as Record<string, unknown>).project_id as string)
        : null;

      // Create and execute run (fire-and-forget)
      let run;
      try {
        run = this.service.createRun({
          agent_id: agent.id,
          trigger_type: "event",
          trigger_payload: payload as Record<string, unknown>,
          goal,
          project_id: projectId,
        });
      } catch (err) {
        log.debug(`ReactiveEngine: trigger ${trigger.id} not run — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      this.activeRuns++;

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

      // Feed the circuit breaker. Event-triggered runs used to skip it
      // entirely, so an agent that only ever fires on events could fail
      // identically forever without tripping — the breaker only saw the
      // scheduler's cron paths and the executor's builtin short-circuit.
      this.service.recordRunOutcome(agent.id, {
        ok: result.status === "completed",
        error: result.error,
        run_id: run.id,
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

      // A throw counts against the breaker exactly like a returned failure —
      // from the operator's side both are "this agent did not work".
      this.service.recordRunOutcome(agent.id, { ok: false, error: errorMsg, run_id: run.id });

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
