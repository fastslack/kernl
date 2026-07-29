/**
 * Debate Orchestrator — auto-opens a structured debate when agents disagree.
 *
 * Subscribes to agent:conversation:message_posted events. When a new message
 * with role='counter' lands, checks whether the conversation already has 2+
 * distinct counter senders. If so — and guardrails allow it — spawns a debate
 * via the MeetingExecutor with mode='debate'.
 *
 * Guardrails (all must pass):
 *   1. Min counters: >= 2 distinct sender agents on the same conversation.
 *   2. Topic dedup: no debate on the same topic_hash within COOLDOWN_MS.
 *   3. Rate limit: no more than MAX_DEBATES_PER_HOUR globally.
 *   4. Flow opt-out: any participant flow with auto_debate=0 vetoes the debate.
 *   5. Anti-loop on resolution: messages inside a debate's own conversation
 *      never trigger a nested debate. Votes (role='vote') never open debates.
 *   6. Max participants: 5 — if more qualify, keep top-5 by rank + initiator.
 *   7. Kill switch: env AGENTS_AUTO_DEBATE=0 disables entirely.
 *
 * Failure mode: any error in the orchestrator is caught + logged. A broken
 * orchestrator must not break the caller's message post.
 */

import { log } from "../../../../../src/core/logger.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";
import type { MeetingExecutor } from "./meeting-executor.js";
import type { AgentConversation, AgentMessage } from "../../../../../src/modules/agents/types.js";

interface OrchestratorConfig {
  cooldownMs: number;        // dedup window per topic_hash
  maxDebatesPerHour: number; // global rate limit
  maxParticipants: number;   // hard cap per debate
  rounds: number;            // debate rounds (1..3)
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  cooldownMs: 60 * 60 * 1000,      // 60 min
  maxDebatesPerHour: 3,
  maxParticipants: 5,
  rounds: 3,
};

export class DebateOrchestrator {
  private config: OrchestratorConfig;
  private killSwitch: boolean;
  private pending = new Set<string>(); // conversation_ids currently being evaluated

  constructor(
    private service: AgentService,
    private meetingExecutor: MeetingExecutor,
    private events: EventBus,
    config?: Partial<OrchestratorConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    this.killSwitch = process.env.AGENTS_AUTO_DEBATE === "0";
    if (this.killSwitch) {
      log.info("DebateOrchestrator: kill switch is ON (AGENTS_AUTO_DEBATE=0) — automatic debates disabled.");
    }
  }

  /** Subscribe to the message stream. Call once at module init. */
  start(): void {
    this.events.on("agent:conversation:message_posted", (payload) => {
      try {
        const p = payload as {
          conversation_id: string;
          message_id: string;
          from_agent_id: string;
          role: string;
        };
        if (!p || p.role !== "counter") return;
        void this.onCounterMessage(p.conversation_id, p.message_id);
      } catch (err) {
        log.warn(`DebateOrchestrator listener error: ${String(err)}`);
      }
    });
    log.info(
      `DebateOrchestrator: started (cooldown ${this.config.cooldownMs}ms, max ${this.config.maxDebatesPerHour}/hr, cap ${this.config.maxParticipants} participants).`,
    );
  }

  /**
   * Evaluate a counter message against the guardrails. If all pass, open a
   * debate. Swallows errors so the poster's run is never affected.
   */
  private async onCounterMessage(conversationId: string, triggerMessageId: string): Promise<void> {
    if (this.killSwitch) return;

    // Avoid re-entrancy: if we are already evaluating this conversation, skip.
    if (this.pending.has(conversationId)) return;
    this.pending.add(conversationId);
    try {
      await this.tryOpenDebate(conversationId, triggerMessageId);
    } catch (err) {
      log.warn(`DebateOrchestrator: tryOpenDebate failed for conv ${conversationId}: ${String(err)}`);
    } finally {
      this.pending.delete(conversationId);
    }
  }

  private async tryOpenDebate(conversationId: string, triggerMessageId: string): Promise<void> {
    const convo = this.service.getConversation(conversationId);
    if (!convo) return;

    // Guardrail 5a: never recurse inside a debate's own conversation.
    if (convo.kind === "debate") return;
    // Guardrail 5b: a closed conversation is already resolved.
    if (convo.status === "closed") return;

    const stats = this.service.getCounterStats(conversationId);

    // Guardrail 1: need >=2 distinct senders marking counter.
    if (stats.distinct_senders.length < 2) return;

    // Guardrail 2: topic dedup.
    const cooldown = this.service.getDebateCooldown(convo.topic_hash);
    if (cooldown) {
      const age = Date.now() - new Date(cooldown.opened_at).getTime();
      if (age < this.config.cooldownMs) {
        this.logEvent("debate_skipped", `dedup — ${convo.topic_hash} debated ${Math.round(age / 1000)}s ago`, {
          conversation_id: conversationId,
          topic_hash: convo.topic_hash,
          last_debate_conv_id: cooldown.debate_conv_id,
          reason: "cooldown",
        });
        return;
      }
    }

    // Guardrail 3: global rate limit.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = this.service.countRecentAutoDebates(hourAgo);
    if (recent >= this.config.maxDebatesPerHour) {
      this.logEvent("debate_skipped", `rate limit — ${recent}/${this.config.maxDebatesPerHour} in the last hour`, {
        conversation_id: conversationId,
        recent_debates: recent,
        reason: "rate_limit",
      });
      return;
    }

    // Collect positions + participants.
    const participantIds = this.selectParticipants(convo, stats.counters);
    if (participantIds.length < 3) return; // require >=3 parties (asker + 2 disagreeing)

    // Guardrail 4: opt-out by flow.
    const flows = this.service.listFlows();
    const flowById = new Map(flows.map(f => [f.id, f]));
    let vetoingFlow = "";
    for (const pid of participantIds) {
      const a = this.service.getAgent(pid);
      if (!a?.flow_id) continue;
      const f = flowById.get(a.flow_id) as (typeof flows[number] & { auto_debate?: number }) | undefined;
      if (f && (f as { auto_debate?: number }).auto_debate === 0) {
        vetoingFlow = f.name;
        break;
      }
    }
    if (vetoingFlow) {
      this.logEvent("debate_skipped", `flow opt-out — "${vetoingFlow}" has auto_debate=0`, {
        conversation_id: conversationId,
        vetoing_flow: vetoingFlow,
        reason: "flow_opt_out",
      });
      return;
    }

    // Positions: for each counter sender, the body of their first counter.
    const positions: Record<string, string> = {};
    for (const c of stats.counters) {
      if (!positions[c.from_agent_id]) {
        positions[c.from_agent_id] = c.body.slice(0, 400);
      }
    }
    // Asker's own position too, if they have one.
    if (convo.initiator_agent_id && !positions[convo.initiator_agent_id]) {
      const askerMsgs = this.service.listMessages(conversationId, { limit: 5 })
        .filter(m => m.from_agent_id === convo.initiator_agent_id);
      if (askerMsgs.length > 0) {
        positions[convo.initiator_agent_id] = askerMsgs[0].body.slice(0, 400);
      }
    }

    // Record cooldown FIRST — if the meeting executor crashes we still hold
    // the lock and avoid re-firing for this topic immediately.
    // Debate conversation id is filled below.
    const debateConvo = this.service.createConversation({
      kind: "debate",
      topic: convo.topic,
      participants: participantIds,
      initiator_agent_id: convo.initiator_agent_id,
      parent_conversation_id: convo.id,
      meta: {
        trigger_message_id: triggerMessageId,
        counters: stats.counters.map(c => c.id),
      },
    });
    this.service.recordDebateCooldown(convo.topic_hash, debateConvo.id);

    this.logEvent("debate_auto_opened", `${participantIds.length} participants — "${convo.topic.slice(0, 80)}"`, {
      conversation_id: conversationId,
      debate_conversation_id: debateConvo.id,
      topic_hash: convo.topic_hash,
      participants: participantIds,
      trigger_message_id: triggerMessageId,
      recent_debates_in_last_hour: recent,
    });

    // Moderator: pass the asker in so the executor can promote next-highest-rank
    // instead. The first participant id is passed as moderator_id; the executor
    // auto-reorders by rank anyway.
    const moderatorSeed = participantIds[0];
    const attendeeSeed = participantIds.slice(1);

    // Find the trigger question (the asker's message the counters replied to,
    // or the earliest asker message as a fallback).
    const triggerMsg = this.service.getMessage(triggerMessageId);
    const sourceQuestionId =
      triggerMsg?.in_reply_to
      || this.firstAskerMessage(conversationId, convo.initiator_agent_id)?.id
      || "";

    // Fire and forget — debates can take minutes. The caller's message post
    // must not wait.
    void this.meetingExecutor.run(
      {
        topic: convo.topic,
        mode: "debate",
        moderator_id: moderatorSeed,
        attendee_ids: attendeeSeed,
        positions,
        source_conversation_id: convo.id,
        source_question_message_id: sourceQuestionId,
        asker_agent_id: convo.initiator_agent_id,
        rounds: this.config.rounds,
        urgency: "urgent",
      },
      this.service,
      this.events,
    ).catch(err => {
      log.error(`DebateOrchestrator: debate ${debateConvo.id} crashed: ${String(err)}`);
      // Release the cooldown so the topic can be re-debated sooner if needed.
      // (We keep the record but the caller could clear it — for now we just log.)
    });
  }

  /**
   * Pick up to maxParticipants agents to include in the debate.
   *
   * Priority:
   *   1. Always include the conversation initiator (the asker).
   *   2. All distinct counter senders.
   *   3. If still under the cap, fill with other participants already in the
   *      source conversation, preferring higher rank (needed as moderator).
   */
  private selectParticipants(convo: AgentConversation, counters: AgentMessage[]): string[] {
    const cap = this.config.maxParticipants;
    const set = new Set<string>();
    if (convo.initiator_agent_id) set.add(convo.initiator_agent_id);
    const counterSenders = Array.from(new Set(counters.map(c => c.from_agent_id)));
    for (const id of counterSenders) {
      if (set.size >= cap) break;
      set.add(id);
    }
    if (set.size < cap) {
      const convoParticipants = this.service.parseParticipants(convo);
      // Fill with remaining participants, highest rank first.
      const remaining = convoParticipants.filter(id => !set.has(id));
      const ranked = remaining
        .map(id => ({ id, rank: this.service.getRank(this.service.getAgent(id)?.rank_id ?? "") }))
        .sort((a, b) => (b.rank?.level ?? -1) - (a.rank?.level ?? -1));
      for (const { id } of ranked) {
        if (set.size >= cap) break;
        set.add(id);
      }
    }
    return Array.from(set);
  }

  private firstAskerMessage(conversationId: string, askerId: string): AgentMessage | undefined {
    if (!askerId) return undefined;
    const all = this.service.listMessages(conversationId, { limit: 50 });
    return all.find(m => m.from_agent_id === askerId);
  }

  private logEvent(subtype: string, detail: string, raw: Record<string, unknown>): void {
    try {
      this.service.logEvent({
        run_id: "",
        agent_id: "",
        agent_name: "debate-orchestrator",
        event_type: "debate",
        event_subtype: subtype,
        detail,
        raw_data: raw,
      });
    } catch (err) {
      log.warn(`DebateOrchestrator logEvent failed: ${String(err)}`);
    }
  }
}
