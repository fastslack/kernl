// office3d/events.ts
// The live-event dispatcher: turns each agents.flow event (run started /
// completed, chain handoffs, tool steps, meetings, escalations, questions,
// trades…) into what the 3D office shows — tags, walkers, meeting-room
// choreography, the My Office report log and the live meeting transcripts.
//
// It used to be AgentWorld3D's processEvents(). The state it reads and writes
// still belongs to that component, so it comes in as a context object whose
// fields are live getters (and setters, for what the dispatcher reassigns).
// Every read goes through `ctx.` on purpose, including inside the setTimeout
// callbacks below: they must see the component's value at the time they run,
// exactly as the inline version did, not a snapshot taken when the event
// arrived.
import type { AgentFlowEvent } from '$lib/stores.js';
import { mailOffice } from '$lib/office/office-kinds.js';
import { toolGlyph } from '$lib/agent-helpers.js';
import { meetingRoomDoorPoint, getMeetingSeatPositions } from '$lib/office-geometry.js';
import {
  enqueueDelivery, updateActivityBoard,
  sendWalker, sendWalkerToPoint, removeArrivedWalkers,
  shake, paperPlane, convergingParticles, fallingGlyph, curvedArrow, floatingGlyph,
  runTradeExecution,
  type AnimationRegistry, type NoteStack,
  type Walker, type SpeechBubble, type RoomInfo, type CorridorGrid, type Aabb2D, type Vec3,
} from './index.js';
import type { SittingWorkers } from './walkers/index.js';
import type {
  WorldAgent, WorldFlow, LiveMeeting, LiveTurn, MgmtEntry, AnimatedTagOpts,
} from '../world-types.js';

type RoomSlot = { cx: number; cz: number; w: number; d: number };

export interface LiveEventContext {
  // ── Component state (live getters; setters where the dispatcher writes) ──
  readonly flowEvents: AgentFlowEvent[];
  lastProcessedFlowEvent: AgentFlowEvent | null;
  readonly flows: WorldFlow[];
  readonly agents: WorldAgent[];
  readonly selectedAgent: string | null;
  readonly scene: any;
  readonly THREE: any;
  readonly sceneTimeSec: number;
  readonly deskGroups: Map<string, any>;
  readonly deskPos: Map<string, Vec3>;
  readonly roomMap: Map<string, RoomInfo>;
  readonly corGrid: CorridorGrid;
  readonly deskAabbs: Map<string, Aabb2D>;
  readonly sittingWorkers: SittingWorkers;
  walkers: Walker[];
  readonly myOfficePos: Vec3 | null;
  readonly myOfficeSeats: Vec3[];
  readonly myOfficeDeskFacing: Vec3 | null;
  readonly myOfficeNoteStack: NoteStack | null;
  readonly hallCenterPos: { x: number; z: number } | null;
  readonly topAgentId: string | null;
  readonly topAgentSeatPos: Vec3 | null;
  readonly meetingRoomSlots: RoomSlot[];
  readonly meetingIdToRoom: Map<string, number>;
  readonly speechBubbles: Map<string, SpeechBubble>;
  liveMeetings: Record<string, LiveMeeting>;
  activeMeetingId: string | null;
  showTranscriptBody: boolean;
  showMyOfficePanel: boolean;
  showLiveMeeting: boolean;
  auditedRunIds: Set<string>;
  readonly meetingActive: boolean;
  readonly meetingSelectedIds: Set<string>;
  readonly animRegistry: AnimationRegistry;
  readonly lastDeliveryAtByFlow: Map<string, number>;

  // ── Component functions ──
  markActivity(aid: string): void;
  showAnimatedTag(aid: string, opts: AnimatedTagOpts): void;
  showThinkingTag(aid: string, durationFrames?: number): void;
  pulseThinkingMonitor(aid: string): void;
  triggerDeliveryForAgent(agentId: string, nowSec: number): void;
  tryFireAnim(tag: string, lifetimeSec: number, fn: () => void): void;
  spawnErrorFx(aid: string): void;
  spawnHandoffPacketFx(sid: string, tid: string, colorCss: string): void;
  spawnTradeCelebration(symbol: string, side: string, price: number, isBuy: boolean): void;
  /** The selected agent just finished a run — the drawer re-reads it. */
  refreshSelectedAgentRuns(): void;
  isOfficeLeader(agentId: string): boolean;
  isSeniorRank(agentId: string): boolean;
  addOfficeReport(agentId: string, text: string, status?: string, runId?: string): void;
  pickFreeMyOfficeChair(): Vec3 | null;
  flowColor(aid: string): string;
  sameOffice(srcId: string, tgtId: string): boolean;
  coordinateInMeetingRoom(srcId: string, tgtId: string, color: string): boolean;
  spawnMeetingDecor(meetingId: string, room: RoomSlot, topic: string, onClick?: () => void): void;
  updateMeetingDecorTurn(meetingId: string, turnText: string): void;
  disposeMeetingDecor(meetingId: string): void;
  pushMgmtLog(entry: MgmtEntry): void;
  playTopAgentChime(): void;
  loadPendingQuestions(): Promise<void> | void;
  topAgent(): { id: string; name: string } | null;
  highestRank(): { id: string; name: string } | null;
  handleInfraToggle(data: { flow_id?: string; action?: string; ok?: boolean }): void;
}

// ── Process live events ────────────────────────
export function processLiveEvents(ctx: LiveEventContext): void {
  const {
    markActivity, showAnimatedTag, showThinkingTag, pulseThinkingMonitor,
    triggerDeliveryForAgent, tryFireAnim, spawnErrorFx, spawnHandoffPacketFx,
    spawnTradeCelebration, refreshSelectedAgentRuns, isOfficeLeader, isSeniorRank,
    addOfficeReport, pickFreeMyOfficeChair, flowColor, sameOffice,
    coordinateInMeetingRoom, spawnMeetingDecor, updateMeetingDecorTurn,
    disposeMeetingDecor, pushMgmtLog, playTopAgentChime, loadPendingQuestions,
    topAgent, highestRank, handleInfraToggle,
  } = ctx;
  if (ctx.flowEvents.length === 0) return;
  if (ctx.flowEvents[0] === ctx.lastProcessedFlowEvent) return;
  // Newest-first store → walk down until we hit the previous head (or the
  // end if it got evicted by the cap).
  let cutoff = ctx.flowEvents.length;
  if (ctx.lastProcessedFlowEvent) {
    const idx = ctx.flowEvents.indexOf(ctx.lastProcessedFlowEvent);
    if (idx >= 0) cutoff = idx;
  }
  const news = ctx.flowEvents.slice(0, cutoff);
  ctx.lastProcessedFlowEvent = ctx.flowEvents[0];
  // Process oldest-first so state-machine sequences land in the right
  // order — e.g. meeting_requested → meeting_started → meeting_turn(s)
  // → meeting_ended. Reverse order would let a newer meeting_ended run
  // before the older meeting_turn re-stamped status='started', leaving
  // the LIVE indicator stuck.
  for (let __i = news.length - 1; __i >= 0; __i--) {
    const e = news[__i];
    const aid = String(e.data.agent_id ?? '');
    const t = e.event.split(':').pop() ?? '';
    // Any event involving an agent resets that agent's idle timer (so the
    // stretch animation only triggers when the agent is genuinely idle).
    if (aid) markActivity(aid);
    const fromIdAny = String((e.data as any).from_agent_id ?? (e.data as any).source_agent_id ?? '');
    const toIdAny   = String((e.data as any).to_agent_id   ?? (e.data as any).target_agent_id ?? '');
    if (fromIdAny) markActivity(fromIdAny);
    if (toIdAny)   markActivity(toIdAny);

    // Inbound email arrived (IMAP fetcher or webhook) → dispatch a truck
    // at the Communications office directly, bypassing the per-flow
    // cooldown so a burst of real emails reads on screen. The label on the
    // package shows how many emails came in this batch.
    if (e.event === 'comms:mail:received') {
      const commsFlow = mailOffice(ctx.flows);
      if (commsFlow) {
        const count = Number((e.data as any)?.count ?? 1) || 1;
        enqueueDelivery({
          flowId: commsFlow.id,
          flowColor: commsFlow.color || '#0ea5a4',
          label: count > 1 ? `${count} MAIL` : 'MAIL',
        });
        // Reset the per-flow cooldown so subsequent agent-started events
        // for Communications don't pile up extra trucks on the same mail.
        ctx.lastDeliveryAtByFlow.set(commsFlow.id, ctx.sceneTimeSec);
      }
      continue;
    }

    // Infrastructure toggled (Docker container up/stop/pause/resume/restart):
    // walk the office's manager to the Repos Office power console and flip it.
    if (e.event === 'office:infra:changed') {
      handleInfraToggle(e.data as any);
      continue;
    }

    if (t === 'run_started') {
      showAnimatedTag(aid, { icon: '▶️', anim: 'pulse', label: 'RUN', durationFrames: 300 });
      // (#F1) "Thinking" — dots in the agent's tag + a monitor flicker, so a
      // run that has produced no step yet still looks alive.
      showThinkingTag(aid);
      pulseThinkingMonitor(aid);
      // External message arriving → dispatch a delivery truck that drops a
      // package at reception, then the recipient agent picks it up.
      triggerDeliveryForAgent(aid, ctx.sceneTimeSec);
      // Error Auditor closes the loop on failed runs. Parse its goal to
      // extract the original run_id it's triaging and mark that report
      // as "audited" in the My Office panel.
      const startedName = String(e.data.agent_name ?? ctx.agents.find(a => a.id === aid)?.name ?? '');
      if (startedName === 'Error Auditor') {
        const goalTxt = String(e.data.goal ?? '');
        const m = goalTxt.match(/Run ID:\s*([A-Za-z0-9-]+)/);
        if (m && m[1]) {
          ctx.auditedRunIds = new Set([...ctx.auditedRunIds, m[1]]);
        }
      }
    }
    else if (t === 'run_completed') {
      const failed = e.data.status !== 'completed';
      // (#3) Tag carries the result icon (✅ pop / ❌ shake). Failed runs
      // also rattle the desk briefly for emphasis.
      if (failed) {
        showAnimatedTag(aid, { icon: '❌', anim: 'shake', color: '#ff3030', label: 'FAILED', durationFrames: 220 });
        const dg = ctx.deskGroups.get(aid);
        if (dg) tryFireAnim(`failed-shake:${aid}`, 2.0, () => {
          ctx.animRegistry.add(shake(dg, {
            property: 'rotation.z', amplitude: 0.045,
            frequencyHz: 16, durationSec: 0.55,
            tag: `failed-shake:${aid}`,
          }));
        });
        // (#F2) Error burst — red rising particles + a red halo flash over the
        // desk. Errors are rare so no FX-cap gating; debounced to avoid double
        // bursts when a failure event repeats. Effects are ephemeral and
        // self-dispose their geometry.
        spawnErrorFx(aid);
      } else {
        showAnimatedTag(aid, { icon: '✅', anim: 'pop', color: '#3DD68C', label: 'DONE', durationFrames: 180 });
      }
      if (aid === ctx.selectedAgent) {
        // The drawer re-reads its last result (and the run list, when the
        // HISTORY tab is open) — see AgentPanel.refreshRuns().
        refreshSelectedAgentRuns();
      }
      // Determine urgency: failures and safety aborts warrant staying at
      // My Office (request urgent meeting). Normal completions just drop
      // a note on the desk and walk back.
      const isUrgent = failed
        || String(e.data.error ?? '').includes('Safety abort')
        || String(e.data.error ?? '').includes('Token budget');

      // If a chain follows, the chain_triggered handler manages the office visit.
      const hasChain = news.some(ev =>
        (ev.event.split(':').pop() ?? '') === 'chain_triggered' &&
        String(ev.data.source_agent_id ?? '') === aid
      );
      // Office LEADERS walk to the top agent's office to file their
      // report in person. "Leader" = any senior officer (rank.level >=
      // MY_OFFICE_MIN_RANK_LEVEL) OR the manager of any flow (role=manager).
      // Plain workers below the lead never make this trip — they just log to
      // My Office and let their manager pick it up via the audit chain.
      const agentObj = ctx.agents.find(a => a.id === aid);
      const shouldReport = isOfficeLeader(aid);

      if (!hasChain && ctx.myOfficePos && ctx.scene && aid && shouldReport) {
        const agentName = agentObj?.name ?? 'Agent';
        const fullResult = String(e.data.result_preview ?? e.data.result ?? '') || 'Task done';
        const fullError = String(e.data.error ?? '');
        const msg = isUrgent
          ? `⚠ ${agentName}: URGENT — ${fullError.slice(0, 50)}`
          : `${agentName}: ${fullResult.slice(0, 60)}`;
        addOfficeReport(aid, isUrgent ? fullError : fullResult, String(e.data.status ?? 'completed'), String(e.data.run_id ?? ''));
        // Urgent → "meeting" path (running, no return until meeting ends).
        // Normal completion → "myoffice" path (walks in, drops a paper note
        // on the top agent's desk, walks back to own desk).
        const walkerTargetId = isUrgent ? 'meeting' : 'myoffice';
        const reportColor = flowColor(aid);
        // Only normal (non-urgent) reports carry & drop a physical note.
        // Urgent walkers join a meeting instead — the top agent deals with
        // those face to face, not via the inbox pile.
        const carryNote = !isUrgent;
        const onArrive = (!isUrgent && ctx.myOfficeNoteStack)
          ? () => { ctx.myOfficeNoteStack?.dropNote({ color: reportColor }); }
          : undefined;
        setTimeout(() => {
          // Pass undefined for the in-walker bubble — the animated tag at
          // the source desk (now following the walker) carries the meaning.
          // Seat the visitor in a free chair across the desk (not a single
          // floor point) and have them face the top agent while seated.
          const seatPt = pickFreeMyOfficeChair() ?? ctx.myOfficePos!;
          sendWalkerToPoint(
            ctx.scene, ctx.walkers, aid, seatPt, ctx.deskPos, ctx.roomMap, ctx.corGrid,
            ctx.agents, reportColor, undefined, ctx.deskAabbs,
            walkerTargetId, ctx.sittingWorkers, isUrgent,
            undefined,             // no viaPoint for myoffice/meeting walks
            onArrive,              // drop note on arrival
            carryNote,             // visible paper in the right hand
            undefined, undefined,  // meetingRoomObstacles / exempt
            undefined,             // stay (auto-return after the sit)
            ctx.myOfficeDeskFacing ?? undefined, // face the desk while seated
          );
        }, isUrgent ? 500 : 2000); // urgent: less delay before running
      }
      // Workers: only log FAILURES to My Office (routine completions stay in their office)
      if (!hasChain && !shouldReport && isUrgent && aid) {
        const workerError = String(e.data.error ?? e.data.result ?? '') || 'Failed';
        addOfficeReport(aid, workerError, 'failed', String(e.data.run_id ?? ''));
      }
    }
    else if (t === 'chain_triggered') {
      const sid = String(e.data.source_agent_id ?? ''), tid = String(e.data.target_agent_id ?? '');
      const tname = String(e.data.target_agent_name ?? '');
      if (sid && tid) {
        const agentName = ctx.agents.find(a => a.id === sid)?.name ?? 'Agent';
        const label = e.data.chain_label ? String(e.data.chain_label) : `${agentName} → ${tname}`;
        addOfficeReport(sid, `Handing off to ${tname}: ${label}`, 'handoff');
        // Cross-office handoffs read more naturally as a meeting room
        // coordination than as a single walker crossing the whole floor —
        // try the meeting visual first and only fall back to desk-to-desk
        // if no room is available (or the agents are in the same office).
        const color = flowColor(sid);
        const wentToMeeting = !sameOffice(sid, tid) && coordinateInMeetingRoom(sid, tid, color);
        if (!wentToMeeting) {
          sendWalker(ctx.scene, ctx.walkers, sid, tid, ctx.deskPos, ctx.roomMap, ctx.corGrid, ctx.agents, color, undefined, ctx.sittingWorkers, ctx.deskAabbs);
        }
        // (#F3) Data-packet handoff — a glowing arc + coin stream fly from
        // desk A to desk B, with a converging ripple + monitor pulse landing
        // at B. Runs for BOTH the meeting and same-office paths so the data
        // hand-off is always visible alongside the walker/meeting logic.
        spawnHandoffPacketFx(sid, tid, color);
        showAnimatedTag(sid, { icon: '🔗', anim: 'bounce', label: `→ ${tname.slice(0,12)}`, durationFrames: 220 });
        if (wentToMeeting) {
          showAnimatedTag(tid, { icon: '🤝', anim: 'bounce', color, label: `← ${agentName.slice(0,12)}`, durationFrames: 220 });
        }
      }
    } else if (t === 'step') {
      const st = String(e.data.type ?? '');
      if (st === 'tool_call') {
        // (#2) Category icon breathing inside the tag. It used to spin: an
        // emoji rotating about its own centre at this size reads as a
        // wobbling blob, and the glyph is the point — you should be able to
        // tell 📧 from 🔍 at a glance, which a spin actively prevents.
        const toolName = String(e.data.tool_name ?? 'tool');
        tryFireAnim(`tool:${aid}`, 1.0, () => {
          showAnimatedTag(aid, {
            icon: toolGlyph(toolName), anim: 'pulse',
            label: toolName.slice(0, 16),
            durationFrames: 130,
          });
        });
        // (#F1) The desk flickers along with it. No tag here — the tool tag
        // above already owns the chip, and an agent only ever shows one.
        pulseThinkingMonitor(aid);
        // ── Top-agent-only command effects ────────────────────────
        // When the top agent fires an agent/flow CRUD tool, mark
        // it visually so the user can see the order being issued. A
        // paper-plane shoots from his desk toward the central hall —
        // the destination office may not exist yet (creation case) or
        // is being torn down (deletion case), so the hall is the
        // safest neutral target.
        if (ctx.topAgentId && aid === ctx.topAgentId && ctx.topAgentSeatPos && ctx.hallCenterPos) {
          let cmd: { label: string; color: number; hex: string } | null = null;
          if (toolName.endsWith('kernel_agents_create')) cmd = { label: 'NEW AGENT',  color: 0x3DD68C, hex: '#3DD68C' };
          else if (toolName.endsWith('kernel_agents_flows_create')) cmd = { label: 'NEW OFFICE', color: 0x5B8DEF, hex: '#5B8DEF' };
          else if (toolName.endsWith('kernel_agents_delete')) cmd = { label: 'DESPIDO',    color: 0xF04770, hex: '#F04770' };
          else if (toolName.endsWith('kernel_agents_flows_delete')) cmd = { label: 'CIERRE',     color: 0xF04770, hex: '#F04770' };
          else if (toolName.endsWith('kernel_agents_update') || toolName.endsWith('kernel_agents_flows_update')) cmd = { label: 'ORDEN',      color: 0xC9A84C, hex: '#C9A84C' };
          if (cmd && ctx.scene) {
            showAnimatedTag(ctx.topAgentId, {
              icon: '✪', anim: 'pulse', color: cmd.hex,
              label: cmd.label, durationFrames: 220,
            });
            tryFireAnim(`top-agent-cmd:${ctx.topAgentId}`, 2.0, () => {
              ctx.animRegistry.add(paperPlane(ctx.scene, {
                from: { x: ctx.topAgentSeatPos!.x, z: ctx.topAgentSeatPos!.z },
                to:   { x: ctx.hallCenterPos!.x,   z: ctx.hallCenterPos!.z   },
                archHeight: 4, durationSec: 1.4,
                color: cmd!.color,
                tag: `top-agent-cmd:${ctx.topAgentId}`,
              }));
            });
          }
        }
      } else if (st === 'thought') {
        // (#1) The thinking dots. They replace a pulsing 💭: at office
        // distance the emoji was a grey smudge, and a thought is the one
        // event with nothing concrete to name — so show rhythm, not a noun.
        tryFireAnim(`thought:${aid}`, 1.0, () => {
          showThinkingTag(aid, 110);
        });
        pulseThinkingMonitor(aid);
      }
    }
    // ── Autonomy loop animations (auto-eval + learning lifecycle) ──
    else if (t === 'auto_eval_started') {
      showAnimatedTag(aid, { icon: '📝', anim: 'wobble', color: '#D4A84B', label: 'GRADING', durationFrames: 150 });
    }
    else if (t === 'auto_eval') {
      const score = Number(e.data.score ?? 0);
      const outcome = String(e.data.outcome ?? 'neutral');
      const tone =
        outcome === 'success' ? '#3DD68C'
        : outcome === 'failure' ? '#F04770'
        : outcome === 'partial' ? '#F0883E'
        : '#8A8FA8';
      const stars = '★'.repeat(score) + '☆'.repeat(Math.max(0, 5 - score));
      showAnimatedTag(aid, {
        icon: score >= 4 ? '🏆' : score >= 3 ? '⭐' : score >= 2 ? '⚠️' : '💢',
        anim: 'pop', color: tone,
        label: stars, durationFrames: 280,
      });
      // Bad self-eval (score<=2) → senior ranks rush to the top agent's office.
      // Low-rank agents escalate through the chain of command (their manager
      // will pick up the signal via the audit flow), not in person.
      if (score <= 2 && ctx.myOfficePos && ctx.scene && aid && isSeniorRank(aid)) {
        const agentName = ctx.agents.find(a => a.id === aid)?.name ?? 'Agent';
        setTimeout(() => {
          const seatPt = pickFreeMyOfficeChair() ?? ctx.myOfficePos!;
          sendWalkerToPoint(
            ctx.scene, ctx.walkers, aid, seatPt, ctx.deskPos, ctx.roomMap, ctx.corGrid, ctx.agents,
            '#F04770', undefined, ctx.deskAabbs, 'meeting', ctx.sittingWorkers, true,
            undefined, undefined, undefined, undefined, undefined, undefined,
            ctx.myOfficeDeskFacing ?? undefined, // face the desk while seated
          );
        }, 500);
      }
    }
    else if (t === 'learning_created') {
      const ltype = String(e.data.learning_type ?? 'insight');
      // (#4) Particles converge into the head (spatial visual) + a tag with
      // a sparkling 💡 / 🚫 / ⭐ explains what KIND of lesson was added.
      const lessonHex =
        ltype === 'avoid'  ? 0xff5050 :
        ltype === 'prefer' ? 0x50ff88 :
                             0xffd166;
      const lessonCss =
        ltype === 'avoid'  ? '#ff5050' :
        ltype === 'prefer' ? '#50ff88' :
                             '#ffd166';
      const icon = ltype === 'avoid' ? '🚫' : ltype === 'prefer' ? '⭐' : '💡';
      showAnimatedTag(aid, { icon, anim: 'sparkle', color: lessonCss, label: 'LESSON', durationFrames: 280 });
      const dp = ctx.deskPos.get(aid);
      if (dp && ctx.scene) tryFireAnim(`lesson:${aid}`, 1.5, () => {
        ctx.animRegistry.add(convergingParticles(ctx.scene, {
          target: { x: dp.x, y: 1.8, z: dp.z + 0.55 },
          spawnRadius: 1.6, count: 10,
          color: lessonHex, durationSec: 1.2,
          tag: `lesson:${aid}`,
        }));
      });
    }
    else if (t === 'learning_deactivated') {
      const count = Number(e.data.count ?? 1);
      // (#5) Tag carries the trash icon shaking; scrolls fall for spatial cue.
      showAnimatedTag(aid, {
        icon: '🗑️', anim: 'shake', color: '#9a9a9a',
        label: count > 1 ? `−${count}` : 'DROPPED',
        durationFrames: 180,
      });
      const dg = ctx.deskGroups.get(aid);
      if (dg) tryFireAnim(`lesson-drop:${aid}`, 2.0, () => {
        const drops = Math.min(count, 3);
        for (let k = 0; k < drops; k++) {
          ctx.animRegistry.add(fallingGlyph(dg, {
            glyph: '📜', fontSize: 28,
            startY: 4.2 + k * 0.3,
            floorY: 0.05, gravity: 11, spinSpeed: 5 + Math.random() * 2,
            color: '#cc9',
            lingerSec: 0.4, fadeSec: 0.5,
            tag: `lesson-drop:${aid}`,
          }));
        }
      });
    }
    else if (t === 'meeting_requested') {
      const mid = String(e.data.meeting_id ?? '');
      const modId = String(e.data.moderator_id ?? '');
      const modName = String(e.data.moderator_name ?? ctx.agents.find(a => a.id === modId)?.name ?? 'Moderator');
      const attIds: string[] = (e.data.attendee_ids as string[]) ?? [];
      const attNames: string[] = (e.data.attendee_names as string[]) ?? [];
      const topic = String(e.data.topic ?? '');
      const mClr = e.data.urgency === 'urgent' ? '#F04770' : '#5B8DEF';
      // Pick a real meeting room. Round-robin across available rooms by
      // distributing concurrent meetings into different slots; fallback to
      // My Office if the current layout has zero meeting rooms.
      let roomIdx = -1;
      if (ctx.meetingRoomSlots.length > 0) {
        const inUse = new Set(ctx.meetingIdToRoom.values());
        roomIdx = ctx.meetingRoomSlots.findIndex((_, i) => !inUse.has(i));
        if (roomIdx < 0) roomIdx = ctx.meetingIdToRoom.size % ctx.meetingRoomSlots.length;
        if (mid) ctx.meetingIdToRoom.set(mid, roomIdx);
      }
      const room = roomIdx >= 0 ? ctx.meetingRoomSlots[roomIdx] : null;
      // One unique seat per participant around the conference table — without
      // this everyone walks to the room center and overlaps. Fall back to the
      // The top agent's 4 visitor chairs (then a single point) when no meeting
      // room is free, so a meeting held in My Office seats everyone properly.
      const seats = room
        ? getMeetingSeatPositions(room)
        : (ctx.myOfficeSeats.length ? ctx.myOfficeSeats : (ctx.myOfficePos ? [ctx.myOfficePos] : []));
      // Door midpoint: pick the wall closest to the central hall — that's
      // where the door was placed in office.ts:buildMeetingRooms. Without
      // routing via the door the walker cuts diagonally through walls.
      const doorPoint = (room && ctx.hallCenterPos) ? meetingRoomDoorPoint(room, ctx.hallCenterPos) : undefined;
      if (seats.length > 0 && ctx.scene) {
        const allParticipants = [modId, ...attIds].filter(Boolean);
        allParticipants.forEach((pid, i) => {
          const meetingUrgent = e.data.urgency === 'urgent';
          const seat = seats[i % seats.length];
          // If an old walker is blocking, drop it so the meeting takes
          // precedence (e.g. the moderator may have a stale chain walker).
          const stale = ctx.walkers.find(w => w.sourceId === pid);
          if (stale) {
            if ((stale as any).group) ctx.scene.remove((stale as any).group);
            if ((stale as any).bubble?.parent) (stale as any).bubble.parent.remove((stale as any).bubble);
            ctx.walkers = ctx.walkers.filter(w => w !== stale);
          }
          // stay=true: seated until meeting_ended dismisses them — the old
          // 60s maxAge default evicted attendees mid-conversation.
          sendWalkerToPoint(
            ctx.scene, ctx.walkers, pid, seat, ctx.deskPos, ctx.roomMap, ctx.corGrid, ctx.agents,
            mClr, undefined, ctx.deskAabbs, 'meeting', ctx.sittingWorkers,
            meetingUrgent, doorPoint, undefined, false, ctx.meetingRoomSlots, roomIdx, true,
            // Face the table. Without this the walker keeps whatever heading
            // it happened to arrive on, so half the room sits with its back
            // to the meeting. `talkFacingPos` was built for exactly this —
            // its own comment says "the table centroid" — but no meeting
            // call site ever passed one.
            room
              ? { x: room.cx, y: 0, z: room.cz }
              : (ctx.myOfficeDeskFacing ?? undefined),
          );
        });
      }
      if (modId) showAnimatedTag(modId, { icon: '📋', anim: 'bounce', color: '#5B8DEF', label: 'CALL MEETING', durationFrames: 480 });
      if (mid) {
        const parts = [{ id: modId, name: modName }, ...attIds.map((id, i) => ({ id, name: attNames[i] ?? ctx.agents.find(a => a.id === id)?.name ?? 'Agent' }))];
        ctx.liveMeetings = {
          ...ctx.liveMeetings,
          [mid]: {
            id: mid, topic, status: 'requested',
            moderatorId: modId, moderatorName: modName,
            participants: parts, turns: [], started_at: Date.now(),
          },
        };
        ctx.activeMeetingId = mid;
        // Transcript modal stays HIDDEN by default at meeting_requested.
        // The user opens it on demand via the meeting-room click or the
        // shell's ActivityPanel.
        ctx.showTranscriptBody = true;
        ctx.showMyOfficePanel = false;
        // Drop the gold halo + topic banner above the meeting table so
        // the user spots the active room from anywhere in the floor plan.
        if (room) spawnMeetingDecor(mid, room, topic);
      }
    }
    else if (t === 'meeting_started') {
      const mid = String(e.data.meeting_id ?? '');
      const mTopic = String(e.data.topic ?? '');
      const mParts = (e.data.participants as Array<{id: string; name: string}>) ?? [];
      for (const p of mParts) showAnimatedTag(p.id, { icon: '🤝', anim: 'bounce', color: '#5B8DEF', label: 'MEETING', durationFrames: 480 });
      if (mid && ctx.liveMeetings[mid]) {
        ctx.liveMeetings = { ...ctx.liveMeetings, [mid]: { ...ctx.liveMeetings[mid], status: 'started', participants: mParts, topic: mTopic || ctx.liveMeetings[mid].topic } };
        // Pin the active meeting id, but DON'T auto-open the transcript.
        // User opens via clicking the meeting room / the shell's
        // ActivityPanel — keeps the 3D view clean by default.
        ctx.activeMeetingId = mid;
        ctx.showMyOfficePanel = false;
      }
    }
    // ── An agent is composing its turn ──────────────────────────
    // Fired by the executor BEFORE the provider call. Median turn is ~25s
    // (measured on this floor: 13s / 24s / 29s / 24s / 41s / 23s / 60s, plus
    // one 5m20s outlier), and until now nothing on screen moved during that
    // wait — a thinking room and a hung room looked identical.
    else if (t === 'meeting_thinking') {
      const thinkerId = String(e.data.agent_id ?? '');
      const isMod = String(e.data.role ?? '') === 'moderator';
      if (thinkerId) {
        showAnimatedTag(thinkerId, {
          icon: '💭',
          anim: 'pulse',
          color: isMod ? '#F0C674' : '#5B8DEF',
          label: '···',
          // Long enough to outlast a slow turn; `meeting_turn` replaces it
          // as soon as the text lands, so it rarely runs to expiry.
          durationFrames: 3600,
        });
      }
      const mid = String(e.data.meeting_id ?? '');
      if (mid && ctx.liveMeetings[mid]) {
        const who = String(e.data.agent_name ?? '');
        updateMeetingDecorTurn(mid, who ? `${who} está pensando…` : 'pensando…');
      }
    }
    else if (t === 'meeting_turn') {
      const mid = String(e.data.meeting_id ?? '');
      const spkId = String(e.data.agent_id ?? '');
      const spkName = String(e.data.agent_name ?? ctx.agents.find(a => a.id === spkId)?.name ?? 'Agent');
      const role = String(e.data.role ?? 'attendee');
      const round = Number(e.data.round ?? 0);
      const body = String(e.data.body ?? e.data.content_preview ?? '');
      const tokens = Number(e.data.tokens ?? 0);
      if (mid && ctx.liveMeetings[mid]) {
        const turn: LiveTurn = { agentId: spkId, agentName: spkName, role, round, body, ts: Date.now(), tokens };
        // Promote the speaker so the floor pose + spotlight code below
        // can light them up. Stamp it on the meeting record before
        // appending the turn so any reactive reads have the latest value.
        ctx.liveMeetings = {
          ...ctx.liveMeetings,
          [mid]: {
            ...ctx.liveMeetings[mid],
            turns: [...ctx.liveMeetings[mid].turns, turn],
            currentSpeakerId: spkId,
          },
        };
        ctx.activeMeetingId = mid;
        // Numbered speech bubble — "[3/8] VP: ...". Only the speaker
        // gets a visible bubble; listeners stay quiet so the room reads
        // as a single conversation. The bubble persists for ~25s, long
        // enough to span the slowest LLM turn before the next one
        // overrides it on the speaker's desk anyway.
        const totalTurns = ctx.liveMeetings[mid].turns.length;
        if (spkId) showAnimatedTag(spkId, { icon: '🗣️', anim: 'pulse', label: `TURN ${totalTurns}`, durationFrames: 1200 });
        // Refresh the floating banner above the meeting table.
        updateMeetingDecorTurn(mid, `Turn ${totalTurns} · ${spkName} (round ${round})`);
        // Wipe stale "🤝 Meeting:" greeting bubbles off everyone else
        // the moment the first turn lands so the speaker is the only
        // one with text above them.
        for (const p of ctx.liveMeetings[mid].participants ?? []) {
          if (p.id && p.id !== spkId) {
            const old = ctx.speechBubbles.get(p.id);
            if (old) {
              if (old.label?.parent) old.label.parent.remove(old.label);
              old.div.remove();
              ctx.animRegistry.cancelByTag(`bubble:${p.id}`);
              ctx.speechBubbles.delete(p.id);
            }
          }
        }
      }
    }
    else if (t === 'meeting_ended') {
      const mid = String(e.data.meeting_id ?? '');
      const mPids: string[] = (e.data.participants as string[]) ?? [];
      const mStat = String(e.data.status ?? '');
      const mSum = String(e.data.summary ?? '');
      // Dismiss only THIS meeting's attendees — other concurrent meetings
      // (including a human-led one) keep their walkers seated. The "failed"
      // event carries no participants; in that case dismiss every meeting
      // walker EXCEPT the active human meeting's attendees.
      if (ctx.scene) {
        const pidSet = new Set(mPids);
        const humanAttendees = ctx.meetingActive ? ctx.meetingSelectedIds : new Set<string>();
        removeArrivedWalkers(ctx.scene, ctx.walkers, 'meeting', pidSet.size > 0
          ? (w) => pidSet.has(w.sourceId)
          : (w) => !humanAttendees.has(w.sourceId));
      }
      for (const pid of mPids) showAnimatedTag(pid, mStat === 'completed'
        ? { icon: '✅', anim: 'pop', color: '#3DD68C', label: 'MEETING OK', durationFrames: 600 }
        : { icon: '❌', anim: 'shake', color: '#F04770', label: 'MEETING FAIL', durationFrames: 600 });
      if (mid && ctx.liveMeetings[mid]) {
        ctx.liveMeetings = {
          ...ctx.liveMeetings,
          [mid]: {
            ...ctx.liveMeetings[mid],
            status: mStat === 'completed' ? 'completed' : 'failed',
            ended_at: Date.now(),
            summary: mSum,
            decisions: (e.data.decisions as string[]) ?? [],
            action_items: (e.data.action_items as string[]) ?? [],
            currentSpeakerId: '',
          },
        };
        ctx.meetingIdToRoom.delete(mid);
        // Halo + banner come down with the meeting. Listeners can still
        // re-open the transcript from the history panel afterwards.
        disposeMeetingDecor(mid);
        // Keep the modal up for a beat so the user reads the wrap-up,
        // then close it automatically. The meeting stays in the
        // history panel for later review.
        if (ctx.activeMeetingId === mid) {
          setTimeout(() => {
            if (ctx.activeMeetingId === mid && ctx.liveMeetings[mid]?.status !== 'started') {
              ctx.showLiveMeeting = false;
            }
          }, 30_000);
        }
      }
    }
    // ── Management visibility: prompt/tool edits by a manager ──
    else if (t === 'agent_edited') {
      const mgrId = String(e.data.manager_id ?? '');
      const mgrName = String(e.data.manager_name ?? '');
      const tgtId = String(e.data.target_id ?? '');
      const tgtName = String(e.data.target_name ?? '');
      const changed: string[] = [];
      if (e.data.prompt_changed) changed.push('prompt');
      if (e.data.tools_changed) changed.push('tools');
      const what = changed.join(' + ') || 'config';
      // Gold/purple beam desk→desk so the user sees "A is editing B's brain".
      // For cross-office edits, route through a meeting room instead — the
      // manager and the edited agent "coordinate" face-to-face.
      if (ctx.scene && mgrId && tgtId) {
        const wentToMeeting = !sameOffice(mgrId, tgtId) && coordinateInMeetingRoom(mgrId, tgtId, '#C67FE8');
        if (!wentToMeeting) {
          sendWalker(ctx.scene, ctx.walkers, mgrId, tgtId, ctx.deskPos, ctx.roomMap, ctx.corGrid, ctx.agents, '#C67FE8', undefined, ctx.sittingWorkers, ctx.deskAabbs);
        }
      }
      // (#6) A pencil tilting inside the target's tag. It was a spinning ⚙️:
      // the gear is what an agent's config looks like in a settings menu, not
      // what "someone just rewrote your brain" looks like over a desk.
      if (tgtId) tryFireAnim(`edit:${tgtId}`, 2.0, () => {
        showAnimatedTag(tgtId, { icon: '✎', anim: 'wobble', color: '#C67FE8', label: 'EDITED', durationFrames: 260 });
      });
      pushMgmtLog({
        kind: 'edit',
        from: mgrName, to: tgtName,
        detail: what,
        ts: Date.now(),
        preview: String(e.data.system_prompt_preview ?? ''),
      });
    }
    // ── Management visibility: explicit escalations (manager → X, or cross-office) ──
    else if (t === 'escalation') {
      const fromId = String(e.data.from_agent_id ?? '');
      const fromName = String(e.data.from_agent_name ?? '');
      const fromRole = String(e.data.from_role ?? 'worker');
      const toId = String(e.data.to_agent_id ?? '');
      const toName = String(e.data.to_agent_name ?? '');
      const subject = String(e.data.subject ?? '').slice(0, 80);
      const crossOffice = !!e.data.cross_office;
      const isDirective = !!e.data.is_manager_directive;
      const color = isDirective
        ? '#F0883E'                    // orange — directive from manager
        : crossOffice ? '#5B8DEF' : '#3DD6C8';  // blue cross-team / teal peer
      // Cross-office escalations + directives: route through a meeting room
      // (both sit and "coordinate"). Same-office stays as desk-to-desk so
      // small adjustments don't look as ceremonious as they really are.
      if (ctx.scene && fromId && toId) {
        const wentToMeeting = !sameOffice(fromId, toId) && coordinateInMeetingRoom(fromId, toId, color);
        if (!wentToMeeting) {
          sendWalker(ctx.scene, ctx.walkers, fromId, toId, ctx.deskPos, ctx.roomMap, ctx.corGrid, ctx.agents, color, undefined, ctx.sittingWorkers, ctx.deskAabbs);
        }
      }
      // No bubbles: the walker (+ for directives the curved arrow below)
      // are the whole visual. Subject text lives in the management log panel.
      // (#7) Directives also get an arched arrow above the walker.
      if (isDirective && ctx.scene && fromId && toId) {
        const fp = ctx.deskPos.get(fromId);
        const tp = ctx.deskPos.get(toId);
        if (fp && tp) tryFireAnim(`directive:${fromId}->${toId}`, 2.0, () => {
          ctx.animRegistry.add(curvedArrow(ctx.scene, {
            from: { x: fp.x, y: 3.2, z: fp.z + 0.55 },
            to:   { x: tp.x, y: 3.2, z: tp.z + 0.55 },
            archHeight: 5, color: 0xf0883e,
            drawSec: 0.5, holdSec: 0.8, fadeSec: 0.5,
            tag: `directive:${fromId}->${toId}`,
          }));
        });
      }
      pushMgmtLog({
        kind: isDirective ? 'directive' : 'escalation',
        from: fromName, to: toName,
        detail: subject,
        ts: Date.now(),
        preview: String(e.data.body_preview ?? ''),
        crossOffice, role: fromRole,
      });
    }
    // ── Question asked: the agent literally walks to My Office ──
    // Two layered visuals:
    //   (1) A fast paper-plane arc (instant signal — easy to spot from afar).
    //   (2) A walker dispatched from the asker's desk to My Office carrying
    //       the question as a CSS2D bubble. The walker plays the "talking"
    //       pose on arrival, then returns to the desk. This is THE feature
    //       the user wanted — the agent physically standing up to ask.
    // The "one walker per agent" guard in sendWalkerToPoint prevents pile-up
    // if the same agent fires several questions in a row.
    else if (t === 'question_asked') {
      const fromId = String(e.data.from_agent_id ?? '');
      const fromName = String(e.data.from_agent_name ?? '');
      const qTxt = String(e.data.question ?? '').slice(0, 60);
      // Audible "new message for the top agent" ping — pairs with the red
      // halo + alert pill so the escalation is hard to miss even off-screen.
      playTopAgentChime();
      if (ctx.scene && fromId && ctx.myOfficePos) {
        const fp = ctx.deskPos.get(fromId);
        if (fp) {
          tryFireAnim(`plane:${fromId}`, 2.5, () => {
            ctx.animRegistry.add(paperPlane(ctx.scene, {
              from: { x: fp.x, z: fp.z },
              to:   { x: ctx.myOfficePos!.x, z: ctx.myOfficePos!.z },
              archHeight: 5, durationSec: 2.0,
              color: 0xffd166, // golden = escalation
              tag: `plane:${fromId}`,
            }));
          });
          // The walker itself — stands up, walks the corridors to My Office,
          // says hello with the question text, returns to the desk.
          tryFireAnim(`ask-walk:${fromId}`, 25, () => {
            sendWalkerToPoint(
              ctx.scene, ctx.walkers, fromId, ctx.myOfficePos!,
              ctx.deskPos, ctx.roomMap, ctx.corGrid, ctx.agents,
              '#ffd166',                 // gold = "asking the boss"
              `❓ ${qTxt || 'question'}`, // bubble shows truncated question
              ctx.deskAabbs, 'myoffice',     // customTargetId — same tag used by report completions
              ctx.sittingWorkers,
              true,                       // urgent = run instead of walk, 1.6× speed
            );
          });
        }
      }
      loadPendingQuestions();
      pushMgmtLog({
        kind: 'escalation',
        from: fromName, to: topAgent()?.name ?? highestRank()?.name ?? 'Chief',
        detail: `❓ ${qTxt}`,
        ts: Date.now(),
        preview: String(e.data.question ?? ''),
        crossOffice: false, role: 'manager',
      });
    }
    // ── Top agent answered: ping the asker's desk with a green "answer
    // delivered" pulse + reverse paper plane. The asker will see this on
    // their next run (the answer also lands in their inbox); the visual is
    // just to close the loop for whoever is watching the 3D office. ─
    else if (t === 'question_answered') {
      const toId = String(e.data.from_agent_id ?? ''); // recipient = original asker
      const chosen = String(e.data.selected_option ?? '').slice(0, 40);
      if (ctx.scene && toId && ctx.myOfficePos) {
        const tp = ctx.deskPos.get(toId);
        if (tp) {
          tryFireAnim(`ans-plane:${toId}`, 2.5, () => {
            ctx.animRegistry.add(paperPlane(ctx.scene, {
              from: { x: ctx.myOfficePos!.x, z: ctx.myOfficePos!.z },
              to:   { x: tp.x, z: tp.z },
              archHeight: 4.5, durationSec: 1.8,
              color: 0x78dc8c, // green = answer delivered
              tag: `ans-plane:${toId}`,
            }));
          });
          const dg = ctx.deskGroups.get(toId);
          if (dg) tryFireAnim(`ans-halo:${toId}`, 2.0, () => {
            ctx.animRegistry.add(floatingGlyph(dg, {
              glyph: '✓',
              color: '#78dc8c',
              fontSize: 28,
              startY: 1.6,
              durationSec: 2.0,
              tag: `ans-halo:${toId}`,
            }));
          });
        }
      }
      loadPendingQuestions();
      if (toId) {
        const a = ctx.agents.find(x => x.id === toId);
        pushMgmtLog({
          kind: 'escalation',
          from: topAgent()?.name ?? highestRank()?.name ?? 'Chief',
          to: a?.name ?? toId.slice(0, 8),
          detail: `✓ ${chosen}`,
          ts: Date.now(),
          preview: chosen,
          crossOffice: false, role: 'manager',
        });
      }
    }
    // ── Trade execution celebration in Central Hall + ritual in trading office ──
    if (e.event === 'archEvent' && (e.data as any)?.event === 'trade_executed') {
      const td = (e.data as any)?.data;
      if (td && ctx.hallCenterPos && ctx.scene && ctx.THREE) {
        const symbol = String(td.symbol ?? '').replace(/\/.*/, '');
        const sideStr = String(td.side ?? 'BUY').toUpperCase();
        const side: 'BUY' | 'SELL' = sideStr === 'SELL' ? 'SELL' : 'BUY';
        const price = Number(td.price ?? 0);
        const isBuy = side === 'BUY';

        // Local ritual — runs inside the trading office for EVERY order.
        // Resolve the trader: prefer agent_id on the event; fall back to the
        // first active agent of the trading flow (name-matched).
        let traderId = String(td.agent_id ?? '');
        const tradingFlow = ctx.flows.find(f => /trad/i.test(f.name || ''));
        if (!traderId && tradingFlow) {
          const ag = ctx.agents.find(a => a.flow_id === tradingFlow.id && a.active === 1);
          if (ag) traderId = ag.id;
        }
        const traderDesk = traderId ? ctx.deskPos.get(traderId) : undefined;
        const tradingRoom = tradingFlow ? ctx.roomMap.get(tradingFlow.id) : undefined;
        if (traderDesk && tradingRoom) {
          const monitorMat = ctx.deskGroups.get(traderId)?.userData?._monitor?.material;
          const pnlRaw = Number(td.pnl ?? td.realized_pnl ?? td.profit ?? NaN);
          runTradeExecution({
            scene: ctx.scene, registry: ctx.animRegistry,
            trader: { x: traderDesk.x, y: 0, z: traderDesk.z },
            marketHub: { x: tradingRoom.cx, y: 2.5, z: tradingRoom.cz },
            symbol, side,
            quantity: Number(td.qty ?? td.quantity ?? td.size ?? 1),
            price,
            pnl: Number.isFinite(pnlRaw) ? pnlRaw : undefined,
            monitorMaterial: monitorMat,
          });
        }

        // Office-wide celebration (existing) — keeps the news visible from
        // anywhere in the floor plan on top of the local ritual.
        spawnTradeCelebration(symbol, sideStr, price, isBuy);
      }
    }
  }

  // Update activity board with latest events
  const boardEvents = ctx.flowEvents.slice(0, 6).map(ev => {
    const t = ev.event.split(':').pop() ?? '';
    const agentName = ctx.agents.find(a => a.id === String(ev.data.agent_id ?? ''))?.name ?? '';
    let text = t;
    if (t === 'run_started') text = 'started';
    else if (t === 'run_completed') text = ev.data.status === 'completed' ? 'done' : 'failed';
    else if (t === 'chain_triggered') text = `→ ${String(ev.data.target_agent_name ?? '').slice(0, 15)}`;
    else if (t === 'step') text = String(ev.data.type === 'tool_call' ? ev.data.tool_name : ev.data.type ?? '').slice(0, 20);
    const ts = ev.data.ts ?? ev.ts;
    const time = ts ? new Date(ts as string).toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
    return { agent: agentName.slice(0, 12), text, color: agentName ? flowColor(String(ev.data.agent_id ?? '')) : '#8a8fa8', time };
  });
  updateActivityBoard(boardEvents);
}
