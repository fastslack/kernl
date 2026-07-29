/**
 * Meeting Executor — structured multi-agent conversations.
 *
 * A meeting is a 2–3 round moderated discussion:
 *   Round 1: Moderator presents topic → each attendee gives input (1 LLM call each)
 *   Round 2: Moderator synthesizes round 1 → attendees refine / raise concerns
 *   Round 3: Moderator produces final summary with decisions + action items
 *
 * Each "turn" is an independent LLM call using the agent's own system prompt
 * plus the shared meeting transcript. No tools are invoked during meetings —
 * the goal is deliberation, not execution.
 *
 * Produces:
 *   - A note with the meeting minutes (kernel_notes)
 *   - Steps logged to a dedicated meeting run
 *   - Events for the 3D office visualization
 */

import { log } from "../../../../../src/core/logger.js";
import { isoNow, newId } from "../../../../../src/core/helpers.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { KernelConfig, KernelLanguage } from "../../../../../src/core/config.js";
import type { ChatLlmProvider } from "../../../../../src/modules/chat/llm-adapter.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";
import type { Agent } from "../../../../../src/modules/agents/types.js";
import { buildAgentChain, runWithChain } from "./chain-runner.js";
import { resolveAgentSystemPrompt, resolveAgentLanguage } from "../../../../../src/modules/agents/i18n.js";
import {
  promptMeetingTurnSystem,
  promptMeetingTranscriptBlock,
  promptModeratorOpen,
  promptModeratorSynthesize,
  promptModeratorClose,
  promptMeetingAttendee,
  promptDebateOpen,
  promptDebateSynthesize,
  promptDebateClose,
  promptDebateAttendee,
  promptStyleDirective,
} from "../../../../../src/core/i18n/prompts.js";

export interface MeetingRequest {
  topic: string;
  /** The agent who called the meeting (moderator). */
  moderator_id: string;
  /** Invited agent IDs (excluding moderator). */
  attendee_ids: string[];
  /** Optional context/document to discuss. */
  context?: string;
  /** Number of discussion rounds (default: 2). */
  rounds?: number;
  /** "normal" | "urgent" — affects 3D animation color. */
  urgency?: string;
  /**
   * 'meeting' = synthetic group discussion (default).
   * 'debate'  = adversarial: every attendee defends their stated position,
   *             rebuts the others, and the moderator decides.
   */
  mode?: "meeting" | "debate";
  /**
   * Debate-only. Ordered map of agent_id → declared position (quoted snippet
   * of their earlier message that triggered the debate). Used to seed each
   * attendee's prompt so they defend a specific claim instead of the generic
   * "give your input".
   */
  positions?: Record<string, string>;
  /**
   * Debate-only. Conversation id the debate is rooted in — we post the final
   * verdict back into this thread as role='vote' so the original asker sees
   * it in their next run.
   */
  source_conversation_id?: string;
  /**
   * Debate-only. Message id of the asker's original question (what the
   * debated counters reply to). Used for the in_reply_to linkage on the
   * verdict message.
   */
  source_question_message_id?: string;
  /**
   * Debate-only. Agent id of the asker. Excluded from moderator selection
   * (conflict of interest) unless they are the only ranked participant.
   */
  asker_agent_id?: string;
}

export interface MeetingResult {
  meeting_id: string;
  summary: string;
  decisions: string[];
  action_items: string[];
  transcript: string;
  total_tokens: number;
  rounds_completed: number;
}

interface Turn {
  agent_id: string;
  agent_name: string;
  role: "moderator" | "attendee";
  round: number;
  content: string;
  tokens: number;
}

export class MeetingExecutor {
  private providers: Map<string, ChatLlmProvider> = new Map();
  private defaultProvider = "";
  private configRef: KernelConfig | null = null;

  setProviders(providers: Map<string, ChatLlmProvider>, defaultProvider: string): void {
    this.providers = providers;
    this.defaultProvider = defaultProvider;
  }

  setConfig(config: KernelConfig): void {
    this.configRef = config;
  }

  async run(
    request: MeetingRequest,
    service: AgentService,
    events: EventBus,
  ): Promise<MeetingResult> {
    // Defer the meetingId assignment until we know the moderator + attendees
    // — we now use a real `agent_conversations` row id so the meeting is
    // persisted from minute zero. That row is what the dashboard hydrates
    // when the user refreshes the page mid-meeting.
    // Cap kept high (20) so the dashboard AUTOMEETING selector (1..20) is
    // honored end-to-end. A higher ceiling protects against an LLM-generated
    // rounds=9999 runaway; 20 still costs minutes of LLM calls so callers
    // who want more must lift this knowingly.
    const rounds = Math.min(Math.max(request.rounds ?? 2, 1), 20);
    const allIds = [request.moderator_id, ...request.attendee_ids];

    // Resolve all agents
    const agents: Agent[] = [];
    for (const id of allIds) {
      const a = service.getAgent(id);
      if (a) agents.push(a);
      else log.warn(`Meeting (pending id): agent ${id} not found, skipping`);
    }
    if (agents.length < 2) {
      return {
        meeting_id: "",
        summary: "Meeting cancelled: not enough participants",
        decisions: [],
        action_items: [],
        transcript: "",
        total_tokens: 0,
        rounds_completed: 0,
      };
    }

    // Auto-reorder: the highest-ranked participant is the natural moderator.
    // Keeps the request intent (whoever called the meeting is still included),
    // but elevates the senior officer to chair. Ties resolved by created_at asc.
    // Debate mode: exclude the asker from the moderator slot when possible —
    // the asker raised the question, so they shouldn't also be the judge.
    const mode = request.mode ?? "meeting";
    const ranked = agents
      .map(a => ({ agent: a, rank: service.getRank(a.rank_id) }))
      .sort((a, b) => {
        const la = a.rank?.level ?? -1;
        const lb = b.rank?.level ?? -1;
        if (la !== lb) return lb - la;
        return (a.agent.created_at ?? "").localeCompare(b.agent.created_at ?? "");
      });
    let moderator = ranked[0].agent;
    if (mode === "debate" && request.asker_agent_id && moderator.id === request.asker_agent_id && ranked.length > 1) {
      moderator = ranked[1].agent;
      log.info(`Meeting (asker excluded): ${request.asker_agent_id} excluded from moderation — ${moderator.name} takes over`);
    }
    const attendees = agents.filter(a => a.id !== moderator.id);
    const attendeeNames = attendees.map(a => a.name).join(", ");
    const originalModeratorId = agents[0].id;
    if (moderator.id !== originalModeratorId) {
      log.info(`Meeting (rank promotion): moderator promoted by rank (${moderator.name} over ${agents[0].name})`);
    }

    // ── Persist the meeting as an `agent_conversations` row ─────────────
    // This is the canonical record the dashboard hydrates from when the
    // browser refreshes mid-meeting. The conversation id doubles as the
    // meeting_id in every WS event so the live state and the persisted
    // state share a single key.
    const conversation = service.createConversation({
      kind: "meeting",
      topic: request.topic,
      participants: agents.map(a => a.id),
      initiator_agent_id: moderator.id,
      meta: {
        moderator_id: moderator.id,
        attendee_ids: attendees.map(a => a.id),
        rounds,
        mode,
        urgency: request.urgency ?? "normal",
      },
    });
    const meetingId = conversation.id;

    // Create a run for the meeting
    const run = service.createRun({
      agent_id: moderator.id,
      trigger_type: "manual",
      trigger_payload: {
        type: "meeting",
        meeting_id: meetingId,
        attendees: attendees.map(a => a.id),
      },
      goal: `Meeting: ${request.topic}`,
    });
    service.updateRun(run.id, { status: "running", started_at: isoNow() });

    // Emit: meeting requested (walkers start moving)
    events.emit("agent:flow:meeting_requested", {
      meeting_id: meetingId,
      moderator_id: moderator.id,
      moderator_name: moderator.name,
      attendee_ids: attendees.map(a => a.id),
      attendee_names: attendees.map(a => a.name),
      topic: request.topic,
      urgency: request.urgency ?? "normal",
    });

    // Wait for walkers to arrive before starting discussion
    await sleep(4000);

    events.emit("agent:flow:meeting_started", {
      meeting_id: meetingId,
      topic: request.topic,
      participants: agents.map(a => ({ id: a.id, name: a.name })),
    });

    const transcript: Turn[] = [];
    let totalTokens = 0;
    let stepNumber = 0;

    // Sanity check: the moderator must have at least one usable provider in
    // its chain (or a fallback). Per-turn calls below will walk the chain on
    // their own so this is purely a fail-fast for unrecoverable misconfig.
    const moderatorChain = buildAgentChain(
      moderator,
      service,
      this.providers,
      { provider: moderator.provider || this.defaultProvider, model: moderator.model },
      this.configRef?.agents?.defaultModelChain,
    );
    if (moderatorChain.length === 0) {
      service.updateRun(run.id, {
        status: "failed",
        error: `No LLM provider available for moderator ${moderator.name} (chain + fallback empty)`,
        completed_at: isoNow(),
      });
      return {
        meeting_id: meetingId,
        summary: "Meeting failed: no LLM provider",
        decisions: [],
        action_items: [],
        transcript: "",
        total_tokens: 0,
        rounds_completed: 0,
      };
    }

    const isDebate = mode === "debate";
    const moderatorLang = resolveAgentLanguage(moderator, this.configRef);

    try {
      for (let round = 1; round <= rounds; round++) {
        // ── Moderator opens the round ──
        const modPrompt = isDebate
          ? (round === 1
              ? this.buildDebateOpenPrompt(request, attendees, moderatorLang)
              : round < rounds
                ? this.buildDebateSynthesizePrompt(request, round, moderatorLang)
                : this.buildDebateClosePrompt(request, moderatorLang))
          : (round === 1
              ? this.buildModeratorOpenPrompt(request, attendeeNames, moderatorLang)
              : round < rounds
                ? this.buildModeratorSynthesizePrompt(request, transcript, round, moderatorLang)
                : this.buildModeratorClosePrompt(request, transcript, moderatorLang));

        const modTurn = await this.callAgent(
          moderator, service, modPrompt, transcript, isDebate,
          service.buildHierarchyBlock(moderator.id),
        );
        transcript.push({
          agent_id: moderator.id,
          agent_name: moderator.name,
          role: "moderator",
          round,
          content: modTurn.content,
          tokens: modTurn.tokens,
        });
        totalTokens += modTurn.tokens;
        stepNumber++;
        service.addStep({
          run_id: run.id,
          step_number: stepNumber,
          type: "thought",
          content: `[Round ${round} - ${moderator.name} (moderator)] ${modTurn.content}`,
          tokens: modTurn.tokens,
        });

        events.emit("agent:flow:meeting_turn", {
          meeting_id: meetingId,
          agent_id: moderator.id,
          agent_name: moderator.name,
          round,
          role: "moderator",
          content_preview: modTurn.content.slice(0, 120),
          // Full body so the live-meeting modal can render the real transcript.
          body: modTurn.content,
          tokens: modTurn.tokens,
        });
        // Persist the turn so a page refresh can rebuild the transcript.
        service.postMessage({
          conversation_id: meetingId,
          from_agent_id: moderator.id,
          role: "stmt",
          body: modTurn.content,
          tokens: modTurn.tokens,
          run_id: run.id,
          meta: { meeting_role: "moderator", round },
        });

        // ── Each attendee responds ──
        if (round <= rounds) {
          for (const attendee of attendees) {
            const attendeeLang = resolveAgentLanguage(attendee, this.configRef);
            const attPrompt = isDebate
              ? this.buildDebateAttendeePrompt(request, transcript, round, attendee, attendeeLang)
              : this.buildAttendeePrompt(request, transcript, round, attendee, attendeeLang);

            const attTurn = await this.callAgent(
              attendee, service, attPrompt, transcript, isDebate,
              service.buildHierarchyBlock(attendee.id),
            );
            transcript.push({
              agent_id: attendee.id,
              agent_name: attendee.name,
              role: "attendee",
              round,
              content: attTurn.content,
              tokens: attTurn.tokens,
            });
            totalTokens += attTurn.tokens;
            stepNumber++;
            service.addStep({
              run_id: run.id,
              step_number: stepNumber,
              type: "thought",
              content: `[Round ${round} - ${attendee.name}] ${attTurn.content}`,
              tokens: attTurn.tokens,
            });

            events.emit("agent:flow:meeting_turn", {
              meeting_id: meetingId,
              agent_id: attendee.id,
              agent_name: attendee.name,
              round,
              role: "attendee",
              content_preview: attTurn.content.slice(0, 120),
              body: attTurn.content,
              tokens: attTurn.tokens,
            });
            service.postMessage({
              conversation_id: meetingId,
              from_agent_id: attendee.id,
              role: "stmt",
              body: attTurn.content,
              tokens: attTurn.tokens,
              run_id: run.id,
              meta: { meeting_role: "attendee", round },
            });
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Log the message text directly so the operator sees WHY it failed
      // (Error objects JSON.stringify to "{}" which hides the cause).
      log.error(`Meeting ${meetingId} error: ${msg}`);
      service.updateRun(run.id, {
        status: "failed",
        error: msg,
        steps_count: stepNumber,
        tokens_used: totalTokens,
        completed_at: isoNow(),
      });
      events.emit("agent:flow:meeting_ended", {
        meeting_id: meetingId,
        status: "failed",
        error: msg,
      });
      // Mark the persisted conversation closed so the dashboard's
      // "open meetings" hydration query stops surfacing it.
      service.closeConversation(meetingId);
      return {
        meeting_id: meetingId,
        summary: `Meeting failed: ${msg}`,
        decisions: [],
        action_items: [],
        transcript: this.formatTranscript(transcript),
        total_tokens: totalTokens,
        rounds_completed: transcript.filter(t => t.role === "moderator").length,
      };
    }

    // Extract the last moderator turn as the summary (final round close)
    const lastModTurn = [...transcript].reverse().find(t => t.role === "moderator");
    const summary = lastModTurn?.content ?? "No summary produced";

    // Parse decisions and action items from the summary
    const decisions = this.extractBullets(summary, "decision");
    const actionItems = this.extractBullets(summary, "action");

    const fullTranscript = this.formatTranscript(transcript);

    // Persist meeting result
    service.updateRun(run.id, {
      status: "completed",
      result: summary,
      steps_count: stepNumber,
      tokens_used: totalTokens,
      completed_at: isoNow(),
    });

    // Save to all participants' memory
    const memContent = `${mode === "debate" ? "Debate" : "Meeting"}: "${request.topic}" — ${summary.slice(0, 500)}`;
    for (const a of agents) {
      service.addMemory(a.id, "assistant", memContent, run.id);
    }

    // Debate mode: post the verdict back into the source conversation so the
    // asker sees the resolution on their next run. Role='vote' marks it as
    // the moderator's decision — no one should counter a vote (anti-loop).
    if (mode === "debate" && request.source_conversation_id) {
      try {
        service.postMessage({
          conversation_id: request.source_conversation_id,
          from_agent_id: moderator.id,
          to_agent_id: request.asker_agent_id ?? "",
          role: "vote",
          in_reply_to: request.source_question_message_id ?? "",
          body: summary,
          tokens: totalTokens,
          run_id: run.id,
          meta: {
            debate_meeting_id: meetingId,
            decisions,
            action_items: actionItems,
          },
        });
      } catch (err) {
        log.warn(`Debate ${meetingId}: failed to post verdict to source conversation: ${String(err)}`);
      }
    }

    // Stamp the closing summary as a final message on the conversation so
    // the persisted record carries decisions + action items, then close it.
    try {
      service.postMessage({
        conversation_id: meetingId,
        from_agent_id: moderator.id,
        role: "summary",
        body: summary,
        tokens: 0,
        run_id: run.id,
        meta: { decisions, action_items: actionItems },
      });
    } catch (err) {
      log.warn(`Meeting ${meetingId}: failed to post summary message: ${String(err)}`);
    }
    service.closeConversation(meetingId);

    events.emit("agent:flow:meeting_ended", {
      meeting_id: meetingId,
      mode,
      status: "completed",
      summary: summary.slice(0, 200),
      participants: agents.map(a => a.id),
      decisions,
      action_items: actionItems,
      total_tokens: totalTokens,
    });

    log.info(
      `Meeting ${meetingId} completed: ${agents.length} participants, ${transcript.length} turns, ${totalTokens} tokens`,
    );

    return {
      meeting_id: meetingId,
      summary,
      decisions,
      action_items: actionItems,
      transcript: fullTranscript,
      total_tokens: totalTokens,
      rounds_completed: Math.min(rounds, transcript.filter(t => t.role === "moderator").length),
    };
  }

  // ── LLM call for a single meeting turn ──

  private async callAgent(
    agent: Agent,
    service: AgentService,
    prompt: string,
    priorTranscript: Turn[],
    isDebate: boolean,
    hierarchyBlock?: string,
  ): Promise<{ content: string; tokens: number }> {
    const lang = resolveAgentLanguage(agent, this.configRef);
    const systemParts: string[] = [];
    const resolvedPrompt = resolveAgentSystemPrompt(agent, lang);
    if (resolvedPrompt) {
      systemParts.push(resolvedPrompt);
    }
    systemParts.push(promptMeetingTurnSystem(lang, isDebate));
    if (hierarchyBlock) {
      systemParts.push(hierarchyBlock);
    }

    // Build context from prior turns
    if (priorTranscript.length > 0) {
      systemParts.push(promptMeetingTranscriptBlock(lang, priorTranscript));
    }

    // Final language reinforcement so the model doesn't drift back to English
    // mid-debate just because the transcript is mixed-language.
    systemParts.push(promptStyleDirective(lang));

    const candidates = buildAgentChain(
      agent,
      service,
      this.providers,
      { provider: agent.provider || this.defaultProvider, model: agent.model },
      this.configRef?.agents?.defaultModelChain,
    );
    const system = systemParts.join("\n\n");

    const completion = await runWithChain(
      candidates,
      `MeetingExecutor[${agent.name}]`,
      (cand) => cand.provider.chatCompletion(
        [{ role: "user", content: prompt }],
        { system, model: cand.model || undefined, caller: `meeting:${agent.name}` },
      ),
    );

    return {
      content: completion.content,
      tokens: completion.tokens_used,
    };
  }

  // ── Prompt builders — all take `lang` (the recipient's resolved language) ──

  private buildModeratorOpenPrompt(req: MeetingRequest, attendeeNames: string, lang: KernelLanguage): string {
    return promptModeratorOpen(lang, req, attendeeNames);
  }

  private buildModeratorSynthesizePrompt(req: MeetingRequest, _transcript: Turn[], round: number, lang: KernelLanguage): string {
    return promptModeratorSynthesize(lang, req, round);
  }

  private buildModeratorClosePrompt(req: MeetingRequest, _transcript: Turn[], lang: KernelLanguage): string {
    return promptModeratorClose(lang, req);
  }

  private buildAttendeePrompt(req: MeetingRequest, transcript: Turn[], round: number, _agent: Agent, lang: KernelLanguage): string {
    const lastMod = [...transcript].reverse().find(t => t.role === "moderator");
    return promptMeetingAttendee(lang, req, round, lastMod?.content ?? null);
  }

  // ── Debate prompt builders ────────────────────────────────────
  // A debate is an adversarial meeting: every attendee has a declared position
  // (quoted from their earlier message), they defend it, rebut the others, and
  // the moderator issues a verdict. No tools, structured output mandatory.

  private buildDebateOpenPrompt(req: MeetingRequest, attendees: Agent[], lang: KernelLanguage): string {
    return promptDebateOpen(
      lang,
      req,
      attendees.map(a => ({ id: a.id, name: a.name })),
      req.positions ?? {},
    );
  }

  private buildDebateSynthesizePrompt(req: MeetingRequest, round: number, lang: KernelLanguage): string {
    return promptDebateSynthesize(lang, req, round);
  }

  private buildDebateClosePrompt(req: MeetingRequest, lang: KernelLanguage): string {
    return promptDebateClose(lang, req);
  }

  private buildDebateAttendeePrompt(req: MeetingRequest, transcript: Turn[], round: number, agent: Agent, lang: KernelLanguage): string {
    const lastMod = [...transcript].reverse().find(t => t.role === "moderator");
    const myPosition = (req.positions ?? {})[agent.id] ?? "";
    return promptDebateAttendee(lang, req, round, lastMod?.content ?? null, myPosition);
  }

  // ── Helpers ──

  private formatTranscript(turns: Turn[]): string {
    return turns
      .map(t => `## [Round ${t.round}] ${t.agent_name} (${t.role})\n${t.content}`)
      .join("\n\n---\n\n");
  }

  private extractBullets(text: string, kind: "decision" | "action"): string[] {
    // Match both English (decisions / action items) and Spanish (decisiones /
    // acciones / elementos de acción) section headers — the moderator writes
    // the summary in its configured language, so we must parse either.
    const sectionRegex = kind === "decision"
      ? /\*?\*?(?:decisions?|decisiones?)\*?\*?[:\s]*\n([\s\S]*?)(?=\n\*?\*?\w|\n---|\n##|$)/i
      : /\*?\*?(?:action\s*items?|acciones?|elementos\s*de\s*acci[oó]n)\*?\*?[:\s]*\n([\s\S]*?)(?=\n\*?\*?\w|\n---|\n##|$)/i;

    const match = text.match(sectionRegex);
    if (!match) return [];

    return match[1]
      .split("\n")
      .map(l => l.replace(/^[-*•]\s*/, "").trim())
      .filter(l => l.length > 3);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
