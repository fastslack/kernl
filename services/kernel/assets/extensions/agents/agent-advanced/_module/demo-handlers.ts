/**
 * Demo handlers — keep a "demo office" alive without burning LLM tokens.
 *
 * Each handler is registered as a builtin (`demo:*`) and gets invoked by the
 * scheduler when the corresponding agent's cron fires. The handler talks to
 * other agents via the real service (postToColleague, postMessage, meeting
 * events) so the 3D office visualizer animates real walkers, beams and
 * bubbles. Side-effects:
 *
 *   - InboxWaker (feature A) wakes up recipients on each post.
 *   - ConversationSubscriptionEngine (feature C) wakes up subscribers when
 *     the handler posts into a watched conversation.
 *   - Manager-driven cross-office posts emit `agent:flow:escalation` so
 *     orange beams appear in the office grid.
 *   - Synthetic meeting events animate walkers to the meeting room without
 *     the LLM-driven MeetingExecutor.
 *
 * All handlers are best-effort and resilient: missing peer agents, empty
 * flows, or missing slugs are logged and the handler returns gracefully.
 */

import type { EventBus } from "../../../../../src/core/event-bus.js";
import { log } from "../../../../../src/core/logger.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";
import type { Agent } from "../../../../../src/modules/agents/types.js";
import type { BuiltinHandler } from "../../../../../src/modules/agents/builtin-handlers.js";
import type { MeetingExecutor } from "./meeting-executor.js";
import { BOARD_CRISIS_HANDLER, boardCrisisDirector } from "./demo-board-crisis.js";

// ─── Story bank — short, deterministic, varied ─────────────────────────────

const STORY_IDEAS = [
  "Tech giant announces AI ethics board",
  "Local startup raises $5M seed round",
  "New transit line opens downtown",
  "Climate report flags coastal risks",
  "Remote-work survey shows productivity gains",
  "Sports team clinches division title",
  "Food delivery app expands to suburbs",
  "Researchers publish quantum benchmark",
  "City budget hearing draws crowd",
  "New zoning rules pass council",
];

const FACT_QUESTIONS = [
  "Can you verify the funding amount?",
  "Need confirmation on the council vote count.",
  "Double-check the spelling of the CEO's name.",
  "What's the source on the climate stat?",
  "Get a second source for the transit budget.",
];

const TECH_CHECKS = [
  "Need eng input — does the metric framework support this?",
  "Cross-team check: any infra blockers if we publish today?",
  "Question for backend: API rate limit on the data we're citing?",
];

const INCIDENT_LINES = [
  "PagerDuty: latency p99 spiked 3x in eu-west.",
  "Customer report: webhook deliveries delayed ~4 min.",
  "Disk pressure on shared-3 — running cleanup.",
  "Auth service noisy with 401s — investigating bot traffic.",
  "Background queue backlog — scaling workers x2.",
];

const ACK_LINES = [
  "On it.",
  "Got it, will follow up shortly.",
  "Acknowledged — adding to the queue.",
  "Investigating now.",
  "Will report back in 5.",
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── Slug map (kept in sync with seed-demo-office.ts) ──────────────────────

export const DEMO_SLUGS = {
  newsroom: {
    editor: "demo:newsroom:editor",
    reporter: "demo:newsroom:reporter",
    fact: "demo:newsroom:fact-checker",
    copy: "demo:newsroom:copy-editor",
  },
  engineering: {
    vp: "demo:engineering:vp",
    backend: "demo:engineering:backend",
    frontend: "demo:engineering:frontend",
    qa: "demo:engineering:qa",
  },
  ops: {
    lead: "demo:ops:lead",
    devops: "demo:ops:devops",
    support: "demo:ops:support",
    sre: "demo:ops:sre",
  },
} as const;

// ─── Helpers ───────────────────────────────────────────────────────────────

function resolveAgent(service: AgentService, slug: string): Agent | null {
  const a = service.getAgentBySlug(slug);
  if (!a) {
    log.warn(`demo-handlers: agent with slug "${slug}" not found — skipping`);
    return null;
  }
  return a;
}

/**
 * Emit a synthetic `agent:flow:chain_triggered` so the visualizer renders a
 * walker carrying a label from `from` to `to` even when no real run is
 * spawned. Used after postToColleague when the recipient is busy / off so
 * the office still feels alive.
 */
function emitChainBeam(
  events: EventBus,
  from: Agent,
  to: Agent,
  label: string,
): void {
  events.emit("agent:flow:chain_triggered", {
    source_agent_id: from.id,
    source_agent_name: from.name,
    target_agent_id: to.id,
    target_agent_name: to.name,
    chain_id: `demo-${from.id}-${to.id}-${Date.now()}`,
    chain_label: label,
    run_id: "",
  });
}

// ─── Handlers ──────────────────────────────────────────────────────────────

function newsroomEditorRoundup(deps: { service: AgentService; events: EventBus }): BuiltinHandler {
  return async () => {
    const { service, events } = deps;
    const editor = resolveAgent(service, DEMO_SLUGS.newsroom.editor);
    if (!editor) return "Editor agent missing — seed the demo office first.";

    const reporter = resolveAgent(service, DEMO_SLUGS.newsroom.reporter);
    const fact = resolveAgent(service, DEMO_SLUGS.newsroom.fact);
    const copy = resolveAgent(service, DEMO_SLUGS.newsroom.copy);
    const vp = resolveAgent(service, DEMO_SLUGS.engineering.vp);

    const story = pick(STORY_IDEAS);
    const sent: string[] = [];

    // 1) Editor → Reporter: assign the story.
    if (reporter) {
      service.postToColleague({
        from_agent_id: editor.id,
        to_agent_id: reporter.id,
        subject: `Story assignment: ${story}`,
        body: `Take the lead on "${story}". Send back a 200-word draft.`,
      });
      emitChainBeam(events, editor, reporter, `Assign: ${story}`);
      sent.push(reporter.name);
    }

    // 2) Editor → Fact Checker: queue a verification request.
    if (fact) {
      service.postToColleague({
        from_agent_id: editor.id,
        to_agent_id: fact.id,
        subject: `Fact-check needed: ${story}`,
        body: pick(FACT_QUESTIONS),
      });
      emitChainBeam(events, editor, fact, `Verify: ${story}`);
      sent.push(fact.name);
    }

    // 3) Cross-office escalation: Editor (manager) → VP Eng (manager) — this
    //    triggers `agent:flow:escalation` (manager + cross-office) and the
    //    visualizer renders an orange beam.
    if (vp) {
      service.postToColleague({
        from_agent_id: editor.id,
        to_agent_id: vp.id,
        subject: `Cross-team check: ${story}`,
        body: pick(TECH_CHECKS),
      });
      sent.push(`${vp.name} (cross-office)`);
    }

    // 4) Copy editor gets a heads-up — uses a shared "Daily Wire" conversation
    //    so the C feature (subscribers) shows wake-ups elsewhere.
    if (copy) {
      const convo = service.findOrCreateChatConversation({
        topic: "Daily Wire — newsroom feed",
        participants: [editor.id, copy.id],
        initiator_agent_id: editor.id,
      });
      service.postMessage({
        conversation_id: convo.id,
        from_agent_id: editor.id,
        to_agent_id: copy.id,
        body: `New story in flight: "${story}". Hold space on the front page.`,
        role: "stmt",
      });
      sent.push(`${copy.name} (via Daily Wire)`);
    }

    return `Editor dispatched assignments for "${story}" — recipients: ${sent.join(", ") || "(none)"}`;
  };
}

// One-shot, simple meeting topics. The LLM-driven MeetingExecutor expands
// them into a real conversation — open, attendee turns, synthesis — so the
// agents speak freely instead of reading from a script.
const MEETING_TOPICS = [
  "What should be our top priority for the next sprint?",
  "We need to pick one feature to ship this week — which one and why?",
  "Quick alignment: what's the one blocker each of you wants resolved today?",
  "Choose between investing in test coverage vs. shipping the new dashboard.",
  "Decide if we cut a release today or wait for the auth refactor to land.",
];

// In-flight lock so the cron + manual triggers don't open two concurrent
// meetings on the same set of agents. Without this, two overlapping
// `meeting_requested` events make the 3D visualizer tear down the older
// walkers mid-talk (its same-agent-id collision logic) and the user sees
// them "vanish" before the conversation even gets going.
let engineeringStandupBusy = false;

function engineeringStandup(deps: {
  service: AgentService;
  events: EventBus;
  meetingExecutor: MeetingExecutor;
}): BuiltinHandler {
  return async () => {
    const { service, events, meetingExecutor } = deps;
    log.info("demo:engineering:standup — handler entered");
    if (engineeringStandupBusy) {
      log.info("demo:engineering:standup — skipped (another standup is still in progress)");
      return "Skipped — a standup is already running. Won't overlap.";
    }
    const vp = resolveAgent(service, DEMO_SLUGS.engineering.vp);
    if (!vp) return "VP Eng missing — seed the demo office first.";

    const backend = resolveAgent(service, DEMO_SLUGS.engineering.backend);
    const frontend = resolveAgent(service, DEMO_SLUGS.engineering.frontend);
    const qa = resolveAgent(service, DEMO_SLUGS.engineering.qa);
    const attendees = [backend, frontend, qa].filter((a): a is Agent => !!a);
    if (attendees.length === 0) return "Engineering office is empty.";

    const topic = pick(MEETING_TOPICS);
    log.info(`demo:engineering:standup — opening REAL meeting topic="${topic}" attendees=${attendees.length}`);

    engineeringStandupBusy = true;
    try {
      // Real meeting — MeetingExecutor drives the conversation through the
      // same code path the LLM-powered tools use. It emits
      // agent:flow:meeting_{requested,started,turn,ended} with proper
      // pacing (4s walker travel before "started", per-turn LLM calls,
      // synthesis + close), so the 3D scene shows walkers arriving, sitting,
      // taking turns and leaving on their own.
      const result = await meetingExecutor.run(
        {
          topic,
          moderator_id: vp.id,
          attendee_ids: attendees.map(a => a.id),
          context:
            "This is a daily engineering standup. Keep replies short (1–3 sentences). " +
            "Be concrete: what you're working on, blockers, what you need from peers. " +
            "The moderator picks one decision at the end.",
          rounds: 2,
          urgency: "normal",
        },
        service,
        events,
      );
      return `Standup completed: "${topic}" — ${(result.summary || "").slice(0, 140)}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`demo:engineering:standup failed: ${msg}`);
      return `Standup failed: ${msg}`;
    } finally {
      engineeringStandupBusy = false;
    }
  };
}

function opsIncidentWatch(deps: { service: AgentService; events: EventBus }): BuiltinHandler {
  return async () => {
    const { service, events } = deps;
    const lead = resolveAgent(service, DEMO_SLUGS.ops.lead);
    if (!lead) return "Ops Lead missing — seed the demo office first.";

    const devops = resolveAgent(service, DEMO_SLUGS.ops.devops);
    const support = resolveAgent(service, DEMO_SLUGS.ops.support);
    const sre = resolveAgent(service, DEMO_SLUGS.ops.sre);
    const subscribers = [devops, support, sre].filter((a): a is Agent => !!a);

    const incident = pick(INCIDENT_LINES);

    // The "Incident wire" conversation — we ensure all ops members are
    // subscribed (idempotent) so the ConversationSubscriptionEngine wakes
    // them on every incident posted here. This is the live demo of feature C.
    const convo = service.findOrCreateChatConversation({
      topic: "Incident wire",
      participants: [lead.id, ...subscribers.map(s => s.id)],
      initiator_agent_id: lead.id,
    });
    for (const s of subscribers) {
      service.subscribeAgentToConversation({
        agent_id: s.id,
        conversation_id: convo.id,
        mode: "responder",
      });
    }

    service.postMessage({
      conversation_id: convo.id,
      from_agent_id: lead.id,
      body: incident,
      role: "stmt",
    });

    // Also send a directed inbox message to one team member so InboxWaker
    // (feature A) fires on a specific recipient — the chain beam makes the
    // walker visible. Cycle through subscribers across runs.
    if (subscribers.length > 0) {
      const target = subscribers[Math.floor(Math.random() * subscribers.length)];
      service.postToColleague({
        from_agent_id: lead.id,
        to_agent_id: target.id,
        subject: "Page",
        body: incident,
      });
      emitChainBeam(events, lead, target, "Page");
    }

    return `Posted incident "${incident.slice(0, 50)}" to wire (${subscribers.length} subscriber${subscribers.length === 1 ? "" : "s"}).`;
  };
}

/**
 * Worker auto-respond: read the unread inbox and reply to the most recent
 * sender with a short ack. Triggered by InboxWaker when a peer posts in.
 *
 * This closes the loop: post_to_colleague → InboxWaker wake → this handler
 * runs → it posts back → the original sender's InboxWaker wakes them → ...
 * Cap the conversation depth via a per-agent in-memory counter so the demo
 * doesn't ping-pong forever on a single thread.
 */

const RESPOND_DEPTH = new Map<string, number>();
const MAX_RESPOND_DEPTH = 2;

function workerAutoRespond(
  deps: { service: AgentService; events: EventBus; agentSlug: string },
): BuiltinHandler {
  return async () => {
    const { service, events, agentSlug } = deps;
    const me = resolveAgent(service, agentSlug);
    if (!me) return `Worker ${agentSlug} not found.`;

    const inbox = service.getUnreadInbox(me.id, 5);
    if (inbox.length === 0) return "No unread mail.";

    // Mark them all as read up front so a re-trigger doesn't re-process.
    service.markInboxRead(inbox.map(m => m.id));

    // Cap ping-pong: count consecutive runs and bail out if we're recursing.
    const cur = (RESPOND_DEPTH.get(me.id) ?? 0) + 1;
    RESPOND_DEPTH.set(me.id, cur);
    setTimeout(() => RESPOND_DEPTH.set(me.id, 0), 60_000);
    if (cur > MAX_RESPOND_DEPTH) {
      return `Read ${inbox.length} message(s); auto-respond depth cap reached, holding.`;
    }

    let replied = 0;
    // Reply to the latest unique sender only — keeps the demo moving.
    const seen = new Set<string>();
    for (const m of inbox.slice().reverse()) {
      if (seen.has(m.from_agent_id)) continue;
      seen.add(m.from_agent_id);
      const sender = service.getAgent(m.from_agent_id);
      if (!sender) continue;
      service.postToColleague({
        from_agent_id: me.id,
        to_agent_id: m.from_agent_id,
        subject: `Re: ${m.subject || "ping"}`,
        body: pick(ACK_LINES),
      });
      emitChainBeam(events, me, sender, "Re:");
      replied++;
      if (replied >= 1) break;
    }

    return `Read ${inbox.length} message(s); replied to ${replied}.`;
  };
}

// ─── Public factory ────────────────────────────────────────────────────────

export function createDemoHandlers(deps: {
  service: AgentService;
  events: EventBus;
  meetingExecutor: MeetingExecutor;
  /** System language, read fresh on each run. Optional so older callers compile. */
  getLanguage?: () => "es" | "en";
}): Map<string, BuiltinHandler> {
  const map = new Map<string, BuiltinHandler>();
  map.set("demo:newsroom:editor-roundup", newsroomEditorRoundup(deps));
  map.set("demo:engineering:standup",     engineeringStandup(deps));
  map.set("demo:ops:incident-watch",      opsIncidentWatch(deps));

  // "Junta y Crisis" — the one-shot floor-wide demo. Unlike the handlers
  // above it needs no seeded demo office: it casts itself from whatever
  // offices and ranks the live instance already has. Registering it is free
  // (handlers only ever fire for an agent that names them), and nothing
  // schedules it — it runs when the operator asks for it and not before.
  map.set(BOARD_CRISIS_HANDLER, boardCrisisDirector(deps));

  // One auto-respond handler per worker slug. The handler captures its own
  // slug so it knows which agent it is at runtime.
  const workerSlugs = [
    DEMO_SLUGS.newsroom.reporter,
    DEMO_SLUGS.newsroom.fact,
    DEMO_SLUGS.newsroom.copy,
    DEMO_SLUGS.engineering.backend,
    DEMO_SLUGS.engineering.frontend,
    DEMO_SLUGS.engineering.qa,
    DEMO_SLUGS.ops.devops,
    DEMO_SLUGS.ops.support,
    DEMO_SLUGS.ops.sre,
  ];
  for (const slug of workerSlugs) {
    map.set(`demo:worker:auto-respond:${slug}`, workerAutoRespond({
      service: deps.service, events: deps.events, agentSlug: slug,
    }));
  }
  return map;
}
