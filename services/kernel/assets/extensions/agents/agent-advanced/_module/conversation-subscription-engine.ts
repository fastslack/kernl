/**
 * ConversationSubscriptionEngine — keeps agents engaged in conversations.
 *
 * Subscribes to agent:conversation:message_posted. When a new turn lands,
 * looks up which agents follow that conversation and (for mode='responder')
 * spawns a run so they can react. mode='observer' is reserved — it does
 * not spawn runs today, but the subscription record is preserved so a
 * future awareness layer can read it without a schema change.
 *
 * Guardrails:
 *   1. Never wake the sender (an agent does not respond to its own message).
 *   2. Per-(agent, conversation) cooldown — `subscriptionCooldownMs` from
 *      service.markSubscriptionFired. Prevents the engine from chasing its
 *      own tail when the responder posts back.
 *   3. Skip if subscriber already has a run in 'running' or 'pending'.
 *   4. Optional filter_role — only fire when the new message matches
 *      ('' means any role).
 *   5. Kill switch: env AGENTS_CONVERSATION_SUBSCRIPTIONS=0 disables all.
 *
 * Failure mode: any error is caught and logged. A broken engine must not
 * break message posting.
 */

import { log } from "../../../../../src/core/logger.js";
import { isoNow } from "../../../../../src/core/helpers.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";
import type { AgentExecutor } from "../../../../../src/modules/agents/executor.js";
import { resolveAgentLanguage } from "../../../../../src/modules/agents/i18n.js";
import { promptSubscriptionResponder, promptStyleDirective } from "../../../../../src/core/i18n/prompts.js";

interface EngineConfig {
  cooldownMs: number;
}

export class ConversationSubscriptionEngine {
  private killSwitch: boolean;

  constructor(
    private service: AgentService,
    private executor: AgentExecutor,
    private events: EventBus,
    private cfg: EngineConfig,
    /** Optional — when provided, the wake-up goal is translated per agent. */
    private kernelConfig?: KernelConfig | null,
  ) {
    this.killSwitch = process.env.AGENTS_CONVERSATION_SUBSCRIPTIONS === "0";
    if (this.killSwitch) {
      log.info("ConversationSubscriptionEngine: kill switch is ON — disabled.");
    }
  }

  start(): void {
    if (this.killSwitch) return;
    this.events.on("agent:conversation:message_posted", (payload) => {
      try {
        const p = payload as {
          conversation_id: string;
          message_id: string;
          from_agent_id: string;
          role: string;
        };
        if (!p?.conversation_id || !p?.message_id) return;
        void this.onMessage(p);
      } catch (err) {
        log.warn(`ConversationSubscriptionEngine listener error: ${String(err)}`);
      }
    });
    log.info(
      `ConversationSubscriptionEngine: started (cooldown ${this.cfg.cooldownMs}ms per agent/conversation).`,
    );
  }

  private async onMessage(p: {
    conversation_id: string;
    message_id: string;
    from_agent_id: string;
    role: string;
  }): Promise<void> {
    const subs = this.service.listSubscriptionsForConversation(p.conversation_id);
    if (subs.length === 0) return;

    const message = this.service.getMessage(p.message_id);
    if (!message) return;
    const conversation = this.service.getConversation(p.conversation_id);
    if (!conversation) return;

    for (const sub of subs) {
      try {
        if (sub.mode !== "responder") continue;
        if (sub.agent_id === p.from_agent_id) continue;
        if (sub.filter_role && sub.filter_role !== p.role) continue;

        // Per-subscription cooldown (against self-reply storms).
        if (sub.last_fired_at) {
          const last = Date.parse(sub.last_fired_at);
          if (Number.isFinite(last) && Date.now() - last < this.cfg.cooldownMs) continue;
        }

        const agent = this.service.getAgent(sub.agent_id);
        if (!agent || !agent.active) continue;

        // Don't queue a duplicate if the subscriber is already running.
        const active = this.service.listRuns({ agent_id: sub.agent_id, status: "running", limit: 1 });
        if (active.length > 0) continue;
        const pending = this.service.listRuns({ agent_id: sub.agent_id, status: "pending", limit: 1 });
        if (pending.length > 0) continue;

        this.service.markSubscriptionFired(sub.id);

        const sender = this.service.getAgent(p.from_agent_id);
        const senderName = sender?.name ?? p.from_agent_id;
        const topic = (conversation.topic || "").slice(0, 200);
        const preview = (message.body || "").slice(0, 800);
        const lang = resolveAgentLanguage(agent, this.kernelConfig ?? null);
        const header = lang === "es"
          ? `Nuevo turno en la conversación "${topic}" (id: ${conversation.id}).\n\n` +
            `${senderName} dijo (rol=${message.role}):\n${preview}\n\n`
          : `New turn in conversation "${topic}" (id: ${conversation.id}).\n\n` +
            `${senderName} said (role=${message.role}):\n${preview}\n\n`;
        const responderInstr = lang === "es"
          ? `${promptSubscriptionResponder(lang)} Si vas a responder, posteá con kernel_agents_post_to_colleague usando conversation_id="${conversation.id}" e in_reply_to_message_id="${message.id}".`
          : `${promptSubscriptionResponder(lang)} If you reply, post with kernel_agents_post_to_colleague using conversation_id="${conversation.id}" and in_reply_to_message_id="${message.id}".`;
        const goal = header + responderInstr + "\n\n" + promptStyleDirective(lang);

        const run = this.service.createRun({
          agent_id: sub.agent_id,
          trigger_type: "event",
          trigger_payload: {
            via: "conversation_subscription",
            subscription_id: sub.id,
            conversation_id: conversation.id,
            triggering_message_id: message.id,
            triggering_role: message.role,
            from_agent_id: p.from_agent_id,
          },
          goal,
        });
        this.service.updateRun(run.id, { status: "running", started_at: isoNow() });
        this.events.emit("agent.run.started", {
          run_id: run.id, agent_id: sub.agent_id, agent_name: agent.name,
          trigger_type: "event",
        });

        log.info(
          `ConversationSubscriptionEngine: waking "${agent.name}" (${sub.agent_id}) ` +
          `for new turn in conversation ${conversation.id}`,
        );

        // Fire-and-forget — do not block other subscribers in this loop.
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
              run_id: run.id, agent_id: sub.agent_id,
              status: result.status, steps_count: result.steps_count, tokens_used: result.tokens_used,
            });
          })
          .catch((err) => {
            this.service.updateRun(run.id, {
              status: "failed",
              error: err instanceof Error ? err.message : String(err),
              completed_at: isoNow(),
            });
            log.error(`ConversationSubscriptionEngine: run ${run.id} failed`, err);
          });
      } catch (err) {
        log.warn(`ConversationSubscriptionEngine.onMessage(sub=${sub.id}) failed: ${String(err)}`);
      }
    }
  }
}
