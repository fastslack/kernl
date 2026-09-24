<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { slide } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import PerfOverlay from './PerfOverlay.svelte';
  import type { AgentFlowEvent } from '$lib/stores.js';
  import { rpcOrCall, rpc } from '$lib/ws.js';
  import { escapeHtml } from '$shared/sanitize';
  import { traitsOf } from '$lib/office/office-kinds.js';
  import {
    computeFloorPlan, initHumanoid, initOffice, initFurniture, initWalkers, initAmbiance,
    initHumanoidPool, createSittingHumanoidPool, type SittingHumanoidPool,
    initAllSkins, resolveSkin, listSkins, type SkinDefinition,
    buildFloor, buildStreets, buildCorridorGrid, buildRooms, buildMeetingRooms, buildMyOffice, buildCentralHall, buildHallExtension, buildReception, buildCommunicationsOffice, buildDataCenterOffice, buildDesks, buildHallways,
    setupLighting,
    buildAmbiance, buildWallClock, buildActivityBoard, buildDoorLeds, updateDoorLeds, buildElevator, updateAmbiance,
    initRedAlertDecor, buildSandbagBarrier, buildCrates,
    buildNameplate,
    paintMeetingScreen, clearMeetingScreen, type MeetingScreenHandle,
    buildPowerConsole, setInfraBreaker, getInfraBreakerState, setInfraReadout,
    flipInfraLever, updateInfraConsole, getInfraOperatorPos, getInfraFacePos,
    resetInfraConsole, toggleInfraBoard, INFRA_VIS, type InfraState,
    sendWalker, sendWalkerToPoint, sendCommuteWalker, updateWalkers, removeArrivedWalkers, syncSeatedVisibility, animateSitting,
    initDelivery, initDeliveryScene, enqueueDelivery, resetDelivery, markPackagePickedUp, updateDelivery,
    initTaxi, initTaxiScene, enqueueTaxi, updateTaxis, resetTaxis,
    createAnimationRegistry, initAnimEffects,
    cameraTween, haloPulse, risingParticles, bubbleFade, materialPulse,
    floatingGlyph, shake, convergingParticles,
    curvedArrow, pillarOfLight, coinTrail, chyronLabel,
    createNoteStack, type NoteStack,
    type AnimationRegistry,
    type DeliveryInfo,
    resolveFlowColor, CLAUDE_CODE_DEFAULT_MODEL,
    type Walker, type SpeechBubble, type HumanoidParts, type RoomInfo, type CorridorGrid, type Aabb2D, type HallwayLine,
  } from './office3d/index.js';
  import {
    createRenderer, configureRenderer, createLabelRenderer, applyEnvironment,
    initialCameraDistance, createPostProcessing,
  } from './office3d/scene.js';
  import { processLiveEvents, type LiveEventContext } from './office3d/events.js';
  import OfficeCreatorChat from '$lib/components/OfficeCreatorChat.svelte';
  import RegisterRepoModal from './RegisterRepoModal.svelte';
  import EmailModal from './EmailModal.svelte';
  import DraftModal from './DraftModal.svelte';
  import BootLoader from './BootLoader.svelte';
  import MeetingPanels from './MeetingPanels.svelte';
  import MyOfficePanel from './MyOfficePanel.svelte';
  import AgentPanel from './AgentPanel.svelte';
  // Aliased: `t` is a local name all over this file, including `{#each … as t}` in markup.
  import { t as translate } from '$lib/i18n/index.js';
  import {
    meetingRoomDoorPoint, getMeetingSeatPositions, pickFreeChair,
    sameOffice as sameOfficeOf, type SeatedWalker,
  } from '$lib/office-geometry.js';
  import { hexToNum, escapeBannerText, parseMeetingTopics } from '$lib/agent-helpers.js';
  import { fetchRecentRunSummaries } from './recent-runs.js';
  import type {
    WorldAgent, WorldChain, WorldFlow, WorldRank, WorldStats,
    OfficeReport, PendingQuestion, LiveMeeting, MgmtEntry, AnimatedTagAnim,
  } from './world-types.js';

  export let agents: WorldAgent[] = [];
  export let chains: WorldChain[] = [];
  export let flows: WorldFlow[] = [];
  export let ranks: WorldRank[] = [];
  export let flowEvents: AgentFlowEvent[] = [];
  export let runningAgentIds: Set<string> = new Set();
  export let stats: WorldStats = {};
  // Parent's first-fetch lifecycle (graphData). The boot loader stays up until
  // `dataLoaded` is true so the offices are never revealed empty mid-fetch.
  export let dataLoaded: boolean = false;
  export let dataError: boolean = false;
  /** The /agents-flow shell renders its own rail and command bar. */

  let canvasEl: HTMLDivElement;
  let THREE: any, CSS2DObject: any;
  let renderer: any, scene: any, camera: any, controls: any, labelRenderer: any;
  let composer: any; // EffectComposer for post-processing
  // Refs to the optional post passes so the adaptive-quality controller can
  // toggle them by `.enabled` (cheap — composer skips disabled passes) instead
  // of rebuilding the pipeline. Resolution is NEVER touched (see note above the
  // animate loop). null when the pass wasn't created (capability-gated at init).
  let gtaoPass: any = null;
  let bloomPass: any = null;
  let qualityTier = 2; // 2 = full (GTAO+bloom), 1 = bloom only, 0 = no post
  let qLowFrames = 0, qHighFrames = 0; // hysteresis counters for tier changes
  let animId: number;
  let fc = 0;
  let hoveredAgent: string | null = null;
  let lastHoveredAgent: string | null = null;
  let selectedAgent: string | null = null;

  /** Toggle the hover highlight for an agent wherever it currently is.
   *  - If the agent has an active walker (walking the floor OR seated in a
   *    meeting room), glow the humanoid body itself.
   *  - Otherwise glow the seated worker's desk top (the at-desk affordance).
   *  Non-destructive: each touched material stashes its original emissive on
   *  `userData._hov*` and restores it on hover-out, so it composes cleanly with
   *  the meeting speaker-spotlight loop and the fade-in/out tweens. */
  function setAgentHover(agentId: string, on: boolean) {
    const w = walkers.find((x) => x.sourceId === agentId);
    if (w?.group) {
      const hex = on ? flowColor(agentId) : 0;
      w.group.traverse((c: any) => {
        const mats = Array.isArray(c.material) ? c.material : c.material ? [c.material] : [];
        for (const m of mats) {
          if (!m.emissive || typeof m.emissive.setHex !== 'function') continue; // skip MeshBasic (glow/eyes)
          if (on) {
            if (!m.userData) m.userData = {};
            if (m.userData._hovEm === undefined) {
              m.userData._hovEm = m.emissive.getHex();
              m.userData._hovEi = m.emissiveIntensity ?? 1;
            }
            m.emissive.set(hex);
            m.emissiveIntensity = 0.6;
          } else if (m.userData && m.userData._hovEm !== undefined) {
            m.emissive.setHex(m.userData._hovEm);
            m.emissiveIntensity = m.userData._hovEi;
            m.userData._hovEm = undefined;
            m.userData._hovEi = undefined;
          }
        }
      });
      return;
    }
    // Seated at desk — glow the desk top (works for pooled workers too).
    const mat = deskGroups.get(agentId)?.userData._deskTop?.material;
    if (mat) {
      if (on) { mat.emissiveIntensity = 0.25; mat.emissive.set(flowColor(agentId)); }
      else { mat.emissiveIntensity = 0; }
    }
  }
  let webglError: string | null = null;
  // Boot loader: true once the office is built AND populated with agents and a
  // frame has painted. Drives the animated "HQ uplink" overlay (no fake timer).
  let sceneReady = false;
  // Hard safety net — reveals even if the readiness signals never fire (hung
  // fetch, unexpected build state) so the user is never trapped on the loader.
  // Much longer than the old 8s blind timer: real reveal comes from the
  // readiness reactive below, this only catches genuine hangs.
  let sceneReadyFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  // Boot pipeline state surfaced in the loader so it shows real progress and
  // never lifts on an empty office.
  let staticBuilt = false;            // office shell (floor/rooms/streets) is in the scene
  let officePopulated = false;        // desks + seated agents have been built at least once
  let bootError: string | null = null; // fatal build error → loader shows it instead of spinning
  // Human-readable boot stage for the loader subtitle.
  let bootStatus = 'initialising renderer…';

  let deskGroups = new Map<string, any>();
  let deskLabels = new Map<string, any>();
  let deskPos = new Map<string, { x: number; y: number; z: number }>();
  let sittingWorkers = new Map<string, import('./office3d/walkers.js').SittingWorkerEntry>();
  // Optional InstancedMesh pool — when non-null, all sitting humanoids share
  // 13 InstancedMesh draw calls instead of ~14 meshes per worker. Toggle
  // with USE_HUMANOID_POOL below to A/B benchmark.
  const USE_HUMANOID_POOL = true;
  let humanoidPool: SittingHumanoidPool | null = null;
  let deskAabbs = new Map<string, Aabb2D>();
  let hallwayLines: HallwayLine[] = [];
  let roomMap = new Map<string, RoomInfo>();
  let resizeObserver: ResizeObserver | null = null;
  let corGrid: CorridorGrid = { segments: [], nodes: [], buildingBounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 } };
  let meetingRooms: Array<{ cx: number; cz: number; w: number; d: number }> = [];
  let hallExtensions: Array<{ cx: number; cz: number; w: number; d: number }> = [];
  let myOfficePos: { x: number; y: number; z: number } | null = null;
  let myOfficeHitbox: any = null;
  // The 4 visitor chairs in front of the top agent's desk + the point a seated
  // visitor faces (the desk). Visitors (reports, meetings held here) sit in
  // these instead of piling onto one floor point. Populated by buildMyOffice.
  let myOfficeSeats: Array<{ x: number; y: number; z: number }> = [];
  let myOfficeDeskFacing: { x: number; y: number; z: number } | null = null;
  // ── Office infrastructure (Docker container per flow) — power state ──
  // The Repos Office holds the master power console; each office's container
  // on/off/paused/error state is shown there (breaker LED + ops board) and on
  // each office's own door sign. Live-updated from `office:infra:changed`.
  let infraState = new Map<string, InfraState>();      // flowId → current state
  let reposOperatorPos: { x: number; y: number; z: number } | null = null;
  let infraConsoleHitbox: any = null;                  // click → toggle power-grid board
  // ── Top agent (holder of the highest rank, seated in My Office) ──
  // Populated by placeTopAgent() after buildSpecialRooms. The hitbox sits
  // around the torso so the raycaster can route clicks on the figure
  // (not the desk hitbox) to "Talk to the top agent". The pinned group
  // holds the seated humanoid + halo + nameplate so they can be disposed
  // on scene rebuild.
  let topAgentId: string | null = null;
  let topAgentGroup: any = null;
  let topAgentHitbox: any = null;
  let topAgentLabel: any = null;
  let topAgentHaloMesh: any = null;
  let topAgentSeatPos: { x: number; y: number; z: number } | null = null;
  // The full HumanoidParts struct (head/torso/leftArm/.../leftLeg) returned
  // by skin.createHumanoid. animateSitting reads .leftArm/.rightArm/.head off
  // this, so ensureTopAgentWiring must re-inject the SAME struct — not a
  // bare THREE.Group — when the desk rebuild wipes sittingWorkers.
  let topAgentHumanParts: any = null;
  // Module-level handle to the raycaster cache so placeTopAgent() can null
  // it out and force a refresh on the next mousemove.
  let rayTargetsCache: any[] | null = null;
  // World-space point on the top agent's desk where leaders pile their report
  // notes (paper-stack visual). Populated when buildMyOffice runs; consumed by
  // the report walker so it knows where its onArriveCallback should drop.
  let myOfficeNoteDropPos: { x: number; y: number; z: number } | null = null;
  // The growing stack of physical paper reports on the desk — capped FIFO so
  // it never overflows the surface. Rebuilt every time the scene rebuilds.
  let myOfficeNoteStack: NoteStack | null = null;
  // Real meeting rooms (slots 0, 2, 4+ — NOT Central Hall / My Office). Each
  // entry is the full slot {cx, cz, w, d} so we can compute chair seats around
  // the conference table, not just walk everyone to the center.
  let meetingRoomSlots: Array<{ cx: number; cz: number; w: number; d: number }> = [];
  // Wall displays, one per meeting-room slot, indexed the same way.
  let meetingScreens: MeetingScreenHandle[] = [];
  /** meeting_id → the wall display currently showing it. */
  const meetingScreenByMeeting = new Map<string, MeetingScreenHandle>();
  let meetingRoomHitboxes: any[] = [];
  // Map meeting_id → index in meetingRoomCenters so all participants walk to
  // the same room and re-clicking the room reopens that specific meeting.
  let meetingIdToRoom = new Map<string, number>();
  // Set of meeting-room indices currently occupied by an ad-hoc cross-office
  // coordination (NOT a real LLM meeting). Tracked separately so we don't
  // double-book a room that's already hosting a real meeting and vice-versa.
  const activeCoordRooms = new Set<number>();
  // Per-meeting visual decor: a glowing halo above the table + a CSS banner
  // showing topic and current turn. Created on meeting_requested, updated on
  // meeting_turn, disposed on meeting_ended. The banner uses CSS2DObject so
  // it follows the camera the same way nameplates do.
  let meetingDecor = new Map<string, { halo: any; bannerObj: any; bannerEl: HTMLDivElement }>();
  let hallCenterPos: { x: number; z: number } | null = null;
  let receptionFrontPos: { x: number; y: number; z: number } | null = null;
  let receptionDropPos: { x: number; y: number; z: number } | null = null;
  let receptionDriverFrontPos: { x: number; y: number; z: number } | null = null;
  // Street/staircase geometry — exposed so the taxi drop-off knows where the
  // car needs to spawn the agent walker, without re-deriving it from corGrid.
  let taxiContext: {
    entryCX: number; pedOuterZ1: number; streetDrop: number; southLaneZ: number;
    plinthOuterZ1: number; plinthDrop: number;
  } | null = null;
  // Dedupe deliveries: at most one active truck per flow, and throttle re-triggers
  const DELIVERY_COOLDOWN_SEC = 12;
  const lastDeliveryAtByFlow = new Map<string, number>();
  let walkers: Walker[] = [];
  let speechBubbles = new Map<string, SpeechBubble>();
  // Animation registry — hosts camera tweens, halo pulses, trade-celebration
  // particles, speech-bubble fades, and the 10 agent-interaction effects (thought
  // glyphs, tool icons, lesson particles, directive arrows, paper planes, rank
  // pillars…). See office3d/anim/registry.ts for the contract.
  const animRegistry: AnimationRegistry = createAnimationRegistry();

  // Per-agent activity tracking — drives the idle-stretch animation. `markActivity`
  // is called every time we see an event tagged to an agent; if no event lands for
  // IDLE_BEFORE_STRETCH_SEC, the seated worker plays a stretch pose.
  const lastActivitySec = new Map<string, number>();
  const stretchState = new Map<string, { endSec: number; nextEligibleSec: number }>();
  const IDLE_BEFORE_STRETCH_SEC = 60;
  const STRETCH_DURATION_SEC = 4;
  const STRETCH_COOLDOWN_SEC = 45;

  // Per-agent last-known rank level — when it bumps up we fire a "promotion"
  // pillar of light over the desk. The first observation just primes the map.
  const lastRankLevelByAgent = new Map<string, number>();

  // Per-agent last-known `active` flag — drives the commute walker. When the
  // value flips (1→0 pause, 0→1 resume), we spawn a LEAVE or ARRIVE walker.
  // First observation just primes the map (no walker fires on initial load).
  const lastActiveByAgent = new Map<string, number>();

  function markActivity(aid: string): void {
    if (!aid) return;
    lastActivitySec.set(aid, sceneTimeSec);
  }

  // Per-tag rate limiter — fixes the flicker caused by burst events. Without
  // this, 5 thoughts in 2s spawn 5 overlapping glyphs at different opacities
  // and the user sees them strobe on top of each other. Now subsequent fires
  // for the same `${kind}:${aid}` tag are dropped while the previous glyph is
  // still in flight; one clean pop-hold-fade per allotted slot.
  const animLastFireSec = new Map<string, number>();
  function tryFireAnim(tag: string, lifetimeSec: number, fn: () => void): void {
    const last = animLastFireSec.get(tag);
    if (last !== undefined && sceneTimeSec - last < lifetimeSec) return;
    animLastFireSec.set(tag, sceneTimeSec);
    fn();
  }

  // ── Ambient FX population ──────────────────────────────────────────────
  // Thinking used to spawn one floating glyph per agent per event, which is
  // unbounded — hence the old concurrent-FX counter. It no longer is: thinking
  // now lives in the agent's own tag, and an agent has exactly one tag, so a
  // 200-agent stampede costs 200 CSS animations the browser composites for
  // free. What survives here is the frustum cull, which still keeps the
  // per-desk monitor pulse off desks nobody is looking at.
  const _deskViewVec = { x: 0, y: 0, z: 0 };
  /** True if the agent's desk world position is inside the camera frustum.
   *  Mirrors the seated-worker cull (humanoidPool.update → frustum.containsPoint).
   *  Returns true when the frustum isn't ready yet so we never hard-block FX. */
  function deskInView(aid: string): boolean {
    if (!_frustum || !THREE) return true;
    const dg = deskGroups.get(aid);
    const p = dg?.position ?? deskPos.get(aid);
    if (!p) return true;
    _deskViewVec.x = p.x; _deskViewVec.y = (p.y ?? 0) + 1.5; _deskViewVec.z = p.z;
    try {
      return _frustum.containsPoint(new THREE.Vector3(_deskViewVec.x, _deskViewVec.y, _deskViewVec.z));
    } catch {
      return true;
    }
  }

  // ── Onboarding (new-recruit) detection ──────────────────────────────────
  // There is no agent-create event; we diff the `agents` prop. The set is
  // seeded WITHOUT animating after the first populated rebuild (so the initial
  // roster doesn't all onboard at once). `onboardingPrimed` gates the diff.
  let seenAgentIds = new Set<string>();
  let onboardingPrimed = false;

  /** (#F1) The desk half of "this agent is thinking": a brief emissive pulse on
   *  its monitor, so the office itself flickers with activity. The readable
   *  half is `showThinkingTag`, in the agent's own nameplate.
   *
   *  There used to be a spinning ⚙️ floating over the head here too. It was the
   *  loudest thing on screen and, at the distance this camera actually sits, a
   *  rotating glyph reads as a vibrating speck — so it is gone, not restyled.
   *
   *  Gated by the frustum cull + a ~1.5s per-agent debounce. */
  function pulseThinkingMonitor(aid: string): void {
    if (!aid || !scene || !THREE) return;
    if (!deskInView(aid)) return;
    const dg = deskGroups.get(aid);
    if (!dg) return;
    tryFireAnim(`think:${aid}`, 1.5, () => {
      // Monitor-screen pulse — reach the per-desk monitor material tagged by
      // buildDesks (group.userData._monitor). Pulse emissiveIntensity briefly.
      const monMat = dg.userData?._monitor?.material;
      if (monMat && typeof monMat.emissiveIntensity === 'number') {
        const base = monMat.emissiveIntensity;
        animRegistry.add(materialPulse(monMat, {
          property: 'emissiveIntensity',
          min: Math.max(0.05, base * 0.7),
          max: Math.min(1.0, base + 0.5),
          speed: 6,
          durationSec: 1.4,
          tag: `think-mon:${aid}`,
        }));
      }
    });
  }

  /** (#F2) Spawn the error burst over an agent's desk: red rising particles +
   *  a red halo flash. Both effects build ephemeral geometry that they dispose
   *  when finished. Debounced so a repeated failure event doesn't stack bursts. */
  function spawnErrorFx(aid: string): void {
    if (!aid || !scene || !THREE) return;
    const p = deskPos.get(aid) ?? deskGroups.get(aid)?.position;
    if (!p) return;
    tryFireAnim(`error-fx:${aid}`, 2.0, () => {
      const RED = 0xff3030;
      // ── Red rising particles ──
      const group = new THREE.Group();
      group.position.set(p.x, 0.3, p.z);
      const pMat = new THREE.MeshStandardMaterial({
        color: RED, emissive: new THREE.Color(RED), emissiveIntensity: 0.9,
        transparent: true, opacity: 0.9, roughness: 0.25,
      });
      for (let i = 0; i < 14; i++) {
        const sph = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), pMat.clone());
        const ang = (i / 14) * Math.PI * 2;
        const rad = 0.3 + Math.random() * 0.8;
        sph.position.set(Math.cos(ang) * rad, Math.random() * 0.4, Math.sin(ang) * rad);
        group.add(sph);
      }
      scene.add(group);
      animRegistry.add(risingParticles(group, {
        maxAgeSec: 1.6,
        riseSpeed: 1.8,
        tag: `error-rise:${aid}`,
        onDispose: () => {
          if (group.parent) group.parent.remove(group);
          group.traverse((c: any) => { c.geometry?.dispose(); c.material?.dispose(); });
        },
      }));
      // ── Red halo flash on the floor under the desk ──
      const ringMat = new THREE.MeshBasicMaterial({
        color: RED, transparent: true, opacity: 0.6, side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.2, 32), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.x, 0.06, p.z);
      scene.add(ring);
      const haloStart = sceneTimeSec;
      animRegistry.add(haloPulse(ring, {
        tag: `error-halo:${aid}`,
        breathSpeed: 6,
        opacityMin: 0.15,
        opacityMax: 0.7,
        spinSpeed: 1.2,
        // Self-terminate after ~1.6s; haloPulse has no built-in duration.
        while: () => sceneTimeSec - haloStart < 1.6,
      }));
      // haloPulse doesn't own the mesh — dispose the flash geometry ourselves.
      setTimeout(() => {
        if (ring.parent) ring.parent.remove(ring);
        ring.geometry?.dispose();
        ringMat.dispose();
      }, 1800);
    });
  }

  /** (#F3) Fly a glowing data packet from desk A to desk B: a curved arrow +
   *  coin stream along the arc, then a converging ripple + monitor pulse at B.
   *  Self-contained ephemeral effects (curvedArrow/coinTrail/convergingParticles
   *  build & dispose their own geometry). Debounced per source→target pair. */
  function spawnHandoffPacketFx(sid: string, tid: string, colorCss: string): void {
    if (!sid || !tid || !scene || !THREE) return;
    const a = deskPos.get(sid) ?? deskGroups.get(sid)?.position;
    const b = deskPos.get(tid) ?? deskGroups.get(tid)?.position;
    if (!a || !b) return;
    const colorNum = hexToNum(colorCss, 0x5b8def);
    tryFireAnim(`handoff:${sid}->${tid}`, 1.5, () => {
      const from = { x: a.x, y: (a.y ?? 0) + 1.4, z: a.z };
      const to   = { x: b.x, y: (b.y ?? 0) + 1.4, z: b.z };
      animRegistry.add(curvedArrow(scene, {
        from, to, archHeight: 3.5, color: colorNum,
        drawSec: 0.45, holdSec: 0.4, fadeSec: 0.35,
        tag: `handoff-arrow:${sid}->${tid}`,
      }));
      animRegistry.add(coinTrail(scene, {
        from, to, count: 5, color: colorNum, archHeight: 1.4,
        radius: 0.07, tag: `handoff-coins:${sid}->${tid}`,
      }));
      // Arrival ripple at B (after the coin stream lands ~0.9s) + monitor pulse.
      setTimeout(() => {
        if (!scene || !THREE) return;
        animRegistry.add(convergingParticles(scene, {
          target: { x: b.x, y: (b.y ?? 0) + 1.2, z: b.z },
          spawnRadius: 1.0, count: 8, color: colorNum,
          durationSec: 0.9, tag: `handoff-ripple:${tid}`,
        }));
        const monMat = deskGroups.get(tid)?.userData?._monitor?.material;
        if (monMat && typeof monMat.emissiveIntensity === 'number') {
          const base = monMat.emissiveIntensity;
          animRegistry.add(materialPulse(monMat, {
            property: 'emissiveIntensity',
            min: Math.max(0.05, base * 0.7),
            max: Math.min(1.0, base + 0.6),
            speed: 7, durationSec: 1.0,
            tag: `handoff-mon:${tid}`,
          }));
        }
      }, 900);
    });
  }

  /** Diff agents' active flag against the cached map; spawn a LEAVE walker
   *  when 1→0 and an ARRIVE walker when 0→1. The first observation just primes
   *  the cache so existing agents don't all spawn ARRIVE walkers on page load. */
  function detectActiveChanges(): void {
    if (!scene || !receptionFrontPos || !corGrid || roomMap.size === 0) return;
    for (const a of agents) {
      const prev = lastActiveByAgent.get(a.id);
      const now = a.active ?? 0;
      lastActiveByAgent.set(a.id, now);
      if (prev === undefined) continue;       // priming the map, no transition
      if (prev === now) continue;
      if (prev === 1 && now === 0) {
        // LEAVE / reject: agent stands up, walks through the corridors out
        // to reception, down the staircase to the street, and gets into a
        // waiting taxi which then drives off. Symmetric to the ARRIVE flow.
        const agentId = a.id;
        const agentColor = flowColor(agentId);
        if (scene && taxiContext) {
          const stairsTop    = { x: taxiContext.entryCX, y: 0, z: taxiContext.plinthOuterZ1 - 0.3 };
          const stairsBottom = { x: taxiContext.entryCX, y: -taxiContext.streetDrop, z: taxiContext.pedOuterZ1 - 0.3 };
          const carDoor      = { x: taxiContext.entryCX + 0.6, y: -taxiContext.streetDrop, z: taxiContext.southLaneZ - 1.4 };
          // Spawn the walker immediately — it has the longest path. The
          // taxi follows below; with parkedDuration=10s the car waits at
          // the curb until the walker arrives + fades into it.
          sendCommuteWalker({
            scene, walkers, agentId, mode: 'leave',
            exitPoint: receptionFrontPos,
            deskPos, rooms: roomMap, corridorGrid: corGrid,
            agents, color: agentColor,
            deskAabbs, sittingWorkers,
            outdoorWaypoints: [stairsTop, stairsBottom, carDoor],
            meetingRoomObstacles: meetingRoomSlots,
          });
          enqueueTaxi(scene, {
            bodyColor: agentColor,
            parkedDuration: 10,
            // No-op onParked: the walker is already in flight; the taxi
            // just needs to be visually present when the walker arrives.
            onParked: () => { /* noop — pickup taxi waits at curb */ },
          });
        } else {
          // Fallback if street geometry isn't ready yet.
          sendCommuteWalker({
            scene, walkers, agentId, mode: 'leave',
            exitPoint: receptionFrontPos,
            deskPos, rooms: roomMap, corridorGrid: corGrid,
            agents, color: agentColor,
            deskAabbs, sittingWorkers,
            meetingRoomObstacles: meetingRoomSlots,
          });
        }
      } else if (prev === 0 && now === 1) {
        // ARRIVE: a taxi drops the agent at the entrance. The taxi animates
        // in along the south lane; when it parks, the agent walker spawns
        // beside the car at street level, climbs the staircase, enters the
        // building, and walks the existing corridor path to its desk.
        const agentId = a.id;
        const agentColor = flowColor(agentId);
        const dropTaxi = scene && taxiContext;
        if (dropTaxi) {
          enqueueTaxi(scene, {
            bodyColor: agentColor,
            onParked: (dropOff) => {
              if (!scene || !receptionFrontPos || !taxiContext) return;
              const stairsBottom = { x: taxiContext.entryCX, y: -taxiContext.streetDrop, z: taxiContext.pedOuterZ1 - 0.3 };
              const stairsTop    = { x: taxiContext.entryCX, y: 0, z: taxiContext.plinthOuterZ1 - 0.3 };
              sendCommuteWalker({
                scene, walkers, agentId, mode: 'arrive',
                exitPoint: receptionFrontPos,
                deskPos, rooms: roomMap, corridorGrid: corGrid,
                agents, color: agentColor,
                deskAabbs, sittingWorkers,
                outdoorWaypoints: [dropOff, stairsBottom, stairsTop],
                meetingRoomObstacles: meetingRoomSlots,
              });
            },
          });
        } else {
          // Fallback when the street geometry isn't ready yet (very first
          // frame after layout): use the legacy reception fade-in.
          sendCommuteWalker({
            scene, walkers, agentId, mode: 'arrive',
            exitPoint: receptionFrontPos,
            deskPos, rooms: roomMap, corridorGrid: corGrid,
            agents, color: agentColor,
            deskAabbs, sittingWorkers,
            meetingRoomObstacles: meetingRoomSlots,
          });
        }
      }
    }
  }

  /** (#F4) Diff `agents` against `seenAgentIds`. Each genuinely new id gets a
   *  NEW-RECRUIT onboarding sequence: a taxi drops them at the entrance, an
   *  ARRIVE commute walker carries them to their desk, and a "NEW RECRUIT"
   *  chyron pops over the desk. Vanished ids are pruned so a later re-add
   *  re-onboards. Mirrors the ARRIVE path in detectActiveChanges(). */
  function detectOnboarding(): void {
    if (!scene || !THREE || !receptionFrontPos || !corGrid || roomMap.size === 0) return;
    const currentIds = new Set(agents.map(a => a.id));
    // Prune ids that vanished so a re-add re-onboards.
    for (const id of [...seenAgentIds]) {
      if (!currentIds.has(id)) seenAgentIds.delete(id);
    }
    for (const a of agents) {
      if (seenAgentIds.has(a.id)) continue;
      seenAgentIds.add(a.id);
      const agentId = a.id;
      const agentColor = flowColor(agentId);
      const dp = deskPos.get(agentId);

      // Taxi drop-off → ARRIVE commute walker (same shape as the active-flag
      // ARRIVE branch). Falls back to a plain reception commute when street
      // geometry isn't ready.
      const dropTaxi = scene && taxiContext;
      if (dropTaxi) {
        enqueueTaxi(scene, {
          bodyColor: agentColor,
          onParked: (dropOff) => {
            if (!scene || !receptionFrontPos || !taxiContext) return;
            const stairsBottom = { x: taxiContext.entryCX, y: -taxiContext.streetDrop, z: taxiContext.pedOuterZ1 - 0.3 };
            const stairsTop    = { x: taxiContext.entryCX, y: 0, z: taxiContext.plinthOuterZ1 - 0.3 };
            sendCommuteWalker({
              scene, walkers, agentId, mode: 'arrive',
              exitPoint: receptionFrontPos,
              deskPos, rooms: roomMap, corridorGrid: corGrid,
              agents, color: agentColor,
              deskAabbs, sittingWorkers,
              outdoorWaypoints: [dropOff, stairsBottom, stairsTop],
              meetingRoomObstacles: meetingRoomSlots,
            });
          },
        });
      } else {
        sendCommuteWalker({
          scene, walkers, agentId, mode: 'arrive',
          exitPoint: receptionFrontPos,
          deskPos, rooms: roomMap, corridorGrid: corGrid,
          agents, color: agentColor,
          deskAabbs, sittingWorkers,
          meetingRoomObstacles: meetingRoomSlots,
        });
      }

      // "NEW RECRUIT" banner over the desk shortly after the commute begins.
      if (dp) {
        setTimeout(() => {
          if (!scene || !THREE) return;
          animRegistry.add(chyronLabel(scene, {
            position: { x: dp.x, y: (dp.y ?? 0) + 4.0, z: dp.z },
            html: `🎉 <b>NEW RECRUIT</b><br><span style="font-size:10px;opacity:.85">${escapeBannerText((a.name || 'Agent').slice(0, 20))}</span>`,
            color: agentColor,
            durationSec: 3.5,
            tag: `onboard:${agentId}`,
          }));
        }, 800);
      }
    }
    seenAgentIds = seenAgentIds; // trigger Svelte reactivity on the Set mutation
  }

  /** Diff agents' rank_id against the cached map; fire a pillar-of-light over
   *  any desk whose rank LEVEL went up. Runs reactively from a `$:` block. */
  function detectRankPromotions(): void {
    if (!scene || !THREE) return;
    for (const a of agents) {
      if (!a.rank_id) continue;
      const r = ranks.find(rk => rk.id === a.rank_id);
      if (!r) continue;
      const prev = lastRankLevelByAgent.get(a.id);
      lastRankLevelByAgent.set(a.id, r.level);
      if (prev === undefined || r.level <= prev) continue;
      const dp = deskPos.get(a.id);
      if (!dp) continue;
      const colorNum = parseInt((r.color || '#ffd166').replace('#', ''), 16);
      animRegistry.add(pillarOfLight(scene, {
        position: { x: dp.x, y: 0, z: dp.z },
        color: Number.isFinite(colorNum) ? colorNum : 0xffd166,
        height: 9, radius: 0.9,
        durationSec: 3.0,
        tag: `promotion:${a.id}`,
      }));
      const dg = deskGroups.get(a.id);
      if (dg) animRegistry.add(floatingGlyph(dg, {
        glyph: r.insignia || '★',
        color: r.color || '#ffd166',
        fontSize: 32,
        startY: 1.6,
        riseHeight: 4.5,
        durationSec: 3.0,
        offsetXZ: { z: 0.55 },
        tag: `promotion-glyph:${a.id}`,
      }));
    }
  }
  // Reference to the newest already-processed event. Tracking by reference
  // (not by count) is robust against the store's eviction cap — when the
  // ring buffer drops old events, length stays constant but new events
  // still appear at index 0.
  let lastProcessedFlowEvent: AgentFlowEvent | null = null;

  // ── Rank gate for MY OFFICE visits ──
  // Only agents at or above this rank level walk to the top agent's office.
  // Anything below just logs its result in its own room. Change this value
  // to loosen/tighten.
  const MY_OFFICE_MIN_RANK_LEVEL = 10;

  function isSeniorRank(agentId: string): boolean {
    const a = agents.find(x => x.id === agentId);
    if (!a || !a.rank_id) return false;
    const r = ranks.find(x => x.id === a.rank_id);
    return !!r && r.level >= MY_OFFICE_MIN_RANK_LEVEL;
  }
  /** Office leader = the head of any office. Senior ranks AND every flow's
   *  manager qualify — even a mid-rank manager runs the floor of their own
   *  office and is expected to deliver completed reports in person to the
   *  top agent. Workers below the lead never make this trip. */
  function isOfficeLeader(agentId: string): boolean {
    if (isSeniorRank(agentId)) return true;
    const a = agents.find(x => x.id === agentId);
    return !!a && a.role === 'manager';
  }

  // ── My Office report log ──────────────────────
  // Live events append here; MyOfficePanel.svelte renders and trims it.
  let officeReports: OfficeReport[] = [];

  // ── Pending questions from agents (top-agent inbox) ──────────────
  let pendingQuestions: PendingQuestion[] = [];
  async function loadPendingQuestions() {
    try {
      const res = await fetch('/api/agents/questions?status=pending&limit=50');
      if (!res.ok) return;
      const data = await res.json();
      pendingQuestions = (data.questions ?? []) as PendingQuestion[];
    } catch { /* best effort */ }
  }
  let showMyOfficePanel = false;
  let myOfficeTab: 'overview' | 'questions' | 'errors' = 'overview';
  let officeReportsLoaded = false;

  // "Send to fixer" lives in MyOfficePanel.svelte with the report modal. Its
  // toast stays here (see markup) so it survives that modal closing on
  // dispatch; the panel writes the status back through bind:.
  let fixerStatus = '';

  // ── Live meeting transcripts + management log ──────────
  // Shapes in world-types.ts. The transcript renders in MeetingPanels.svelte;
  // the management log in the shell's ActivityPanel (the `mgmtlog` event).
  let mgmtLog: MgmtEntry[] = [];
  // ── Visualization toggles ───────────────────────
  // The command bar's View menu drives these through the imperative API;
  // meeting history and the management log live in the shell's ActivityPanel.
  let showPerfHud = false;

  // Dismiss a single meeting from the history panel — archives it on the
  // server (so a refresh doesn't bring it back) and removes it from the
  // local store. Active meetings (requested/started) are kept; only the
  // X button on completed/failed rows triggers this.
  export async function dismissMeeting(meetingId: string): Promise<void> {
    if (!meetingId) return;
    try {
      await fetch(`/api/agents/conversations/${encodeURIComponent(meetingId)}/archive`, { method: 'POST' });
    } catch { /* network error — still drop it from the local view */ }
    const next: Record<string, LiveMeeting> = { ...liveMeetings };
    delete next[meetingId];
    liveMeetings = next;
    if (activeMeetingId === meetingId) {
      activeMeetingId = null;
      showLiveMeeting = false;
    }
  }

  // Bulk-dismiss every completed/failed meeting in one shot.
  export async function dismissAllReadMeetings(): Promise<void> {
    try {
      await fetch('/api/agents/conversations/archive-all-closed?kind=meeting', { method: 'POST' });
    } catch { /* network error — fall through to local cleanup */ }
    const next: Record<string, LiveMeeting> = {};
    let droppedActive = false;
    for (const [id, m] of Object.entries(liveMeetings)) {
      if (m.status === 'completed' || m.status === 'failed') {
        if (id === activeMeetingId) droppedActive = true;
        continue;
      }
      next[id] = m;
    }
    liveMeetings = next;
    if (droppedActive) {
      activeMeetingId = null;
      showLiveMeeting = false;
    }
  }
  function pushMgmtLog(entry: MgmtEntry): void {
    mgmtLog = [entry, ...mgmtLog].slice(0, 40);
    // The shell's ActivityPanel renders the log (the `mgmtlog` event) — we
    // do NOT auto-open anything here, otherwise the user's "off" choice gets
    // overridden whenever a new manager event arrives.
  }

  let liveMeetings: Record<string, LiveMeeting> = {};
  let activeMeetingId: string | null = null; // which one the modal currently shows
  let showLiveMeeting = false;
  // Defer expensive transcript rendering until the user clicks "Mostrar
  // turnos". Opening the panel itself must be cheap — we suspect the 10×
  // turn render block was what froze the browser. The header alone is light.
  // The transcript body is shown by default — the user asked for the
  // conversation to be visible without an extra click. The "Mostrar X turns"
  // gate stays as a manual open path for when the user closes it.
  let showTranscriptBody = true;
  $: liveMeetingsList = Object.values(liveMeetings).sort((a, b) => b.started_at - a.started_at);
  $: hasActiveMeeting = liveMeetingsList.some(m => m.status === 'requested' || m.status === 'started');
  $: anyMeetingPresent = liveMeetingsList.length > 0;
  // Run IDs that the Error Auditor has already triaged — used to show a badge
  // on failed reports so we know the audit loop closed. Populated live from
  // Error Auditor run_started events (it's the one agent that quotes the
  // original failing run_id in its goal text).
  let auditedRunIds: Set<string> = new Set();

  function addOfficeReport(agentId: string, text: string, status: string = 'completed', runId?: string) {
    const agent = agents.find(a => a.id === agentId);
    const name = agent?.name ?? 'Agent';
    const color = flowColor(agentId);
    officeReports = [{ agentName: name, agentId, text, color, ts: Date.now(), status, runId }, ...officeReports].slice(0, 100);
  }

  /** Load recent completed runs from ALL agents on first open — fills the report backlog. */
  async function loadOfficeReportsFromApi() {
    if (officeReportsLoaded) return;
    officeReportsLoaded = true;
    try {
      const historical: OfficeReport[] = [];
      // Fetch last 5 runs per MANAGER (completed + failed) and last 3 FAILURES
      // per WORKER. Workers' successful runs stay in their office; only
      // failures bubble up to My Office.
      const managers = agents.filter(a => a.role === 'manager');
      const workers = agents.filter(a => a.role !== 'manager');
      const fetches = [
        ...managers.map(async (a) => {
          try {
            const res = await fetch(`/api/agents/${a.id}/runs?limit=5`);
            const data: any = await res.json();
            const runs: any[] = data?.runs ?? [];
            for (const r of runs) {
              if (r.status !== 'completed' && r.status !== 'failed') continue;
              const text = String(r.result ?? r.error ?? '') || r.status;
              historical.push({
                agentName: a.name, agentId: a.id, text,
                color: flowColor(a.id),
                ts: new Date(r.created_at).getTime(),
                status: r.status, runId: r.id,
              });
            }
          } catch { /* skip agent */ }
        }),
        ...workers.map(async (a) => {
          try {
            const res = await fetch(`/api/agents/${a.id}/runs?limit=10`);
            const data: any = await res.json();
            const runs: any[] = (data?.runs ?? []).filter((r: any) => r.status === 'failed').slice(0, 3);
            for (const r of runs) {
              const text = String(r.error ?? r.result ?? '') || 'Failed';
              historical.push({
                agentName: a.name, agentId: a.id, text,
                color: flowColor(a.id),
                ts: new Date(r.created_at).getTime(),
                status: 'failed', runId: r.id,
              });
            }
          } catch { /* skip agent */ }
        }),
      ];
      await Promise.all(fetches);
      // Merge: keep live reports on top, add historical below (deduped by timestamp proximity)
      const liveTs = new Set(officeReports.map(r => r.ts));
      const deduped = historical.filter(h => !liveTs.has(h.ts));
      const merged = [...officeReports, ...deduped].sort((a, b) => b.ts - a.ts).slice(0, 100);
      officeReports = merged;

      // Backfill audited run IDs by fetching the Error Auditor's recent runs
      // and parsing each run's goal for the original `Run ID: <id>` marker.
      // This makes the "✓ audited" badge survive across reloads.
      const auditor = agents.find(a => a.name === 'Error Auditor');
      if (auditor) {
        try {
          const res = await fetch(`/api/agents/${auditor.id}/runs?limit=50`);
          const data: any = await res.json();
          const next = new Set(auditedRunIds);
          for (const r of (data?.runs ?? [])) {
            const m = String(r.goal ?? '').match(/Run ID:\s*([A-Za-z0-9-]+)/);
            if (m && m[1]) next.add(m[1]);
          }
          auditedRunIds = next;
        } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
  }

  function flowColor(aid: string) { return resolveFlowColor(aid, agents, flows); }

  // ── Delivery glue ─────────────────────────────────────────────
  // Patterns that mark a flow as "inbound" — external transports whose agents
  // would realistically receive physical-package-style deliveries.
  const INBOUND_FLOW_PATTERNS = /gmail|mail|imap|smtp|calendar|drive|rss|webhook|slack|telegram|whatsapp|discord|sync|inbox/i;
  function isInboundFlow(f: { name: string }): boolean {
    return INBOUND_FLOW_PATTERNS.test(f.name);
  }
  function pickAgentIdForFlow(flowId: string): string | null {
    // Prefer the first active agent in the flow; fall back to any agent
    const inFlow = agents.filter(a => a.flow_id === flowId);
    if (inFlow.length === 0) return null;
    const act = inFlow.find(a => a.active);
    return (act ?? inFlow[0]).id;
  }

  function installDeliveryContext() {
    if (!scene || !THREE || !hallCenterPos || !receptionFrontPos || !receptionDropPos || !receptionDriverFrontPos) return;
    // Match the constants used in office.ts/buildStreets (keep in sync)
    const PLINTH_DROP = 0.7;
    const STREET_DROP = 0.9; // PLINTH_DROP + CURB_H (0.2)
    const PLINTH_W = 5, PED_W = 5.5, STREET_W = 12;
    const { maxZ } = corGrid.buildingBounds;
    const plinthOuterZ1 = maxZ + PLINTH_W;
    const pedOuterZ1 = plinthOuterZ1 + PED_W;
    const streetOuterZ1 = pedOuterZ1 + STREET_W;
    const southLaneZ = (pedOuterZ1 + streetOuterZ1) / 2;
    // Taxi shares the same street geometry as the delivery truck so the two
    // can coexist on the same lane without re-deriving the math.
    taxiContext = {
      entryCX: hallCenterPos.x,
      pedOuterZ1,
      streetDrop: STREET_DROP,
      southLaneZ,
      plinthOuterZ1,
      plinthDrop: PLINTH_DROP,
    };
    initTaxiScene({
      entryCX: hallCenterPos.x,
      pedOuterZ1,
      streetDrop: STREET_DROP,
      southLaneZ,
    });
    initDeliveryScene(scene, {
      entryCX: hallCenterPos.x,
      plinthOuterZ1,
      pedOuterZ1,
      southLaneZ,
      plinthDrop: PLINTH_DROP,
      streetDrop: STREET_DROP,
      receptionDrop: receptionDropPos,
      receptionFront: receptionFrontPos,
      receptionDriverFront: receptionDriverFrontPos,
      sendRecipientWalker: (info: DeliveryInfo) => {
        if (!receptionFrontPos) return;
        const srcId = pickAgentIdForFlow(info.flowId);
        if (!srcId) { markPackagePickedUp(info.flowId); return; }
        // Pickup tag is fired via showAnimatedTag below — no in-walker bubble.
        sendWalkerToPoint(
          scene, walkers, srcId, receptionFrontPos,
          deskPos, roomMap, corGrid, agents,
          info.flowColor, undefined,
          deskAabbs, `delivery_pickup_${info.flowId}`,
          sittingWorkers, true,
        );
        showAnimatedTag(srcId, { icon: '📦', anim: 'bounce', label: info.label, durationFrames: 250 });
      },
    });
  }

  /** Trigger a truck delivery when a real external-message run fires on an
   *  inbound flow. Throttled per flow so a burst of runs doesn't spam trucks. */
  function triggerDeliveryForAgent(agentId: string, nowSec: number) {
    const a = agents.find(x => x.id === agentId);
    if (!a) return;
    const f = flows.find(x => x.id === a.flow_id);
    if (!f || !isInboundFlow(f)) return;
    const last = lastDeliveryAtByFlow.get(f.id) ?? -Infinity;
    if (nowSec - last < DELIVERY_COOLDOWN_SEC) return;
    lastDeliveryAtByFlow.set(f.id, nowSec);
    enqueueDelivery({
      flowId: f.id,
      flowColor: f.color || '#c9a84c',
      label: f.name.split(/\s+/)[0].slice(0, 10),
    });
  }

  /** Force a delivery for the given flow (or auto-pick any inbound flow, or
   *  any flow as fallback). Bypasses the cooldown — use for demos or tests. */
  function runDeliveryDemo(flowId?: string): string | null {
    let f = flowId ? flows.find(x => x.id === flowId) : undefined;
    if (!f) f = flows.find(x => x.active && isInboundFlow(x) && pickAgentIdForFlow(x.id));
    if (!f) f = flows.find(x => pickAgentIdForFlow(x.id));
    if (!f) return null;
    enqueueDelivery({
      flowId: f.id,
      flowColor: f.color || '#c9a84c',
      label: f.name.split(/\s+/)[0].slice(0, 10) || 'DEMO',
    });
    return f.id;
  }

  /** Themed decor passes — run after buildRooms so per-flow props sit inside
   *  their already-built 4-wall shell. Currently: Communications. */
  // ── Red Alert decor — sandbags + crates ────────────────────
  // The radar dish was removed by user request (was a decorative system-
  // activity indicator; replaced by clearer signals elsewhere).
  function buildRedAlertDecor(target: any, entranceHint: { cx: number; width: number } | undefined): void {
    if (!corGrid?.buildingBounds) return;
    const bb = corGrid.buildingBounds;

    // Sandbag barrier flanking the main entrance — two short rows leaving a
    // gap for the door. `entranceHint.cx` is the center of the main entrance;
    // we put bags on the plinth just outside the south wall.
    if (entranceHint) {
      const entryCX = entranceHint.cx;
      const plinthZ = bb.maxZ + 1.4;
      const halfDoorGap = Math.max(1.4, entranceHint.width * 0.25);
      const wingLength = 3.0;
      // Left wing
      buildSandbagBarrier(target,
        { x: entryCX - halfDoorGap - wingLength, z: plinthZ },
        { x: entryCX - halfDoorGap,              z: plinthZ },
      );
      // Right wing
      buildSandbagBarrier(target,
        { x: entryCX + halfDoorGap,              z: plinthZ },
        { x: entryCX + halfDoorGap + wingLength, z: plinthZ },
      );
    }

    // Crates scattered along the sidewalk corners. Random-ish rotations so
    // the cluster doesn't look like a Costco pallet.
    const crateZ = bb.maxZ + 3.2;
    const crates = [
      { x: bb.minX - 1.5, z: crateZ,        rotY: 0.4 },
      { x: bb.minX - 2.4, z: crateZ + 0.8,  rotY: -0.2, tilt: 0.06 },
      { x: bb.maxX + 1.5, z: crateZ,        rotY: -0.5 },
      { x: bb.maxX + 2.6, z: crateZ + 0.8,  rotY: 0.2 },
      { x: bb.minX - 2.0, z: bb.minZ - 1.5, rotY: 1.1 },
      { x: bb.maxX + 2.0, z: bb.minZ - 1.5, rotY: -0.9 },
    ];
    buildCrates(target, crates);
  }

  // Repos registry — populates rack name tags + wall directory in the
  // datacenter-themed Repos Office. Fetched lazily on mount and on every
  // scene rebuild; the API is cheap (one SQL SELECT). Empty array is fine —
  // racks render as "FREE" slots and the directory panel says "(empty registry)".
  let reposBookmarks: Array<{ id: string; name: string; path?: string; default_branch?: string; language?: string; tags?: string }> = [];
  async function fetchReposBookmarks(): Promise<void> {
    try {
      const r = await fetch('/api/dashboard/repos');
      if (!r.ok) return;
      const j = await r.json();
      const list = Array.isArray(j?.recent) ? j.recent : (Array.isArray(j) ? j : []);
      reposBookmarks = list.map((row: any) => ({
        id: String(row.id ?? ''),
        name: String(row.name ?? ''),
        path: row.path ? String(row.path) : '',
        default_branch: row.default_branch ? String(row.default_branch) : '',
        language: row.language ? String(row.language) : '',
        tags: row.tags ? String(row.tags) : '',
      })).filter((r: any) => r.name);
    } catch { /* offline / not registered — leave empty */ }
  }

  /** Pull every office's cached infra state (no docker inspect) so the badges
   *  + power console show the real power state from the first paint. */
  async function fetchInfraStates(): Promise<void> {
    try {
      const r = await fetch('/api/office-env/list');
      if (!r.ok) return;
      const j = await r.json();
      const offices = Array.isArray(j?.offices) ? j.offices : [];
      for (const o of offices) {
        const fid = String(o.flow_id ?? '');
        if (!fid) continue;
        // Prefer the observed docker status; fall back to the desired state.
        const raw = String(o.last_status || o.desired_state || 'absent');
        const st: InfraState =
          raw === 'running' ? 'running'
          : raw === 'paused' ? 'paused'
          : raw === 'error' ? 'error'
          : (raw === 'exited' || raw === 'stopped' || raw === 'created') ? 'stopped'
          : 'absent';
        applyInfraState(fid, st);
      }
    } catch { /* office-infra module absent — leave badges hidden */ }
  }

  // Hitboxes over FREE racks in the Repos Office — populated on every scene
  // rebuild and fed into the raycaster so click → open the register modal.
  let freeRepoRackHitboxes: any[] = [];
  // Hitbox over the DevOps workstation (desk + monitor) in the Repos/DevOps
  // office — click navigates to the DevOps control panel (/devops).
  let devopsTerminalHitbox: any = null;

  // The register-repo modal owns its own state, form, focus trap and
  // styles. The world keeps only the handle, so a click on a FREE rack
  // can open it.
  let registerRepoModal: RegisterRepoModal | null = null;

  function buildThemedOffices(target: any) {
    freeRepoRackHitboxes = [];
    devopsTerminalHitbox = null;
    reposOperatorPos = null;
    infraConsoleHitbox = null;
    resetInfraConsole();
    // Every flow office that can carry infrastructure (a Docker container).
    const infraOffices = [...roomMap.keys()]
      .map(fid => ({ flowId: fid, name: flows.find(f => f.id === fid)?.name || '?', color: flows.find(f => f.id === fid)?.color || '#4a4f6a' }));
    for (const [flowId, room] of roomMap) {
      const flow = flows.find(f => f.id === flowId);
      const theme = traitsOf(flow).theme;
      if (theme === 'communications') {
        buildCommunicationsOffice(target, room);
      } else if (theme === 'data-center') {
        // Vintage data center theme — server racks, CRT terminals, tape reels,
        // mainframe console + UPS + patch panel + KVM + ops chair + printout
        // stack + DIRECTORY wall panel. Racks light up per registered repo.
        // See office.ts:buildDataCenterOffice.
        const handles = buildDataCenterOffice(target, room, reposBookmarks);
        if (handles?.freeRackHitboxes?.length) freeRepoRackHitboxes.push(...handles.freeRackHitboxes);
        if (handles?.devopsTerminalHitbox) devopsTerminalHitbox = handles.devopsTerminalHitbox;
        // Master POWER console — where managers come to switch their office's
        // infrastructure on/off. Holds a breaker LED per office + a clickable
        // hitbox that toggles the full power-grid board.
        const pc = buildPowerConsole(target, room, infraOffices);
        if (pc) { reposOperatorPos = pc.operatorPos; infraConsoleHitbox = pc.hitbox; }
      }
    }
    // Paint whatever infra state we already know onto the fresh console. The
    // 3D breaker LEDs update synchronously; the door-sign CSS2D elements only
    // attach to the DOM on the first render, so defer that repaint a beat.
    for (const [fid, st] of infraState) setInfraBreaker(fid, st);
    setTimeout(() => updateInfraSignsAll(), 150);
  }

  /** Build special rooms in fixed order from layout:
   *  [0]=Meeting A, [1]=Central Hall, [2]=Meeting B, [3]=My Office, [4+]=extra meeting rooms */
  function buildSpecialRooms(target: any) {
    if (meetingRooms.length === 0) { myOfficePos = null; myOfficeHitbox = null; return; }

    // Fixed slot assignments matching SPECIAL_CELLS order in layout.ts
    const hallSlot = meetingRooms[1] ?? meetingRooms[0]; // Central Hall = index 1
    const officeSlot = meetingRooms[3] ?? meetingRooms[0]; // My Office = index 3
    const hallCenter = { x: hallSlot.cx, z: hallSlot.cz };
    hallCenterPos = hallCenter;

    // Build the unified hall — Central Hall + extensions + entrance strip
    const southEndZ = corGrid.buildingBounds.maxZ + 4 - 0.2; // WALK_W=4, keep clear of the glass wall
    buildCentralHall(target, hallSlot, hallExtensions, southEndZ);

    // Reception takes the former Central Hall slot. The entire marble lobby
    // from the entrance doors up to here reads as one grand reception.
    const receptionCX = hallSlot.cx;
    const anchors = buildReception(target, receptionCX, hallSlot.cz);
    receptionFrontPos = anchors.frontPos;
    receptionDropPos = anchors.dropPos;
    receptionDriverFrontPos = anchors.driverFrontPos;

    // Build My Office. The door sign uses the TOP RANK name uppercased,
    // so renaming the rank in the Ranks
    // UI re-labels the door without any code change.
    const doorLabel = (highestRank()?.name ?? 'MY OFFICE').toUpperCase();
    const myOfficeResult = buildMyOffice(target, officeSlot, doorLabel);
    myOfficePos = myOfficeResult.visitorPos;
    myOfficeHitbox = myOfficeResult.hitbox;
    myOfficeNoteDropPos = myOfficeResult.noteDropPos;
    myOfficeSeats = myOfficeResult.visitorChairs;
    myOfficeDeskFacing = myOfficeResult.deskFacingPos;
    // Seat the top agent at the executive desk. The seeder
    // guarantees one agent with rank.level === 11; if multiple are
    // present we honor the first one and ignore the rest (seeder also
    // enforces a single row, this is defensive).
    placeTopAgent(target, myOfficeResult.seatPos, myOfficeResult.headPos, myOfficeResult.seatFacingY);
    // Wire up the desk paper-stack. Notes parent to `target` (= scene) and
    // their fall animation lives on the shared anim registry. The stack is
    // recreated on every scene rebuild — clear() drops the old meshes first.
    if (myOfficeNoteStack) myOfficeNoteStack.clear();
    myOfficeNoteStack = createNoteStack({
      basePos: myOfficeNoteDropPos,
      scene: target,
      registry: animRegistry,
      maxNotes: 8,
    });

    // Build Meeting Rooms (indices 0, 2, and 4+)
    const meetingSlots = meetingRooms.filter((_, i) => i !== 1 && i !== 3);
    meetingScreens = meetingSlots.length > 0
      ? (buildMeetingRooms(target, meetingSlots, hallCenter) ?? [])
      : [];

    // Expose meeting-room slots so walkers can actually go there. Each slot
    // becomes the walk target for one autonomous agent meeting (round-robin
    // by meeting_id). Fallback below uses My Office if no meeting rooms exist.
    meetingRoomSlots = meetingSlots;
    // Build clickable hitboxes over each meeting room (raycaster targets) so
    // clicking a meeting room in the 3D opens that meeting's live transcript.
    meetingRoomHitboxes = [];
    for (let i = 0; i < meetingSlots.length; i++) {
      const s = meetingSlots[i];
      const hb = new THREE.Mesh(
        new THREE.BoxGeometry(s.w * 0.8, 3, s.d * 0.8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hb.position.set(s.cx, 1.5, s.cz);
      hb.userData.isMeetingRoom = true;
      hb.userData.meetingRoomIndex = i;
      target.add(hb);
      meetingRoomHitboxes.push(hb);
    }
  }

  /** Resolve the top rank — the one with the highest level. Ties
   *  resolved by name to stay deterministic across reloads. Returns null
   *  when the ranks list is empty (first boot before ranks-seeder runs). */
  function highestRank(): { id: string; name: string; level: number; color: string; insignia: string } | null {
    if (ranks.length === 0) return null;
    let best = ranks[0];
    for (const r of ranks) {
      if (r.level > best.level || (r.level === best.level && r.name < best.name)) best = r;
    }
    return best;
  }

  /** Resolve the current top agent (the one wearing the top rank).
   *  Returns null when nothing has been seeded yet. Tracks live agent
   *  renames so any UI that calls this gets the up-to-date display name. */
  function topAgent(): { id: string; name: string } | null {
    const rk = highestRank();
    if (!rk) return null;
    const a = agents.find(a => a.rank_id === rk.id);
    return a ? { id: a.id, name: a.name } : null;
  }

  /** Place the top agent (whoever holds the highest rank level)
   *  inside My Office.
   *  Builds a seated humanoid at the executive chair, a permanent gold halo
   *  on the floor under him, a CSS2D nameplate with COMANDANTE tag, and an
   *  invisible hitbox the raycaster routes to "open chat with him". All
   *  artifacts are tracked in module-level state so disposeTopAgent() can
   *  tear them down on scene rebuild. */
  function placeTopAgent(
    target: any,
    seatPos: { x: number; y: number; z: number },
    headPos: { x: number; y: number; z: number },
    facingY: number,
  ): void {
    disposeTopAgent();
    // The top agent = whoever holds the highest-level rank. Whatever name
    // the user gave that rank (or the agent) is what we render — never a
    // hardcoded name.
    const topRank = highestRank();
    const holder = topRank ? agents.find(a => a.rank_id === topRank.id) : undefined;
    if (!holder) return;
    topAgentId = holder.id;
    topAgentSeatPos = seatPos;

    // Seated humanoid — we use the default skin's createHumanoid (not the
    // shared InstancedMesh pool) so this one figure can carry per-instance
    // gold trim without forcing a pool-level change.
    const skin = resolveSkin((holder as { skin_id?: string }).skin_id);
    const palette = skin.pickPalette(holder.id);
    const human = skin.createHumanoid({
      flowColor: topRank?.color ?? '#7c3aed',
      palette,
      scale: 1.05, // slightly bigger than rank-and-file
      walker: false,
    });
    const group = new THREE.Group();
    group.position.set(seatPos.x, 0, seatPos.z);
    group.add(human.group);
    human.group.rotation.y = facingY;
    // Seated pose offsets (same numbers used for regular seated workers).
    human.leftLeg.rotation.x  = -1.5;
    human.rightLeg.rotation.x = -1.5;
    human.leftArm.rotation.x  = -0.8;
    human.rightArm.rotation.x = -0.8;
    // Hitbox around the seated top agent — small box just over the torso so
    // clicks route to him, not to the broader My Office room hitbox.
    const hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 1.6, 1.0),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    hitbox.position.set(0, 0.9, 0);
    hitbox.userData.isTopAgent = true;
    hitbox.userData.agentId = holder.id;
    hitbox.renderOrder = -1;
    group.add(hitbox);
    target.add(group);
    topAgentGroup = group;
    topAgentHitbox = hitbox;

    // Gold halo — a flat ring on the floor under the chair. Pulses live on
    // the anim registry via materialPulse so it breathes without us writing
    // a per-frame ticker.
    const haloGeo = new THREE.RingGeometry(0.8, 1.05, 32);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xc9a84c,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.rotation.x = -Math.PI / 2;
    halo.position.set(seatPos.x, 0.03, seatPos.z);
    target.add(halo);
    topAgentHaloMesh = halo;
    animRegistry.add(materialPulse(haloMat, {
      property: 'opacity',
      min: 0.35,
      max: 0.75,
      speed: 2,
      tag: 'top-agent-halo',
    }));
    // A fresh halo defaults to gold; re-apply the red alert hue immediately if
    // he already has unanswered messages (rebuildScene wipes the old mesh).
    paintTopAgentAlert(pendingQuestions.length > 0);

    // Nameplate — the SAME chip every other agent gets, from the shared
    // builder, and registered in `deskLabels` like the rest.
    //
    // It used to be a bespoke gold plaque built inline here and anchored to
    // this office forever. Two consequences, both of which read as bugs: the
    // top agent's label was a different size and style from everyone else's,
    // and because it never entered `deskLabels` it did not follow him. Walking
    // into a meeting, the highest-ranked agent in the building arrived as the
    // one unlabelled figure at the table. The office keeps its own door sign,
    // so nothing is lost by making the person's tag look like a person's tag.
    const div = buildNameplate({
      agentId: holder.id,
      name: holder.name,
      color: topRank?.color ?? '#c9a84c',
      active: holder.active === 1,
      rank: topRank
        ? { name: topRank.name, color: topRank.color, insignia: topRank.insignia, level: topRank.level }
        : undefined,
      powerChip: false,
    });
    const label = new CSS2DObject(div);
    label.position.set(headPos.x, headPos.y + 0.5, headPos.z);
    target.add(label);
    deskLabels.set(holder.id, label);
    topAgentLabel = label;

    // Anchor the top agent's deskPos so walkers (reports, chains, etc.) can
    // path to him. Without this entry, sendWalker(...) would log "no source/
    // target position" and silently drop the visit.
    deskPos.set(holder.id, seatPos);
    // Stash the HumanoidParts struct so ensureTopAgentWiring() can re-use
    // the SAME struct after a desk rebuild wipes sittingWorkers — passing a
    // bare THREE.Group there would crash animateSitting (no .leftArm/.head).
    topAgentHumanParts = human;
    // Register a sittingWorker entry so the existing arrive-and-sit logic
    // treats him as a regular seated agent. Hidden setter is a no-op — he's
    // permanently visible.
    sittingWorkers.set(holder.id, {
      group: human,
      phase: 0,
      pooled: false,
      setVisible: (v: boolean) => { human.group.visible = v; },
    });

    // Invalidate the raycaster cache so the next mousemove picks up his
    // hitbox without waiting for an unrelated topology change.
    rayTargetsCache = null;
  }

  /** Re-inject the top agent's deskPos + sittingWorkers entries after every
   *  desk rebuild. The visual mesh lives in staticGroup (only rebuilt on
   *  layout changes) but the deskPos map is reconstructed by computeFloorPlan
   *  on every reactive pass, and sittingWorkers.clear() runs inside the
   *  always-run desk-refresh step. Without this re-wiring, walkers would
   *  treat the top agent as if they didn't have a desk anymore. */
  function ensureTopAgentWiring(): void {
    if (!topAgentId || !topAgentSeatPos) return;
    if (!deskPos.has(topAgentId)) deskPos.set(topAgentId, topAgentSeatPos);
    // …and his nameplate. buildDesks rebuilds `deskLabels` from the grid
    // agents only, so every desk rebuild dropped the top agent's entry and
    // his chip stopped following him — he went back to being the one
    // unlabelled figure at the meeting table. The CSS2DObject itself survives
    // (it isn't tagged isNameplate, so the purge leaves it), only the map
    // entry is lost, so re-registering is enough.
    if (topAgentLabel && !deskLabels.has(topAgentId)) deskLabels.set(topAgentId, topAgentLabel);
    if (!sittingWorkers.has(topAgentId) && topAgentHumanParts) {
      // Re-inject the SAME HumanoidParts struct that placeTopAgent built —
      // animateSitting reads .leftArm/.rightArm/.head off it. A bare
      // THREE.Group (topAgentGroup.children[0]) would not have those fields
      // and the next frame would throw "Cannot read properties of undefined
      // (reading 'rotation')".
      const human = topAgentHumanParts;
      sittingWorkers.set(topAgentId, {
        group: human,
        phase: 0,
        pooled: false,
        setVisible: (v: boolean) => { human.group.visible = v; },
      });
    }
  }

  function disposeTopAgent(): void {
    if (topAgentGroup) {
      topAgentGroup.traverse((c: any) => {
        c.geometry?.dispose();
        if (c.material) {
          if (Array.isArray(c.material)) c.material.forEach((m: any) => m.dispose());
          else c.material.dispose();
        }
      });
      if (topAgentGroup.parent) topAgentGroup.parent.remove(topAgentGroup);
      topAgentGroup = null;
    }
    if (topAgentHaloMesh) {
      animRegistry?.cancelByTag('top-agent-halo');
      topAgentHaloMesh.geometry?.dispose();
      topAgentHaloMesh.material?.dispose();
      if (topAgentHaloMesh.parent) topAgentHaloMesh.parent.remove(topAgentHaloMesh);
      topAgentHaloMesh = null;
    }
    if (topAgentLabel?.parent) topAgentLabel.parent.remove(topAgentLabel);
    topAgentLabel?.element?.remove();  // drop the CSS2D DOM node (else it stacks on rebuild)
    topAgentLabel = null;
    topAgentHitbox = null;
    if (topAgentId) {
      sittingWorkers.delete(topAgentId);
      // Keep deskPos around — buildDesks doesn't touch the top agent (they were
      // filtered out at the floor-plan step), so leaving his entry doesn't
      // cause a duplicate render. It lets walkers still target him on
      // subsequent scene rebuilds.
    }
    topAgentId = null;
    topAgentSeatPos = null;
    topAgentHumanParts = null;
  }

  // ── Speech Bubbles ─────────────────────────────
  // ── One tag per agent ─────────────────────────────────────────────
  //
  // Event tags used to be their own CSS2DObject parented to the agent's desk
  // group, which meant every agent doing anything carried TWO floating things:
  // the nameplate chip and a second badge under it. They also needed a
  // reparenting pass every frame to follow a walking agent, and they scaled
  // independently of the chip.
  //
  // Now the tag is a span INSIDE the chip. It follows, scales and hides with
  // the nameplate for free, and an agent never shows more than one label.
  function mountAgentStatus(aid: string, el: HTMLElement, dur: number): void {
    const old = speechBubbles.get(aid);
    if (old) {
      if (old.label?.parent) old.label.parent.remove(old.label);
      old.div.remove();
      animRegistry.cancelByTag(`bubble:${aid}`);
      speechBubbles.delete(aid);
    }
    const inner = deskLabels.get(aid)?.element?.firstElementChild as HTMLElement | null;
    if (!inner) return;
    inner.appendChild(el);
    speechBubbles.set(aid, { div: el, label: null, age: 0, maxAge: dur });
    animRegistry.add(bubbleFade(el, {
      maxAgeFrames: dur,
      tag: `bubble:${aid}`,
      onExpire: () => {
        el.remove();
        if (speechBubbles.get(aid)?.div === el) speechBubbles.delete(aid);
      },
    }));
  }

  /** Shared shell for the in-chip tag: a hairline separator then the content. */
  function statusSpan(accent: string): HTMLSpanElement {
    const sp = document.createElement('span');
    sp.style.cssText =
      `display:inline-flex;align-items:center;gap:4px;flex:none;` +
      `margin-left:5px;padding-left:6px;border-left:1px solid ${accent}55;`;
    return sp;
  }

  function showBubble(aid: string, text: string, dur = 200) {
    const sp = statusSpan('#f0f0e8');
    const t = document.createElement('span');
    t.textContent = text;
    t.style.cssText = "max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dfe4ef";
    sp.appendChild(t);
    mountAgentStatus(aid, sp, dur);
  }

  // ── Animated agent-event tag ────────────────────
  // The unified event indicator: a single CSS2D card whose icon animates via
  // CSS keyframes (pulse / spin / shake / wobble / bounce / sparkle / pop).
  // Replaces both the old text-only `showBubble` AND the separate floating
  // glyphs for step/run/edit events — one self-contained visual per event,
  // readable from any camera distance, no per-frame JS work on the icon.
  function showAnimatedTag(aid: string, opts: {
    icon: string;
    anim?: AnimatedTagAnim;
    color?: string;            // accent for the separator + icon
    label?: string;            // optional small caption next to the icon
    durationFrames?: number;   // lifetime (drives bubbleFade)
  }): void {
    if (!aid) return;
    const color = opts.color ?? flowColor(aid);
    const sp = statusSpan(color);
    sp.className = `atag atag-anim-${opts.anim ?? 'pulse'}`;
    const ico = document.createElement('span');
    // The keyframes hang off `.atag-anim-<x> .atag-icon`. Without this class
    // every tag rendered as a static glyph — the animations below were dead
    // code, which is why the floating gear was the only motion on screen.
    ico.className = 'atag-icon';
    ico.textContent = opts.icon;
    ico.style.cssText = `font-size:11px;line-height:1;color:${color}`;
    sp.appendChild(ico);
    if (opts.label) {
      const lb = document.createElement('span');
      lb.textContent = opts.label;
      lb.style.cssText =
        `font:700 8px/1 'Fira Code',monospace;letter-spacing:1px;` +
        `text-transform:uppercase;color:${color};opacity:.95`;
      sp.appendChild(lb);
    }
    mountAgentStatus(aid, sp, opts.durationFrames ?? 200);
  }

  /** The "thinking" tag: three dots breathing in sequence inside the agent's
   *  own nameplate, in its flow colour.
   *
   *  Dots rather than a glyph on purpose. This chip is ~11px at a camera that
   *  usually sits well back, so anything with internal detail (a gear, a 💭)
   *  turns to mush; three moving dots survive the distance because the motion
   *  IS the shape. They also read as "working, not stuck" without claiming a
   *  step happened — which is exactly what a thought is.
   *
   *  Pure CSS: the browser composites it off the main thread, so a room full
   *  of thinking agents costs no per-frame JS. */
  function showThinkingTag(aid: string, durationFrames = 150): void {
    if (!aid) return;
    const color = flowColor(aid);
    const sp = statusSpan(color);
    sp.className = 'atag atag-think';
    sp.style.gap = '3px';   // inline: statusSpan's own inline gap would win otherwise
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('i');
      dot.className = 'atag-think-dot';
      // Colour drives background + glow through currentColor; the stagger is
      // what turns three pulsing dots into one travelling wave.
      dot.style.cssText = `color:${color};animation-delay:${(i * 0.16).toFixed(2)}s`;
      sp.appendChild(dot);
    }
    mountAgentStatus(aid, sp, durationFrames);
  }

  // ── Meeting decor (halo + topic banner) ─────────
  // Plant a warm glowing disc over the meeting table + a floating banner
  // ("Topic · Turn N/M") so the user can see at a glance which room is in
  // session. The decor lives in `meetingDecor` keyed by meeting_id so
  // concurrent meetings each get their own. Cleared in disposeMeetingDecor.
  function spawnMeetingDecor(
    meetingId: string,
    room: { cx: number; cz: number; w: number; d: number },
    topic: string,
    // Custom click action for the banner. Default opens the live transcript
    // (autonomous meetings); human-led meetings pass a handler that opens the
    // user↔agents dialog panel instead.
    onClick?: () => void,
  ): void {
    if (!scene || !THREE || !CSS2DObject) return;
    if (meetingDecor.has(meetingId)) return;
    // Halo: thin ring on the floor of the room, emissive gold.
    const ringGeo = new THREE.RingGeometry(Math.min(room.w, room.d) * 0.28, Math.min(room.w, room.d) * 0.42, 48);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd166,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const halo = new THREE.Mesh(ringGeo, ringMat);
    halo.rotation.x = -Math.PI / 2;
    halo.position.set(room.cx, 0.05, room.cz);
    scene.add(halo);

    // Banner: floating CSS card above the room.
    const bannerEl = document.createElement('div');
    bannerEl.style.cssText = `
      background: linear-gradient(180deg,#3a2d05,#1c1500);
      color:#ffe898;
      border:2px solid #ffd166;
      border-radius:8px;
      padding:6px 14px;
      font:600 12px 'Fira Code',monospace;
      box-shadow:0 6px 18px rgba(255,209,102,0.25);
      max-width:320px;
      text-align:center;
      pointer-events:auto;
      cursor:pointer;
    `;
    bannerEl.title = 'Click to open the meeting dialog';
    bannerEl.innerHTML = `<div style="font-size:10px;letter-spacing:1px;color:#ffd166;text-transform:uppercase;">🔴 Meeting in progress</div>
      <div style="margin-top:2px;color:#fff;font-weight:700;">${escapeBannerText(topic.slice(0, 64))}</div>
      <div data-role="turn" style="font-size:10px;color:#ffd166;margin-top:2px;">starting…</div>`;
    // Click the floating banner → open this meeting's dialog. This is the
    // reliable, discoverable entry-point (the invisible room hitbox raycast
    // is unreliable from steep isometric angles). Stop propagation so the
    // window-level "click closes menus" handler doesn't immediately swallow it.
    bannerEl.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (onClick) { onClick(); return; }
      activeMeetingId = meetingId;
      showLiveMeeting = true;
      showMyOfficePanel = false;
      selectedAgent = null;
    });
    // The banner lives on the room's wall display now — a real textured
    // surface inside the office, so it obeys perspective and occlusion like
    // everything else. The CSS2D card is kept only as the clickable target
    // (the transcript opens from it) and is parked off to the side, small,
    // instead of hanging over the table.
    const bannerObj = new CSS2DObject(bannerEl);
    // NEVER over the table. Whatever happens with the wall display below, the
    // card does not go back to floating in the camera's line of sight — that
    // is the thing being fixed, and making it conditional on the screen
    // working is how it came back.
    const doorPt = hallCenterPos ? meetingRoomDoorPoint(room, hallCenterPos) : null;
    if (doorPt) {
      const wx = room.cx * 2 - doorPt.x, wz = room.cz * 2 - doorPt.z;
      const ix = room.cx - wx, iz = room.cz - wz;
      const ilen = Math.hypot(ix, iz) || 1;
      bannerObj.position.set(wx + (ix / ilen) * 0.6, 3.4, wz + (iz / ilen) * 0.6);
    } else {
      bannerObj.position.set(room.cx, 6.5, room.cz);
    }
    const screenIdx = meetingIdToRoom.get(meetingId);
    const screen = screenIdx !== undefined ? meetingScreens[screenIdx] : undefined;
    if (screen) {
      meetingScreenByMeeting.set(meetingId, screen);
      paintMeetingScreen(screen, { topic, status: 'comenzando…' });
    } else {
      // No wall display for this room — fall back to the card, on the wall.
      scene.add(bannerObj);
    }

    // NOTE: do not try to hide the card with `bannerEl.style.display`.
    // CSS2DRenderer rewrites that property every frame from the object's own
    // `visible` flag, so the card reappeared on the next render — which is
    // exactly how the floating banner came back after being "removed". Either
    // the object is in the scene or it is not.

    meetingDecor.set(meetingId, { halo, bannerObj, bannerEl });
    // Breathe + slow spin while this meeting exists. The `while` predicate
    // hooks the ticker's lifetime to disposeMeetingDecor() — when the entry
    // disappears from `meetingDecor`, the ticker self-removes.
    animRegistry.add(haloPulse(halo, {
      tag: `halo:${meetingId}`,
      while: () => meetingDecor.has(meetingId),
    }));
  }

  function updateMeetingDecorTurn(meetingId: string, turnText: string): void {
    const d = meetingDecor.get(meetingId);
    if (!d) return;
    const turnEl = d.bannerEl.querySelector('[data-role="turn"]') as HTMLElement | null;
    if (turnEl) turnEl.textContent = turnText;
    const screen = meetingScreenByMeeting.get(meetingId);
    if (screen) {
      const lm = liveMeetings[meetingId];
      paintMeetingScreen(screen, { topic: lm?.topic ?? '', status: turnText });
    }
  }

  function disposeMeetingDecor(meetingId: string): void {
    const d = meetingDecor.get(meetingId);
    if (!d) return;
    if (d.halo) {
      if (d.halo.parent) d.halo.parent.remove(d.halo);
      d.halo.geometry?.dispose();
      d.halo.material?.dispose();
    }
    if (d.bannerObj) {
      if (d.bannerObj.parent) d.bannerObj.parent.remove(d.bannerObj);
    }
    if (d.bannerEl) d.bannerEl.remove();
    const screen = meetingScreenByMeeting.get(meetingId);
    if (screen) { clearMeetingScreen(screen); meetingScreenByMeeting.delete(meetingId); }
    meetingDecor.delete(meetingId);
  }

  // O(1) agent lookup for per-frame loops — rebuilt only when the agents
  // array is reassigned (parent polls ~1/min). Avoids agents.find() scans
  // inside the animation loop (230 agents × 230 lookups/frame otherwise).
  let agentById: Map<string, any> = new Map();
  $: agentById = new Map(agents.map(a => [a.id, a]));

  export function focusAgentById(id: string) {
    if (!camera || !controls) { selectedAgent = id; return; }
    const p = deskPos.get(id);
    if (!p) { selectedAgent = id; return; }
    selectedAgent = id;
    // Close-up: keep current camera angle, zoom to ~6 units from the desk.
    const desiredDist = 6;
    const dx = camera.position.x - controls.target.x;
    const dy = camera.position.y - controls.target.y;
    const dz = camera.position.z - controls.target.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    const camX = p.x + ux * desiredDist;
    const camY = Math.max(1.6, p.y + uy * desiredDist + 1.2);
    const camZ = p.z + uz * desiredDist;
    tweenCameraTo(p.x, 1.2, p.z, camX, camY, camZ);
  }

  /** Fly the camera to a world point keeping the current viewing angle, WITHOUT
   *  selecting an agent (so it doesn't pop the agent detail panel). Mirrors the
   *  framing math in focusAgentById. */
  function flyCameraToPoint(p: { x: number; y: number; z: number } | null) {
    if (!camera || !controls || !p) return;
    const desiredDist = 7;
    const dx = camera.position.x - controls.target.x;
    const dy = camera.position.y - controls.target.y;
    const dz = camera.position.z - controls.target.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const camX = p.x + (dx / len) * desiredDist;
    const camY = Math.max(1.6, p.y + (dy / len) * desiredDist + 1.2);
    const camZ = p.z + (dz / len) * desiredDist;
    tweenCameraTo(p.x, 1.2, p.z, camX, camY, camZ);
  }

  /** One-click path from the alert pill / red halo to actually handling the
   *  top agent's messages: open My Office on the Questions tab, refresh
   *  the inbox, and fly the camera to his desk. */
  function openTopAgentMessages() {
    selectedAgent = null;
    showMyOfficePanel = true;
    myOfficeTab = 'questions';
    loadOfficeReportsFromApi();
    loadPendingQuestions();
    flyCameraToPoint(topAgentSeatPos);
  }

  /** Recolour the top agent's floor halo to a pulsing RED while they have
   *  unanswered escalations (gold when his inbox is clear). The existing
   *  opacity `materialPulse` keeps it breathing — we only swap the hue, so the
   *  alert reads from across the office with every panel closed. */
  function paintTopAgentAlert(hasMessages: boolean) {
    const mat = topAgentHaloMesh?.material;
    if (!mat?.color) return;
    mat.color.set(hasMessages ? 0xff3344 : 0xc9a84c);
  }
  $: paintTopAgentAlert(pendingQuestions.length > 0);

  // Lazily-created shared AudioContext for UI alerts (one per page, resumed on
  // demand — browsers start it suspended until a user gesture happens).
  let alertAudioCtx: AudioContext | null = null;
  /** A short two-tone "incoming message" ping for the top agent — an
   *  urgent ascending chime (A5 → D6) with a bell-like decay. Fired when a new
   *  escalation lands. Best-effort: silently no-ops if Web Audio is blocked or
   *  the context can't resume (e.g. no user gesture yet). */
  function playTopAgentChime() {
    try {
      if (!alertAudioCtx) {
        alertAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = alertAudioCtx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(880, t0);          // A5
      osc.frequency.setValueAtTime(1175, t0 + 0.11);  // D6
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
      osc.start(t0);
      osc.stop(t0 + 0.6);
    } catch { /* audio not available — silent fallback */ }
  }

  // ── Quick active/inactive toggle straight from the 3D ──────────────
  // Powers the ⏻ chip on each agent nameplate. Generalizes togglePause (which
  // only worked on the selected agent) to ANY agent id. Optimistic local
  // update flips `agents` → sceneFingerprint changes → rebuildScene repaints
  // the floor ring + status dot + greyed station; dispatch('refresh') then
  // pulls server truth. detectActiveChanges() animates the walk in/out.
  let togglingAgentId: string | null = null;
  async function toggleAgentActive(agentId: string, currentActive: boolean) {
    if (togglingAgentId) return;
    togglingAgentId = agentId;
    try {
      const r = await fetch(`/api/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !currentActive }),
      });
      const data = await r.json();
      if (data?.success) {
        agents = agents.map(a => a.id === agentId ? { ...a, active: currentActive ? 0 : 1 } : a);
        dispatch('refresh');
      } else {
        console.error('toggle active failed', data?.error);
      }
    } catch (e) {
      console.error('toggle active network error', e);
    } finally {
      togglingAgentId = null;
    }
  }

  // ⏻ chips live in the CSS2D nameplate DOM (built in furniture.ts, hidden by
  // default). Reveal them only for the hovered / selected agent so 200 chips
  // don't clutter the floor, and hide them again on blur. Event-driven off the
  // hover/select vars — no per-frame cost.
  let shownChipIds = new Set<string>();
  function setChipVisible(agentId: string, show: boolean) {
    const lbl = deskLabels.get(agentId);
    const btn = lbl?.element?.querySelector?.('.dl-power') as HTMLElement | null;
    if (btn) btn.style.display = show ? 'inline-block' : 'none';
  }
  function updatePowerChips() {
    const want = new Set<string>();
    if (hoveredAgent) want.add(hoveredAgent);
    if (selectedAgent) want.add(selectedAgent);
    for (const id of shownChipIds) if (!want.has(id)) setChipVisible(id, false);
    for (const id of want) setChipVisible(id, true);
    shownChipIds = want;
  }
  // Re-evaluate whenever hover or selection changes (and after rebuilds, since
  // fresh labels start hidden — this re-shows the active one).
  $: { void hoveredAgent; void selectedAgent; void lastReactiveKey; updatePowerChips(); }

  // ── Create Office — handled by <OfficeCreatorChat>; only the modal flag
  //    lives here so the HQ menu can toggle it open.
  let showOfficeModal = false;

  // ── Build Scene ────────────────────────────────
  // Idempotent: dissolve the boot loader exactly once, after the next painted
  // frame. Called when the office is first populated with agents (or by the
  // fallback timer if no agents ever load).
  function markSceneReady(): void {
    if (sceneReady) return;
    if (sceneReadyFallbackTimer) { clearTimeout(sceneReadyFallbackTimer); sceneReadyFallbackTimer = null; }
    requestAnimationFrame(() => { sceneReady = true; dispatch('sceneready'); });
  }

  // Readiness gate — only reveal the office once EVERYTHING needed is in place:
  // WebGL up, office shell built, the parent's first data fetch resolved, and
  // (when there are agents) the desks actually populated. Updates the loader
  // subtitle for the stage it's waiting on. Driven by the reactive below + the
  // populate path so it re-checks whenever an input changes.
  function maybeRevealScene(): void {
    if (sceneReady || bootError) return;
    if (!renderer || !staticBuilt) { bootStatus = 'building offices…'; return; }
    if (!dataLoaded) { bootStatus = 'waiting for agent data…'; return; }
    if (dataError) { bootStatus = 'error al cargar datos'; return; }
    if (agents.length > 0 && !officePopulated) { bootStatus = 'deploying staff…'; return; }
    bootStatus = 'ready';
    markSceneReady();
  }

  async function buildScene() {
    if (!canvasEl) return;
    THREE = await import('three');
    const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
    const css2d = await import('three/examples/jsm/renderers/CSS2DRenderer.js');
    CSS2DObject = css2d.CSS2DObject;

    // Init modules
    initHumanoid(THREE);
    initHumanoidPool(THREE);
    // Initialise every registered skin (office-worker, ra-soldier, …) — each
    // skin's init() runs once and wires its module-level THREE handle.
    initAllSkins(THREE);
    initAnimEffects(THREE, CSS2DObject);
    // Snapshot the registry once skins are loaded — feeds the panel dropdown.
    availableSkins = listSkins();
    // Reusable frustum / projection matrix for per-frame pool culling.
    _frustum = new THREE.Frustum();
    _projScreenMatrix = new THREE.Matrix4();
    _labelSphere = new THREE.Sphere(new THREE.Vector3(), 2.5);
    initOffice(THREE, CSS2DObject);
    initFurniture(THREE, CSS2DObject);
    initWalkers(THREE, CSS2DObject);
    initAmbiance(THREE, CSS2DObject);
    initDelivery(THREE, CSS2DObject);
    initTaxi(THREE);
    initRedAlertDecor(THREE);

    renderer = createRenderer(THREE);
    if (!renderer) { webglError = 'WebGL not available. Check GPU settings.'; return; }

    // Size, pixel ratio, shadow map, grading — see office3d/scene.ts.
    configureRenderer(THREE, renderer, canvasEl);

    labelRenderer = createLabelRenderer(css2d, canvasEl);

    // Delegated click handler for the ⏻ power chips embedded in the CSS2D
    // nameplates (furniture.ts). The chip carries pointer-events:auto so it
    // gets the click even though the label layer is pointer-events:none; one
    // listener serves every agent. stopPropagation keeps it from bubbling into
    // any canvas/select logic.
    labelRenderer.domElement.addEventListener('click', (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      const btn = target?.closest?.('.dl-power') as HTMLElement | null;
      if (!btn) return;
      ev.stopPropagation();
      ev.preventDefault();
      const id = btn.dataset.agent;
      if (!id) return;
      const wasActive = btn.dataset.active === '1';
      toggleAgentActive(id, wasActive);
    });

    scene = new THREE.Scene();

    // ── Environment map for realistic reflections on glass/metal, plus the
    // fog / environment-intensity grading — see office3d/scene.ts ──
    applyEnvironment(THREE, renderer, scene);

    // Isometric-style camera (high angle, looking down). Factor in the
    // streetscape added by buildStreets — sidewalk + street extends ~15u past
    // the building bounds, and with FOV 35° the default cd based only on the
    // desks was clipping the entire block outside the frame.
    const cd = initialCameraDistance(deskPos, corGrid.buildingBounds);
    camera = new THREE.PerspectiveCamera(35, canvasEl.clientWidth / canvasEl.clientHeight, 0.5, 600);
    // Isometric angle: 45° from high above, looking down at the office
    camera.position.set(cd * 0.7, cd * 0.8, cd * 0.7);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2.5;  // keep high angle
    controls.minPolarAngle = Math.PI / 6;    // don't go too flat
    // Lower bound lets the camera approach the reception screens / monitors
    // up close (≈2u from the face of the screen). Previously this was 15u
    // which clamped the zoom too aggressively.
    controls.minDistance = 2;
    controls.maxDistance = 300;

    // ── Rotation with the reception as the axis (see setRotationMode / turntableRotate) ──
    // The turntable's elevation range is the complement of the polar limits.
    initTurntableTemps();
    TURNTABLE_MIN_EL = Math.PI / 2 - controls.maxPolarAngle;
    TURNTABLE_MAX_EL = Math.PI / 2 - controls.minPolarAngle;
    try {
      const savedMode = localStorage.getItem(LS_ROTMODE);
      if (savedMode === 'recenter' || savedMode === 'turntable') rotationMode = savedMode;
    } catch { /* private mode — best effort */ }
    // En turntable el giro lo maneja nuestro handler → OrbitControls no rota.
    controls.enableRotate = (rotationMode === 'recenter');
    renderer.domElement.addEventListener('pointerdown', onWorldPointerDown);
    // move/up on window so the drag keeps tracking outside the canvas.
    window.addEventListener('pointermove', onWorldPointerMove);
    window.addEventListener('pointerup', onWorldPointerUp);

    // Restore the saved pos/target if there is one. If the restore fails we
    // keep the default view configured above.
    restoreCamera();

    // Persist every time the user moves the camera (pan/orbit/zoom). The
    // evento 'change' se dispara muchas veces por segundo durante damping, por
    // so we debounce to 250ms in scheduleCameraSave.
    controls.addEventListener('change', scheduleCameraSave);
    // Stamp camera motion (fires during damping too) — drives the full-rate
    // CSS2D label rendering while orbiting/panning/zooming.
    controls.addEventListener('change', () => { lastControlChangeAt = performance.now(); });

    // ── Global lighting (key/fill/rim) — see office3d/office/lighting.ts ──
    // World bounds → tightened shadow frustum (shadow texels 2–4× denser).
    setupLighting(scene, corGrid.buildingBounds);

    // ── Post-processing: MSAA composer + bloom (GTAO off) on dpr ≤ 1.5, direct
    // render otherwise — see office3d/scene.ts ──
    ({ composer, gtaoPass, bloomPass } = await createPostProcessing(THREE, renderer, scene, camera, canvasEl));

    // Build static structure in a group (reused by rebuildScene diff logic)
    staticGroup = new THREE.Group();
    staticGroup.userData._static = true;
    buildFloor(staticGroup, corGrid.buildingBounds);
    // Central Hall (meetingRooms[1]) anchors the staircase so the entrance
    // lines up visually with the main indoor axis.
    const hallHint = meetingRooms[1] ?? meetingRooms[0];
    const entranceHint = hallHint ? { cx: hallHint.cx, width: hallHint.w } : undefined;
    buildStreets(staticGroup, corGrid.buildingBounds, entranceHint);
    buildCorridorGrid(staticGroup, corGrid);
    buildRooms(staticGroup, roomMap, computeRoomCounts());
    buildThemedOffices(staticGroup);
    buildSpecialRooms(staticGroup);
    buildAmbiance(staticGroup, corGrid.buildingBounds, corGrid.nodes, entranceHint);
    if (hallCenterPos) {
      const hSlot = meetingRooms[1] ?? meetingRooms[0];
      buildActivityBoard(staticGroup, hallCenterPos.x, hallCenterPos.z, hSlot?.d ?? 8);
    }
    buildDoorLeds(staticGroup, roomMap);
    // buildElevator(staticGroup, corGrid.buildingBounds); // hidden for now
    scene.add(staticGroup);
    // Office shell is now in the scene — the loader can show "waiting for staff".
    staticBuilt = true;
    bootStatus = dataLoaded ? 'deploying staff…' : 'waiting for agent data…';
    // Delivery infra — truck + driver are cached, so just (re)set the context
    resetDelivery();
    installDeliveryContext();
    // ── Dev helpers: fire test animations from the DevTools console ──
    // All cosmetic-only — they enqueue visuals and touch NO agent/kernel state
    // (so no LLM runs, no active-flag side effects). Type __animDemos() in the
    // console to list them.
    // Mail/package truck. Real deliveries fire on inbound agent runs.
    (window as any).__deliveryDemo = (flowId?: string) => runDeliveryDemo(flowId);
    // Car (taxi): a sedan drives in along the south lane, parks at the
    // entrance, then drives off. The live scene only spawns this on an agent
    // active-flag flip (0→1 arrive / 1→0 leave); this demo skips all that.
    (window as any).__taxiDemo = (bodyColor?: string) => {
      if (!scene || !taxiContext) { console.warn('[taxiDemo] scene/taxi not ready yet'); return false; }
      enqueueTaxi(scene, { bodyColor, parkedDuration: 2.5, onParked: () => {} });
      return true;
    };
    // Trade-execution celebration (expanding ring + particle burst in the
    // central hall). Pass false for a sell (red) instead of a buy (green).
    (window as any).__tradeDemo = (isBuy: boolean = true) => {
      spawnTradeCelebration('DEMO', isBuy ? 'buy' : 'sell', 0, isBuy);
      return true;
    };
    (window as any).__animDemos = () => {
      const list = [
        '__deliveryDemo()        — camión de correo/paquete (mail)',
        '__taxiDemo()            — a car/taxi drives up to the front and leaves',
        '__taxiDemo("#4ddbff")   — taxi with a custom body colour',
        '__tradeDemo()           — trade celebration (buy, green)',
        '__tradeDemo(false)      — trade celebration (sell, red)',
      ];
      console.log('Test animations:\n  ' + list.join('\n  '));
      return ['__deliveryDemo', '__taxiDemo', '__tradeDemo'];
    };
    lastLayoutKey = agents.map(a => `${a.id}:${a.flow_id}`).sort().join('|') + `|${flows.length}|${meetingRooms.length}`;

    if (USE_HUMANOID_POOL) {
      // Capacity = active agent count + 20% headroom for late additions.
      const activeCount = agents.filter(a => a.active === 1).length;
      // Resolve the default skin's pool factory. Agents with non-default
      // skin_ids render per-mesh (handled in furniture.ts).
      const defaultSkin = resolveSkin(undefined);
      humanoidPool = defaultSkin.createPool
        ? defaultSkin.createPool(scene, Math.max(8, Math.ceil(activeCount * 1.2)))
        : null;
    }
    const deskResult = buildDesks(scene, agents, flows, deskPos, runningAgentIds, ranks, humanoidPool);
    deskGroups = deskResult.deskGroups;
    deskLabels = deskResult.deskLabels;
    sittingWorkers = deskResult.sittingWorkers;
    deskAabbs = deskResult.deskAabbs;
    // Wire the top agent into the freshly-built deskPos + sittingWorkers
    // maps — same reason as the rebuildScene branch (see comment there).
    ensureTopAgentWiring();
    hallwayLines = buildHallways(scene, chains, deskPos, agents, flows);

    // Raycaster — targets desks + My Office hitbox + meeting room hitboxes
    const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
    let hoveredMyOffice = false;
    let hoveredMeetingRoomIdx = -1;

    // Cache ray targets — rebuilt only when the desk set or hitbox changes,
    // not on every mousemove event.
    let rayTargetsCacheLocal: any[] | null = null;
    let rayTargetsDeskSize = -1;
    let rayTargetsHitbox: any = null;
    let rayTargetsMRCount = -1;
    let rayTargetsTopAgent: any = null;
    let rayTargetsFreeRackCount = -1;
    let rayTargetsInfraConsole: any = null;
    let rayTargetsDevopsTerminal: any = null;
    function getRayTargets(): any[] {
      const invalidateHint = rayTargetsCache === null; // module-level reset (e.g. top-agent rebuild)
      if (
        invalidateHint ||
        !rayTargetsCacheLocal ||
        rayTargetsDeskSize !== deskGroups.size ||
        rayTargetsHitbox !== myOfficeHitbox ||
        rayTargetsMRCount !== meetingRoomHitboxes.length ||
        rayTargetsTopAgent !== topAgentHitbox ||
        rayTargetsFreeRackCount !== freeRepoRackHitboxes.length ||
        rayTargetsInfraConsole !== infraConsoleHitbox ||
        rayTargetsDevopsTerminal !== devopsTerminalHitbox
      ) {
        rayTargetsCacheLocal = Array.from(deskGroups.values());
        // The top agent's hitbox sits INSIDE the My Office hitbox in world
        // space. Push him first so when the raycaster sorts by distance and
        // we read hits[0], we still see his isTopAgent flag even though
        // the My Office room mesh shares the same Z range.
        if (topAgentHitbox) rayTargetsCacheLocal.push(topAgentHitbox);
        if (myOfficeHitbox) rayTargetsCacheLocal.push(myOfficeHitbox);
        for (const hb of meetingRoomHitboxes) rayTargetsCacheLocal.push(hb);
        // FREE racks in the Repos Office — click = open register modal.
        for (const hb of freeRepoRackHitboxes) rayTargetsCacheLocal.push(hb);
        // Power console in the Repos Office — click = toggle the power-grid board.
        if (infraConsoleHitbox) rayTargetsCacheLocal.push(infraConsoleHitbox);
        // DevOps workstation — click = open the DevOps control panel (/devops).
        if (devopsTerminalHitbox) rayTargetsCacheLocal.push(devopsTerminalHitbox);
        rayTargetsDeskSize = deskGroups.size;
        rayTargetsHitbox = myOfficeHitbox;
        rayTargetsMRCount = meetingRoomHitboxes.length;
        rayTargetsTopAgent = topAgentHitbox;
        rayTargetsFreeRackCount = freeRepoRackHitboxes.length;
        rayTargetsInfraConsole = infraConsoleHitbox;
        rayTargetsDevopsTerminal = devopsTerminalHitbox;
        rayTargetsCache = rayTargetsCacheLocal; // sync the module-level handle
      }
      // Active walkers (walking the floor or seated in a meeting) come and go
      // every frame, so they can't live in the cached static set. Append their
      // groups fresh each call — the list is tiny (≤20) and this is the only
      // way a moving/seated agent becomes hoverable + clickable wherever it is.
      if (walkers.length === 0) return rayTargetsCacheLocal;
      const out = rayTargetsCacheLocal.slice();
      for (const w of walkers) out.push(w.group);
      return out;
    }

    let hoveredTopAgent = false;
    let hoveredFreeRack = false;
    let hoveredInfraConsole = false;
    let hoveredDevopsTerminal = false;
    let lastHoverRayAt = 0;
    renderer.domElement.addEventListener('mousemove', (e: MouseEvent) => {
      // While a camera drag is in progress (orbit/pan: any button held) hover
      // is meaningless — skip the recursive raycast storm entirely. mousemove
      // fires 60–120Hz during drags and each raycast walks every desk group.
      if (e.buttons !== 0) return;
      // True hover: 30Hz is indistinguishable for a highlight + cursor swap.
      const tNow = performance.now();
      if (tNow - lastHoverRayAt < 33) return;
      lastHoverRayAt = tNow;
      const r = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(mouse, camera);
      const hits = ray.intersectObjects(getRayTargets(), true);
      hoveredMyOffice = false;
      hoveredMeetingRoomIdx = -1;
      hoveredTopAgent = false;
      hoveredFreeRack = false;
      hoveredInfraConsole = false;
      hoveredDevopsTerminal = false;
      if (hits.length) {
        // The top agent's hitbox sits inside My Office's hitbox so the
        // raycaster might list both. Prefer the top-agent hit (smaller,
        // more specific) over the room hit when both are present. The infra
        // console sits inside the Repos Office — prefer it the same way.
        let o = hits.find(h => h.object.userData.isTopAgent)?.object
          ?? hits.find(h => h.object.userData.isInfraConsole)?.object
          ?? hits.find(h => h.object.userData.isDevopsTerminal)?.object
          ?? hits.find(h => h.object.userData.isFreeRepoRack)?.object
          ?? hits[0].object;
        if (o.userData.isTopAgent) {
          hoveredTopAgent = true;
          hoveredAgent = null;
          renderer.domElement.style.cursor = 'pointer';
        } else if (o.userData.isInfraConsole) {
          hoveredInfraConsole = true;
          hoveredAgent = null;
          renderer.domElement.style.cursor = 'pointer';
        } else if (o.userData.isDevopsTerminal) {
          hoveredDevopsTerminal = true;
          hoveredAgent = null;
          renderer.domElement.style.cursor = 'pointer';
        } else if (o.userData.isFreeRepoRack) {
          hoveredFreeRack = true;
          hoveredAgent = null;
          renderer.domElement.style.cursor = 'pointer';
        } else if (o.userData.isMeetingRoom) {
          hoveredMeetingRoomIdx = o.userData.meetingRoomIndex ?? -1;
          hoveredAgent = null;
          renderer.domElement.style.cursor = 'pointer';
        } else if (o.userData.isMyOffice) {
          hoveredMyOffice = true;
          hoveredAgent = null;
          renderer.domElement.style.cursor = 'pointer';
        } else {
          while (o.parent && !o.userData.agentId) o = o.parent;
          hoveredAgent = o.userData.agentId || null;
          renderer.domElement.style.cursor = hoveredAgent ? 'pointer' : 'grab';
        }
      } else { hoveredAgent = null; renderer.domElement.style.cursor = 'grab'; }
    });
    renderer.domElement.addEventListener('click', () => {
      if (hoveredTopAgent) {
        // Click on the figure → open the office-architect chat. The HQ
        // menu's 'New Office' button is still wired to the same flag for
        // discoverability, but this gesture is the canonical one.
        showOfficeModal = true;
        selectedAgent = null;
        showMyOfficePanel = false;
        return;
      }
      if (hoveredInfraConsole) {
        // Click on the power console → show/hide the full power-grid board
        // (which is hidden by default to keep the office clean).
        toggleInfraBoard();
        return;
      }
      if (hoveredDevopsTerminal) {
        // Click on the DevOps workstation → open the full DevOps control panel.
        // Replaces the old floating quick-console button with an in-world,
        // discoverable entry point sitting on the office floor.
        window.location.href = '/devops';
        return;
      }
      if (hoveredFreeRack) {
        // Click on a FREE server rack → open the register-repo modal. Goes
        // through the shared opener rather than flipping the flag and clearing
        // fields by hand: doing it by hand skipped loading the checkouts the
        // kernel can see, the focus handoff, and every field added since.
        registerRepoModal?.open();
        return;
      }
      if (hoveredMeetingRoomIdx >= 0) {
        // Find a meeting currently placed in this room; if none, pick any
        // recent meeting so the user always sees transcript on click.
        let mid: string | null = null;
        for (const [id, idx] of meetingIdToRoom.entries()) {
          if (idx === hoveredMeetingRoomIdx) { mid = id; break; }
        }
        if (!mid) mid = liveMeetingsList[0]?.id ?? null;
        if (mid) {
          activeMeetingId = mid;
          showLiveMeeting = true;
          showMyOfficePanel = false;
          selectedAgent = null;
        }
      } else if (hoveredMyOffice) {
        showMyOfficePanel = !showMyOfficePanel;
        if (showMyOfficePanel) { loadOfficeReportsFromApi(); loadPendingQuestions(); }
        selectedAgent = null;
      } else if (hoveredAgent) {
        showMyOfficePanel = false;
        // The top-agent chat docks on the same right edge as the agent panel
        // — swap panels instead of stacking them invisibly.
        showOfficeModal = false;
        selectedAgent = selectedAgent === hoveredAgent ? null : hoveredAgent;
        focusAgent();
      }
    });

    animate();
    // Reveal is driven by the readiness reactive ($: maybeRevealScene) below —
    // it waits for the office shell + the parent's first data fetch + a
    // populated frame, instead of a blind timer that used to expose an empty
    // office. This call covers the fast path where agents were already present
    // at build time (desks just built → reveal next frame).
    maybeRevealScene();
    // Hard safety net for a genuinely hung fetch / unexpected state: reveal
    // after 30s no matter what so the user is never stuck on the loader.
    sceneReadyFallbackTimer = setTimeout(() => {
      if (!sceneReady) { console.warn('[boot] readiness timed out — revealing anyway'); markSceneReady(); }
    }, 30000);
    resizeObserver = new ResizeObserver(() => {
      if (!canvasEl || !renderer) return;
      const w = canvasEl.clientWidth, h = canvasEl.clientHeight;
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
      if (composer) composer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(canvasEl);
  }

  // ── Process live events ────────────────────────
  // The dispatcher itself is office3d/events.ts. It reads and writes this
  // component's state through `eventCtx`, whose getters/setters are live —
  // including from the setTimeout callbacks it schedules.
  const eventCtx: LiveEventContext = {
    get flowEvents() { return flowEvents; },
    get lastProcessedFlowEvent() { return lastProcessedFlowEvent; },
    set lastProcessedFlowEvent(v: AgentFlowEvent | null) { lastProcessedFlowEvent = v; },
    get flows() { return flows; },
    get agents() { return agents; },
    get selectedAgent() { return selectedAgent; },
    get scene() { return scene; },
    get THREE() { return THREE; },
    get sceneTimeSec() { return sceneTimeSec; },
    get deskGroups() { return deskGroups; },
    get deskPos() { return deskPos; },
    get roomMap() { return roomMap; },
    get corGrid() { return corGrid; },
    get deskAabbs() { return deskAabbs; },
    get sittingWorkers() { return sittingWorkers; },
    get walkers() { return walkers; },
    set walkers(v: Walker[]) { walkers = v; },
    get myOfficePos() { return myOfficePos; },
    get myOfficeSeats() { return myOfficeSeats; },
    get myOfficeDeskFacing() { return myOfficeDeskFacing; },
    get myOfficeNoteStack() { return myOfficeNoteStack; },
    get hallCenterPos() { return hallCenterPos; },
    get topAgentId() { return topAgentId; },
    get topAgentSeatPos() { return topAgentSeatPos; },
    get meetingRoomSlots() { return meetingRoomSlots; },
    get meetingIdToRoom() { return meetingIdToRoom; },
    get speechBubbles() { return speechBubbles; },
    get liveMeetings() { return liveMeetings; },
    set liveMeetings(v: Record<string, LiveMeeting>) { liveMeetings = v; },
    get activeMeetingId() { return activeMeetingId; },
    set activeMeetingId(v: string | null) { activeMeetingId = v; },
    get showTranscriptBody() { return showTranscriptBody; },
    set showTranscriptBody(v: boolean) { showTranscriptBody = v; },
    get showMyOfficePanel() { return showMyOfficePanel; },
    set showMyOfficePanel(v: boolean) { showMyOfficePanel = v; },
    get showLiveMeeting() { return showLiveMeeting; },
    set showLiveMeeting(v: boolean) { showLiveMeeting = v; },
    get auditedRunIds() { return auditedRunIds; },
    set auditedRunIds(v: Set<string>) { auditedRunIds = v; },
    get meetingActive() { return meetingActive; },
    get meetingSelectedIds() { return meetingSelectedIds; },
    animRegistry,
    lastDeliveryAtByFlow,
    markActivity, showAnimatedTag, showThinkingTag, pulseThinkingMonitor,
    triggerDeliveryForAgent, tryFireAnim, spawnErrorFx, spawnHandoffPacketFx,
    spawnTradeCelebration,
    refreshSelectedAgentRuns: () => agentPanel?.refreshRuns(),
    isOfficeLeader, isSeniorRank, addOfficeReport, pickFreeMyOfficeChair,
    flowColor, sameOffice, coordinateInMeetingRoom,
    spawnMeetingDecor, updateMeetingDecorTurn, disposeMeetingDecor,
    pushMgmtLog, playTopAgentChime, loadPendingQuestions,
    topAgent, highestRank, handleInfraToggle,
  };
  function processEvents() {
    processLiveEvents(eventCtx);
  }

  // ── Trade celebration: particles + glow ring + sound in Central Hall ──
  function spawnTradeCelebration(symbol: string, side: string, price: number, isBuy: boolean) {
    if (!hallCenterPos || !scene || !THREE) return;
    const cx = hallCenterPos.x;
    const cz = hallCenterPos.z;
    const color = isBuy ? 0x00ff88 : 0xff4466;

    const group = new THREE.Group();
    group.position.set(cx, 0.2, cz);

    // Glowing ring expanding outward
    const ringMat = new THREE.MeshStandardMaterial({
      color, emissive: new THREE.Color(color), emissiveIntensity: 1.0,
      transparent: true, opacity: 0.8, roughness: 0.1,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.08, 8, 32), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.15;
    group.add(ring);

    // Particle burst (small spheres)
    const particleMat = new THREE.MeshStandardMaterial({
      color, emissive: new THREE.Color(color), emissiveIntensity: 0.8,
      transparent: true, opacity: 0.9, roughness: 0.2,
    });
    for (let i = 0; i < 20; i++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), particleMat.clone());
      const angle = (i / 20) * Math.PI * 2;
      const radius = 0.5 + Math.random() * 1.5;
      p.position.set(Math.cos(angle) * radius, 0.3 + Math.random() * 0.5, Math.sin(angle) * radius);
      group.add(p);
    }

    scene.add(group);
    animRegistry.add(risingParticles(group, {
      maxAgeSec: 4,
      onDispose: () => {
        if (group.parent) group.parent.remove(group);
        group.traverse((c: any) => { c.geometry?.dispose(); c.material?.dispose(); });
      },
    }));

    // Hall label announcement
    const labelDiv = document.createElement('div');
    const priceStr = price > 0 ? ` @ ${price.toFixed(2)}` : '';
    labelDiv.innerHTML = `${isBuy ? '🟢' : '🔴'} <b>${side} ${symbol}</b>${priceStr}`;
    labelDiv.style.cssText = `font:900 14px 'Syne','Fira Code',monospace;
      color:${isBuy ? '#00ff88' : '#ff4466'};
      background:rgba(0,0,8,0.85);padding:8px 18px;border-radius:8px;
      border:2px solid ${isBuy ? '#00ff88' : '#ff4466'};
      box-shadow:0 0 20px ${isBuy ? '#00ff8855' : '#ff446655'};
      animation:gpop .4s cubic-bezier(.17,.88,.32,1.28);`;
    const lbl = new CSS2DObject(labelDiv);
    lbl.position.set(cx, 3.5, cz);
    scene.add(lbl);
    setTimeout(() => { scene.remove(lbl); labelDiv.remove(); }, 5000);

    // Sound — Web Audio API chime
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = isBuy ? 'sine' : 'triangle';
      // BUY = ascending chime (C5 → E5 → G5), SELL = descending (G5 → E5 → C5)
      const notes = isBuy ? [523, 659, 784] : [784, 659, 523];
      osc.frequency.setValueAtTime(notes[0], audioCtx.currentTime);
      osc.frequency.setValueAtTime(notes[1], audioCtx.currentTime + 0.12);
      osc.frequency.setValueAtTime(notes[2], audioCtx.currentTime + 0.24);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
      osc.start(audioCtx.currentTime);
      osc.stop(audioCtx.currentTime + 0.5);
    } catch { /* audio not available — silent fallback */ }
  }

  // Richer variant used for eval grades and lesson drops — colored border + longer life
  function showGradeBubble(aid: string, text: string, color: string, dur = 250) {
    const sp = statusSpan(color);
    const t = document.createElement('span');
    t.innerHTML = text;
    t.style.cssText =
      `max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;` +
      `font:700 9px 'Fira Code',monospace;color:${color}`;
    sp.appendChild(t);
    mountAgentStatus(aid, sp, dur);
  }

  // ── Persistencia de UI en localStorage ─────────────────────────────
  // Dedicated keys so we don't collide with other features.
  const LS_CAMERA = 'agentworld:camera';
  const LS_SELECTED = 'agentworld:selected-agent';

  /** Serializa {pos, target} a localStorage. Debounced a 250ms via rAF. */
  let _camSaveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleCameraSave() {
    if (_camSaveTimer) clearTimeout(_camSaveTimer);
    _camSaveTimer = setTimeout(() => {
      _camSaveTimer = null;
      if (!camera || !controls) return;
      try {
        localStorage.setItem(LS_CAMERA, JSON.stringify({
          pos: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
          target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
        }));
      } catch { /* localStorage puede fallar en private mode — best effort */ }
    }, 250);
  }

  /** Restaura la cámara si hay un snapshot válido en localStorage. */
  function restoreCamera(): boolean {
    if (!camera || !controls) return false;
    try {
      const raw = localStorage.getItem(LS_CAMERA);
      if (!raw) return false;
      const data = JSON.parse(raw) as { pos?: { x: number; y: number; z: number }; target?: { x: number; y: number; z: number } };
      if (!data.pos || !data.target) return false;
      const p = data.pos, t = data.target;
      // Sanity checks: finite numbers, within the range controls allows.
      if (![p.x, p.y, p.z, t.x, t.y, t.z].every(v => Number.isFinite(v))) return false;
      const dist = Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z);
      if (dist < controls.minDistance || dist > controls.maxDistance) return false;
      camera.position.set(p.x, p.y, p.z);
      controls.target.set(t.x, t.y, t.z);
      controls.update();
      return true;
    } catch {
      return false;
    }
  }

  // ── Rotation mode (left button) — axis = reception / central office ──
  // Two modes, selectable from the HQ menu and persisted in localStorage:
  //  • 'turntable' (default): the {camera, target} pair rotates rigidly
  //    around the reception's vertical axis, preserving your framing and
  //    sin salto. OrbitControls.enableRotate queda OFF; el giro lo maneja este
  //    handler (yaw horizontal + pitch con clamp).
  //  • 'recenter': on drag start the target snaps to the reception and
  //    OrbitControls orbits there (simple, but it reframes toward the centre).
  type RotationMode = 'turntable' | 'recenter';
  const LS_ROTMODE = 'agentworld:rotation-mode';
  let rotationMode: RotationMode = 'turntable';

  // Height of the reception pivot (matches the office focus height).
  const RECEPTION_PIVOT_Y = 1.0;
  // Elevation range allowed for the camera relative to the pivot, derived from
  // OrbitControls' polar limits (elevation = π/2 − polar). Recomputed
  // en initScene desde controls.min/maxPolarAngle.
  let TURNTABLE_MIN_EL = 0.3, TURNTABLE_MAX_EL = 1.05;
  const TURNTABLE_ROT_SPEED = 0.005; // rad por px arrastrado

  // Reusable temporaries (no per-frame allocation). Initialised once THREE
  // has loaded (initScene → initTurntableTemps).
  let _ttUP: any = null, _ttC: any = null, _ttQ: any = null, _ttQ2: any = null,
      _ttView: any = null, _ttRight: any = null, _ttTest: any = null, _ttE: any = null;
  function initTurntableTemps() {
    if (_ttUP || !THREE) return;
    _ttUP = new THREE.Vector3(0, 1, 0);
    _ttC = new THREE.Vector3(); _ttQ = new THREE.Quaternion(); _ttQ2 = new THREE.Quaternion();
    _ttView = new THREE.Vector3(); _ttRight = new THREE.Vector3();
    _ttTest = new THREE.Vector3(); _ttE = new THREE.Vector3();
  }

  /** Pivot point (axis) of the rotation = geometric centre of the offices, i.e.
   *  the midpoint of the building extent (`corGrid.buildingBounds`). The
   *  the reception (`hallCenterPos`) sits on the north edge, so it does NOT work
   *  eje: dejaría el giro corrido. Cae a hallCenterPos / origen si el layout
   *  aún no se armó. */
  function orbitPivot(): { x: number; y: number; z: number } {
    const bb = corGrid?.buildingBounds;
    if (bb && Number.isFinite(bb.minX) && Number.isFinite(bb.maxX)) {
      return { x: (bb.minX + bb.maxX) / 2, y: RECEPTION_PIVOT_Y, z: (bb.minZ + bb.maxZ) / 2 };
    }
    if (hallCenterPos) return { x: hallCenterPos.x, y: RECEPTION_PIVOT_Y, z: hallCenterPos.z };
    return { x: 0, y: RECEPTION_PIVOT_Y, z: 0 };
  }

  function _rotAround(P: any, C: any, q: any) { P.sub(C).applyQuaternion(q).add(C); }

  /** Rigidly rotates {camera, target} around the pivot's vertical axis.
   *  dAzim = horizontal turn (yaw), dPolar = tilt (pitch, with an elevation
   *  clamp so we never cross the vertical or dip below the floor). */
  function turntableRotate(pivot: { x: number; y: number; z: number }, dAzim: number, dPolar: number) {
    if (!camera || !controls || !THREE) return;
    initTurntableTemps();
    const C = _ttC.set(pivot.x, pivot.y, pivot.z);
    if (dAzim !== 0) {
      const qy = _ttQ.setFromAxisAngle(_ttUP, dAzim);
      _rotAround(camera.position, C, qy);
      _rotAround(controls.target, C, qy);
    }
    if (dPolar !== 0) {
      _ttView.subVectors(controls.target, camera.position).normalize();
      _ttRight.crossVectors(_ttView, _ttUP);
      if (_ttRight.lengthSq() > 1e-6) {
        _ttRight.normalize();
        const qp = _ttQ2.setFromAxisAngle(_ttRight, dPolar);
        // Try the pitch on a copy of the camera: only apply it if the resulting
        // elevation stays inside the allowed range.
        _ttTest.copy(camera.position);
        _rotAround(_ttTest, C, qp);
        const e = _ttE.subVectors(_ttTest, C);
        const el = Math.atan2(e.y, Math.hypot(e.x, e.z));
        if (el >= TURNTABLE_MIN_EL && el <= TURNTABLE_MAX_EL) {
          camera.position.copy(_ttTest);
          _rotAround(controls.target, C, qp);
        }
      }
    }
    controls.update(); // resync + emite 'change' (persistencia de cámara / labels)
  }

  // Custom drag state (only active in 'turntable' mode).
  let _ttDragging = false, _ttLastX = 0, _ttLastY = 0;
  function onWorldPointerDown(ev: PointerEvent) {
    if (ev.button !== 0 || !camera || !controls) return;
    if (rotationMode === 'recenter') {
      // Anchor the rotation pivot to the centre of the offices before orbiting.
      const p = orbitPivot();
      controls.target.set(p.x, p.y, p.z);
      controls.update();
      return; // OrbitControls (enableRotate ON) hace el giro
    }
    // turntable: we handle the rotation ourselves
    _ttDragging = true;
    _ttLastX = ev.clientX; _ttLastY = ev.clientY;
  }
  function onWorldPointerMove(ev: PointerEvent) {
    if (!_ttDragging || rotationMode !== 'turntable') return;
    const dx = ev.clientX - _ttLastX, dy = ev.clientY - _ttLastY;
    _ttLastX = ev.clientX; _ttLastY = ev.clientY;
    if (dx === 0 && dy === 0) return;
    turntableRotate(orbitPivot(), -dx * TURNTABLE_ROT_SPEED, -dy * TURNTABLE_ROT_SPEED);
  }
  function onWorldPointerUp() {
    _ttDragging = false;
  }

  /** Aplica el modo a OrbitControls (enableRotate) y persiste la preferencia. */
  function setRotationMode(m: RotationMode) {
    rotationMode = m;
    _ttDragging = false;
    if (controls) controls.enableRotate = (m === 'recenter');
    try { localStorage.setItem(LS_ROTMODE, m); } catch { /* private mode — best effort */ }
  }

  /**
   * Resolve the agent id to auto-select at boot. Priority:
   *   1. ?agent=<id> en query string — deep-link, gana sobre lo persistido
   *   2. localStorage[LS_SELECTED] — the user's last selection
   * Returns undefined when there is nothing to restore.
   */
  // Snapshot of ?agent= at component init: the reactive
  // persistence (further down) runs with selectedAgent=null on the first flush
  // and WIPES the URL param before the agents load async — without
  // este snapshot el deep-link se pierde en esa carrera.
  const _deepLinkAgent: string | null = (() => {
    try {
      return typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('agent')
        : null;
    } catch { return null; }
  })();
  function pickInitialSelectedAgent(): string | undefined {
    try {
      if (_deepLinkAgent) return _deepLinkAgent;
      const sel = localStorage.getItem(LS_SELECTED);
      if (sel) return sel;
    } catch { /* ignore */ }
    return undefined;
  }

  /** One-shot flag: true once the initial restore from URL/LS has been
   *  attempted. Without it the auto-restore reactive block overrode the user
   *  on every `selectedAgent = null` and the modal's X "wouldn't close". */
  let _initialSelectionRestored = false;

  /** Restore selection and UI filters from URL/localStorage. Call after onMount. */
  function restoreUiState() {
    const want = pickInitialSelectedAgent();
    if (want && agents.some(a => a.id === want)) {
      selectedAgent = want;
      _initialSelectionRestored = true;
    }
  }

  /**
   * When the agents arrive after mount (async load from the parent),
   * `restoreUiState` ran with `agents=[]` and found no match. We retry
   * exactly ONCE as soon as the set is populated. This fixes the regression
   * where opening /agents-flow?agent=<id>, or having a previous selection, had
   * no effect — but it does NOT reopen the modal when the user closes it on
   * purpose (which was the bug: the block ran on every `selectedAgent = null`
   * LS before the persistence block wiped it).
   */
  $: if (!_initialSelectionRestored && !selectedAgent && agents.length > 0) {
    _initialSelectionRestored = true;
    const want = pickInitialSelectedAgent();
    if (want && agents.some(a => a.id === want)) selectedAgent = want;
  }

  // ?chat=chief — deep link to the direct channel with the top agent. Opens
  // only once the agents have loaded, so topAgent() resolves the real
  // name/insignia instead of the fallback label.
  let _deepLinkChat: boolean = (() => {
    try {
      return typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).get('chat') === 'chief';
    } catch { return false; }
  })();
  $: if (_deepLinkChat && agents.length > 0) {
    _deepLinkChat = false;
    showOfficeModal = true;
  }

  // Persist selectedAgent whenever it changes (reactive, minimal overhead).
  // When the user closes the modal (selectedAgent = null) we also clear the
  // `?agent=<id>` from the URL — without that, a previous deep link would
  // reopen it on any re-mount of the component.
  $: {
    try {
      if (selectedAgent) {
        localStorage.setItem(LS_SELECTED, selectedAgent);
      } else {
        localStorage.removeItem(LS_SELECTED);
        if (typeof window !== 'undefined' && window.history?.replaceState) {
          const url = new URL(window.location.href);
          if (url.searchParams.has('agent')) {
            url.searchParams.delete('agent');
            window.history.replaceState(null, '', url.toString());
          }
        }
      }
    } catch { /* ignore */ }
  }

  // ── Re-hydration from the server on F5 ─────────────────────────────
  // Queries the open meetings and restores the transcript so that a user who
  // had a meeting in progress doesn't lose the view on reload. The
  // runs already in the 'running' state show up automatically via the
  // `runningAgentIds` coming from the parent.
  async function hydrateLiveState() {
    try {
      const res = await fetch('/api/agents/conversations?kind=meeting&status=open&limit=20');
      if (!res.ok) return;
      const data = (await res.json()) as { conversations?: Array<{ id: string; topic: string; created_at: string; initiator_agent_id: string }> };
      if (!data.conversations?.length) return;

      // For each open meeting, fetch details + messages and populate liveMeetings.
      for (const conv of data.conversations) {
        try {
          const detail = await fetch(`/api/agents/conversations/${encodeURIComponent(conv.id)}`);
          if (!detail.ok) continue;
          const { conversation, messages, participants } = (await detail.json()) as {
            conversation: { id: string; topic: string; initiator_agent_id: string; created_at: string };
            messages: Array<{ from_agent_id: string; role: string; body: string; tokens: number; created_at: string }>;
            participants: Array<{ id: string; name: string }>;
          };
          if (!conversation) continue;
          // If the WS already delivered this meeting in the last few ms (the
          // raro), no sobreescribir.
          if (liveMeetings[conversation.id]) continue;

          const modId = conversation.initiator_agent_id || participants[0]?.id || '';
          const modName = participants.find(p => p.id === modId)?.name ?? 'Moderator';
          const turns = messages.map((m) => {
            const p = participants.find(x => x.id === m.from_agent_id);
            return {
              agentId: m.from_agent_id,
              agentName: p?.name ?? 'Agent',
              role: m.role,
              round: 0,
              body: m.body,
              ts: new Date(m.created_at).getTime(),
              tokens: m.tokens ?? 0,
            };
          });

          liveMeetings = {
            ...liveMeetings,
            [conversation.id]: {
              id: conversation.id,
              topic: conversation.topic,
              status: 'started',
              moderatorId: modId,
              moderatorName: modName,
              participants,
              turns,
              started_at: new Date(conversation.created_at).getTime(),
            },
          };

          // Reserve a room slot so that if a meeting_turn arrives later, the
          // id → roomIdx mapping stays consistent with the rest of the code.
          if (meetingRoomSlots.length > 0 && !meetingIdToRoom.has(conversation.id)) {
            const inUse = new Set(meetingIdToRoom.values());
            let roomIdx = meetingRoomSlots.findIndex((_, i) => !inUse.has(i));
            if (roomIdx < 0) roomIdx = meetingIdToRoom.size % meetingRoomSlots.length;
            meetingIdToRoom.set(conversation.id, roomIdx);

            // Recreate the in-progress meeting scene: the "meeting in
            // progress" sign + attendees walking in to sit down. Without this,
            // refreshing the page mid-meeting left the room empty, with no
            // banner (el evento meeting_requested ya pasó y no se re-emite).
            const room = meetingRoomSlots[roomIdx];
            if (scene && room) {
              spawnMeetingDecor(conversation.id, room, conversation.topic || 'Meeting');
              updateMeetingDecorTurn(conversation.id, `${turns.length} turns · en curso`);
              const seats = getMeetingSeatPositions(room);
              const doorPoint = hallCenterPos ? meetingRoomDoorPoint(room, hallCenterPos) : undefined;
              participants.forEach((p, i) => {
                if (!p?.id) return;
                const seat = seats[i % seats.length];
                sendWalkerToPoint(
                  scene, walkers, p.id, seat, deskPos, roomMap, corGrid, agents,
                  flowColor(p.id), undefined, deskAabbs, 'meeting', sittingWorkers,
                  false, doorPoint, undefined, false, meetingRoomSlots, roomIdx, true,
                  { x: room.cx, y: 0, z: room.cz }, // face the table
                );
              });
            }
          }
        } catch { /* single meeting fetch failed — carry on with the rest */ }
      }

      // After hydrating, surface the most recent active meeting in the
      // transcript modal so refreshing the page mid-meeting drops the user
      // Pick the freshest active meeting (so opening the transcript shows IT)
      // but do NOT auto-open the transcript modal on page mount.
      const live = Object.values(liveMeetings)
        .filter(m => m.status === 'started' || m.status === 'requested')
        .sort((a, b) => b.started_at - a.started_at);
      if (live.length > 0 && !activeMeetingId) {
        activeMeetingId = live[0].id;
      }
    } catch {
      // Fetch failed — don't block the rest of the mount. The user can
      // refrescar manual si quiere reintentar.
    }
  }

  function focusAgent() {
    if (!selectedAgent || !controls) return;
    const p = deskPos.get(selectedAgent); if (!p) return;
    tweenCameraTo(p.x, 1.2, p.z, camera.position.x, camera.position.y, camera.position.z);
  }

  /**
   * Animated zoom toward an office — fired when the user clicks an office
   * title (the 'office:focus' event from office.ts). Keeps the camera's
   * current angle but pulls the distance in to the size of the room.
   */
  function focusOffice(bounds: { cx: number; cz: number; w: number; d: number }) {
    if (!camera || !controls) return;
    const { cx, cz, w, d } = bounds;
    const targetY = 1.0;
    const size = Math.max(w, d);
    const minDist = (controls as any).minDistance ?? 15;
    const desiredDist = Math.max(size * 1.3, minDist + 1);

    // Preserve the user's current angle (unit vector target→camera).
    const dx = camera.position.x - controls.target.x;
    const dy = camera.position.y - controls.target.y;
    const dz = camera.position.z - controls.target.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / len, uy = dy / len, uz = dz / len;

    const camX = cx + ux * desiredDist;
    const camY = Math.max(targetY + uy * desiredDist, size * 0.7);
    const camZ = cz + uz * desiredDist;

    tweenCameraTo(cx, targetY, cz, camX, camY, camZ);
  }
  function onOfficeFocus(ev: Event) {
    const detail = (ev as CustomEvent).detail as { cx: number; cz: number; w: number; d: number };
    if (!detail) return;
    focusOffice(detail);
    for (const [flowId, room] of roomMap) {
      if (room.cx === detail.cx && room.cz === detail.cz) {
        dispatch('officeclick', { flowId });
        break;
      }
    }
  }

  // ── Imperative API for the /agents-flow shell (bind:this) ─────────
  export function focusOfficeById(flowId: string): boolean {
    const room = roomMap.get(flowId);
    if (!room) return false;
    focusOffice(room);
    return true;
  }

  /** Frame every room and meeting room. */
  export function fitAll(): void {
    if (!camera || !controls || roomMap.size === 0) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const boxes: Array<{ cx: number; cz: number; w: number; d: number }> = [...roomMap.values(), ...meetingRooms];
    for (const b of boxes) {
      minX = Math.min(minX, b.cx - b.w / 2);
      maxX = Math.max(maxX, b.cx + b.w / 2);
      minZ = Math.min(minZ, b.cz - b.d / 2);
      maxZ = Math.max(maxZ, b.cz + b.d / 2);
    }
    focusOffice({ cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, w: maxX - minX, d: maxZ - minZ });
  }

  export function togglePerfHud(): void { showPerfHud = !showPerfHud; }
  export function toggleRotationMode(): void { setRotationMode(rotationMode === 'turntable' ? 'recenter' : 'turntable'); }
  export function openHeadquartersInbox(): void { openTopAgentMessages(); }
  export function selectAgent(id: string | null): void { selectedAgent = id; }
  export function openRegisterRepo(): void { registerRepoModal?.open(); }
  /** Show a meeting's live transcript (from ActivityPanel, or once an agent opens one). The panel renders as soon as the meeting is known. */
  export function openLiveMeeting(id: string): void {
    activeMeetingId = id;
    showLiveMeeting = true;
    showMyOfficePanel = false;
    selectedAgent = null;
  }
  /** Bring back the minimised chat of the meeting the operator moderates. */
  export function openHumanMeeting(): void {
    if (meetingActive) meetingPanelOpen = true;
  }
  /** Close the world's right-hand surfaces before a shell drawer opens: the agent drawer, the live transcript, and the operator's meeting chat (minimised; the meeting keeps running). */
  export function closeRightPanels(): void {
    selectedAgent = null;
    showLiveMeeting = false;
    meetingPanelOpen = false;
  }

  // Tell the shell whenever the selection changes (desk click, drawer close,
  // selectAgent) — once per change, so the rail and the office panel follow.
  let lastDispatchedAgentId: string | null = null;
  $: if (selectedAgent !== lastDispatchedAgentId) {
    lastDispatchedAgentId = selectedAgent;
    dispatch('agentselect', { id: selectedAgent });
  }

  // The shell's ActivityPanel renders meetings, the management log and the
  // operator's own meeting; each is sent once per change.
  let lastMeetingsKey = '';
  $: {
    const key = liveMeetingsList.map((m) => `${m.id}:${m.status}:${m.turns.length}:${m.summary ?? ''}`).join('|');
    if (key !== lastMeetingsKey) {
      lastMeetingsKey = key;
      dispatch('meetings', { list: liveMeetingsList });
    }
  }
  let lastMgmtLog: MgmtEntry[] | null = null;
  $: if (mgmtLog !== lastMgmtLog) {
    lastMgmtLog = mgmtLog;
    dispatch('mgmtlog', { entries: mgmtLog });
  }
  let lastHumanKey = '';
  $: {
    const key = meetingActive ? `on:${meetingTopic}:${meetingSelectedIds.size}` : 'off';
    if (key !== lastHumanKey) {
      lastHumanKey = key;
      dispatch('humanmeeting', { active: meetingActive, topic: meetingTopic, attendees: meetingSelectedIds.size });
    }
  }
  // Once per false→true transition of the transcript panel, whoever opened it
  // (auto-open, a room sign, openLiveMeeting), so the shell can close its own panels.
  let lastShowLiveMeeting = false;
  $: if (showLiveMeeting !== lastShowLiveMeeting) {
    lastShowLiveMeeting = showLiveMeeting;
    if (showLiveMeeting) dispatch('liveopen', { id: activeMeetingId });
  }

  // Camera tween entry point — runs in the animation registry as a Ticker.
  // Panel-shift logic stays here; the ease itself is the shared cameraTween()
  // effect. Replacing an in-flight tween cancels the old one by tag so they
  // don't fight over the same `camera.position` lerp.
  function tweenCameraTo(lookX: number, lookY: number, lookZ: number, posX: number, posY: number, posZ: number) {
    // If a right-side panel is open (agent detail or office reports), shift
    // both target and camera along the camera's world-right axis so the scene
    // point visually lands on the left (uncovered) half of the viewport.
    const panelOpen = !!selectedAgent || showMyOfficePanel;
    if (panelOpen) {
      const zax = posX - lookX;
      const zaz = posZ - lookZ;
      const horizLen = Math.hypot(zax, zaz) || 1;
      const rx = zaz / horizLen;   // right axis X = (up × zaxis) / |·|, with up=+Y
      const rz = -zax / horizLen;  // right axis Z
      const dist = Math.hypot(posX - lookX, posY - lookY, posZ - lookZ);
      const shift = dist * 0.45;   // panel is ~55vw; lands the target near the center of the visible 45%
      lookX += rx * shift;
      lookZ += rz * shift;
      posX += rx * shift;
      posZ += rz * shift;
    }
    animRegistry.cancelByTag('camera-tween');
    animRegistry.add(cameraTween(camera, controls, {
      target: { x: lookX, y: lookY, z: lookZ },
      position: { x: posX, y: posY, z: posZ },
    }));
  }

  // ── Animation Loop ─────────────────────────────
  let lastFrameTime = 0;
  let sceneTimeSec = 0; // accumulated scene time in seconds for frame-rate-independent animation

  // Reusable frustum + projection matrix for pool culling — avoids per-frame
  // allocation. Lazily initialised on first animate() call.
  let _frustum: any = null;
  let _projScreenMatrix: any = null;
  // Reusable sphere for nameplate frustum culling (no per-frame allocation).
  let _labelSphere: any = null;
  // Timestamp of the last OrbitControls 'change' — while the camera is in
  // motion (including damping) the CSS2D labels render at FULL frame rate so
  // they stay glued to the scene instead of trailing at half rate.
  let lastControlChangeAt = 0;

  // Perf stats (computed inside animate loop and fed to PerfOverlay)
  const perfFrameTimes: number[] = [];
  const PERF_WINDOW = 180;
  let perfStats = { fps: 0, avgMs: 0, p99Ms: 0, calls: 0, tris: 0, geom: 0, tex: 0 };

  // NOTE: adaptive pixel-ratio downscaling was tried here and REMOVED — on
  // scenes that hover above the frame-time threshold it permanently blurred
  // the canvas (labels stay DOM-sharp, which makes the soft 3D render look
  // broken). Resolution stays fixed at the dpr≤1.5 cap; never trade it away.
  // Per-agent cached nameplate scale (distance × active/walking boost). Kept
  // outside the loop so we only touch the DOM when a label's scale changes.
  const labelScales = new Map<string, number>();

  // ── Adaptive quality (FPS-driven, resolution-safe) ──────────────────────
  // Honors the "never trade resolution away" rule above: instead of touching
  // pixelRatio we shed the expensive post passes when sustained FPS is low and
  // restore them when it recovers. Tiers: 2 = GTAO+bloom, 1 = bloom only,
  // 0 = no post. Hysteresis (counted in ~100ms samples) keeps it from
  // oscillating; restore is deliberately slower than degrade.
  function updateAdaptiveQuality(avgMs: number): void {
    if (!composer || (!gtaoPass && !bloomPass)) return;
    const LOW = 26;   // >26ms (~38fps) sustained → step down
    const HIGH = 17;  // <17ms (~59fps) sustained → step up
    if (avgMs > LOW) { qLowFrames++; qHighFrames = 0; }
    else if (avgMs < HIGH) { qHighFrames++; qLowFrames = 0; }
    else { qLowFrames = 0; qHighFrames = 0; }

    if (qLowFrames >= 12 && qualityTier > 0) {        // ~1.2s of pain → degrade
      qualityTier--; qLowFrames = 0;
    } else if (qHighFrames >= 25 && qualityTier < 2) { // ~2.5s of headroom → restore
      qualityTier++; qHighFrames = 0;
    } else return;

    // Apply: GTAO only at tier 2; bloom at tier ≥1.
    if (gtaoPass) gtaoPass.enabled = qualityTier >= 2;
    if (bloomPass) bloomPass.enabled = qualityTier >= 1;
  }

  function animate(now: number = performance.now()) {
    animId = requestAnimationFrame(animate);
    fc++;
    if (!renderer || !scene || !camera) return;
    const deltaSec = lastFrameTime > 0 ? Math.min(0.1, (now - lastFrameTime) / 1000) : 1 / 60;
    lastFrameTime = now;
    sceneTimeSec += deltaSec;
    controls.update();

    // Drive every registered Ticker — camera tweens, halo pulses, trade
    // particles, bubble fades. Finished tickers self-dispose and drop out.
    animRegistry.tick(deltaSec, sceneTimeSec);

    // Build set of agents currently being spoken to (a walker arrived at their desk)
    const beingSpokenTo = new Set<string>();
    for (const w of walkers) {
      if (w.arrived && !w.returning && w.targetId !== 'meeting') {
        beingSpokenTo.add(w.targetId);
      }
    }

    // ── Meeting speaker spotlight ─────────────────────────────────────
    // For every meeting that's currently in 'started' status with a
    // currentSpeakerId, dim every other seated participant and brighten
    // the speaker. Cheap material-opacity tweak, no shader work — runs
    // every frame so a turn change is visible within ~16ms.
    const speakerSet = new Set<string>();
    const listenerSet = new Set<string>();
    for (const m of Object.values(liveMeetings)) {
      if (m.status !== 'started') continue;
      if (!m.currentSpeakerId) continue;
      speakerSet.add(m.currentSpeakerId);
      for (const p of (m.participants ?? [])) {
        if (p.id && p.id !== m.currentSpeakerId) listenerSet.add(p.id);
      }
    }
    for (const w of walkers) {
      if (w.targetId !== 'meeting' || !w.arrived || w.returning) continue;
      const isSpeaker = speakerSet.has(w.sourceId);
      const isListener = listenerSet.has(w.sourceId);
      const targetOp = isSpeaker ? 1.0 : isListener ? 0.55 : 1.0;
      const mats = w.fadeMats;
      if (!mats) continue;
      // Smooth interpolate so changes between turns aren't jarring.
      for (let j = 0; j < mats.length; j++) {
        const m = mats[j];
        m.transparent = true;
        const cur = m.opacity ?? 1;
        m.opacity = cur + (targetOp - cur) * 0.18;
        // Speaker gets a warm glow on top of the existing color so the
        // viewer's eye lands on them without losing per-flow color cues.
        // While this agent is hovered, leave the emissive to setAgentHover().
        if (w.sourceId !== hoveredAgent && m.emissive && typeof m.emissive.setRGB === 'function') {
          if (isSpeaker) {
            const intensity = 0.18 + 0.08 * Math.sin(sceneTimeSec * 4 + (w.talkPhase ?? 0));
            m.emissive.setRGB(intensity * 1.4, intensity * 1.0, intensity * 0.2);
            (m as any).emissiveIntensity = 1.0;
          } else {
            m.emissive.setRGB(0, 0, 0);
          }
        }
      }
      // Pop the speaker slightly above the seated pose so the head pokes
      // visually above the listeners on long shots.
      const targetY = isSpeaker ? -0.30 : -0.45;
      w.group.position.y += (targetY - w.group.position.y) * 0.18;
    }

    // Meeting halo pulses are registered per meeting in spawnMeetingDecor()
    // with a `while` predicate so they self-remove when disposeMeetingDecor()
    // drops the entry. No per-frame loop needed here.

    // ── Nameplate LOD + scaling: measured per-label as the distance from each
    // ── desk to the CAMERA (not the orbit target). The target sits at the
    // office centre; in a large/expanded office you orbit at a big radius
    // around that centre, so distance-to-centre stays ≥90u and the labels
    // never reappear even when you've zoomed right up to a desk. Measuring each
    // desk against the camera position is office-size independent and survives
    // pan/orbit. Grows on close-up, hides when far.
    //
    //   desk ≤ 12u from camera → 1.4×   (close-up — readable from above a desk)
    //   desk ~ 30u             → 1.0×   (normal inspection)
    //   desk ≥ 70u             → hidden (pulled back / far across the floor)
    {
      const camX = camera.position.x, camY = camera.position.y, camZ = camera.position.z;

      // ── Camera frustum — computed once per frame here; shared by the
      // nameplate culling below and the humanoid pool culling further down.
      camera.updateMatrixWorld();
      if (_frustum) {
        _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        _frustum.setFromProjectionMatrix(_projScreenMatrix);
      }

      // Collect agents whose avatar is currently walking (the source agent of
      // any active walker) — their label tracks the moving avatar, so it's the
      // focus of attention: always shown, EXEMPT from distance LOD + frustum.
      const walkingIds = new Set<string>();
      for (const w of walkers) if (w.sourceId) walkingIds.add(w.sourceId);

      // ── Per-label distance LOD (to camera) + frustum cull ──
      // A nameplate shows when its desk is within range of the CAMERA, hides
      // when far. Hysteresis (show ≤70u, keep until >82u) avoids flicker right
      // at the boundary, read off the label's own current visibility. The
      // frustum cull then drops on-range but off-screen labels so CSS2DRenderer
      // skips their DOM transform — what keeps full-rate label rendering cheap.
      const LBL_SHOW2 = 70 * 70;
      const LBL_HIDE2 = 82 * 82;
      for (const [aid, lbl] of deskLabels) {
        if (walkingIds.has(aid)) { if (!lbl.visible) lbl.visible = true; continue; }
        let vis = true;
        const p = deskPos.get(aid);
        if (p) {
          const dx = camX - p.x, dy = camY - 1.6, dz = camZ - p.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          vis = lbl.visible ? d2 <= LBL_HIDE2 : d2 <= LBL_SHOW2;
          if (vis && _frustum) {
            _labelSphere.center.set(p.x, 1.6, p.z);
            vis = _frustum.intersectsSphere(_labelSphere);
          }
        }
        if (lbl.visible !== vis) lbl.visible = vis;
      }

      // Nameplate scale by per-label camera distance (close = bigger) + active
      // boost. Only touch the DOM when a visible label's scale actually changed.
      const ACTIVE_BOOST = 1.2;                          // running / walking agents get ~20% bigger labels
      for (const [aid, lbl] of deskLabels) {
        if (!lbl.visible) continue; // hidden / culled — skip the DOM scale write too
        let d = 30;
        // Measure to where the label ACTUALLY is, not to the agent's desk.
        // The follow-the-walker block above moves a label to its agent's
        // current position, but this loop kept sizing it by desk distance —
        // so six agents sitting around one meeting table were scaled by how
        // far their home offices happen to be from the camera, and the same
        // table showed six different label sizes. That is the "distintos
        // tamaños" the operator sees; it has nothing to do with the styling.
        const p = { x: lbl.position.x, z: lbl.position.z };
        {
          const dx = camX - p.x, dy = camY - 1.6, dz = camZ - p.z;
          d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        const baseScale = d <= 30
          ? Math.max(1.0, Math.min(1.4, 1.4 - (d - 12) / 18 * 0.4))
          : Math.max(0.5, Math.min(1.0, 1.0 - (d - 30) / 100));
        const boosted = runningAgentIds.has(aid) || walkingIds.has(aid);
        const scale = baseScale * (boosted ? ACTIVE_BOOST : 1);
        const prev = labelScales.get(aid) ?? -1;
        if (Math.abs(scale - prev) < 0.01) continue;
        labelScales.set(aid, scale);
        const inner = lbl.element?.firstElementChild as HTMLElement | null;
        if (inner) {
          inner.style.transform = `scale(${scale.toFixed(2)})`;
          inner.style.transformOrigin = 'center bottom';
        }
      }
    }

    // Sitting workers (timeSec-based animation).
    // Pool path: write per-slot anim modes, then a single pool.update()
    // recomputes 13 InstancedMesh × N matrices in one go.
    // Individual path: per-worker animateSitting (legacy).
    let slotIdx = 0;
    for (const [aid, sw] of sittingWorkers) {
      const isRunning = runningAgentIds.has(aid);
      const isSpokenTo = beingSpokenTo.has(aid);

      // (#10) Idle stretch — if the agent has had no event for
      // IDLE_BEFORE_STRETCH_SEC and is not currently busy, play a stretch
      // pose for STRETCH_DURATION_SEC, then cool down before the next one.
      let isStretching = false;
      const lastSec = lastActivitySec.get(aid) ?? sceneTimeSec;
      const stretch = stretchState.get(aid);
      if (stretch && sceneTimeSec < stretch.endSec) {
        isStretching = true;
      } else if (
        !isRunning && !isSpokenTo &&
        sceneTimeSec - lastSec > IDLE_BEFORE_STRETCH_SEC &&
        (!stretch || sceneTimeSec > stretch.nextEligibleSec)
      ) {
        stretchState.set(aid, {
          endSec: sceneTimeSec + STRETCH_DURATION_SEC,
          nextEligibleSec: sceneTimeSec + STRETCH_DURATION_SEC + STRETCH_COOLDOWN_SEC,
        });
        isStretching = true;
      }

      if (sw.pooled) {
        humanoidPool?.setAnimMode(slotIdx, isRunning, isSpokenTo, isStretching);
        slotIdx++;
      } else if (sw.group) {
        animateSitting(sw.group, sceneTimeSec, sw.phase, isRunning, isSpokenTo, isStretching);
      }
      const dg = deskGroups.get(aid);
      if (dg) {
        const mon = dg.userData._monitor;
        if (mon?.material) {
          mon.material.emissiveIntensity = isRunning
            ? 0.25 + 0.15 * Math.sin(sceneTimeSec * 3.6 + sw.phase)
            : (agentById.get(aid)?.active ? 0.12 : 0.02);
        }
      }
    }
    // Single InstancedMesh matrix update for all pooled humanoids in one shot.
    // The camera frustum was computed once in the nameplate block above —
    // off-screen slots get a zero-scale matrix and skip body-part composition.
    if (humanoidPool) {
      humanoidPool.update(sceneTimeSec, _frustum, 2.5);
    }

    // Walkers — pass deltaSec for constant world speed and sittingWorkers for restore on return
    updateWalkers(scene, walkers, (targetId) => {
      if (typeof targetId === 'string' && targetId.startsWith('delivery_pickup_')) {
        markPackagePickedUp(targetId.substring('delivery_pickup_'.length));
      } else {
        showAnimatedTag(targetId, { icon: '📬', anim: 'bounce', label: 'RECEIVED', durationFrames: 150 });
      }
    }, deltaSec, sittingWorkers);

    // Name/rank labels (built at each desk at scene time) sit static at the
    // desk position. When a walker exists for that agent, follow the walker
    // instead so the "cartel" appears above the moving worker. When the walker
    // returns to the desk, the label naturally snaps back to the desk (because
    // walker.group.position converges on the desk position again) — we detect
    // the returned state and restore the original desk-anchored position.
    if (deskLabels.size > 0 || speechBubbles.size > 0) {
      const walkerByAgent = new Map<string, any>();
      for (const w of walkers) walkerByAgent.set((w as any).sourceId, w);

      // Name/rank labels (deskLabels) live in scene space — set their world
      // position directly to walker-or-desk.
      for (const [agentId, lbl] of deskLabels) {
        const w = walkerByAgent.get(agentId);
        const dp = deskPos.get(agentId);
        if (w && !((w as any).returning && (w as any).progress >= 1)) {
          const g = (w as any).group;
          if (g) lbl.position.set(g.position.x, 3.2, g.position.z);
        } else if (dp) {
          if (Math.abs(lbl.position.x - dp.x) > 0.05 || Math.abs(lbl.position.z - dp.z) > 0.05) {
            lbl.position.x = dp.x;
            lbl.position.z = dp.z;
          }
        }
      }

      // NOTE: event tags used to be reparented here every frame so they would
      // follow a walking agent. They are spans inside the nameplate now, so
      // they follow it for free and this pass is gone.
    }

    // Delivery system — truck + driver animation (triggered by inbound events)
    updateDelivery(scene, deltaSec);
    updateTaxis(scene, deltaSec);

    // Ambiance: clock hands, elevator doors
    updateAmbiance(sceneTimeSec);
    // Infra power console: ease the master lever + pulse booting/error LEDs.
    updateInfraConsole(deltaSec, sceneTimeSec);
    // Door LEDs: green=running, grey=idle
    updateDoorLeds(runningAgentIds, agents);

    // Speech bubble fades are registered in showBubble/showGradeBubble as
    // bubbleFade() tickers. They self-remove from the registry, scene and DOM
    // when their `maxAge` (in frames) elapses.

    // Hover highlight — only on the frame the hover target actually changed,
    // so we never iterate desks/walkers every frame. setAgentHover() lights the
    // agent wherever it is: the moving/seated walker body if one exists,
    // otherwise the seated desk top.
    if (hoveredAgent !== lastHoveredAgent) {
      if (lastHoveredAgent) setAgentHover(lastHoveredAgent, false);
      if (hoveredAgent) setAgentHover(hoveredAgent, true);
      lastHoveredAgent = hoveredAgent;
    }

    // Trade celebrations are registered per spawn in spawnTradeCelebration()
    // as risingParticles() tickers; they self-dispose at maxAge.

    processEvents();
    // Shadow pass cadence — see renderer init (autoUpdate=false). While walkers
    // are on the move re-bake EVERY frame so their shadow tracks the body
    // instead of trailing it at 30Hz (the half-rate shadow reads as lag). When
    // the floor is idle, the cheaper even-frame cadence is indistinguishable.
    if (walkers.length > 0 || fc % 2 === 0) renderer.shadowMap.needsUpdate = true;
    // Reset stats just before rendering so the per-frame accumulator captures
    // exactly this frame's draws / tris (across all passes).
    renderer.info.reset();
    // Use EffectComposer (bloom) if available, fallback to direct render
    if (composer) {
      composer.render(deltaSec);
    } else {
      renderer.render(scene, camera);
    }
    // Label renderer (CSS2D) is expensive: it traverses every CSS2DObject
    // and writes a 4×4 transform to its DOM element. Cadence is motion-aware:
    //  - camera moving (including damping): render EVERY frame — at half rate
    //    the labels visibly trail the 3D scene and the whole view reads
    //    laggy/slow. The per-label frustum culling above keeps this cheap.
    //  - camera at rest: every 3rd frame is plenty (only walkers/scale tweaks
    //    move labels then), which is cheaper than the old every-2nd-frame.
    // Walkers move every frame and carry their name tag + speech bubble, so if
    // labels render at the every-3rd-frame rest cadence the tags visibly trail
    // the moving body (reads as "laggy walkers"). Treat any active walker like
    // camera motion → full-rate labels while someone is on the move.
    const cameraMoving = now - lastControlChangeAt < 160;
    const labelsNeedFullRate = cameraMoving || walkers.length > 0;
    if (labelsNeedFullRate || fc % 3 === 0) {
      labelRenderer.render(scene, camera);
    }

    // ── Perf stats: feed PerfOverlay reactively. Updated every 6 frames
    //    (~10Hz). The threshold is just 5 samples so the readout shows real
    //    numbers within ~100ms even on slow rates / headless throttling.
    perfFrameTimes.push(deltaSec * 1000);
    if (perfFrameTimes.length > PERF_WINDOW) perfFrameTimes.shift();
    if (fc % 6 === 0 && perfFrameTimes.length >= 5) {
      let sum = 0;
      for (const t of perfFrameTimes) sum += t;
      const avg = sum / perfFrameTimes.length;
      const sorted = [...perfFrameTimes].sort((a, b) => b - a);
      const cutoff = Math.max(1, Math.floor(sorted.length * 0.01) || 1);
      let worst = 0;
      for (let i = 0; i < cutoff; i++) worst += sorted[i];
      perfStats = {
        fps: avg > 0 ? 1000 / avg : 0,
        avgMs: avg,
        p99Ms: worst / cutoff,
        calls: renderer.info.render.calls,
        tris: renderer.info.render.triangles,
        geom: renderer.info.memory.geometries,
        tex: renderer.info.memory.textures,
      };
      // Feed the rolling average into the adaptive-quality controller so heavy
      // post passes are shed/restored to keep animations smooth.
      updateAdaptiveQuality(avg);
    }
  }

  /** Headcount per office (keyed by flow id, same key as roomMap) — feeds the
   *  "N AGENTS · M ON" subline on every room sign. */
  function computeRoomCounts(): Map<string, { total: number; active: number }> {
    const m = new Map<string, { total: number; active: number }>();
    for (const a of agents) {
      if (!a.flow_id) continue;
      let e = m.get(a.flow_id);
      if (!e) { e = { total: 0, active: 0 }; m.set(a.flow_id, e); }
      e.total++;
      if (a.active === 1) e.active++;
    }
    return m;
  }

  /** Live-patch the sign sublines (active toggles don't rebuild the static
   *  scene, so the DOM is updated in place — cheap, runs on data refresh). */
  function updateRoomSignCounts(): void {
    const counts = computeRoomCounts();
    document.querySelectorAll('[data-room-sub]').forEach((el) => {
      const rc = counts.get((el as HTMLElement).getAttribute('data-room-sub') ?? '');
      if (!rc) return;
      el.textContent = `${rc.total} ${rc.total === 1 ? 'AGENT' : 'AGENTS'} · ${rc.active} ON`;
      (el as HTMLElement).style.color = rc.active > 0 ? '#9fe8c0' : '#6a7390';
    });
  }

  /** Repaint one office's door-sign infra line from infraState (live, no
   *  rebuild). Hidden until a state is known so unconfigured offices stay clean. */
  function updateInfraSign(flowId: string): void {
    // NB: no CSS.escape here — it escapes for identifier context, which would
    // backslash the UUID's hyphens and break the quoted attribute match.
    const el = document.querySelector(`[data-infra-sign="${flowId}"]`) as HTMLElement | null;
    if (!el) return;
    const st = infraState.get(flowId);
    if (!st || st === 'absent') { el.style.display = 'none'; return; }
    const vis = INFRA_VIS[st];
    const hex = '#' + vis.hex.toString(16).padStart(6, '0');
    el.style.display = 'block';
    el.style.color = hex;
    el.textContent = `⚡ ${vis.text}`;
  }
  function updateInfraSignsAll(): void {
    for (const fid of infraState.keys()) updateInfraSign(fid);
  }

  /** Apply a new infra state for an office everywhere: badge sign + console
   *  breaker + ops board. Central so every surface stays in sync. */
  function applyInfraState(flowId: string, st: InfraState): void {
    infraState.set(flowId, st);
    setInfraBreaker(flowId, st);
    updateInfraSign(flowId);
  }

  /** Map a kernel container action → the steady state it settles into. */
  function infraStateForAction(action: string, ok: boolean): InfraState {
    if (!ok) return 'error';
    switch (action) {
      case 'up': case 'resume': case 'restart': return 'running';
      case 'stop': return 'stopped';
      case 'pause': return 'paused';
      default: return 'running';
    }
  }

  /** Pick the agent who walks to the Repos Office for a flow's infra toggle:
   *  the office manager (prefer active), else any active agent in the flow. */
  function infraResponsibleAgent(flowId: string): string | null {
    const inFlow = agents.filter(a => a.flow_id === flowId);
    if (inFlow.length === 0) return null;
    const mgrActive = inFlow.find(a => (a as any).role === 'manager' && a.active === 1);
    if (mgrActive) return mgrActive.id;
    const mgr = inFlow.find(a => (a as any).role === 'manager');
    if (mgr) return mgr.id;
    const anyActive = inFlow.find(a => a.active === 1);
    return (anyActive ?? inFlow[0]).id;
  }

  /** Dramatic per-office effect when its power lands: a rising pillar of light
   *  (ON) or a dim red flash (OFF), plus a state chyron above the office. */
  function spawnInfraSurge(flowId: string, st: InfraState): void {
    const room = roomMap.get(flowId);
    if (!room || !scene) return;
    const vis = INFRA_VIS[st];
    const hex = '#' + vis.hex.toString(16).padStart(6, '0');
    const name = (flows.find(f => f.id === flowId)?.name || 'OFFICE').toUpperCase();
    if (st === 'running') {
      animRegistry.add(pillarOfLight(scene, {
        position: { x: room.cx, y: 0.05, z: room.cz },
        height: 6, radius: Math.min(room.w, room.d) * 0.32,
        color: vis.hex, durationSec: 2.6, peakOpacity: 0.4, tag: `infra:${flowId}`,
      }));
    }
    animRegistry.add(chyronLabel(scene, {
      position: { x: room.cx, y: 3.4, z: room.cz },
      html: `<div style="font:800 11px 'Fira Code',monospace;letter-spacing:1px">⚡ ${escapeHtml(name)}</div>` +
            `<div style="font:700 13px 'Fira Code',monospace;color:${hex};margin-top:2px">${vis.text}</div>`,
      color: hex, durationSec: 2.8, riseHeight: 0.6, tag: `infra-chyron:${flowId}`,
    }));
  }

  /** Handle an `office:infra:changed` event: walk the responsible manager to
   *  the Repos Office power console, flip the breaker, and land the new state
   *  on every surface (badge sign + console LED + ops board). */
  function handleInfraToggle(data: { flow_id?: string; action?: string; ok?: boolean }): void {
    const flowId = String(data?.flow_id ?? '');
    if (!flowId) return;
    const action = String(data?.action ?? 'up');
    const ok = data?.ok !== false;
    const finalState = infraStateForAction(action, ok);
    const turningOn = finalState === 'running';
    const name = (flows.find(f => f.id === flowId)?.name || 'OFFICE').toUpperCase();
    const operatorPos = getInfraOperatorPos();
    const facePos = getInfraFacePos();
    const responsible = infraResponsibleAgent(flowId);

    // Settle the new state directly (badge + console) when we can't stage the
    // walk (no Repos Office in this layout, or nobody available to send).
    const settle = () => {
      applyInfraState(flowId, finalState);
      setInfraReadout(`${name} · ${INFRA_VIS[finalState].text}`, ok && finalState !== 'error');
      spawnInfraSurge(flowId, finalState);
    };
    if (!operatorPos || !responsible || !deskPos.has(responsible) || !scene) {
      settle();
      return;
    }

    // Stage the walk: transient state while the manager heads over.
    const transient: InfraState = turningOn ? 'booting' : (finalState === 'error' ? 'error' : infraState.get(flowId) ?? 'running');
    applyInfraState(flowId, transient);
    setInfraReadout(`${name} · ${action.toUpperCase()}…`, ok);

    const color = flows.find(f => f.id === flowId)?.color || '#8fd6ff';
    const onArrive = () => {
      // At the console: throw the master lever + readout, then let the infra
      // "settle" after a short boot/shutdown beat.
      flipInfraLever(turningOn);
      setInfraReadout(`${name} · ${turningOn ? 'POWERING ON' : 'POWERING OFF'}`, ok);
      setInfraBreaker(flowId, transient);
      setTimeout(() => settle(), turningOn ? 1500 : 800);
    };
    sendWalkerToPoint(
      scene, walkers, responsible, operatorPos, deskPos, roomMap, corGrid,
      agents, color, undefined, deskAabbs,
      'infra', sittingWorkers, /*urgent*/ false,
      undefined,            // no viaPoint
      onArrive,             // operate the console on arrival
      false,                // no carried note
      undefined, undefined, // meetingRoomObstacles / exempt
      undefined,            // stay (auto-return after operating)
      facePos ?? undefined, // face the console
    );
  }

  // Track last layout fingerprint to detect when static structure needs rebuild
  let lastLayoutKey = '';
  let staticGroup: any = null; // Group holding floor, corridors, rooms — only rebuilt on layout change

  // Cheap fingerprint of everything the scene actually depends on. Parent polls
  // every minute and reassigns graphData, which would otherwise re-trigger the
  // reactive block on every tick even when nothing structural changed.
  let lastReactiveKey = '';
  function sceneFingerprint(): string {
    const a = agents.map(x => `${x.id}:${x.flow_id}:${x.active}:${x.rank_id ?? ''}:${x.skin_id ?? ''}:${x.name}`).sort().join('|');
    const c = chains.map(x => `${x.source_agent_id}>${x.target_agent_id}:${x.active}`).sort().join('|');
    const f = flows.map(x => `${x.id}:${x.kind ?? ''}:${x.name}:${x.color}:${x.active}`).sort().join('|');
    const r = ranks.map(x => `${x.id}:${x.color}:${x.insignia}:${x.level}`).sort().join('|');
    return `${a}#${c}#${f}#${r}`;
  }

  // Active-flag transitions FIRST — must run before rebuildScene so the
  // ARRIVE walker exists when buildDesks creates the seated worker; the
  // syncSeatedVisibility at the end of rebuildScene then hides the just-
  // created seated worker until the walker arrives.
  $: if (agents.length > 0 && scene && THREE && deskPos.size > 0 && receptionFrontPos) {
    detectActiveChanges();
  }

  $: if (agents.length > 0 && THREE) {
    const key = sceneFingerprint();
    if (key !== lastReactiveKey) {
      lastReactiveKey = key;
      const plan = computeFloorPlan(agents, chains, flows, ranks);
      deskPos = plan.deskPositions; roomMap = plan.rooms; corGrid = plan.corridorGrid; meetingRooms = plan.meetingRooms ?? []; hallExtensions = plan.hallExtensions ?? [];
      rebuildScene();
      // Active toggles reach here without a static rebuild — refresh the
      // "N AGENTS · M ON" sublines on the room signs in place.
      updateRoomSignCounts();
      // Offices are now populated with seated agents — let the readiness gate
      // dissolve the loader (it also checks dataLoaded etc.).
      officePopulated = true;
      maybeRevealScene();
      // (#F4) Prime the onboarding diff AFTER the first populate so the initial
      // roster doesn't all "onboard" at once. Subsequent additions animate.
      if (!onboardingPrimed) {
        seenAgentIds = new Set(agents.map(a => a.id));
        onboardingPrimed = true;
      }
    }
  }

  // Boot readiness gate — re-check whenever any input changes (parent's first
  // fetch resolving, an empty-system confirmation, or the office populating).
  // Covers the "empty system" path: dataLoaded with zero agents reveals the
  // (empty) office instead of spinning forever.
  $: { dataLoaded; dataError; agents; staticBuilt; officePopulated; bootError; maybeRevealScene(); }

  // Boot checklist shown in the loader — each step flips to ✓ as it completes,
  // so the user sees real progress instead of a fake animated list.
  $: bootSteps = [
    { label: 'núcleo de render', done: staticBuilt },
    { label: 'building offices', done: staticBuilt },
    { label: 'syncing data', done: dataLoaded },
    { label: 'deploying staff', done: officePopulated || (dataLoaded && agents.length === 0) },
  ];
  function retryBoot(): void {
    if (bootError) { if (typeof location !== 'undefined') location.reload(); return; }
    bootError = null;
    dispatch('refresh');
  }

  // (#9) Rank promotion detection — watches `agents` × `ranks` for level bumps
  // and fires a pillar-of-light over the promoted agent's desk. The first
  // observation primes the cache; subsequent diffs trigger the animation.
  $: if (agents.length > 0 && ranks.length > 0 && scene && THREE && deskPos.size > 0) {
    detectRankPromotions();
  }

  // (#F4) Onboarding — once primed + scene ready, diff `agents` against the
  // seen set. New ids run a NEW-RECRUIT sequence (taxi → commute walker →
  // banner). Vanished ids are dropped so a re-add re-onboards. No FX cap.
  $: if (onboardingPrimed && agents.length > 0 && scene && THREE && deskPos.size > 0 && receptionFrontPos) {
    detectOnboarding();
  }

  function rebuildScene() {
    if (!scene || !THREE) return;

    // Fingerprint: agent IDs + flow assignments + flow count + each flow's kind/name/color
    // (kind picks the room theme, name the door sign, color the floor/sign). If unchanged, only desks need refreshing.
    const flowLayoutKey = flows.map(f => `${f.id}:${f.kind ?? ''}:${f.name}:${f.color}`).sort().join('|');
    const layoutKey = agents.map(a => `${a.id}:${a.flow_id}`).sort().join('|') + `|${flows.length}|${meetingRooms.length}|${flowLayoutKey}`;
    const layoutChanged = layoutKey !== lastLayoutKey;
    lastLayoutKey = layoutKey;

    if (layoutChanged) {
      // Full rebuild — remove static geometry group and recreate
      if (staticGroup) {
        staticGroup.traverse((c: any) => { c.geometry?.dispose(); if (c.material) { if (Array.isArray(c.material)) c.material.forEach((m: any) => m.dispose()); else c.material.dispose(); } });
        scene.remove(staticGroup);
      }
      staticGroup = new THREE.Group();
      staticGroup.userData._static = true;

      buildFloor(staticGroup, corGrid.buildingBounds);
      const hallHint = meetingRooms[1] ?? meetingRooms[0];
      const entranceHint = hallHint ? { cx: hallHint.cx, width: hallHint.w } : undefined;
      buildStreets(staticGroup, corGrid.buildingBounds, entranceHint);
      buildCorridorGrid(staticGroup, corGrid);
      buildRooms(staticGroup, roomMap, computeRoomCounts());
      buildThemedOffices(staticGroup);
      buildSpecialRooms(staticGroup);
      buildAmbiance(staticGroup, corGrid.buildingBounds, corGrid.nodes, entranceHint);
      if (hallCenterPos) {
        const hSlot = meetingRooms[1] ?? meetingRooms[0];
        buildActivityBoard(staticGroup, hallCenterPos.x, hallCenterPos.z, hSlot?.d ?? 8);
      }
      buildDoorLeds(staticGroup, roomMap);
      // buildElevator(staticGroup, corGrid.buildingBounds); // hidden for now

      // ── Red Alert decor — additive props, no geometry changes ─────
      buildRedAlertDecor(staticGroup, entranceHint);

      scene.add(staticGroup);
      resetDelivery();
      resetTaxis(scene);
      installDeliveryContext();
    }

    // Always refresh desks (running state, active state can change without layout change)
    // Remove old desk groups, labels, instanced meshes, and hallway lines
    for (const [, g] of deskGroups) {
      g.traverse((c: any) => { c.geometry?.dispose(); if (c.material) { if (Array.isArray(c.material)) c.material.forEach((m: any) => m.dispose()); else c.material.dispose(); } });
      scene.remove(g);
    }
    // Removing a CSS2DObject from the scene graph does NOT remove its DOM
    // node — CSS2DRenderer leaves the <div> frozen at its last position. Drop
    // the element too, or every rebuildScene stacks a second (offset) copy of
    // each nameplate on top of the fresh one.
    for (const [, l] of deskLabels) { if (l.parent) l.parent.remove(l); l.element?.remove(); }
    for (const h of hallwayLines) { scene.remove(h.line); h.line.geometry.dispose(); h.line.material.dispose(); }
    // Remove old InstancedMesh objects (they sit directly on the scene)
    const instToRemove: any[] = [];
    scene.children.forEach((c: any) => { if (c.isInstancedMesh) instToRemove.push(c); });
    for (const inst of instToRemove) { scene.remove(inst); inst.geometry?.dispose(); inst.material?.dispose(); }

    deskGroups.clear(); deskLabels.clear(); sittingWorkers.clear(); deskAabbs.clear();
    // Tear down the previous pool (its InstancedMeshes were just removed
    // above with the rest of the scene's instanced meshes) and rebuild a
    // fresh one sized to the new agent count.
    if (USE_HUMANOID_POOL) {
      humanoidPool?.dispose();
      const activeCount = agents.filter(a => a.active === 1).length;
      // Resolve the default skin's pool factory. Agents with non-default
      // skin_ids render per-mesh (handled in furniture.ts).
      const defaultSkin = resolveSkin(undefined);
      humanoidPool = defaultSkin.createPool
        ? defaultSkin.createPool(scene, Math.max(8, Math.ceil(activeCount * 1.2)))
        : null;
    } else {
      humanoidPool = null;
    }

    const r = buildDesks(scene, agents, flows, deskPos, runningAgentIds, ranks, humanoidPool);
    deskGroups = r.deskGroups; deskLabels = r.deskLabels; sittingWorkers = r.sittingWorkers; deskAabbs = r.deskAabbs;
    // The top agent is filtered out of buildDesks (no flow grid slot for
    // him). His seated entry was wiped by sittingWorkers.clear() above, so
    // re-add it now that the new map is in place.
    ensureTopAgentWiring();
    hallwayLines = buildHallways(scene, chains, deskPos, agents, flows);

    // CRITICAL: hide seated workers for agents that currently have an active walker.
    // Without this, a rebuild creates fresh visible workers while the walker is still out.
    syncSeatedVisibility(walkers, sittingWorkers);
  }

  // Repos registry refresh — fires every 60s so newly registered repos light
  // up their rack within a minute. The poll is on a separate cadence from the
  // agents WS feed (which would over-rebuild the static scene); we only force
  // a scene rebuild when the count changes.
  let reposRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let infraRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let questionsRefreshTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    // (The drawer's extension-contributed tabs load in AgentPanel's onMount.)
    const plan = computeFloorPlan(agents, chains, flows, ranks);
    deskPos = plan.deskPositions; roomMap = plan.rooms; corGrid = plan.corridorGrid; meetingRooms = plan.meetingRooms ?? []; hallExtensions = plan.hallExtensions ?? [];
    // Build the scene; surface any fatal error on the loader instead of leaving
    // it spinning forever (the old behavior on a mid-build throw).
    buildScene()
      .then(() => {
        // Hydration has to run AFTER the scene exists. It re-seats the
        // attendees of a meeting that was already in progress when this page
        // loaded, and to do that it needs `meetingRoomSlots` — which is only
        // assigned while the scene is built. buildScene() is async and was
        // never awaited, so hydration fired first, found zero rooms, skipped
        // the whole re-seat + banner block, and never retried. Opening the
        // dashboard while a meeting was running therefore showed an empty
        // meeting room, no halo and no banner, for the rest of the session —
        // which reads as "the meeting is broken" when it is running fine.
        hydrateLiveState();
      })
      .catch((e: any) => {
        console.error('[buildScene] failed:', e);
        bootError = 'No se pudo construir la escena 3D: ' + (e?.message ?? String(e));
      });
    restoreUiState();
    // Pull the repo registry now so the first scene build paints the rack
    // tags + directory panel; if the fetch resolves after buildScene we
    // trigger a one-shot rebuild so the racks light up without a full reload.
    fetchReposBookmarks().then(() => {
      if (reposBookmarks.length > 0) rebuildScene();
    });
    // Paint each office's infra power state (badge + console) from the first
    // frame, then keep it fresh on a slow poll (events drive the live changes).
    fetchInfraStates();
    infraRefreshTimer = setInterval(fetchInfraStates, 30_000);
    // Top-agent inbox — load it up front (and on a slow poll) so the
    // alert pill + red halo light up even on a fresh reload, not only when a
    // live `question_asked` event happens to fire while the tab is open.
    loadPendingQuestions();
    questionsRefreshTimer = setInterval(loadPendingQuestions, 20_000);
    reposRefreshTimer = setInterval(async () => {
      const prevCount = reposBookmarks.length;
      const prevNames = reposBookmarks.map(r => r.name).sort().join('|');
      await fetchReposBookmarks();
      const nextNames = reposBookmarks.map(r => r.name).sort().join('|');
      if (prevCount !== reposBookmarks.length || prevNames !== nextNames) rebuildScene();
    }, 60_000);
    if (typeof window !== 'undefined') {
      window.addEventListener('office:focus', onOfficeFocus);
    }
  });
  onDestroy(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (animId) cancelAnimationFrame(animId);
    if (reposRefreshTimer) { clearInterval(reposRefreshTimer); reposRefreshTimer = null; }
    if (infraRefreshTimer) { clearInterval(infraRefreshTimer); infraRefreshTimer = null; }
    if (questionsRefreshTimer) { clearInterval(questionsRefreshTimer); questionsRefreshTimer = null; }
    if (sceneReadyFallbackTimer) { clearTimeout(sceneReadyFallbackTimer); sceneReadyFallbackTimer = null; }
    // Dispose every pending Ticker — fires onDispose callbacks (scene/material
    // cleanup for trade celebrations) so we don't leak ahead of the renderer.
    animRegistry.clear();
    if (composer) { composer.dispose(); composer = null; }
    if (renderer) { renderer.dispose(); renderer.domElement?.parentNode?.removeChild(renderer.domElement); }
    if (labelRenderer?.domElement?.parentNode) labelRenderer.domElement.parentNode.removeChild(labelRenderer.domElement);
    for (const [, m] of deskGroups) m.traverse((c: any) => { c.geometry?.dispose(); c.material?.dispose(); });
    for (const h of hallwayLines) { h.line.geometry.dispose(); h.line.material.dispose(); }
    for (const [, b] of speechBubbles) { if (b.label) scene?.remove(b.label); b.div.remove(); }
    for (const id of [...meetingDecor.keys()]) disposeMeetingDecor(id);
    // Guard against SSR/prerender — SvelteKit may invoke onDestroy on the
    // server when tearing down a render pass. window only exists in the
    // browser; without this check the whole page crashes with a 500 and
    // SvelteKit drops /agents-flow from the static build entirely.
    if (typeof window !== 'undefined') {
      window.removeEventListener('office:focus', onOfficeFocus);
      window.removeEventListener('pointermove', onWorldPointerMove);
      window.removeEventListener('pointerup', onWorldPointerUp);
    }
  });

  // The selected agent's drawer — its detail fetch, tabs, chat and actions —
  // lives in AgentPanel.svelte. The world keeps the selection itself.
  let agentPanel: AgentPanel | null = null;
  // Installed skins for the drawer's picker, snapshotted in buildScene().
  let availableSkins: SkinDefinition[] = [];

  // Show/hide hallway lines based on selected agent
  $: {
    for (const h of hallwayLines) {
      const connected = selectedAgent && (h.sourceId === selectedAgent || h.targetId === selectedAgent);
      h.line.visible = !!connected;
      if (h.line.material) {
        h.line.material.opacity = connected ? 0.6 : 0;
      }
    }
  }

  // Clipboard — shows a brief "copied" flash on the triggering button
  let copiedKey: string | null = null;
  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      copiedKey = key;
      setTimeout(() => { if (copiedKey === key) copiedKey = null; }, 1200);
    } catch {
      copiedKey = key + ':err';
      setTimeout(() => { copiedKey = null; }, 1200);
    }
  }

  const dispatch = createEventDispatcher();

  let lastInboxCount = -1;
  $: if (pendingQuestions.length !== lastInboxCount) {
    lastInboxCount = pendingQuestions.length;
    dispatch('inbox', { count: lastInboxCount });
  }

  // ── Sent-email viewer ──────────────────────────────────────────────
  // An email-send activity row shows a "Ver email" link; it calls open()
  // on EmailModal.svelte, which fetches and renders the real sent message.
  // Only the handle stays here — the link sits next to its own row.
  let emailModal: EmailModal | null = null;

  // ── Draft (communication) modal ────────────────
  // The preview behind every UUID chip in a run output. Resolving the id
  // against seven endpoints, and rendering whichever entity answers, is all
  // in DraftModal.svelte now. handleOutputClick below stays here — it is
  // wired to six different output panes.
  let draftModal: DraftModal | null = null;

  function handleOutputClick(e: MouseEvent) {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const btn = t.closest('.ip-uuid-link') as HTMLElement | null;
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute('data-comm-id');
      if (id) draftModal?.open(id);
    }
  }

  // ── Meeting System ─────────────────────────────
  let meetingTopic = '';
  let meetingDescription = '';
  // Temas a profundizar — one per line. Injected into every agent's goal so
  // the discussion drills into each item instead of staying generic.
  let meetingTopicsText = '';
  let meetingSelectedIds: Set<string> = new Set();
  let meetingActive = false;
  // Panel visibility is independent of the meeting lifecycle: minimizing the
  // dialog does NOT end the meeting — the in-progress banner above the room
  // reopens it. Only "End Meeting" sends everyone home.
  let meetingPanelOpen = true;
  // Synthetic id claiming a room slot in meetingIdToRoom while a human-led
  // meeting runs, so autonomous meetings can't double-book the same room.
  let humanMeetingId = '';
  let meetingChat: Array<{ role: 'you' | string; name: string; text: string; color: string; ts: number }> = [];
  let meetingInput = '';
  let meetingSending = false;

  /** The brief the operator's chat opens with, in the operator's language. The agents' goal restates the topic in English. */
  function meetingBrief(): string {
    const lines = [`${$translate('meeting.brief_topic')}: ${meetingTopic.trim()}`];
    if (meetingDescription.trim()) lines.push(`${$translate('meeting.brief_description')}: ${meetingDescription.trim()}`);
    const topics = parseMeetingTopics(meetingTopicsText);
    if (topics.length > 0) {
      lines.push(`${$translate('meeting.brief_topics')}:`);
      for (const t of topics) lines.push(`  • ${t}`);
    }
    return lines.join('\n');
  }

  /**
   * MeetingModal → "Yo". The same client-side mechanism Call Meeting always
   * had: attendees walk to a room, each message runs every attendee. No
   * kernel meeting, no history row. Contexto is optional here.
   */
  export function startHumanMeeting(input: { topic: string; description: string; topics: string[]; attendeeIds: string[] }): boolean {
    if (meetingActive) return false;
    meetingTopic = input.topic;
    meetingDescription = input.description;
    meetingTopicsText = input.topics.join('\n');
    meetingSelectedIds = new Set(input.attendeeIds);
    void startMeeting();
    return meetingActive;
  }

  async function startMeeting() {
    if (meetingSelectedIds.size === 0 || !meetingTopic.trim()) return;
    meetingActive = true;
    meetingPanelOpen = true;
    meetingChat = [];

    // Hide seated workers (they're "standing up" to go to the meeting)
    for (const aid of meetingSelectedIds) {
      const dg = deskGroups.get(aid);
      if (dg) {
        // The humanoid group is the last Group-type child added by buildDesks
        for (const child of dg.children) {
          if (child.type === 'Group' && child.children.length > 3) {
            child.visible = false; // hide seated worker
          }
        }
      }
    }

    // Walk agents into a FREE meeting room, entering through the door.
    // meetingRoomSlots excludes Central Hall / My Office (unlike the old
    // `meetingRooms[1+idx]` which pointed straight at the reception slot and
    // seated everyone in the middle of the lobby). The slot is claimed in
    // meetingIdToRoom under a synthetic id so concurrent autonomous meetings
    // pick a different room.
    if (meetingRoomSlots.length > 0 && scene && THREE) {
      const inUse = new Set([...meetingIdToRoom.values(), ...activeCoordRooms]);
      let roomIdx = meetingRoomSlots.findIndex((_, i) => !inUse.has(i));
      if (roomIdx < 0) roomIdx = meetingIdToRoom.size % meetingRoomSlots.length;
      humanMeetingId = `human-${Date.now()}`;
      meetingIdToRoom.set(humanMeetingId, roomIdx);

      const mr = meetingRoomSlots[roomIdx];
      const seatPositions = getMeetingSeatPositions(mr);
      const doorPoint = hallCenterPos ? meetingRoomDoorPoint(mr, hallCenterPos) : undefined;
      let seatIdx = 0;
      for (const aid of meetingSelectedIds) {
        const seat = seatPositions[seatIdx % seatPositions.length];
        // targetId 'meeting' + stay=true: seated pose on arrival, no
        // auto-return — they only stand up when endMeeting() dismisses them.
        sendWalkerToPoint(
          scene, walkers, aid, seat, deskPos, roomMap, corGrid, agents,
          flowColor(aid), undefined, deskAabbs, 'meeting', sittingWorkers,
          false, doorPoint, undefined, false, meetingRoomSlots, roomIdx, true,
          { x: mr.cx, y: 0, z: mr.cz }, // face the table
        );
        showAnimatedTag(aid, { icon: '🚶', anim: 'bounce', color: '#5B8DEF', label: 'TO MEETING', durationFrames: 250 });
        seatIdx++;
      }
      // "Meeting in progress" banner + halo above the room. Clicking it
      // (re)opens the user↔agents dialog panel — minimizing the panel never
      // ends the meeting.
      spawnMeetingDecor(humanMeetingId, mr, meetingTopic, () => {
        meetingPanelOpen = true;
        showMyOfficePanel = false;
        selectedAgent = null;
      });
      updateMeetingDecorTurn(humanMeetingId, `${meetingSelectedIds.size} attendees · you moderate`);
    }

    meetingChat = [{
      role: 'you', name: 'You', text: meetingBrief(),
      color: '#3dd6c8', ts: Date.now(),
    }];
  }

  /** Get seat positions around the meeting table */
  // Door midpoint of a meeting room. Mirrors office.ts:buildMeetingRooms door
  // placement: pick the wall whose center is closest to the central hall.
  /** Two agents from different offices interact → both walk to a free meeting
   *  room, sit down at facing seats around the conference table, "coordinate"
   *  for a few seconds, then walk back to their desks. This is the visual we
   *  use for any cross-office interaction (handoffs, escalations, edits). The
   *  underlying state — DB writes, event log, kernel chain — is unchanged; we
   *  only swap the *3D* desk-to-desk walker for the meeting-room sequence so
   *  the floor reads more naturally when teams collaborate across offices.
   *
   *  Returns true if the coordination was kicked off, false if no room is
   *  available (caller should fall back to a desk-to-desk visual). */
  function coordinateInMeetingRoom(srcId: string, tgtId: string, color: string): boolean {
    if (!scene || meetingRoomSlots.length === 0) return false;
    // One walker per agent — if either is already in flight (real meeting,
    // commute, etc.) the coordination would silently no-op partway through.
    // Bail early so the caller can fall back to a desk-to-desk visual.
    if (walkers.some(w => w.sourceId === srcId || w.sourceId === tgtId)) return false;

    // Skip rooms in use by real LLM meetings AND other coordinations.
    const realMeetingRooms = new Set(meetingIdToRoom.values());
    let roomIdx = meetingRoomSlots.findIndex((_, i) =>
      !realMeetingRooms.has(i) && !activeCoordRooms.has(i)
    );
    if (roomIdx < 0) {
      // All booked — fall back to least-recently-claimed; visuals will overlap
      // briefly but that's better than not animating the interaction at all.
      roomIdx = activeCoordRooms.size % meetingRoomSlots.length;
    }
    const room = meetingRoomSlots[roomIdx];
    const seats = getMeetingSeatPositions(room);
    if (seats.length < 2) return false;
    const doorPoint = hallCenterPos
      ? meetingRoomDoorPoint(room, hallCenterPos)
      : undefined;
    activeCoordRooms.add(roomIdx);

    // Source sits at seat[0] (front side), target at seat[1] (back side) — the
    // two seats face each other across the table, perfect for a 1-on-1 coord.
    let arrivedCount = 0;
    let dismissed = false;
    const COORD_SIT_SEC = 6;       // time both stay seated after second arrival
    const COORD_SAFETY_SEC = 60;   // hard ceiling — never get stuck seated

    function dismiss(): void {
      if (dismissed) return;
      dismissed = true;
      if (scene) {
        removeArrivedWalkers(scene, walkers, 'meeting',
          (w) => w.sourceId === srcId || w.sourceId === tgtId);
      }
      activeCoordRooms.delete(roomIdx);
    }
    const onArrive = (): void => {
      arrivedCount++;
      if (arrivedCount >= 2) {
        setTimeout(dismiss, COORD_SIT_SEC * 1000);
      }
    };

    // The trailing arguments matter as much as the leading ones: without
    // meetingRoomSlots + the exempt index this pair never gets the door-aware
    // approach the other meetings get, and without the face point they sit
    // back-to-back instead of across the table from each other.
    const tableCentre = { x: room.cx, y: 0, z: room.cz };
    sendWalkerToPoint(
      scene, walkers, srcId, seats[0], deskPos, roomMap, corGrid,
      agents, color, undefined, deskAabbs,
      'meeting', sittingWorkers, false,
      doorPoint, onArrive, false,
      meetingRoomSlots, roomIdx, false, tableCentre,
    );
    sendWalkerToPoint(
      scene, walkers, tgtId, seats[1], deskPos, roomMap, corGrid,
      agents, color, undefined, deskAabbs,
      'meeting', sittingWorkers, false,
      doorPoint, onArrive, false,
      meetingRoomSlots, roomIdx, false, tableCentre,
    );
    // Safety: if one walker never arrives (path-build failure, off-screen
    // cleanup) the seated one stays put forever. This hard ceiling guarantees
    // both go home eventually.
    setTimeout(dismiss, COORD_SAFETY_SEC * 1000);
    return true;
  }

  function sameOffice(srcId: string, tgtId: string): boolean {
    return sameOfficeOf(agents, srcId, tgtId);
  }

  /** Free visitor chair in My Office; seats and walkers live in this component. */
  function pickFreeMyOfficeChair(): { x: number; y: number; z: number } | null {
    return pickFreeChair(myOfficeSeats, walkers as unknown as SeatedWalker[]);
  }

  async function sendMeetingMessage(text?: string) {
    const msg = (text ?? meetingInput).trim();
    if (!msg || meetingSending) return;
    meetingInput = '';
    meetingSending = true;

    meetingChat = [...meetingChat, {
      role: 'you', name: 'You', text: msg, color: '#3dd6c8', ts: Date.now(),
    }];

    // Build shared context from meeting history
    const contextLines = meetingChat.map(m => `${m.name}: ${m.text}`).join('\n');

    // Run each invited agent sequentially with the shared context
    for (const aid of meetingSelectedIds) {
      const agent = agents.find(a => a.id === aid);
      if (!agent) continue;

      // Fetch this agent's recent work so it has concrete context
      const recentWork = await fetchRecentRunSummaries(aid, 5);

      const meetingTopicsList = parseMeetingTopics(meetingTopicsText);
      const goal = `You are in a group meeting about: "${meetingTopic}". You are ${agent.name}: ${agent.description || 'an agent in this office'}.

## MEETING BRIEF
Topic: ${meetingTopic}
${meetingDescription.trim() ? `Description: ${meetingDescription.trim()}` : ''}
${meetingTopicsList.length > 0 ? `Topics to dig into (when you answer, go deep specifically on these points):\n${meetingTopicsList.map(t => `- ${t}`).join('\n')}` : ''}

## YOUR RECENT WORK (this is what YOU actually did — cite it!)
${recentWork}

## RULES
1. You KNOW what you did — it's listed above under "YOUR RECENT WORK". Reference it with specific details (dates, IDs, counts, names).
2. If asked for a report, summarize your recent work above with concrete numbers. Do NOT say "I haven't done anything" if your work history shows completed runs.
3. If you genuinely have no completed runs, say "I haven't run yet" — but check your work history first.
4. NEVER use vague language: "I will work on it", "the team is focused on", "leveraging", "key priorities". FORBIDDEN.
5. If asked to do something concrete, USE A TOOL. Don't promise — execute.
6. Be SPECIFIC: cite dates, numbers, exact names from your actual runs.
7. Maximum 3-4 sentences unless reporting detailed results. No fluff.

## MEETING TRANSCRIPT
${contextLines}

Respond to the latest message as ${agent.name}. Be concrete. Reference your actual work. Be honest.`;

      showBubble(aid, 'Thinking...', 150);

      try {
        const res: any = await rpcOrCall('agents.run', { agent_id: aid, goal }, async () => {
          const r = await fetch('/api/agents/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_id: aid, goal }),
          });
          return r.json();
        });

        if (res?.run_id) {
          // Poll for result
          for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 2000));
            try {
              const detail: any = await rpcOrCall('agents.runs.detail', { id: res.run_id }, async () => {
                const r2 = await fetch(`/api/agents/runs/${res.run_id}`);
                return r2.json();
              });
              if (detail?.run?.status === 'completed' || detail?.run?.status === 'failed') {
                const result = detail.run.result || detail.run.error || '(no response)';
                const preview = typeof result === 'string' ? result.slice(0, 400) : String(result).slice(0, 400);
                meetingChat = [...meetingChat, {
                  role: aid, name: agent.name, text: preview,
                  color: flowColor(aid), ts: Date.now(),
                }];
                showBubble(aid, preview.slice(0, 60), 250);
                break;
              }
            } catch { /* keep polling */ }
          }
        }
      } catch (e: any) {
        meetingChat = [...meetingChat, {
          role: aid, name: agent.name, text: `Error: ${e.message}`,
          color: flowColor(aid), ts: Date.now(),
        }];
      }
    }

    meetingSending = false;
  }

  function endMeeting() {
    // Show seated workers again (they're "back at their desk")
    for (const aid of meetingSelectedIds) {
      const dg = deskGroups.get(aid);
      if (dg) {
        for (const child of dg.children) {
          if (child.type === 'Group' && child.children.length > 3) {
            child.visible = true;
          }
        }
      }
    }
    // Send THIS meeting's walkers back to their desks. The filter keeps
    // autonomous-meeting attendees (same targetId='meeting', different room)
    // seated — without it, ending the human meeting evicted every meeting
    // walker on the floor.
    const attendees = new Set(meetingSelectedIds);
    if (scene) removeArrivedWalkers(scene, walkers, 'meeting', w => attendees.has(w.sourceId));
    // Banner + halo come down, the room slot is released for the next meeting.
    if (humanMeetingId) {
      disposeMeetingDecor(humanMeetingId);
      meetingIdToRoom.delete(humanMeetingId);
      humanMeetingId = '';
    }
    meetingActive = false;
    meetingPanelOpen = true;
    meetingChat = [];
    meetingSelectedIds = new Set();
    meetingTopic = '';
    meetingDescription = '';
    meetingTopicsText = '';
  }

  // ── Perf overlay reactive counters ────────────────────────────────
  // Re-evaluated on every animate() tick via the assignment trick below
  // (we don't re-render the overlay every frame, just feed it numbers).
  let perfExtra: Record<string, number> = { agents: 0, walkers: 0, sitting: 0, labels: 0 };
  $: perfExtra = {
    agents: agents.length,
    active: agents.filter(a => a.active).length,
    running: runningAgentIds.size,
    walkers: walkers.length,
    sitting: sittingWorkers.size,
    labels: deskLabels.size,
  };
</script>


<div class="world3d-container" role="presentation">
  {#if webglError}
    <div class="fb"><span class="fb-icon">&#9888;</span> {webglError}</div>
  {:else}
    <div class="world3d-canvas" bind:this={canvasEl}></div>
  {/if}

  <div class="scene-vignette" aria-hidden="true"></div>

  <BootLoader
    show={!sceneReady && !webglError}
    {bootError}
    {dataError}
    steps={bootSteps}
    status={bootStatus}
    onRetry={retryBoot}
  />

  <PerfOverlay bind:visible={showPerfHud} stats={perfStats} extra={perfExtra} label="baseline" />


  <!-- Send-to-fixer toast — page-level so it survives the report modal
       closing on dispatch. Auto-clears via the same setTimeout that owns
       `fixerStatus`. -->
  {#if fixerStatus}
    <div class="fixer-toast"
         transition:slide|local={{ duration: 220, easing: quintOut }}
         class:fixer-toast-ok={fixerStatus.startsWith('✓')}
         class:fixer-toast-err={fixerStatus.startsWith('✗')}>
      {fixerStatus}
    </div>
  {/if}

  <!-- New Office chat — replaces the legacy form. Talks directly to the AI
       architect, which uses the kernel_agents_* tools to spin up the flow +
       CEO + team based on the conversation. -->
  {#if showOfficeModal}
    <OfficeCreatorChat
      topAgentName={topAgent()?.name ?? highestRank()?.name ?? 'Chief'}
      topAgentInsignia={highestRank()?.insignia ?? '✪'}
      topAgentColor={highestRank()?.color ?? '#c9a84c'}
      topAgentRankLabel={highestRank()?.name ?? ''}
      on:close={() => { showOfficeModal = false; }}
      on:refresh={() => dispatch('refresh')}
    />
  {/if}

  <!-- Register Repo Modal — the whole form lives in RegisterRepoModal.svelte.
       Opened from the HQ dropdown and from a click on a FREE rack in the
       Repos Office. The scene refresh stays here because it is the world's:
       it is awaited before the modal closes, so the rack flips from FREE to
       OCCUPIED while the form is still up, exactly as it did inline. -->
  <RegisterRepoModal
    bind:this={registerRepoModal}
    onRegistered={async () => { await fetchReposBookmarks(); rebuildScene(); }}
  />

  <!-- Live agent-to-agent meeting transcript (side panel, so the 3D stays
       visible) and the operator-moderated meeting — see MeetingPanels.svelte. -->
  <MeetingPanels
    {liveMeetings}
    {liveMeetingsList}
    bind:activeMeetingId
    bind:showLiveMeeting
    {showTranscriptBody}
    {meetingActive}
    bind:meetingPanelOpen
    {meetingTopic}
    {meetingSelectedIds}
    {meetingChat}
    {meetingSending}
    bind:meetingInput
    {endMeeting}
    {sendMeetingMessage}
    {agents}
    {flowColor}
  />

  <!-- My Office reports panel + report detail modal — see MyOfficePanel.svelte. -->
  <MyOfficePanel
    bind:showMyOfficePanel
    bind:myOfficeTab
    bind:officeReports
    bind:officeReportsLoaded
    bind:pendingQuestions
    bind:fixerStatus
    {auditedRunIds}
    {agents}
    {flowColor}
    {topAgent}
    {copiedKey}
    {copy}
    onOutputClick={handleOutputClick}
    selectAgent={(id) => { selectedAgent = id; }}
    {focusAgent}
  />

  <!-- Selected agent's drawer — see AgentPanel.svelte. -->
  <AgentPanel
    bind:this={agentPanel}
    bind:selectedAgent
    bind:agents
    {chains}
    {flows}
    {stats}
    {runningAgentIds}
    {flowEvents}
    {availableSkins}
    {copiedKey}
    {copy}
    {handleOutputClick}
    openEmail={(id) => emailModal?.open(id)}
    {showBubble}
    on:refresh
    on:moveagent
  />

  {#if runningAgentIds.size > 0}
    <div class="hud">
      <div class="hud-t"><span class="hud-p"></span> WORKING</div>
      {#each [...runningAgentIds] as rid}
        {@const a = agents.find(x => x.id === rid)}
        {#if a}<div class="hud-i" on:click={() => { selectedAgent = rid; focusAgent(); }} on:keydown role="button" tabindex="0"><span class="hud-d" style="background:{flowColor(rid)}"></span>{a.name}</div>{/if}
      {/each}
    </div>
  {/if}

  <!-- Draft preview modal — see DraftModal.svelte. handleOutputClick opens
       it when a UUID chip in any run output is clicked. -->
  <DraftModal bind:this={draftModal} />
</div>

<!-- Sent-email viewer modal (opened from email-send activity rows) — the
     fetch, the state and the styles live in EmailModal.svelte. -->
<EmailModal bind:this={emailModal} />

<style>
  .world3d-container{position:relative;width:100%;height:100%;overflow:hidden;background:#020206}
  .world3d-canvas{width:100%;height:100%;position:relative}
  .scene-vignette{position:absolute;inset:0;z-index:2;pointer-events:none;
    background:radial-gradient(125% 115% at 50% 42%, transparent 55%, rgba(2,4,10,.42) 100%);
    mix-blend-mode:multiply}
  .fb{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;gap:8px;background:#0d0f18;font:400 12px 'Manrope',sans-serif;color:#8a8fa8}
  .fb-icon{font-size:20px;color:#d4a84b}

  /* Containers that host a <CopyTextBtn /> overlay. The component positions
     itself absolutely in the top-right corner and fades in on hover. */
  :global(.copy-wrap){position:relative}

  .hud{position:absolute;bottom:12px;left:12px;background:rgba(14,16,24,.9);backdrop-filter:blur(12px);border:1px solid rgba(16,185,129,.2);border-radius:10px;padding:10px 14px;z-index:10}
  .hud-t{display:flex;align-items:center;gap:6px;font:700 8px 'Syne',sans-serif;color:var(--green,#3dd68c);letter-spacing:1.5px;margin-bottom:6px}
  .hud-p{width:6px;height:6px;border-radius:50%;background:var(--green,#3dd68c);animation:p 1.5s ease-in-out infinite}
  @keyframes p{0%,100%{opacity:1;box-shadow:0 0 4px var(--green)}50%{opacity:.5;box-shadow:0 0 8px var(--green)}}
  .hud-i{display:flex;align-items:center;gap:6px;font:500 10px 'Manrope',sans-serif;color:var(--text-2);padding:3px 0;cursor:pointer;transition:color .15s}
  .hud-i:hover{color:var(--text-1)}
  .hud-d{width:6px;height:6px;border-radius:50%;flex-shrink:0}

  /* ── Markdown output (run.result / step.content) ──
     Global, so it styles every `.ip-out-md` pane — the drawer's, My Office's
     and the meeting panels' — from here. Each of those components carries its
     own scoped `.ip-out-md` box rule. */
  :global(.ip-out-md .md-h){font:700 13px 'Syne',sans-serif;color:#e5e8f0;margin:12px 0 5px;letter-spacing:.3px}
  :global(.ip-out-md h3.md-h){font-size:14.5px;color:#fff}
  :global(.ip-out-md h4.md-h){font-size:13px;color:#e5e8f0}
  :global(.ip-out-md h5.md-h){font-size:12px;color:#c8ccd8;text-transform:uppercase;letter-spacing:.6px}
  :global(.ip-out-md .md-p){margin:6px 0}
  :global(.ip-out-md .md-ul),
  :global(.ip-out-md .md-ol){margin:4px 0 4px 18px;padding:0}
  :global(.ip-out-md .md-ul li),
  :global(.ip-out-md .md-ol li){margin:2px 0}
  :global(.ip-out-md strong){color:#fff;font-weight:600}
  :global(.ip-out-md em){color:#c8ccd8;font-style:italic}
  :global(.ip-out-md .md-code){
    font:500 10px 'JetBrains Mono',monospace;
    background:rgba(120,130,160,.14);color:#e0e4f0;padding:1px 5px;border-radius:3px;
  }
  :global(.ip-out-md .md-codeblock){
    font:500 10px/1.55 'JetBrains Mono',monospace;
    background:rgba(0,0,0,.38);color:#d8dcea;
    border:1px solid rgba(120,130,160,.18);border-radius:6px;
    padding:8px 10px;margin:6px 0;
    white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;
    max-height:320px;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  :global(.ip-out-md .md-trunc-hint){
    margin:8px 0 2px;padding:6px 10px;
    font:500 10px/1.4 'JetBrains Mono',monospace;
    color:#c9a84c;background:rgba(201,168,76,.08);
    border:1px dashed rgba(201,168,76,.35);border-radius:5px;
    letter-spacing:.2px;
  }
  :global(.ip-out-md .md-envelope){
    margin-top:10px; border:1px solid rgba(120,130,160,.18);
    border-radius:5px; background:rgba(255,255,255,.02);
  }
  :global(.ip-out-md .md-envelope > summary){
    cursor:pointer; padding:5px 10px; font:600 9px 'JetBrains Mono',monospace;
    color:#7e84a3; letter-spacing:.7px; text-transform:uppercase;
    list-style:none;
  }
  :global(.ip-out-md .md-envelope > summary::-webkit-details-marker){display:none;}
  :global(.ip-out-md .md-envelope > summary::before){content:'▸  ';color:#5a5f7a;}
  :global(.ip-out-md .md-envelope[open] > summary::before){content:'▾  ';}
  :global(.ip-out-md .md-envelope > summary:hover){color:#cbd0e8;}
  :global(.ip-out-md .md-envelope[open]){background:rgba(255,255,255,.04);}
  :global(.ip-out-md .md-envelope > .md-codeblock){margin:0;border:none;border-top:1px solid rgba(120,130,160,.12);border-radius:0;}
  :global(.ip-out-md a){color:#8ab4ff;text-decoration:underline;text-underline-offset:2px}
  :global(.ip-out-md a:hover){color:#b3cfff}
  :global(.ip-out-md .ip-uuid-link){
    display:inline-flex;align-items:center;gap:4px;
    font:600 10px 'JetBrains Mono',monospace;
    padding:1px 6px;margin:0 1px;border-radius:4px;
    background:rgba(99,102,241,.18);border:1px solid rgba(99,102,241,.38);color:#a4a8ff;
    cursor:pointer;transition:all .12s;
  }
  :global(.ip-out-md .ip-uuid-link::before){content:'📄';font-size:9px;filter:saturate(.7)}
  :global(.ip-out-md .ip-uuid-link:hover){background:rgba(99,102,241,.32);border-color:#8b8cf6;color:#d8daff}
  /* Floating toast that confirms a "send to fixer" dispatch after the
     report modal closes. Anchored top-center to stay clear of the HQ bar. */
  .fixer-toast{
    position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:var(--z-toast);
    padding:10px 18px;border-radius:999px;
    font:700 11px 'JetBrains Mono',monospace;letter-spacing:.3px;
    background:rgba(8,6,2,.92);backdrop-filter:blur(6px);
    border:1px solid #ffb84a55;color:#ffb84a;
    box-shadow:0 6px 22px rgba(0,0,0,.55),0 0 18px rgba(255,184,74,.18);
  }
  .fixer-toast-ok{border-color:#4cff7a55;color:#4cff7a;box-shadow:0 6px 22px rgba(0,0,0,.55),0 0 18px rgba(76,255,122,.18)}
  .fixer-toast-err{border-color:#ef5d6e55;color:#ef5d6e;box-shadow:0 6px 22px rgba(0,0,0,.55),0 0 18px rgba(239,93,110,.18)}

  /* Bubble animations (global, avoids per-bubble style injection) */
  @keyframes -global-bpop {
    from { transform: scale(.6) translateY(5px); opacity: 0; }
  }
  @keyframes -global-gpop {
    from { transform: scale(.3) translateY(10px); opacity: 0; }
    70% { transform: scale(1.08) translateY(-2px); }
    to { transform: scale(1) translateY(0); opacity: 1; }
  }

  /* ── Animated agent-event tags — the icon inside each tag plays one of
     these CSS keyframes so the entire visual lives in a single element
     (no separate floating glyph on top). All `:global` so they survive
     Svelte's scoping when applied to dynamically-created divs. */
  @keyframes -global-tag-pulse  { 0%,100% { transform: scale(1); } 50% { transform: scale(1.18); } }
  @keyframes -global-tag-spin   { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @keyframes -global-tag-shake  {
    0%,100% { transform: translateX(0) rotate(0deg); }
    20% { transform: translateX(-3px) rotate(-6deg); }
    40% { transform: translateX(3px) rotate(6deg); }
    60% { transform: translateX(-2px) rotate(-4deg); }
    80% { transform: translateX(2px) rotate(4deg); }
  }
  @keyframes -global-tag-wobble { 0%,100% { transform: rotate(-8deg); } 50% { transform: rotate(8deg); } }
  @keyframes -global-tag-bounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
  @keyframes -global-tag-sparkle {
    0%,100% { filter: drop-shadow(0 0 2px currentColor); }
    50% { filter: drop-shadow(0 0 10px currentColor) drop-shadow(0 0 18px currentColor); }
  }
  @keyframes -global-tag-pop {
    0% { transform: scale(.4); opacity: 0; }
    60% { transform: scale(1.25); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }
  @keyframes -global-tag-card-in {
    from { transform: scale(.7) translateY(6px); opacity: 0; }
    to   { transform: scale(1) translateY(0);   opacity: 1; }
  }
  :global(.atag-icon) {
    display: inline-block;
    line-height: 1;
    animation-iteration-count: infinite;
    animation-timing-function: ease-in-out;
    will-change: transform, filter;
  }
  :global(.atag-anim-pulse   .atag-icon) { animation-name: tag-pulse;   animation-duration: 1.0s; }
  :global(.atag-anim-spin    .atag-icon) { animation-name: tag-spin;    animation-duration: 1.6s; animation-timing-function: linear; }
  :global(.atag-anim-shake   .atag-icon) { animation-name: tag-shake;   animation-duration: .55s; animation-iteration-count: 3; }
  :global(.atag-anim-wobble  .atag-icon) { animation-name: tag-wobble;  animation-duration: .8s; }
  :global(.atag-anim-bounce  .atag-icon) { animation-name: tag-bounce;  animation-duration: .65s; }
  :global(.atag-anim-sparkle .atag-icon) { animation-name: tag-sparkle; animation-duration: .9s; }
  :global(.atag-anim-pop     .atag-icon) { animation-name: tag-pop;     animation-duration: .45s; animation-iteration-count: 1; }
  :global(.atag) { animation: tag-card-in .22s cubic-bezier(.17,.88,.32,1.28); }
  /* ── "Thinking" dots ───────────────────────────────────────────────
     Three dots lifting and brightening in sequence, 160ms apart, so the
     highlight travels left-to-right and loops without a seam. The dot is
     never fully out — it drops to 38% and 72% scale, which keeps three
     dots legible as three dots at distance instead of blinking down to a
     single moving speck. `currentColor` carries the agent's flow colour
     into both the fill and the glow, so the tag matches the walkers and
     beams that agent already owns elsewhere in the scene. */
  @keyframes -global-tag-think-dot {
    0%, 70%, 100% { transform: translateY(0) scale(.72);     opacity: .38; }
    35%           { transform: translateY(-2px) scale(1);    opacity: 1; }
  }
  :global(.atag-think-dot) {
    display: inline-block; flex: none;
    width: 4px; height: 4px; border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 5px currentColor;
    animation: tag-think-dot 1.15s ease-in-out infinite;
    will-change: transform, opacity;
  }
  /* Someone who asked for less motion gets the colour and the glow, which
     still say "busy", without the loop. */
  @media (prefers-reduced-motion: reduce) {
    :global(.atag-think-dot) { animation: none; opacity: .85; }
    :global(.atag-icon) { animation: none; }
  }
</style>
