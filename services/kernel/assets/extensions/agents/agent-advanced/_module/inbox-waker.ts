/**
 * InboxWaker — turns the inbox from "lazy mailbox" into a wake-up signal.
 *
 * Subscribes to agent:inbox:posted. When a message lands and the recipient is
 * idle (no running/pending run) and not about to fire from a schedule within
 * the configured quiet window, it spawns a "process inbox" run so the agent
 * actually reads the message instead of waiting for an unrelated trigger.
 *
 * Guardrails:
 *   1. Recipient agent must have wake_on_inbox=1 and be active.
 *   2. Recipient must NOT have a run already in 'running' or 'pending'.
 *   3. No schedule of the recipient may fire within `quietMs` from now.
 *   4. Per-agent in-memory cooldown — same agent isn't woken twice within
 *      `quietMs` even if multiple messages arrive in quick succession.
 *   5. Kill switch: env AGENTS_INBOX_WAKE=0 disables entirely.
 *
 * Failure mode: any error is caught and logged. A broken waker must not
 * break the caller's postToColleague.
 */

import { log } from "../../../../../src/core/logger.js";
import { isoNow } from "../../../../../src/core/helpers.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";
import type { AgentExecutor } from "../../../../../src/modules/agents/executor.js";

interface WakerConfig {
  quietMs: number;
}

export class InboxWaker {
  private killSwitch: boolean;
  private lastWakeAt = new Map<string, number>();
  private inFlight = new Set<string>();

  constructor(
    private service: AgentService,
    private executor: AgentExecutor,
    private events: EventBus,
    private cfg: WakerConfig,
  ) {
    this.killSwitch = process.env.AGENTS_INBOX_WAKE === "0";
    if (this.killSwitch) {
      log.info("InboxWaker: kill switch is ON (AGENTS_INBOX_WAKE=0) — auto-wake disabled.");
    }
  }

  start(): void {
    if (this.killSwitch) return;
    this.events.on("agent:inbox:posted", (payload) => {
      try {
        const p = payload as {
          message_id: string;
          to_agent_id: string;
          from_agent_id: string;
          subject: string;
          conversation_id?: string;
        };
        if (!p?.to_agent_id) return;
        void this.onInboxPost(p);
      } catch (err) {
        log.warn(`InboxWaker listener error: ${String(err)}`);
      }
    });
    log.info(`InboxWaker: started (quiet window ${this.cfg.quietMs}ms).`);
  }

  private async onInboxPost(p: {
    message_id: string;
    to_agent_id: string;
    from_agent_id: string;
    subject: string;
    conversation_id?: string;
  }): Promise<void> {
    const agentId = p.to_agent_id;
    if (this.inFlight.has(agentId)) return; // already evaluating
    this.inFlight.add(agentId);
    try {
      const agent = this.service.getAgent(agentId);
      if (!agent || !agent.active) return;
      if (agent.wake_on_inbox === 0) return;

      // Per-agent cooldown — collapse a burst of messages into one wake-up.
      const last = this.lastWakeAt.get(agentId) ?? 0;
      if (Date.now() - last < this.cfg.quietMs) return;

      // Already busy? Let the current run pick up the inbox naturally.
      const active = this.service.listRuns({ agent_id: agentId, status: "running", limit: 1 });
      if (active.length > 0) return;
      const pending = this.service.listRuns({ agent_id: agentId, status: "pending", limit: 1 });
      if (pending.length > 0) return;

      // About to fire from a schedule? Skip — the schedule will handle it.
      const horizon = new Date(Date.now() + this.cfg.quietMs).toISOString();
      const schedules = this.service.listSchedules(agentId)
        .filter(s => s.active && s.next_run_at && s.next_run_at <= horizon);
      if (schedules.length > 0) return;

      this.lastWakeAt.set(agentId, Date.now());

      const sender = this.service.getAgent(p.from_agent_id);
      const senderName = sender?.name ?? p.from_agent_id;
      const subject = (p.subject || "(no subject)").slice(0, 200);
      const goal =
        `Inbox wake-up: ${senderName} just sent you "${subject}". ` +
        `Read your inbox with kernel_agents_inbox, decide if a reply is needed, ` +
        `and respond via kernel_agents_post_to_colleague (or take whatever action the message asks for).`;

      const run = this.service.createRun({
        agent_id: agentId,
        trigger_type: "event",
        trigger_payload: {
          via: "inbox_waker",
          inbox_message_id: p.message_id,
          conversation_id: p.conversation_id ?? "",
          from_agent_id: p.from_agent_id,
        },
        goal,
      });
      this.service.updateRun(run.id, { status: "running", started_at: isoNow() });
      this.events.emit("agent.run.started", {
        run_id: run.id, agent_id: agentId, agent_name: agent.name,
        trigger_type: "event",
      });

      log.info(`InboxWaker: waking "${agent.name}" (${agentId}) for message ${p.message_id} from ${senderName}`);

      // Fire-and-forget — the waker does not await; the executor manages
      // its own lifecycle (timeouts, errors, completion events).
      this.executor.execute({ agent, goal, run, service: this.service, events: this.events })
        .then((result) => {
          this.service.updateRun(run.id, {
            status: result.status,
            result: result.result,
            error: result.error,
            steps_count: result.steps_count,
            tokens_used: result.tokens_used,
            completed_at: isoNow(),
          });
          this.events.emit("agent.run.completed", {
            run_id: run.id, agent_id: agentId,
            status: result.status, steps_count: result.steps_count, tokens_used: result.tokens_used,
          });
        })
        .catch((err) => {
          this.service.updateRun(run.id, {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            completed_at: isoNow(),
          });
          log.error(`InboxWaker: run ${run.id} failed`, err);
        });
    } catch (err) {
      log.warn(`InboxWaker.onInboxPost failed: ${String(err)}`);
    } finally {
      this.inFlight.delete(agentId);
    }
  }
}
