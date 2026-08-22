/**
 * "Junta y Crisis" — a scripted, ~8 minute demo of the whole agent floor.
 *
 * One builtin handler drives the entire sequence so the operator triggers it
 * with a single `POST /api/agents/run` and then just watches the 3D office:
 *
 *   Act I  — the top-ranked agent chairs a board meeting with one delegate per
 *            office. Real MeetingExecutor rounds, so the agents actually talk.
 *   Act II — an office loses its infrastructure. The responsible manager walks
 *            to the power console, an urgent meeting is called (attendees RUN,
 *            in red), two of them file opposing positions which the debate
 *            orchestrator picks up on its own, the outcome is escalated to the
 *            operator as a real question, and the power comes back on.
 *
 * ── Which parts are real and which are staged ─────────────────────────────
 * Meetings and the debate are REAL: they go through MeetingExecutor and the
 * DebateOrchestrator, cost tokens and produce a genuine transcript. Everything
 * that only has to *look* right — the infrastructure toggle, the cross-office
 * escalation beam — is emitted straight onto the event bus. That is deliberate,
 * and it is the same split `demo-handlers.ts` already uses:
 *
 *   • `office:infra:changed` is consumed by a handler that reads nothing but
 *     `flow_id` / `action` / `ok`, so emitting it gives the identical animation
 *     without needing a Docker socket the kernel container does not have.
 *   • `agent:flow:escalation` and `agent:flow:question_asked` are emitted by
 *     the TOOL handlers in `modules/agents/tools.ts`, never by the service
 *     methods underneath them. A builtin handler calling the service directly
 *     therefore has to emit them itself or the walker never leaves its desk.
 *
 * ── Walker budget ─────────────────────────────────────────────────────────
 * The 3D caps concurrent walkers at `max(6, min(20, ceil(agents/4)))` and
 * `sendWalkerToPoint` silently returns past the cap — an attendee simply never
 * stands up. Seated attendees hold their slot until they finish walking back,
 * so Act I and Act II overlap in the budget. BOARD_SEATS + CRISIS_SEATS is kept
 * under that ceiling on purpose; raising either means raising the cap too.
 *
 * Nothing here is scheduled. The demo only ever runs when somebody asks for it.
 */

import { log } from "../../../../../src/core/logger.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";
import type { Agent, AgentFlow } from "../../../../../src/modules/agents/types.js";
import type { BuiltinHandler } from "../../../../../src/modules/agents/builtin-handlers.js";
import type { MeetingExecutor } from "./meeting-executor.js";

/** Handler id. Set an agent's `builtin_handler` to this to make it the director. */
export const BOARD_CRISIS_HANDLER = "demo:board:crisis";

/**
 * Delegates invited to the board, moderator excluded. Seven walkers total.
 * Chosen against the 13-walker ceiling a ~50 agent floor gets, leaving room
 * for Act II and for whatever scheduled agents are moving at the same time.
 */
const BOARD_SEATS = 6;

/** Attendees of the emergency meeting, convener excluded. */
const CRISIS_SEATS = 3;

/**
 * How long walkers get to reach the table before the first turn is spoken.
 * The executor's own default is 4s, which was tuned for a short hop; on a
 * full floor the far offices are a 12s+ walk from the meeting rooms, so a
 * board meeting that uses the default starts talking to an empty room.
 */
const BOARD_TRAVEL_MS = 13_000;

/** Shorter: the emergency crowd runs (1.6x) and is picked from nearby offices. */
const CRISIS_TRAVEL_MS = 7_000;

type Lang = "es" | "en";

/**
 * The demo's own script, in both languages.
 *
 * This used to be hardcoded Spanish, which produced the exact mess it was
 * meant to avoid: the moderator mirrored the Spanish topic it was handed while
 * every attendee followed the style directive built from the SYSTEM language
 * and answered in English, so one meeting came out half and half. The script
 * has to follow `KERNEL_DEFAULT_LANGUAGE` like everything else the agents read.
 */
const SCRIPT: Record<Lang, {
  boardTopic: string;
  boardContext: string;
  crisisContext: string;
  crisisTopic: (office: string) => string;
  escalationSubject: (office: string) => string;
  escalationBody: (office: string) => string;
  postmortemTopic: (office: string) => string;
  restoreNow: (office: string) => string;
  counterEvidence: string;
  counterCorruption: string;
  question: (office: string) => string;
  options: string[];
}> = {
  es: {
    boardTopic:
      "Revisión de prioridades entre oficinas: qué es lo único que cada oficina " +
      "necesita resuelto esta semana, y cuál de todas esas cosas va primero.",
    boardContext: [
      "Es la junta directiva periódica. Cada asistente representa a su oficina.",
      "Sé concreto y breve (2 a 4 frases): qué está haciendo tu oficina, qué la",
      "está frenando, y qué necesitás de otra oficina. No inventes métricas.",
      "Quien preside cierra eligiendo UNA prioridad y diciendo por qué.",
    ].join(" "),
    crisisContext: [
      "Es una reunión de emergencia: una oficina se quedó sin infraestructura y",
      "su trabajo está detenido. Respuestas de 1 a 3 frases. Cada uno dice qué",
      "puede hacer AHORA y qué riesgo ve. Si no estás de acuerdo con otro, decilo",
      "explícitamente. Quien preside cierra con una recomendación para el operador.",
    ].join(" "),
    crisisTopic: (o) =>
      `${o} se quedó sin infraestructura y su trabajo está detenido. ` +
      `¿Restablecemos ya, o investigamos la causa antes de volver a levantarla?`,
    escalationSubject: (o) => `${o} sin infraestructura`,
    escalationBody: (o) =>
      `${o} perdió su entorno y su trabajo está detenido. ` +
      `Convoco reunión de emergencia y te traigo una recomendación.`,
    postmortemTopic: (o) => `Postmortem — ${o}`,
    restoreNow: (o) =>
      `Propongo restablecer ${o} ahora mismo y revisar la causa después, ` +
      `con el servicio arriba.`,
    counterEvidence:
      "No estoy de acuerdo. Si la levantamos sin saber por qué se cayó, " +
      "se vuelve a caer y perdemos la evidencia.",
    counterCorruption:
      "Tampoco. Primero hay que confirmar que no se corrompió nada en el " +
      "apagón; volver a levantarla a ciegas es el riesgo más caro.",
    question: (o) => `¿Qué hacemos con ${o}?`,
    options: ["Restablecer ahora", "Investigar antes de levantarla", "Dejarla abajo hasta mañana"],
  },
  en: {
    boardTopic:
      "Cross-office priority review: the one thing each office needs unblocked " +
      "this week, and which of those goes first.",
    boardContext: [
      "This is the regular board meeting. Each attendee speaks for their office.",
      "Be concrete and short (2 to 4 sentences): what your office is doing, what",
      "is blocking it, and what you need from another office. Do not invent metrics.",
      "The chair closes by picking ONE priority and saying why.",
    ].join(" "),
    crisisContext: [
      "This is an emergency meeting: an office lost its infrastructure and its",
      "work is stopped. Answer in 1 to 3 sentences. Each of you says what you can",
      "do NOW and what risk you see. If you disagree with someone, say so",
      "explicitly. The chair closes with a recommendation for the operator.",
    ].join(" "),
    crisisTopic: (o) =>
      `${o} lost its infrastructure and its work is stopped. Do we restore it ` +
      `now, or find the cause before bringing it back up?`,
    escalationSubject: (o) => `${o} has no infrastructure`,
    escalationBody: (o) =>
      `${o} lost its environment and its work is stopped. I am calling an ` +
      `emergency meeting and will bring you a recommendation.`,
    postmortemTopic: (o) => `Postmortem — ${o}`,
    restoreNow: (o) =>
      `I propose we restore ${o} right now and look into the cause afterwards, ` +
      `with the service up.`,
    counterEvidence:
      "I disagree. If we bring it up without knowing why it went down, it goes " +
      "down again and we lose the evidence.",
    counterCorruption:
      "Also no. First we confirm nothing was corrupted during the outage; " +
      "bringing it back blind is the most expensive risk.",
    question: (o) => `What do we do about ${o}?`,
    options: ["Restore now", "Investigate before bringing it up", "Leave it down until tomorrow"],
  },
};

/**
 * In-flight lock. Two overlapping runs would fight over the same walkers —
 * `meeting_requested` drops any existing walker for an agent it is seating,
 * so the second run would yank people out of the first one's meeting mid-turn
 * and the operator would watch attendees vanish. Same guard, same reason, as
 * `engineeringStandupBusy` in demo-handlers.ts.
 */
let boardCrisisBusy = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rank level, or -1 for an agent with no rank assigned. */
function levelOf(service: AgentService, a: Agent): number {
  return service.getRank(a.rank_id)?.level ?? -1;
}

/**
 * Score an agent as its office's delegate. Higher is better.
 *
 * A manager outranks a high-ranked worker because the meeting prompts address
 * the delegate as the voice of the office. An agent backed by a builtin
 * handler still *can* attend — the executor never looks at `builtin_handler`
 * when it collects turns — but it carries the system prompt of, say, an RSS
 * watcher, so it is the last resort rather than the first pick.
 */
function delegateScore(service: AgentService, a: Agent): number {
  let score = levelOf(service, a);
  if (a.role === "manager") score += 100;
  if (a.active === 1) score += 50;
  if (!a.builtin_handler) score += 25;
  return score;
}

function bestOf(service: AgentService, pool: Agent[]): Agent | null {
  if (pool.length === 0) return null;
  return pool
    .slice()
    .sort((x, y) => delegateScore(service, y) - delegateScore(service, x))[0];
}

/** Offices that actually have someone in them, most-staffed first. */
function staffedFlows(service: AgentService): Array<{ flow: AgentFlow; members: Agent[] }> {
  const agents = service.listAgents();
  const out: Array<{ flow: AgentFlow; members: Agent[] }> = [];
  for (const flow of service.listFlows()) {
    const members = agents.filter((a) => a.flow_id === flow.id);
    if (members.length > 0) out.push({ flow, members });
  }
  return out.sort((a, b) => b.members.length - a.members.length);
}

/**
 * The office that hosts the power console. The 3D builds it inside whichever
 * office's name starts with "repos" or "devops" (AgentWorld3D `buildThemedOffices`);
 * without one the infra event still lands, it just settles the state instead of
 * staging the walk. Returning null is fine — the demo degrades, it doesn't break.
 */
function consoleFlowId(service: AgentService): string | null {
  for (const flow of service.listFlows()) {
    const n = flow.name.trim().toLowerCase();
    if (n.startsWith("repos") || n.startsWith("devops")) return flow.id;
  }
  return null;
}

/** Who plays what, resolved from whatever the live instance actually has. */
export interface DemoCast {
  /** Chairs the board. The highest-ranked agent on the floor. */
  chair: Agent;
  /** One delegate per office, best-scored, capped at BOARD_SEATS. */
  delegates: Agent[];
  /** The office that loses its infrastructure in Act II. */
  victim: AgentFlow;
  /** Office hosting the 3D power console, or null if the layout has none. */
  consoleFlowId: string | null;
  /** Convenes the emergency meeting, or null if nobody is free to. */
  crisisConvener: Agent | null;
  /** Emergency attendees, convener excluded. Never overlaps the board. */
  crisisAttendees: Agent[];
}

/**
 * Cast the demo from the live floor. Exported so the selection can be
 * inspected against a real database without running (and paying for) the
 * meetings — the casting is the part most sensitive to how a given instance
 * happens to be staffed.
 *
 * Returns null when the floor is too empty to stage anything.
 */
export function selectCast(service: AgentService): DemoCast | null {
  const flows = staffedFlows(service);
  if (flows.length < 2) return null;

  const everyone = service.listAgents();

  // The chair is simply the highest-ranked agent on the floor. The executor
  // re-derives this on its own (it promotes by rank regardless of who called
  // the meeting), so picking the same agent here just keeps the log honest.
  const chair = bestOf(service, everyone.filter((a) => levelOf(service, a) >= 0));
  if (!chair) return null;

  // Pick each office's best voice FIRST, then rank the offices by how good
  // that voice is — not by headcount. Sorting offices by size looks sensible
  // and gives a terrible board: on a real floor the biggest offices are the
  // ones packed with builtin RSS/calendar watchers, so headcount order hands
  // every seat to a script while the offices holding actual conversational
  // agents get cut off by BOARD_SEATS.
  const delegates: Agent[] = flows
    .map(({ members }) => bestOf(service, members.filter((a) => a.id !== chair.id)))
    .filter((a): a is Agent => a !== null)
    .sort((x, y) => delegateScore(service, y) - delegateScore(service, x))
    .slice(0, BOARD_SEATS);
  if (delegates.length === 0) return null;

  const seated = new Set([chair.id, ...delegates.map((a) => a.id)]);

  // The office that goes dark is never the one hosting the power console —
  // the operator has to be able to watch somebody walk INTO a lit data center
  // to fix it. Prefer an office that still has somebody free after the board,
  // so it can speak for itself in the emergency meeting.
  const consoleId = consoleFlowId(service);
  const freeIn = (flowId: string) =>
    everyone.filter((a) => a.flow_id === flowId && !seated.has(a.id)).length;
  const candidates = flows.filter((f) => f.flow.id !== consoleId);
  const victim =
    candidates.find((f) => freeIn(f.flow.id) > 0) ?? candidates[0] ?? flows[0];

  // The emergency crowd is drawn from agents who are NOT at the board. If a
  // seated delegate were invited, `meeting_requested` would tear their board
  // walker down to re-seat them, and the board's own `meeting_ended` would
  // later send them home from the wrong room.
  const free = (flowId: string | null) =>
    flowId
      ? everyone
          .filter((a) => a.flow_id === flowId && !seated.has(a.id))
          .sort((x, y) => delegateScore(service, y) - delegateScore(service, x))
      : [];
  const fromConsole = free(consoleId);
  const fromVictim = free(victim.flow.id);

  // Whoever owns the console convenes — they are the one who can actually
  // restore the power. The office that fell always gets a chair: picking the
  // room purely on score fills it with the console office's own staff and the
  // victim ends up absent from the meeting about its own outage.
  const crisisConvener = fromConsole[0] ?? fromVictim[0] ?? null;
  const crisisAttendees: Agent[] = [];
  const takeCrisis = (a: Agent | undefined) => {
    if (!a) return;
    if (a.id === crisisConvener?.id) return;
    if (crisisAttendees.some((x) => x.id === a.id)) return;
    if (crisisAttendees.length >= CRISIS_SEATS) return;
    crisisAttendees.push(a);
  };
  takeCrisis(fromVictim[0]);
  takeCrisis(fromVictim[1]);
  for (const a of [...fromConsole, ...fromVictim]) takeCrisis(a);

  return {
    chair,
    delegates,
    victim: victim.flow,
    consoleFlowId: consoleId,
    crisisConvener,
    crisisAttendees,
  };
}

/** Cross-office post that the 3D draws as two agents meeting to coordinate. */
function escalate(
  service: AgentService,
  events: EventBus,
  from: Agent,
  to: Agent,
  subject: string,
  body: string,
): void {
  service.postToColleague({
    from_agent_id: from.id,
    to_agent_id: to.id,
    subject,
    body,
  });
  events.emit("agent:flow:escalation", {
    from_agent_id: from.id,
    from_agent_name: from.name,
    from_role: from.role || "worker",
    to_agent_id: to.id,
    to_agent_name: to.name,
    subject,
    body_preview: body.slice(0, 200),
    role: "stmt",
    cross_office: from.flow_id !== to.flow_id,
    is_manager_directive: from.role === "manager",
    ts: new Date().toISOString(),
  });
}

/** Flip an office's power. Purely an event — see the header note on Docker. */
function toggleInfra(events: EventBus, flowId: string, action: "up" | "stop", ok: boolean): void {
  events.emit("office:infra:changed", {
    flow_id: flowId,
    action,
    ok,
    ts: new Date().toISOString(),
  });
}

// ─── The director ──────────────────────────────────────────────────────────

export function boardCrisisDirector(deps: {
  service: AgentService;
  events: EventBus;
  meetingExecutor: MeetingExecutor;
  getLanguage?: () => Lang;
}): BuiltinHandler {
  return async () => {
    const { service, events, meetingExecutor } = deps;
    // Read per run, not per registration — the operator can change the system
    // language between two runs and the second one has to follow it.
    const lang: Lang = deps.getLanguage?.() ?? "en";
    const T = SCRIPT[lang];

    if (boardCrisisBusy) {
      return "Skipped — the demo is already running. Let it finish before triggering it again.";
    }

    const cast = selectCast(service);
    if (!cast) {
      return {
        ok: false,
        error: "Not enough staffed offices / ranked agents to stage the demo.",
      };
    }
    const { chair, delegates, victim, crisisConvener, crisisAttendees } = cast;

    boardCrisisBusy = true;
    const started = Date.now();
    const log_: string[] = [];

    try {
      // ── Act I — the board ─────────────────────────────────────────────
      log.info(
        `demo:board:crisis — Act I: ${chair.name} chairs a board of ${delegates.length} ` +
        `delegates (${delegates.map((a) => a.name).join(", ")})`,
      );
      const board = await meetingExecutor.run(
        {
          topic: T.boardTopic,
          moderator_id: chair.id,
          attendee_ids: delegates.map((a) => a.id),
          context: T.boardContext,
          rounds: 1,
          urgency: "normal",
          travel_ms: BOARD_TRAVEL_MS,
        },
        service,
        events,
      );
      log_.push(`Junta: ${delegates.length + 1} sentados, ${board.decisions.length} decisiones.`);

      // ── Act II — the lights go out ────────────────────────────────────
      log.info(`demo:board:crisis — Act II: dropping infrastructure for "${victim.name}"`);
      toggleInfra(events, victim.id, "stop", false);
      log_.push(`Caída: ${victim.name}.`);

      // Let the walk to the console and the door-sign repaint land before the
      // emergency crowd starts moving, so the two beats read as cause and
      // effect rather than as one blur.
      await sleep(9_000);

      // An emergency needs somebody to convene it and somebody to convene.
      // Neither is guaranteed on a floor where every free agent is already at
      // the board — in that case Act II is just the outage and the recovery.
      if (crisisConvener && crisisAttendees.length > 0) {
        // Somebody tells the chair before pulling people into a room.
        escalate(
          service,
          events,
          crisisConvener,
          chair,
          `${victim.name} sin infraestructura`,
          `${victim.name} perdió su entorno y su trabajo está detenido. ` +
          `Convoco reunión de emergencia y te traigo una recomendación.`,
        );
        await sleep(4_000);

        log.info(`demo:board:crisis — urgent meeting, ${crisisAttendees.length} attendees`);
        const crisis = await meetingExecutor.run(
          {
            topic:
              `${victim.name} se quedó sin infraestructura y su trabajo está ` +
              `detenido. ¿Restablecemos ya, o investigamos la causa antes de volver a levantarla?`,
            moderator_id: crisisConvener.id,
            attendee_ids: crisisAttendees.map((a) => a.id),
            context: T.crisisContext,
            rounds: 2,
            urgency: "urgent",
            travel_ms: CRISIS_TRAVEL_MS,
          },
          service,
          events,
        );
        log_.push(`Emergencia: ${crisisAttendees.length + 1} convocados.`);

        // ── The disagreement becomes a formal debate ─────────────────
        // Two DISTINCT senders filing role='counter' on one conversation is
        // exactly what DebateOrchestrator watches for. It opens the debate
        // itself, on its own guardrails (3/hour, 60 min per topic, max 5
        // participants) — we only stage the disagreement.
        if (crisisAttendees.length >= 2) {
          const thread = service.findOrCreateChatConversation({
            topic: `Postmortem — ${victim.name}`,
            participants: [crisisConvener.id, ...crisisAttendees.map((a) => a.id)],
            initiator_agent_id: crisisConvener.id,
          });
          service.postMessage({
            conversation_id: thread.id,
            from_agent_id: crisisConvener.id,
            body: T.restoreNow(victim.name),
            role: "stmt",
          });
          service.postMessage({
            conversation_id: thread.id,
            from_agent_id: crisisAttendees[0].id,
            body: T.counterEvidence,
            role: "counter",
          });
          // The two counters MUST be spaced out. DebateOrchestrator holds a
          // per-conversation re-entrancy lock for the whole evaluation, and it
          // takes that lock synchronously the moment a counter lands. Posting
          // both in the same tick means the first evaluation (which sees only
          // one dissenting sender, and bails) still owns the lock when the
          // second arrives — so the message that would finally satisfy the
          // "2+ distinct counter senders" rule is dropped, silently, and no
          // debate ever opens. Verified: back-to-back posts produced no debate
          // and no skip reason in the log, because that guard returns quietly.
          await sleep(3_000);
          service.postMessage({
            conversation_id: thread.id,
            from_agent_id: crisisAttendees[1].id,
            body: T.counterCorruption,
            role: "counter",
          });
          log_.push("Debate: dos posiciones en contra publicadas.");
        }

        // ── The call goes up to the operator ─────────────────────────
        const question = service.createQuestion({
          from_agent_id: crisisConvener.id,
          flow_id: crisisConvener.flow_id ?? "",
          meeting_id: crisis.meeting_id,
          question: T.question(victim.name),
          context: (crisis.summary || "").slice(0, 600),
          options: T.options.map((label, i) => ({
            label, value: ["restore", "investigate", "hold"][i] ?? String(i),
          })),
        });
        // The service emits `agent:question_asked` (the notification bell).
        // The 3D listens for the flow-namespaced one, which only the tool
        // handler emits — so the walk to My Office needs this line.
        events.emit("agent:flow:question_asked", {
          question_id: question.id,
          from_agent_id: crisisConvener.id,
          from_agent_name: crisisConvener.name,
          flow_id: crisisConvener.flow_id ?? "",
          question: T.question(victim.name),
          options: T.options,
          ts: new Date().toISOString(),
        });
        log_.push(`Pregunta ${question.id} elevada al operador.`);

        // Give the operator a beat to answer on camera. Whatever they pick,
        // the demo restores power — the point of the beat is the walk to
        // My Office and the paper plane, not branching on the answer.
        await sleep(20_000);
      }

      // ── Curtain — the lights come back ────────────────────────────────
      toggleInfra(events, victim.id, "up", true);
      log_.push(`Restablecida: ${victim.name}.`);

      const mins = ((Date.now() - started) / 60_000).toFixed(1);
      return `Demo "Junta y Crisis" completa en ${mins} min. ${log_.join(" ")}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`demo:board:crisis failed: ${msg}`);
      // Never leave an office dark because the script died halfway.
      toggleInfra(events, victim.id, "up", true);
      return { ok: false, error: `Demo interrumpida: ${msg}` };
    } finally {
      boardCrisisBusy = false;
    }
  };
}
