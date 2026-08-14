<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher, tick } from 'svelte';
  import { slide, scale } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import PerfOverlay from './PerfOverlay.svelte';
  import type { AgentFlowEvent } from '$lib/stores.js';
  import { rpcOrCall, rpc } from '$lib/ws.js';
  import { getCommDetail } from '$lib/api.js';
  import { sanitizeHtml } from '$lib/sanitize.js';
  import { highlightCode, detectLang } from '$lib/workspace-highlight.js';
  import { renderMarkdown } from '$lib/workspace-md.js';
  import {
    computeFloorPlan, initHumanoid, initOffice, initFurniture, initWalkers, initAmbiance,
    initHumanoidPool, createSittingHumanoidPool, type SittingHumanoidPool,
    initAllSkins, resolveSkin, listSkins, type SkinDefinition,
    buildFloor, buildStreets, buildCorridorGrid, buildRooms, buildMeetingRooms, buildMyOffice, buildCentralHall, buildHallExtension, buildReception, buildCommunicationsOffice, buildDataCenterOffice, buildDesks, buildHallways,
    setupLighting, applyRendererGrading, applySceneGrading, GRADING,
    buildAmbiance, buildWallClock, buildActivityBoard, updateActivityBoard, buildDoorLeds, updateDoorLeds, buildElevator, updateAmbiance,
    initRedAlertDecor, buildSandbagBarrier, buildCrates,
    buildPowerConsole, setInfraBreaker, getInfraBreakerState, setInfraReadout,
    flipInfraLever, updateInfraConsole, getInfraOperatorPos, getInfraFacePos,
    resetInfraConsole, toggleInfraBoard, INFRA_VIS, type InfraState,
    sendWalker, sendWalkerToPoint, sendCommuteWalker, updateWalkers, removeArrivedWalkers, syncSeatedVisibility, animateSitting,
    initDelivery, initDeliveryScene, enqueueDelivery, resetDelivery, markPackagePickedUp, updateDelivery,
    initTaxi, initTaxiScene, enqueueTaxi, updateTaxis, resetTaxis,
    createAnimationRegistry, initAnimEffects,
    cameraTween, haloPulse, risingParticles, bubbleFade, materialPulse,
    floatingGlyph, shake, convergingParticles, fallingGlyph, spinningGear,
    curvedArrow, paperPlane, pillarOfLight, coinTrail, chyronLabel,
    createNoteStack, type NoteStack,
    runTradeExecution,
    type AnimationRegistry,
    type DeliveryInfo,
    resolveFlowColor, agentType, modelChainFallbacks, CLAUDE_CODE_DEFAULT_MODEL,
    type Walker, type SpeechBubble, type HumanoidParts, type RoomInfo, type CorridorGrid, type Aabb2D, type HallwayLine,
  } from './office3d/index.js';
  import { setTextureAnisotropy } from './office3d/textures.js';
  import CopyTextBtn from '$lib/components/CopyTextBtn.svelte';
  import OfficeCreatorChat from '$lib/components/OfficeCreatorChat.svelte';
  import NewOfficeModal from './NewOfficeModal.svelte';
  import OfficeInfraPanel from '$lib/components/OfficeInfraPanel.svelte';
  import ChatComposer from '$lib/components/ChatComposer.svelte';
  import { isLlmConfigError, LLM_SETTINGS_HREF } from '$lib/llm-error.js';
  import { panelTabComponents, tabMatches } from '$lib/panelTabRegistry';

  // Tabs contribuidos por extensiones (declarados en su manifest, expuestos por
  // /api/manifest). They are filtered by the selected office/agent and the
  // component bound in the registry is rendered. NOTHING is hardcoded by office name.
  let contributedTabs: Array<{ id: string; label: string; match?: { office?: string }; order?: number }> = [];
  async function loadContributedTabs() {
    try {
      const r = await fetch('/api/manifest');
      if (!r.ok) return;
      const m = await r.json();
      contributedTabs = Array.isArray(m?.agentPanelTabs) ? m.agentPanelTabs : [];
    } catch {}
  }
  $: myPanelTabs = contributedTabs
    .filter((t) => panelTabComponents[t.id] && tabMatches(t, selFlow))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

  export let agents: Array<{
    id: string; name: string; description: string;
    provider: string; model: string; active: number;
    builtin_handler: string; flow_id: string;
    role?: string;
    rank_id?: string;
    executor_type?: 'native' | 'claude_code' | string;
    model_chain?: string;
    // Both ride along in the graph payload, so Overview can lead with the
    // mandate and gate the office environment without a second fetch.
    system_prompt?: string;
    allowed_tools?: string;
    // How long the kernel lets a run go. The chat waits on the agent's own
    // budget instead of a hardcoded one.
    timeout_ms?: number;
  }> = [];
  export let chains: Array<{
    id: string; source_agent_id: string; target_agent_id: string;
    label: string; active: number;
  }> = [];
  export let flows: Array<{ id: string; name: string; color: string; active: number }> = [];
  export let ranks: Array<{
    id: string; name: string; level: number;
    insignia: string; color: string; description: string; active: number;
  }> = [];
  export let flowEvents: AgentFlowEvent[] = [];
  export let runningAgentIds: Set<string> = new Set();
  export let stats: Record<string, { total_runs: number; completed: number; failed: number; success_rate: number }> = {};
  export let triggerCount: number = 0;
  export let todayRuns: number = 0;
  // Parent's first-fetch lifecycle (graphData). The boot loader stays up until
  // `dataLoaded` is true so the offices are never revealed empty mid-fetch.
  export let dataLoaded: boolean = false;
  export let dataError: boolean = false;

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

  // ── Ambient FX budget ──────────────────────────────────────────────────
  // The "thinking" gears (one per active agent's tool call / thought) are the
  // only effect with an unbounded population — every running agent could spawn
  // one each frame. Cap concurrent ambient FX so a 200-agent stampede can't
  // flood the registry. Combined with the per-tag debounce + frustum cull, the
  // visible cost stays bounded. The counter is incremented at spawn and
  // decremented when the effect's lifetime elapses (setTimeout matching the
  // effect's durationSec — simplest reliable decrement).
  const MAX_AMBIENT_FX = 12;
  let ambientFxCount = 0;
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

  /** (#F1) Spawn the "thinking" 3D effect over an agent's desk: a small spinning
   *  gear above the head + a brief monitor-screen emissive pulse. Gated by the
   *  frustum cull + ambient-FX cap + a ~1.5s per-agent debounce. */
  function spawnThinkingFx(aid: string): void {
    if (!aid || !scene || !THREE) return;
    if (!deskInView(aid)) return;
    if (ambientFxCount >= MAX_AMBIENT_FX) return;
    const dg = deskGroups.get(aid);
    if (!dg) return;
    tryFireAnim(`think:${aid}`, 1.5, () => {
      const gearDur = 1.4;
      ambientFxCount++;
      animRegistry.add(spinningGear(dg, {
        startY: 3.2,
        durationSec: gearDur,
        color: flowColor(aid),
        tag: `think:${aid}`,
      }));
      // Decrement the budget when the gear's lifetime elapses. The registry
      // disposes the ticker itself; this only frees the slot counter.
      setTimeout(() => { ambientFxCount = Math.max(0, ambientFxCount - 1); }, gearDur * 1000 + 50);
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
          durationSec: gearDur,
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

  /** Parse a CSS hex color (`#rrggbb`) to a THREE-friendly numeric hex. */
  function hexToNum(css: string, fallback = 0xffffff): number {
    const n = parseInt((css || '').replace('#', ''), 16);
    return Number.isFinite(n) ? n : fallback;
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

  /** Map a kernel tool name to a glyph for the floating-tool-icon animation. */
  function toolGlyph(name: string): string {
    if (!name) return '🔧';
    const n = name.toLowerCase();
    if (n.includes('email') || n.includes('mail')) return '📧';
    if (n.includes('workspace')) return '💻';
    if (n.includes('files') || n.includes('fs_')) return '📁';
    if (n.includes('web')) return '🌐';
    if (n.includes('calendar') || n.includes('events')) return '📅';
    if (n.includes('tasks')) return '✅';
    if (n.includes('chat') || n.includes('comms')) return '💬';
    if (n.includes('code')) return '⌨️';
    if (n.includes('trad')) return '📈';
    if (n.includes('vault')) return '🔐';
    if (n.includes('graph') || n.includes('memory')) return '🧠';
    if (n.includes('research') || n.includes('search')) return '🔍';
    if (n.includes('agent')) return '🤝';
    return '🔧';
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
  interface OfficeReport { agentName: string; agentId: string; text: string; color: string; ts: number; status: string; runId?: string }
  let officeReports: OfficeReport[] = [];

  // ── Pending questions from agents (top-agent inbox) ──────────────
  interface PendingQuestion {
    id: string;
    from_agent_id: string;
    flow_id: string;
    question: string;
    context: string;
    options: Array<{ label: string; value?: string; url?: string }>;
    created_at: string;
  }
  let pendingQuestions: PendingQuestion[] = [];
  let questionSubmitting: Record<string, boolean> = {};
  async function loadPendingQuestions() {
    try {
      const res = await fetch('/api/agents/questions?status=pending&limit=50');
      if (!res.ok) return;
      const data = await res.json();
      pendingQuestions = (data.questions ?? []) as PendingQuestion[];
    } catch { /* best effort */ }
  }
  /** Pull the first http(s) URL out of a free-text context. Used as a
   *  fallback for older questions whose options don't yet carry `url`. */
  function firstUrlIn(text: string | undefined | null): string | null {
    if (!text) return null;
    const m = text.match(/https?:\/\/[^\s)\]>"']+/i);
    return m ? m[0] : null;
  }
  /** Resolve the URL an option should open: explicit `url` wins; otherwise,
   *  if the option's label hints at opening a link ("open"), fall
   *  back to the first URL found in the question's context. */
  function urlForOption(q: PendingQuestion, opt: { label: string; value?: string; url?: string }): string | null {
    if (opt.url && /^https?:\/\//i.test(opt.url)) return opt.url;
    const labelMentionsLink = /(open|view|visit|go to)/i.test(opt.label);
    const valueMentionsLink = opt.value === 'open' || opt.value === 'view' || opt.value === 'visit';
    if (labelMentionsLink || valueMentionsLink) return firstUrlIn(q.context);
    return null;
  }
  async function answerQuestion(q: PendingQuestion, idx: number, opt: { label: string; value?: string; url?: string }) {
    if (questionSubmitting[q.id]) return;
    // Open the linked URL FIRST (synchronously, inside the user's click event)
    // — popup blockers reject window.open() when it's behind an async await.
    const target = urlForOption(q, opt);
    if (target) {
      window.open(target, '_blank', 'noopener,noreferrer');
    }
    questionSubmitting = { ...questionSubmitting, [q.id]: true };
    try {
      await fetch(`/api/agents/questions/${q.id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected_index: idx, selected_option: opt.label }),
      });
      pendingQuestions = pendingQuestions.filter(x => x.id !== q.id);
    } finally {
      questionSubmitting = { ...questionSubmitting, [q.id]: false };
    }
  }
  async function dismissQuestion(q: PendingQuestion) {
    if (questionSubmitting[q.id]) return;
    questionSubmitting = { ...questionSubmitting, [q.id]: true };
    try {
      await fetch(`/api/agents/questions/${q.id}/dismiss`, { method: 'POST' });
      pendingQuestions = pendingQuestions.filter(x => x.id !== q.id);
    } finally {
      questionSubmitting = { ...questionSubmitting, [q.id]: false };
    }
  }

  // Bulk actions for the My Office panel.
  let bulkBusy = false;
  async function dismissAllQuestions() {
    if (bulkBusy || pendingQuestions.length === 0) return;
    if (!confirm(`Dismiss all ${pendingQuestions.length} pending questions?`)) return;
    bulkBusy = true;
    const snapshot = [...pendingQuestions];
    try {
      // Fire all dismissals in parallel — server-side they're independent.
      await Promise.all(snapshot.map(q =>
        fetch(`/api/agents/questions/${q.id}/dismiss`, { method: 'POST' }).catch(() => null)
      ));
      pendingQuestions = [];
    } finally {
      bulkBusy = false;
    }
  }
  function clearErrors() {
    if (officeReports.filter(r => r.status === 'failed').length === 0) return;
    officeReports = officeReports.filter(r => r.status !== 'failed');
  }
  function clearActivity() {
    if (officeReports.filter(r => r.status !== 'failed').length === 0) return;
    officeReports = officeReports.filter(r => r.status === 'failed');
  }
  function clearAllOfficeData() {
    if (!confirm('Clear ALL reports and dismiss ALL pending questions?')) return;
    void dismissAllQuestions();
    officeReports = [];
    officeReportsLoaded = false;
  }
  let showMyOfficePanel = false;
  let myOfficeTab: 'overview' | 'questions' | 'errors' = 'overview';
  let officeReportsLoaded = false;
  let openReport: OfficeReport | null = null;

  // ── "Send to fixer" — dispatch the open report to a fixing agent ──
  // The list below is a name-matched whitelist of active claude_code agents
  // that can reasonably act on a bug/error/infra report. Order = priority;
  // the first one that exists is the default. The user can override via the
  // ▾ dropdown next to the button.
  interface FixerCandidate { id: string; name: string; hint: string; }
  const FIXER_WHITELIST: Array<{ match: RegExp; hint: string }> = [
    { match: /^director de desarrollo$/i, hint: 'dev manager — fixes code + infra' },
    { match: /^project builder$/i, hint: 'generic dev fixer' },
    { match: /^cloudops$/i, hint: 'infra / MCP / deploy' },
    { match: /^repo coordinator$/i, hint: 'routes work into registered repos' },
    { match: /^security auditor$/i, hint: 'security findings only' },
    { match: /^error auditor$/i, hint: 'triages — does NOT fix' },
  ];
  $: fixerCandidates = (() => {
    const out: FixerCandidate[] = [];
    for (const w of FIXER_WHITELIST) {
      const a = agents.find(x => x.active === 1 && w.match.test(x.name));
      if (a) out.push({ id: a.id, name: a.name, hint: w.hint });
    }
    // Whoever holds the top rank is always a valid last-resort target — looked
    // up by rank, never by name, so renaming the agent or the rank can't
    // silently drop it from the list.
    const top = topAgent();
    if (top && !out.some(c => c.id === top.id)) {
      out.push({ id: top.id, name: top.name, hint: 'top-level coordinator / router' });
    }
    return out;
  })();
  let selectedFixerId: string | null = null;
  let fixerPickerOpen = false;
  let sendingToFixer = false;
  let fixerStatus = '';
  // Resolve which agent will receive the report — explicit pick wins, else
  // first candidate, else null (button stays disabled).
  $: activeFixer = (() => {
    if (selectedFixerId) return fixerCandidates.find(c => c.id === selectedFixerId) ?? null;
    return fixerCandidates[0] ?? null;
  })();

  function buildFixerGoal(report: OfficeReport, body: string): string {
    return [
      `An agent run reported an issue that needs diagnosis + a fix.`,
      ``,
      `Source agent: ${report.agentName} (${report.agentId})`,
      `Run ID:       ${report.runId ?? '(unknown)'}`,
      `Status:       ${report.status}`,
      `When:         ${new Date(report.ts).toISOString()}`,
      ``,
      `--- BEGIN REPORT BODY ---`,
      body,
      `--- END REPORT BODY ---`,
      ``,
      `Please:`,
      `  1. Diagnose the root cause from the report body above.`,
      `  2. If it's a code/config/infra issue you can fix, fix it. Otherwise route to the right agent (post_to_colleague) with a clear ask.`,
      `  3. Reply with: ROOT_CAUSE, ACTION_TAKEN (or DELEGATED_TO + agent), and STATUS (fixed / in_progress / blocked).`,
    ].join('\n');
  }

  async function sendReportToFixer(): Promise<void> {
    if (!openReport || sendingToFixer) return;
    const fixer = activeFixer;
    if (!fixer) { fixerStatus = '✗ no fixer agent available'; return; }
    sendingToFixer = true;
    fixerStatus = '';
    try {
      const body = (fullReportText ?? openReport.text ?? '').slice(0, 16000);
      const goal = buildFixerGoal(openReport, body);
      const res: any = await rpcOrCall('agents.run', { agent_id: fixer.id, goal }, async () => {
        const r = await fetch('/api/agents/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: fixer.id, goal }),
        });
        return r.json();
      });
      if (res?.success || res?.run_id) {
        // Drop the dispatched report from the visible list. Same-shape filter
        // also touches the errorReports view (computed from officeReports).
        // The {#each (key)} + out:slide on the cards animates the removal.
        const target = openReport;
        const targetKey = target.runId ?? `${target.agentId}-${target.ts}`;
        // Close the report modal first so its closing animation doesn't fight
        // the list-card slide-out — keeps both transitions clean.
        openReport = null;
        // Force a reactive remove. Filter handles the case where the same
        // report object lives in officeReports under a different reference.
        officeReports = officeReports.filter(r => (r.runId ?? `${r.agentId}-${r.ts}`) !== targetKey);
        fixerStatus = `✓ sent to ${fixer.name} · run ${String(res.run_id || '').slice(0, 8)}`;
      } else {
        fixerStatus = `✗ ${res?.error || 'failed to dispatch'}`;
      }
    } catch (e: any) {
      fixerStatus = `✗ ${e?.message ?? String(e)}`;
    } finally {
      sendingToFixer = false;
      setTimeout(() => { fixerStatus = ''; }, 6000);
    }
  }

  // Fire-and-forget POST to /api/agents/flow-diag so diagnostic context from
  // the 3D view lands in the kernel log (keeps browser console clean).
  function reportWalkerDiag(payload: Record<string, unknown>): void {
    try {
      fetch('/api/agents/flow-diag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => { /* best effort */ });
    } catch { /* best effort */ }
  }

  // ── Live meeting transcripts ──────────────────
  // Keyed by meeting_id. Updated by meeting_requested / _started / _turn / _ended
  // events arriving on the agents.flow WS. The modal at the bottom of the
  // markup renders this Map reactively so each turn appears as soon as the
  // backend emits it.
  interface LiveTurn { agentId: string; agentName: string; role: string; round: number; body: string; ts: number; tokens: number }
  interface LiveMeeting {
    id: string;
    topic: string;
    status: 'requested' | 'started' | 'completed' | 'failed';
    moderatorId: string;
    moderatorName: string;
    participants: Array<{ id: string; name: string }>;
    turns: LiveTurn[];
    started_at: number;
    ended_at?: number;
    summary?: string;
    decisions?: string[];
    action_items?: string[];
    /** Agent id of whoever is talking right now — drives the speaker
     *  spotlight + listener dim in the 3D scene. Cleared on meeting_ended. */
    currentSpeakerId?: string;
  }
  // ── Management log (prompt edits + escalations) ─────────
  // Visible record of every time a manager reshapes the fleet or escalates
  // across offices. Rendered in a small floating panel bottom-left so the
  // user sees the org-level activity at a glance.
  interface MgmtEntry {
    kind: 'edit' | 'directive' | 'escalation';
    from: string; to: string;
    detail: string;
    preview: string;
    ts: number;
    crossOffice?: boolean;
    role?: string;
  }
  let mgmtLog: MgmtEntry[] = [];
  // ── Visualization toggles ───────────────────────
  // All visualization layers are managed from the hq-bar dropdown so the
  // user has a single, always-visible control surface. Defaults are tuned
  // so the canvas stays clean on first load — Meetings panel only opens on
  // demand, modal opens automatically when a real meeting starts.
  let showMgmtLog = false;
  let showMeetingHistory = false;
  let showPerfHud = false;

  // Dismiss a single meeting from the history panel — archives it on the
  // server (so a refresh doesn't bring it back) and removes it from the
  // local store. Active meetings (requested/started) are kept; only the
  // X button on completed/failed rows triggers this.
  async function dismissMeeting(meetingId: string): Promise<void> {
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
  async function dismissAllReadMeetings(): Promise<void> {
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
    // Visibility is controlled exclusively from the hq-bar View menu now —
    // we do NOT auto-open the panel, otherwise the user's "off" choice gets
    // overridden whenever a new manager event arrives. The unread count on
    // the View toggle (badge) signals the new activity instead.
  }
  function mgmtKindIcon(k: MgmtEntry['kind']): string {
    return k === 'edit' ? '📝' : k === 'directive' ? '📤' : '📨';
  }
  function mgmtKindColor(k: MgmtEntry['kind'], cross?: boolean): string {
    if (k === 'edit') return '#c67fe8';
    if (k === 'directive') return '#f0883e';
    return cross ? '#5b8def' : '#3dd6c8';
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
  // Full-text cache keyed by runId — events only carry a 200-char preview, so
  // when the modal opens we fetch the full agent_runs.result from the API.
  let fullReportText: string | null = null;
  let fullReportLoading = false;

  async function loadFullReport(runId: string) {
    fullReportText = null;
    if (!runId) return;
    fullReportLoading = true;
    try {
      const res = await fetch(`/api/agents/runs/${runId}`);
      const data: any = await res.json();
      const full = String(data?.run?.result ?? data?.run?.error ?? '');
      if (full) fullReportText = full;
    } catch { /* keep preview */ }
    fullReportLoading = false;
  }

  $: if (openReport?.runId) { loadFullReport(openReport.runId); } else { fullReportText = null; }
  $: displayReportText = (fullReportText ?? openReport?.text ?? '');
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

  // ── Register-repo modal state ────────────────────────────────
  // Opened by clicking a FREE rack OR by the floating "+" button in the HQ
  // overlay. Submits via rpcOrCall('repos.register', …) → backend extension.
  let showRegisterRepoModal = false;
  let registerRepoName = '';
  let registerRepoPath = '';
  let registerRepoDesc = '';
  let registerRepoTags = '';
  let registerRepoBusy = false;
  let registerRepoError = '';
  // Does ANY flow look like a Repos Office? Drives visibility of the floating
  // button so the entry-point only appears when the office actually exists.
  $: hasReposOffice = flows.some(f => { const n = (f.name || '').trim().toLowerCase(); return n.startsWith('repos') || n.startsWith('devops'); });

  /** POST to repos.register via the RPC bus (mtw-request) with a REST
   *  fallback to /api/mtw. On success we refetch repos + force a scene
   *  rebuild so the new rack lights up immediately. */
  async function submitRegisterRepo(): Promise<void> {
    const name = registerRepoName.trim();
    const path = registerRepoPath.trim();
    if (!name) { registerRepoError = 'Name is required'; return; }
    if (!path || !path.startsWith('/')) { registerRepoError = 'Absolute path is required (must start with /)'; return; }
    registerRepoBusy = true;
    registerRepoError = '';
    try {
      // The repos extension exposes `repos.register` over the mtwRequest WS
      // bus (auto-registered RpcAction). No matching HTTP route exists today
      // — if WS is down the register has to wait, hence the explicit error.
      const args: Record<string, unknown> = { name, path };
      const desc = registerRepoDesc.trim(); if (desc) args.description = desc;
      const tags = registerRepoTags.trim(); if (tags) args.tags = tags;
      await rpc('repos.register', args, 8000);
      // Success → refresh + rebuild so the rack flips from FREE to OCCUPIED.
      await fetchReposBookmarks();
      rebuildScene();
      showRegisterRepoModal = false;
    } catch (e: any) {
      registerRepoError = e?.message ?? String(e);
    } finally {
      registerRepoBusy = false;
    }
  }

  function openRegisterRepoModal(): void {
    registerRepoError = '';
    registerRepoName = '';
    registerRepoPath = '';
    registerRepoDesc = '';
    registerRepoTags = '';
    showRegisterRepoModal = true;
  }

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
      const nm = (flow?.name || '').trim().toLowerCase();
      if (nm.startsWith('comunicacion') || nm.startsWith('communication')) {
        buildCommunicationsOffice(target, room);
      } else if (nm.startsWith('repos') || nm.startsWith('devops')) {
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
    if (meetingSlots.length > 0) buildMeetingRooms(target, meetingSlots, hallCenter);

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

    // Nameplate — RANK pill + insignia + agent name, anchored above his
    // head. The pill text is the RANK name uppercased so renaming the
    // rank in the dashboard re-labels the top agent automatically.
    const div = document.createElement('div');
    const insignia = topRank?.insignia ?? '✪';
    const insColor = topRank?.color ?? '#7c3aed';
    const rankName = topRank?.name ?? '';
    const rankPill = rankName.toUpperCase();
    // The seeder defaults the agent name to the rank name, so showing both
    // would print the same label twice (rank pill above + name below).
    // Drop the name line when it duplicates the rank — if the user renames
    // the agent to anything else, both lines render again.
    const showName =
      holder.name.trim().toLowerCase() !== rankName.trim().toLowerCase();
    div.innerHTML =
      `<div style="text-align:center;pointer-events:none">` +
      `<div style="display:inline-block;background:#c9a84c;color:#1a1a1a;` +
      `font:900 9px 'Manrope',sans-serif;letter-spacing:1.2px;` +
      `padding:2px 8px;border-radius:3px;margin-bottom:3px;` +
      `box-shadow:0 0 8px rgba(201,168,76,0.7);` +
      `text-shadow:none">${escapeHtml(rankPill)}</div>` +
      `<div style="font:900 14px 'Manrope',sans-serif;color:${insColor};` +
      `text-shadow:0 1px 2px rgba(0,0,0,0.85);line-height:1;${showName ? 'margin-bottom:2px' : ''}">${escapeHtml(insignia)}</div>` +
      (showName
        ? `<div style="font:700 11px 'Manrope',sans-serif;color:#f3e9c7;white-space:nowrap;` +
          `text-shadow:0 1px 3px rgba(0,0,0,0.9);background:rgba(13,15,24,0.7);padding:2px 10px;` +
          `border-radius:3px;border-bottom:2px solid #c9a84c">${escapeHtml(holder.name)}</div>`
        : '') +
      `</div>`;
    const label = new CSS2DObject(div);
    label.position.set(headPos.x, headPos.y + 0.5, headPos.z);
    target.add(label);
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
  function showBubble(aid: string, text: string, dur = 200) {
    const old = speechBubbles.get(aid);
    if (old) {
      // Remove from parent (could be scene or desk group)
      if (old.label.parent) old.label.parent.remove(old.label);
      old.div.remove();
      animRegistry.cancelByTag(`bubble:${aid}`);
      speechBubbles.delete(aid);
    }
    const deskGroup = deskGroups.get(aid);
    if (!deskGroup) return;
    const div = document.createElement('div');
    // Bubble text is user chat input / agent output — escape to prevent XSS.
    div.innerHTML = escapeHtml(text);
    div.style.cssText = `font:600 9px 'Fira Code',monospace;color:#111;
      background:#f0f0e8;border:2px solid #222;padding:4px 10px;
      border-radius:4px;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      box-shadow:2px 3px 0 #000;animation:bpop .15s ease-out;`;
    const lbl = new CSS2DObject(div);
    // Position above the worker's head (worker is at z=0.55, head at y~1.6, scaled 1.3x)
    lbl.position.set(0, 3.2, 0.55);
    deskGroup.add(lbl); // add to desk group so it follows the worker
    speechBubbles.set(aid, { div, label: lbl, age: 0, maxAge: dur });
    animRegistry.add(bubbleFade(div, {
      maxAgeFrames: dur,
      tag: `bubble:${aid}`,
      onExpire: () => {
        if (lbl.parent) lbl.parent.remove(lbl);
        div.remove();
        if (speechBubbles.get(aid)?.label === lbl) speechBubbles.delete(aid);
      },
    }));
  }

  // ── Animated agent-event tag ────────────────────
  // The unified event indicator: a single CSS2D card whose icon animates via
  // CSS keyframes (pulse / spin / shake / wobble / bounce / sparkle / pop).
  // Replaces both the old text-only `showBubble` AND the separate floating
  // glyphs for step/run/edit events — one self-contained visual per event,
  // readable from any camera distance, no per-frame JS work on the icon.
  type AnimatedTagAnim = 'pulse' | 'spin' | 'shake' | 'wobble' | 'bounce' | 'sparkle' | 'pop';
  function showAnimatedTag(aid: string, opts: {
    icon: string;
    anim?: AnimatedTagAnim;
    color?: string;            // border + glow color (CSS)
    label?: string;            // optional small caption to the right of the icon
    durationFrames?: number;   // lifetime (drives bubbleFade)
  }): void {
    if (!aid) return;
    const old = speechBubbles.get(aid);
    if (old) {
      if (old.label.parent) old.label.parent.remove(old.label);
      old.div.remove();
      animRegistry.cancelByTag(`bubble:${aid}`);
      speechBubbles.delete(aid);
    }
    const deskGroup = deskGroups.get(aid);
    if (!deskGroup) return;
    const color = opts.color ?? flowColor(aid);
    const anim = opts.anim ?? 'pulse';
    const dur = opts.durationFrames ?? 200;
    const labelHtml = opts.label
      ? `<span style="font:700 9px/1 'Fira Code',monospace;color:${color};letter-spacing:1.5px;text-transform:uppercase;opacity:.9;">${opts.label}</span>`
      : '';
    const div = document.createElement('div');
    div.className = `atag atag-anim-${anim}`;
    div.style.cssText = `display:inline-flex;align-items:center;gap:7px;
      background:linear-gradient(180deg,rgba(0,8,16,0.92),rgba(0,16,32,0.96));
      border:2px solid ${color};padding:5px 10px;border-radius:14px;
      box-shadow:0 0 12px ${color},0 2px 6px rgba(0,0,0,0.4);
      pointer-events:none;color:#fff;will-change:opacity;`;
    div.innerHTML = `<span class="atag-icon" style="font-size:18px;color:${color};">${opts.icon}</span>${labelHtml}`;
    const lbl = new CSS2DObject(div);
    lbl.position.set(0, 3.2, 0.55);
    deskGroup.add(lbl);
    speechBubbles.set(aid, { div, label: lbl, age: 0, maxAge: dur });
    animRegistry.add(bubbleFade(div, {
      maxAgeFrames: dur,
      tag: `bubble:${aid}`,
      onExpire: () => {
        if (lbl.parent) lbl.parent.remove(lbl);
        div.remove();
        if (speechBubbles.get(aid)?.label === lbl) speechBubbles.delete(aid);
      },
    }));
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
    const bannerObj = new CSS2DObject(bannerEl);
    bannerObj.position.set(room.cx, 6.5, room.cz);
    scene.add(bannerObj);

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
    meetingDecor.delete(meetingId);
  }

  function escapeBannerText(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── HQ menu (hidden dropdown) ───────────────────
  let hqMenuOpen = false;

  // ── Pending-approval dropdown ────────────────────
  let pendingMenuOpen = false;
  let activatingAgentId: string | null = null;
  $: pendingAgents = agents.filter(a => a.active !== 1);

  // O(1) agent lookup for per-frame loops — rebuilt only when the agents
  // array is reassigned (parent polls ~1/min). Avoids agents.find() scans
  // inside the animation loop (230 agents × 230 lookups/frame otherwise).
  let agentById: Map<string, any> = new Map();
  $: agentById = new Map(agents.map(a => [a.id, a]));

  // ── Agent search (HUD lupa) ────────────────────────
  // Click the magnifier in the HQ stats row → input expands inline.
  // Type → filtered list of agents drops down (matches name/slug).
  // Click a row → camera zooms onto the agent's desk + opens its panel.
  let searchOpen = false;
  let searchQuery = '';
  let searchInputEl: HTMLInputElement | null = null;
  $: searchResults = (() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return agents
      .filter(a => {
        const hay = `${a.name ?? ''} ${a.slug ?? ''}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 12);
  })();
  function openSearch() {
    searchOpen = true;
    pendingMenuOpen = false;
    hqMenuOpen = false;
    // Focus on next tick once the input is mounted.
    setTimeout(() => { searchInputEl?.focus(); }, 0);
  }
  function closeSearch() {
    searchOpen = false;
    searchQuery = '';
  }
  function focusAgentById(id: string) {
    if (!camera || !controls) { selectedAgent = id; closeSearch(); return; }
    const p = deskPos.get(id);
    if (!p) { selectedAgent = id; closeSearch(); return; }
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
    closeSearch();
  }
  function onSearchKey(ev: KeyboardEvent) {
    if (ev.key === 'Escape') { closeSearch(); return; }
    if (ev.key === 'Enter' && searchResults.length > 0) {
      focusAgentById(searchResults[0].id);
    }
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

  async function activateAgent(agentId: string) {
    if (activatingAgentId) return;
    activatingAgentId = agentId;
    try {
      const r = await fetch(`/api/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      });
      const data = await r.json();
      if (data?.success) {
        dispatch('refresh');
      } else {
        console.error('activate failed', data?.error);
      }
    } catch (e) {
      console.error('activate network error', e);
    } finally {
      activatingAgentId = null;
    }
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
  // "New Office" wizard (Office Kit) — the form-based, no-code creator.
  // The AI-chat creator (OfficeCreatorChat, `showOfficeModal`) stays as the
  // conversational alternative, reachable from the HQ menu + top-agent click.
  // Deep-link: /agents-flow?new=office opens the wizard directly (same
  // pattern as ?chat=chief below).
  let showNewOfficeWizard = (() => {
    try {
      return typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).get('new') === 'office';
    } catch { return false; }
  })();


  // ── Build Scene ────────────────────────────────
  // Idempotent: dissolve the boot loader exactly once, after the next painted
  // frame. Called when the office is first populated with agents (or by the
  // fallback timer if no agents ever load).
  function markSceneReady(): void {
    if (sceneReady) return;
    if (sceneReadyFallbackTimer) { clearTimeout(sceneReadyFallbackTimer); sceneReadyFallbackTimer = null; }
    requestAnimationFrame(() => { sceneReady = true; });
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

    const opts = [
      { antialias: true, alpha: false, failIfMajorPerformanceCaveat: false, powerPreference: 'high-performance' as const, preserveDrawingBuffer: false },
      { antialias: false, alpha: false, failIfMajorPerformanceCaveat: false, powerPreference: 'default' as const },
      { antialias: false, alpha: false, failIfMajorPerformanceCaveat: false },
    ];
    for (const o of opts) {
      try {
        renderer = new THREE.WebGLRenderer(o);
        // Verify the context is actually usable
        const gl = renderer.getContext();
        if (!gl || gl.isContextLost?.()) { renderer = null; continue; }
        break;
      } catch (e) {
        console.warn('[WebGL] renderer init failed:', e);
        renderer = null;
      }
    }
    if (!renderer) { webglError = 'WebGL not available. Check GPU settings.'; return; }

    renderer.setSize(canvasEl.clientWidth, canvasEl.clientHeight);
    // Cap pixel ratio at 1.5 — HiDPI displays (dpr=2/3) quadruple shading cost
    // for marginal visual gain on a dense 3D scene. 1.5 still looks crisp.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    // Accumulate render stats across all passes (composer / post-process /
    // labelRenderer) within a single frame so the perf overlay sees the real
    // total — auto-reset would zero between sub-renders and only the last
    // pass (e.g. a fullscreen quad) would survive.
    renderer.info.autoReset = false;
    renderer.shadowMap.enabled = true;
    // PCFSoft is noticeably cheaper than VSM on dense scenes and visually
    // indistinguishable for our top-down office view.
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Shadow pass at half frame rate: the key light and the architecture are
    // static — only walkers/taxis move shadows, and 30Hz on those is
    // imperceptible. Saves a full 2048² depth render every other frame.
    // (needsUpdate=true is set on even frames in animate(); true here so the
    // very first frame bakes shadows.)
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    // ── Color grading global — ver office3d/grading.ts ──
    applyRendererGrading(renderer);
    // Procedural world textures sample at grazing angles on floors/streets —
    // real HW anisotropy keeps them sharp without supersampling.
    setTextureAnisotropy(renderer.capabilities?.getMaxAnisotropy?.() ?? 4);
    canvasEl.appendChild(renderer.domElement);

    labelRenderer = new css2d.CSS2DRenderer();
    labelRenderer.setSize(canvasEl.clientWidth, canvasEl.clientHeight);
    labelRenderer.domElement.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:5;';
    canvasEl.appendChild(labelRenderer.domElement);

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

    // ── Environment map for realistic reflections on glass/metal ──
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      // Richer studio-style environment → more believable reflections on metal
      // and glass. All meshes live in this throwaway scene and are baked once
      // by PMREM into a cubemap; zero per-frame cost.
      const envScene = new THREE.Scene();
      envScene.add(new THREE.Mesh(
        new THREE.SphereGeometry(50, 24, 16),
        new THREE.MeshBasicMaterial({ color: 0x0a1020, side: 1 }),
      ));
      // Warm ceiling glow (brighter so highlights on metal/glass read).
      const ceilGlow = new THREE.Mesh(
        new THREE.PlaneGeometry(90, 90),
        new THREE.MeshBasicMaterial({ color: 0x24304e }),
      );
      ceilGlow.position.y = 40; ceilGlow.rotation.x = Math.PI / 2;
      envScene.add(ceilGlow);
      // Cool floor reflection
      const floorGlow = new THREE.Mesh(
        new THREE.PlaneGeometry(90, 90),
        new THREE.MeshBasicMaterial({ color: 0x070c1a }),
      );
      floorGlow.position.y = -10; floorGlow.rotation.x = -Math.PI / 2;
      envScene.add(floorGlow);
      // Horizon haze band → soft gradient at eye level, the bit reflections
      // actually catch on near-vertical surfaces.
      const horizon = new THREE.Mesh(
        new THREE.CylinderGeometry(48, 48, 22, 24, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x12203c, side: 1 }),
      );
      envScene.add(horizon);
      // Warm key bounce (upper-right, matching the sun) + cool fill (opposite)
      // → directional shine on metals instead of a flat ambient sheen.
      const keyPanel = new THREE.Mesh(
        new THREE.PlaneGeometry(38, 26),
        new THREE.MeshBasicMaterial({ color: 0x4a4030, side: 2 }),
      );
      keyPanel.position.set(26, 16, 18); keyPanel.lookAt(0, 0, 0);
      envScene.add(keyPanel);
      const fillPanel = new THREE.Mesh(
        new THREE.PlaneGeometry(34, 22),
        new THREE.MeshBasicMaterial({ color: 0x1c3258, side: 2 }),
      );
      fillPanel.position.set(-30, 12, -22); fillPanel.lookAt(0, 0, 0);
      envScene.add(fillPanel);
      // Higher blur sigma (0.035→0.18): the env is a few flat colored panels;
      // sharp, they reflected as hard ugly blotches on any glossy floor. Blurred
      // they read as a soft gradient, so reflections look like ambient sheen.
      const envMap = pmrem.fromScene(envScene, 0.18).texture;
      scene.environment = envMap;
      pmrem.dispose();
    } catch (e) { console.warn('[EnvMap] Failed:', e); }
    // Fog + environment intensity — unconditional (must apply even if PMREM
    // env generation above threw; environmentIntensity is `in`-guarded).
    applySceneGrading(scene);

    // Isometric-style camera (high angle, looking down). Factor in the
    // streetscape added by buildStreets — sidewalk + street extends ~15u past
    // the building bounds, and with FOV 35° the default cd based only on the
    // desks was clipping the entire block outside the frame.
    let ext = 0;
    for (const [, p] of deskPos) ext = Math.max(ext, Math.sqrt(p.x ** 2 + p.z ** 2));
    const b = corGrid.buildingBounds;
    const buildingRadius = Math.max(Math.abs(b.maxX), Math.abs(b.minX), Math.abs(b.maxZ), Math.abs(b.minZ));
    const STREET_MARGIN = 23; // ≈ PLINTH_W (5) + PED_W (3.5) + STREET_W (12) + portal in office.ts
    const cd = Math.max(60, Math.max(ext, buildingRadius + STREET_MARGIN) * 1.15);
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

    // ── Post-processing: selective bloom for emissive surfaces (monitors, envelopes) ──
    // Bloom adds 3 fullscreen passes per frame. On HiDPI displays that's very
    // expensive; skip it entirely on retina / >1.5x dpr and fall back to direct
    // render. Loss of bloom is barely noticeable with tonemapping active.
    if (window.devicePixelRatio <= 1.5) {
      try {
        const { EffectComposer } = await import('three/examples/jsm/postprocessing/EffectComposer.js');
        const { RenderPass } = await import('three/examples/jsm/postprocessing/RenderPass.js');
        const { UnrealBloomPass } = await import('three/examples/jsm/postprocessing/UnrealBloomPass.js');
        const { OutputPass } = await import('three/examples/jsm/postprocessing/OutputPass.js');
        composer = new EffectComposer(renderer);
        // ── Anti-aliasing through the composer (fixes the "pixelado") ──
        // The renderer's `antialias:true` ONLY anti-aliases the default
        // framebuffer — which the EffectComposer bypasses entirely. So every
        // edge in the post-processed scene (i.e. always, on dpr≤1.5 monitors)
        // was rendered with zero MSAA → jagged/aliased = the pixelation the
        // user saw. Enable 4× MSAA on the composer's ping-pong render targets.
        // We let the default constructor size them correctly (CSS px × dpr) and
        // only flip `samples` + dispose so the GL framebuffers reinit as
        // multisampled (setSize alone ignores a samples change). samples is
        // preserved across resize, so this survives the ResizeObserver path.
        const AA_SAMPLES = 4;
        for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
          rt.samples = AA_SAMPLES;
          rt.dispose();
        }
        composer.addPass(new RenderPass(scene, camera));

        // GTAO — screen-space ambient occlusion. DISABLED by default: at our
        // sample budget it produced view-dependent noise/blotches on flat
        // surfaces (desks, carpet) that read as "manchas". The scene already
        // has zero-cost baked vertex AO (bakeVertexAO) + real shadow maps for
        // depth, so dropping GTAO removes the artifact AND saves the most
        // expensive post pass. Flip GTAO_ENABLED back to true to restore it.
        const GTAO_ENABLED = false;
        const aoCores = navigator.hardwareConcurrency ?? 8;
        if (GTAO_ENABLED && aoCores >= 4) {
          try {
            const { GTAOPass } = await import('three/examples/jsm/postprocessing/GTAOPass.js');
            const gtao = new GTAOPass(scene, camera, canvasEl.clientWidth, canvasEl.clientHeight);
            gtao.output = (GTAOPass as any).OUTPUT.Default;
            // AO tuned to stop the blotchy "reflejo feo" on flat surfaces
            // (keyboards, carpet): smaller radius keeps it as tight contact
            // shadows instead of large smears; distanceExponent 1→2 makes AO
            // fall off faster so it stops bleeding across flat planes; samples
            // back up to 16 to kill the noise the 8-sample pass introduced. The
            // adaptive controller still disables the whole pass under load.
            gtao.updateGtaoMaterial({
              radius: 0.5, distanceExponent: 2, thickness: 1,
              scale: 1.0, samples: 16, screenSpaceRadius: false,
            });
            composer.addPass(gtao);
            gtaoPass = gtao;
          } catch (e) { console.warn('[GTAO] unavailable, skipping AO pass:', e); }
        }

        // Bloom — subtle glow on emissive surfaces. Strength + radius dialed
        // down (0.3→0.15, 0.5→0.3) to roughly halve the post-process cost.
        // Visually still picks up on monitor glow / running emissives.
        const bloom = new UnrealBloomPass(
          new THREE.Vector2(canvasEl.clientWidth, canvasEl.clientHeight),
          GRADING.bloom.strength,
          GRADING.bloom.radius,
          GRADING.bloom.threshold,
        );
        composer.addPass(bloom);
        bloomPass = bloom;
        composer.addPass(new OutputPass());
      } catch (e) {
        console.warn('[PostProcess] Not available, falling back to direct render:', e);
        composer = null;
      }
    } else {
      composer = null;
    }

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
        // Click on a FREE server rack → open the register-repo modal,
        // pre-filled with nothing. The rack itself is just a discoverable
        // entry-point; the modal is shared with the floating HQ button.
        registerRepoError = '';
        registerRepoName = '';
        registerRepoPath = '';
        registerRepoDesc = '';
        registerRepoTags = '';
        showRegisterRepoModal = true;
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
    const ro = new ResizeObserver(() => {
      if (!canvasEl || !renderer) return;
      const w = canvasEl.clientWidth, h = canvasEl.clientHeight;
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
      if (composer) composer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(canvasEl);
  }

  // ── Process live events ────────────────────────
  function processEvents() {
    if (flowEvents.length === 0) return;
    if (flowEvents[0] === lastProcessedFlowEvent) return;
    // Newest-first store → walk down until we hit the previous head (or the
    // end if it got evicted by the cap).
    let cutoff = flowEvents.length;
    if (lastProcessedFlowEvent) {
      const idx = flowEvents.indexOf(lastProcessedFlowEvent);
      if (idx >= 0) cutoff = idx;
    }
    const news = flowEvents.slice(0, cutoff);
    lastProcessedFlowEvent = flowEvents[0];
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
        const commsFlow = flows.find(f => {
          const nm = (f.name || '').trim().toLowerCase();
          return nm.startsWith('comunicacion') || nm.startsWith('communication');
        });
        if (commsFlow) {
          const count = Number((e.data as any)?.count ?? 1) || 1;
          enqueueDelivery({
            flowId: commsFlow.id,
            flowColor: commsFlow.color || '#0ea5a4',
            label: count > 1 ? `${count} MAIL` : 'MAIL',
          });
          // Reset the per-flow cooldown so subsequent agent-started events
          // for Communications don't pile up extra trucks on the same mail.
          lastDeliveryAtByFlow.set(commsFlow.id, sceneTimeSec);
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
        // (#F1) "Thinking" 3D — kick the head gear when the run kicks off.
        spawnThinkingFx(aid);
        // External message arriving → dispatch a delivery truck that drops a
        // package at reception, then the recipient agent picks it up.
        triggerDeliveryForAgent(aid, sceneTimeSec);
        // Error Auditor closes the loop on failed runs. Parse its goal to
        // extract the original run_id it's triaging and mark that report
        // as "audited" in the My Office panel.
        const startedName = String(e.data.agent_name ?? agents.find(a => a.id === aid)?.name ?? '');
        if (startedName === 'Error Auditor') {
          const goalTxt = String(e.data.goal ?? '');
          const m = goalTxt.match(/Run ID:\s*([A-Za-z0-9-]+)/);
          if (m && m[1]) {
            auditedRunIds = new Set([...auditedRunIds, m[1]]);
          }
        }
      }
      else if (t === 'run_completed') {
        const failed = e.data.status !== 'completed';
        // (#3) Tag carries the result icon (✅ pop / ❌ shake). Failed runs
        // also rattle the desk briefly for emphasis.
        if (failed) {
          showAnimatedTag(aid, { icon: '❌', anim: 'shake', color: '#ff3030', label: 'FAILED', durationFrames: 220 });
          const dg = deskGroups.get(aid);
          if (dg) tryFireAnim(`failed-shake:${aid}`, 2.0, () => {
            animRegistry.add(shake(dg, {
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
        if (aid === selectedAgent) {
          loadLatestRun();
          if (panelTab === 'history') loadAgentRuns();
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
        const agentObj = agents.find(a => a.id === aid);
        const shouldReport = isOfficeLeader(aid);

        if (!hasChain && myOfficePos && scene && aid && shouldReport) {
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
          const onArrive = (!isUrgent && myOfficeNoteStack)
            ? () => { myOfficeNoteStack?.dropNote({ color: reportColor }); }
            : undefined;
          setTimeout(() => {
            // Pass undefined for the in-walker bubble — the animated tag at
            // the source desk (now following the walker) carries the meaning.
            // Seat the visitor in a free chair across the desk (not a single
            // floor point) and have them face the top agent while seated.
            const seatPt = pickFreeMyOfficeChair() ?? myOfficePos!;
            sendWalkerToPoint(
              scene, walkers, aid, seatPt, deskPos, roomMap, corGrid,
              agents, reportColor, undefined, deskAabbs,
              walkerTargetId, sittingWorkers, isUrgent,
              undefined,             // no viaPoint for myoffice/meeting walks
              onArrive,              // drop note on arrival
              carryNote,             // visible paper in the right hand
              undefined, undefined,  // meetingRoomObstacles / exempt
              undefined,             // stay (auto-return after the sit)
              myOfficeDeskFacing ?? undefined, // face the desk while seated
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
          const agentName = agents.find(a => a.id === sid)?.name ?? 'Agent';
          const label = e.data.chain_label ? String(e.data.chain_label) : `${agentName} → ${tname}`;
          addOfficeReport(sid, `Handing off to ${tname}: ${label}`, 'handoff');
          // Cross-office handoffs read more naturally as a meeting room
          // coordination than as a single walker crossing the whole floor —
          // try the meeting visual first and only fall back to desk-to-desk
          // if no room is available (or the agents are in the same office).
          const color = flowColor(sid);
          const wentToMeeting = !sameOffice(sid, tid) && coordinateInMeetingRoom(sid, tid, color);
          if (!wentToMeeting) {
            sendWalker(scene, walkers, sid, tid, deskPos, roomMap, corGrid, agents, color, undefined, sittingWorkers, deskAabbs);
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
          // (#2) Animated category icon spinning inside the tag.
          const toolName = String(e.data.tool_name ?? 'tool');
          tryFireAnim(`tool:${aid}`, 1.0, () => {
            showAnimatedTag(aid, {
              icon: toolGlyph(toolName), anim: 'spin',
              label: toolName.slice(0, 16),
              durationFrames: 130,
            });
          });
          // (#F1) "Thinking" 3D — a small spinning gear above the agent's head
          // plus a brief monitor-screen pulse. Capped + frustum-culled +
          // debounced so a roomful of busy agents stays cheap.
          spawnThinkingFx(aid);
          // ── Top-agent-only command effects ────────────────────────
          // When the top agent fires an agent/flow CRUD tool, mark
          // it visually so the user can see the order being issued. A
          // paper-plane shoots from his desk toward the central hall —
          // the destination office may not exist yet (creation case) or
          // is being torn down (deletion case), so the hall is the
          // safest neutral target.
          if (topAgentId && aid === topAgentId && topAgentSeatPos && hallCenterPos) {
            let cmd: { label: string; color: number; hex: string } | null = null;
            if (toolName.endsWith('kernel_agents_create')) cmd = { label: 'NEW AGENT',  color: 0x3DD68C, hex: '#3DD68C' };
            else if (toolName.endsWith('kernel_agents_flows_create')) cmd = { label: 'NEW OFFICE', color: 0x5B8DEF, hex: '#5B8DEF' };
            else if (toolName.endsWith('kernel_agents_delete')) cmd = { label: 'DESPIDO',    color: 0xF04770, hex: '#F04770' };
            else if (toolName.endsWith('kernel_agents_flows_delete')) cmd = { label: 'CIERRE',     color: 0xF04770, hex: '#F04770' };
            else if (toolName.endsWith('kernel_agents_update') || toolName.endsWith('kernel_agents_flows_update')) cmd = { label: 'ORDEN',      color: 0xC9A84C, hex: '#C9A84C' };
            if (cmd && scene) {
              showAnimatedTag(topAgentId, {
                icon: '✪', anim: 'pulse', color: cmd.hex,
                label: cmd.label, durationFrames: 220,
              });
              tryFireAnim(`top-agent-cmd:${topAgentId}`, 2.0, () => {
                animRegistry.add(paperPlane(scene, {
                  from: { x: topAgentSeatPos!.x, z: topAgentSeatPos!.z },
                  to:   { x: hallCenterPos!.x,   z: hallCenterPos!.z   },
                  archHeight: 4, durationSec: 1.4,
                  color: cmd!.color,
                  tag: `top-agent-cmd:${topAgentId}`,
                }));
              });
            }
          }
        } else if (st === 'thought') {
          // (#1) 💭 pulses inside the tag.
          tryFireAnim(`thought:${aid}`, 1.0, () => {
            showAnimatedTag(aid, { icon: '💭', anim: 'pulse', durationFrames: 110 });
          });
          // (#F1) "Thinking" 3D — also fire the head gear on raw thoughts.
          spawnThinkingFx(aid);
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
        if (score <= 2 && myOfficePos && scene && aid && isSeniorRank(aid)) {
          const agentName = agents.find(a => a.id === aid)?.name ?? 'Agent';
          setTimeout(() => {
            const seatPt = pickFreeMyOfficeChair() ?? myOfficePos!;
            sendWalkerToPoint(
              scene, walkers, aid, seatPt, deskPos, roomMap, corGrid, agents,
              '#F04770', undefined, deskAabbs, 'meeting', sittingWorkers, true,
              undefined, undefined, undefined, undefined, undefined, undefined,
              myOfficeDeskFacing ?? undefined, // face the desk while seated
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
        const dp = deskPos.get(aid);
        if (dp && scene) tryFireAnim(`lesson:${aid}`, 1.5, () => {
          animRegistry.add(convergingParticles(scene, {
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
        const dg = deskGroups.get(aid);
        if (dg) tryFireAnim(`lesson-drop:${aid}`, 2.0, () => {
          const drops = Math.min(count, 3);
          for (let k = 0; k < drops; k++) {
            animRegistry.add(fallingGlyph(dg, {
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
        const modName = String(e.data.moderator_name ?? agents.find(a => a.id === modId)?.name ?? 'Moderator');
        const attIds: string[] = (e.data.attendee_ids as string[]) ?? [];
        const attNames: string[] = (e.data.attendee_names as string[]) ?? [];
        const topic = String(e.data.topic ?? '');
        const mClr = e.data.urgency === 'urgent' ? '#F04770' : '#5B8DEF';
        // Pick a real meeting room. Round-robin across available rooms by
        // distributing concurrent meetings into different slots; fallback to
        // My Office if the current layout has zero meeting rooms.
        let roomIdx = -1;
        if (meetingRoomSlots.length > 0) {
          const inUse = new Set(meetingIdToRoom.values());
          roomIdx = meetingRoomSlots.findIndex((_, i) => !inUse.has(i));
          if (roomIdx < 0) roomIdx = meetingIdToRoom.size % meetingRoomSlots.length;
          if (mid) meetingIdToRoom.set(mid, roomIdx);
        }
        const room = roomIdx >= 0 ? meetingRoomSlots[roomIdx] : null;
        // One unique seat per participant around the conference table — without
        // this everyone walks to the room center and overlaps. Fall back to the
        // The top agent's 4 visitor chairs (then a single point) when no meeting
        // room is free, so a meeting held in My Office seats everyone properly.
        const seats = room
          ? getMeetingSeatPositions(room)
          : (myOfficeSeats.length ? myOfficeSeats : (myOfficePos ? [myOfficePos] : []));
        // Door midpoint: pick the wall closest to the central hall — that's
        // where the door was placed in office.ts:buildMeetingRooms. Without
        // routing via the door the walker cuts diagonally through walls.
        const doorPoint = (room && hallCenterPos) ? meetingRoomDoorPoint(room, hallCenterPos) : undefined;
        if (seats.length > 0 && scene) {
          const allParticipants = [modId, ...attIds].filter(Boolean);
          allParticipants.forEach((pid, i) => {
            const pName = agents.find(a => a.id === pid)?.name ?? 'Agent';
            const meetingUrgent = e.data.urgency === 'urgent';
            const seat = seats[i % seats.length];
            // If an old walker is blocking, drop it so the meeting takes
            // precedence (e.g. the moderator may have a stale chain walker).
            const stale = walkers.find(w => w.sourceId === pid);
            if (stale) {
              if ((stale as any).group) scene.remove((stale as any).group);
              if ((stale as any).bubble?.parent) (stale as any).bubble.parent.remove((stale as any).bubble);
              walkers = walkers.filter(w => w !== stale);
            }
            // stay=true: seated until meeting_ended dismisses them — the old
            // 60s maxAge default evicted attendees mid-conversation.
            sendWalkerToPoint(
              scene, walkers, pid, seat, deskPos, roomMap, corGrid, agents,
              mClr, undefined, deskAabbs, 'meeting', sittingWorkers,
              meetingUrgent, doorPoint, undefined, false, meetingRoomSlots, roomIdx, true,
              room ? undefined : (myOfficeDeskFacing ?? undefined), // face the desk if held in My Office
            );
          });
        }
        if (modId) showAnimatedTag(modId, { icon: '📋', anim: 'bounce', color: '#5B8DEF', label: 'CALL MEETING', durationFrames: 480 });
        if (mid) {
          const parts = [{ id: modId, name: modName }, ...attIds.map((id, i) => ({ id, name: attNames[i] ?? agents.find(a => a.id === id)?.name ?? 'Agent' }))];
          liveMeetings = {
            ...liveMeetings,
            [mid]: {
              id: mid, topic, status: 'requested',
              moderatorId: modId, moderatorName: modName,
              participants: parts, turns: [], started_at: Date.now(),
            },
          };
          activeMeetingId = mid;
          // Transcript modal stays HIDDEN by default at meeting_requested.
          // The user opens it on demand via the hq-bar 📡 toggle, the
          // meeting-room click, or the Meetings panel.
          showTranscriptBody = true;
          showMyOfficePanel = false;
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
        if (mid && liveMeetings[mid]) {
          liveMeetings = { ...liveMeetings, [mid]: { ...liveMeetings[mid], status: 'started', participants: mParts, topic: mTopic || liveMeetings[mid].topic } };
          // Pin the active meeting id, but DON'T auto-open the transcript.
          // User opens via hq-bar 📡 / clicking the meeting room / Meetings
          // panel — keeps the 3D view clean by default.
          activeMeetingId = mid;
          showMyOfficePanel = false;
        }
      }
      else if (t === 'meeting_turn') {
        const mid = String(e.data.meeting_id ?? '');
        const spkId = String(e.data.agent_id ?? '');
        const spkName = String(e.data.agent_name ?? agents.find(a => a.id === spkId)?.name ?? 'Agent');
        const role = String(e.data.role ?? 'attendee');
        const round = Number(e.data.round ?? 0);
        const body = String(e.data.body ?? e.data.content_preview ?? '');
        const tokens = Number(e.data.tokens ?? 0);
        const mIco = role === 'moderator' ? '🎙️' : '💬';
        const mPrev = String(e.data.content_preview ?? '').slice(0, 60);
        if (mid && liveMeetings[mid]) {
          const turn: LiveTurn = { agentId: spkId, agentName: spkName, role, round, body, ts: Date.now(), tokens };
          // Promote the speaker so the floor pose + spotlight code below
          // can light them up. Stamp it on the meeting record before
          // appending the turn so any reactive reads have the latest value.
          liveMeetings = {
            ...liveMeetings,
            [mid]: {
              ...liveMeetings[mid],
              turns: [...liveMeetings[mid].turns, turn],
              currentSpeakerId: spkId,
            },
          };
          activeMeetingId = mid;
          // Numbered speech bubble — "[3/8] VP: ...". Only the speaker
          // gets a visible bubble; listeners stay quiet so the room reads
          // as a single conversation. The bubble persists for ~25s, long
          // enough to span the slowest LLM turn before the next one
          // overrides it on the speaker's desk anyway.
          const totalTurns = liveMeetings[mid].turns.length;
          if (spkId) showAnimatedTag(spkId, { icon: '🗣️', anim: 'pulse', label: `TURN ${totalTurns}`, durationFrames: 1200 });
          // Refresh the floating banner above the meeting table.
          updateMeetingDecorTurn(mid, `Turn ${totalTurns} · ${spkName} (round ${round})`);
          // Wipe stale "🤝 Meeting:" greeting bubbles off everyone else
          // the moment the first turn lands so the speaker is the only
          // one with text above them.
          for (const p of liveMeetings[mid].participants ?? []) {
            if (p.id && p.id !== spkId) {
              const old = speechBubbles.get(p.id);
              if (old) {
                if (old.label.parent) old.label.parent.remove(old.label);
                old.div.remove();
                animRegistry.cancelByTag(`bubble:${p.id}`);
                speechBubbles.delete(p.id);
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
        if (scene) {
          const pidSet = new Set(mPids);
          const humanAttendees = meetingActive ? meetingSelectedIds : new Set<string>();
          removeArrivedWalkers(scene, walkers, 'meeting', pidSet.size > 0
            ? (w) => pidSet.has(w.sourceId)
            : (w) => !humanAttendees.has(w.sourceId));
        }
        for (const pid of mPids) showAnimatedTag(pid, mStat === 'completed'
          ? { icon: '✅', anim: 'pop', color: '#3DD68C', label: 'MEETING OK', durationFrames: 600 }
          : { icon: '❌', anim: 'shake', color: '#F04770', label: 'MEETING FAIL', durationFrames: 600 });
        if (mid && liveMeetings[mid]) {
          liveMeetings = {
            ...liveMeetings,
            [mid]: {
              ...liveMeetings[mid],
              status: mStat === 'completed' ? 'completed' : 'failed',
              ended_at: Date.now(),
              summary: mSum,
              decisions: (e.data.decisions as string[]) ?? [],
              action_items: (e.data.action_items as string[]) ?? [],
              currentSpeakerId: '',
            },
          };
          meetingIdToRoom.delete(mid);
          // Halo + banner come down with the meeting. Listeners can still
          // re-open the transcript from the history panel afterwards.
          disposeMeetingDecor(mid);
          // Keep the modal up for a beat so the user reads the wrap-up,
          // then close it automatically. The meeting stays in the
          // history panel for later review.
          if (activeMeetingId === mid) {
            setTimeout(() => {
              if (activeMeetingId === mid && liveMeetings[mid]?.status !== 'started') {
                showLiveMeeting = false;
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
        if (scene && mgrId && tgtId) {
          const wentToMeeting = !sameOffice(mgrId, tgtId) && coordinateInMeetingRoom(mgrId, tgtId, '#C67FE8');
          if (!wentToMeeting) {
            sendWalker(scene, walkers, mgrId, tgtId, deskPos, roomMap, corGrid, agents, '#C67FE8', undefined, sittingWorkers, deskAabbs);
          }
        }
        // (#6) ⚙️ spins inside the target's tag — the gear animates via CSS
        // keyframes, no separate floating-glyph layer needed.
        if (tgtId) tryFireAnim(`edit:${tgtId}`, 2.0, () => {
          showAnimatedTag(tgtId, { icon: '⚙️', anim: 'spin', color: '#C67FE8', label: 'EDITED', durationFrames: 260 });
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
        if (scene && fromId && toId) {
          const wentToMeeting = !sameOffice(fromId, toId) && coordinateInMeetingRoom(fromId, toId, color);
          if (!wentToMeeting) {
            sendWalker(scene, walkers, fromId, toId, deskPos, roomMap, corGrid, agents, color, undefined, sittingWorkers, deskAabbs);
          }
        }
        // No bubbles: the walker (+ for directives the curved arrow below)
        // are the whole visual. Subject text lives in the management log panel.
        // (#7) Directives also get an arched arrow above the walker.
        if (isDirective && scene && fromId && toId) {
          const fp = deskPos.get(fromId);
          const tp = deskPos.get(toId);
          if (fp && tp) tryFireAnim(`directive:${fromId}->${toId}`, 2.0, () => {
            animRegistry.add(curvedArrow(scene, {
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
        if (scene && fromId && myOfficePos) {
          const fp = deskPos.get(fromId);
          if (fp) {
            tryFireAnim(`plane:${fromId}`, 2.5, () => {
              animRegistry.add(paperPlane(scene, {
                from: { x: fp.x, z: fp.z },
                to:   { x: myOfficePos!.x, z: myOfficePos!.z },
                archHeight: 5, durationSec: 2.0,
                color: 0xffd166, // golden = escalation
                tag: `plane:${fromId}`,
              }));
            });
            // The walker itself — stands up, walks the corridors to My Office,
            // says hello with the question text, returns to the desk.
            tryFireAnim(`ask-walk:${fromId}`, 25, () => {
              sendWalkerToPoint(
                scene, walkers, fromId, myOfficePos!,
                deskPos, roomMap, corGrid, agents,
                '#ffd166',                 // gold = "asking the boss"
                `❓ ${qTxt || 'question'}`, // bubble shows truncated question
                deskAabbs, 'myoffice',     // customTargetId — same tag used by report completions
                sittingWorkers,
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
        if (scene && toId && myOfficePos) {
          const tp = deskPos.get(toId);
          if (tp) {
            tryFireAnim(`ans-plane:${toId}`, 2.5, () => {
              animRegistry.add(paperPlane(scene, {
                from: { x: myOfficePos!.x, z: myOfficePos!.z },
                to:   { x: tp.x, z: tp.z },
                archHeight: 4.5, durationSec: 1.8,
                color: 0x78dc8c, // green = answer delivered
                tag: `ans-plane:${toId}`,
              }));
            });
            const dg = deskGroups.get(toId);
            if (dg) tryFireAnim(`ans-halo:${toId}`, 2.0, () => {
              animRegistry.add(floatingGlyph(dg, {
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
          const a = agents.find(x => x.id === toId);
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
        if (td && hallCenterPos && scene && THREE) {
          const symbol = String(td.symbol ?? '').replace(/\/.*/, '');
          const sideStr = String(td.side ?? 'BUY').toUpperCase();
          const side: 'BUY' | 'SELL' = sideStr === 'SELL' ? 'SELL' : 'BUY';
          const price = Number(td.price ?? 0);
          const isBuy = side === 'BUY';

          // Local ritual — runs inside the trading office for EVERY order.
          // Resolve the trader: prefer agent_id on the event; fall back to the
          // first active agent of the trading flow (name-matched).
          let traderId = String(td.agent_id ?? '');
          const tradingFlow = flows.find(f => /trad/i.test(f.name || ''));
          if (!traderId && tradingFlow) {
            const ag = agents.find(a => a.flow_id === tradingFlow.id && a.active === 1);
            if (ag) traderId = ag.id;
          }
          const traderDesk = traderId ? deskPos.get(traderId) : undefined;
          const tradingRoom = tradingFlow ? roomMap.get(tradingFlow.id) : undefined;
          if (traderDesk && tradingRoom) {
            const monitorMat = deskGroups.get(traderId)?.userData?._monitor?.material;
            const pnlRaw = Number(td.pnl ?? td.realized_pnl ?? td.profit ?? NaN);
            runTradeExecution({
              scene, registry: animRegistry,
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
    const boardEvents = flowEvents.slice(0, 6).map(ev => {
      const t = ev.event.split(':').pop() ?? '';
      const agentName = agents.find(a => a.id === String(ev.data.agent_id ?? ''))?.name ?? '';
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
    const old = speechBubbles.get(aid);
    if (old) {
      if (old.label.parent) old.label.parent.remove(old.label);
      old.div.remove();
      animRegistry.cancelByTag(`bubble:${aid}`);
      speechBubbles.delete(aid);
    }
    const deskGroup = deskGroups.get(aid);
    if (!deskGroup) return;
    const div = document.createElement('div');
    div.innerHTML = text;
    div.style.cssText = `font:700 10px 'Fira Code',monospace;color:#111;
      background:#fff;border:2px solid ${color};padding:5px 12px;
      border-radius:6px;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      box-shadow:2px 3px 0 ${color},4px 5px 0 rgba(0,0,0,.3);
      animation:gpop .3s cubic-bezier(.17,.88,.32,1.28);`;
    const lbl = new CSS2DObject(div);
    lbl.position.set(0, 3.6, 0.55);
    deskGroup.add(lbl);
    speechBubbles.set(aid, { div, label: lbl, age: 0, maxAge: dur });
    animRegistry.add(bubbleFade(div, {
      maxAgeFrames: dur,
      tag: `bubble:${aid}`,
      onExpire: () => {
        if (lbl.parent) lbl.parent.remove(lbl);
        div.remove();
        if (speechBubbles.get(aid)?.label === lbl) speechBubbles.delete(aid);
      },
    }));
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
                );
              });
            }
          }
        } catch { /* single meeting fetch failed — carry on with the rest */ }
      }

      // After hydrating, surface the most recent active meeting in the
      // transcript modal so refreshing the page mid-meeting drops the user
      // Pick the freshest active meeting (so hq-bar 📡 toggle opens IT)
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
        const p = deskPos.get(aid);
        if (p) {
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

      // Animated event tags (speechBubbles) — these are CSS2D children parented
      // to deskGroup; when a walker spawns for this agent, REPARENT the label
      // to walker.group so the tag follows the moving humanoid. Reparent back
      // to the desk when the walker disposes. Position is in local coordinates
      // relative to the new parent.
      for (const [agentId, bubble] of speechBubbles) {
        const w = walkerByAgent.get(agentId);
        const dg = deskGroups.get(agentId);
        const lbl = bubble.label as any;
        const currentParent = lbl.parent;
        if (w && !((w as any).returning && (w as any).progress >= 1)) {
          const g = (w as any).group;
          if (g && currentParent !== g) {
            if (currentParent) currentParent.remove(lbl);
            g.add(lbl);
            // Above the walker's head — humanoid scale 1.3, head ~1.6 local,
            // so 2.4 places the tag just above the head.
            lbl.position.set(0, 2.4, 0);
          }
        } else if (dg && currentParent !== dg) {
          if (currentParent) currentParent.remove(lbl);
          dg.add(lbl);
          lbl.position.set(0, 3.2, 0.55);
        }
      }
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
    const f = flows.map(x => `${x.id}:${x.color}:${x.active}`).sort().join('|');
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

    // Fingerprint: agent IDs + flow assignments + flow count. If unchanged, only desks need refreshing.
    const layoutKey = agents.map(a => `${a.id}:${a.flow_id}`).sort().join('|') + `|${flows.length}|${meetingRooms.length}`;
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
    loadContributedTabs();
    const plan = computeFloorPlan(agents, chains, flows, ranks);
    deskPos = plan.deskPositions; roomMap = plan.rooms; corGrid = plan.corridorGrid; meetingRooms = plan.meetingRooms ?? []; hallExtensions = plan.hallExtensions ?? [];
    // Build the scene; surface any fatal error on the loader instead of leaving
    // it spinning forever (the old behavior on a mid-build throw).
    buildScene().catch((e: any) => {
      console.error('[buildScene] failed:', e);
      bootError = 'No se pudo construir la escena 3D: ' + (e?.message ?? String(e));
    });
    restoreUiState();
    hydrateLiveState();
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
    for (const [, b] of speechBubbles) { scene?.remove(b.label); b.div.remove(); }
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

  $: selData = selectedAgent ? agents.find(a => a.id === selectedAgent) : null;
  // Phase 4 (B): DevOps affordance — is the selected agent part of a DevOps/Repos
  // office? If so, offer a deep-link to the paid DevOps control panel (/devops).
  $: selDevopsOffice = !!selData && /^(devops|repos)/i.test((flows.find(f => f.id === selData.flow_id)?.name) || '');
  $: selStats = selectedAgent ? stats[selectedAgent] : null;
  $: selChains = selectedAgent ? chains.filter(c => c.source_agent_id === selectedAgent || c.target_agent_id === selectedAgent) : [];
  $: selFlow = selData ? flows.find(f => f.id === selData.flow_id) : null;

  // ── What defines the selected agent ────────────────────────────────────
  // The system prompt for an LLM agent, the builtin handler for a scripted
  // one. Either way it is the answer to "what is this thing", so Overview
  // leads with it instead of burying it under a collapsed section at the end.
  // The graph payload already carries both, so the block renders with the
  // selection instead of flashing a loading line until the detail fetch lands.
  $: selPrompt = String(agentDetail?.agent?.system_prompt ?? selData?.system_prompt ?? '');

  /** Tools that reach outside the model: a shell, a filesystem, a container. */
  const ENV_TOOL_RE = /office_exec|workspace|filesystem|shell|bash|terminal|docker/i;
  $: selAllowedTools = (() => {
    const parsed = safeParse(agentDetail?.agent?.allowed_tools ?? selData?.allowed_tools);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  })();
  /** Can this agent actually use the office's shared container?
   *  A pure LLM agent calls a model and nothing else — a Docker image and a
   *  Start button mean nothing to it. The environment is still office-scoped
   *  and this panel is its only entry point, so it is never removed, only
   *  folded away (see the `startCollapsed` prop on OfficeInfraPanel). */
  $: canUseOfficeEnv =
    !!selData &&
    (agentType(selData) === 'claude_code' || selAllowedTools.some((t) => ENV_TOOL_RE.test(t)));

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

  // ── Full agent detail (fetched on demand) ──────────
  let agentDetail: {
    agent?: any;
    runs?: any[];
    triggers?: Array<{ event_name: string; filter?: string; cooldown_ms?: number; active?: number }>;
    schedules?: Array<{ cron_expression: string; interval_ms: number; goal_override?: string; next_run_at?: string; last_run_at?: string; active?: number }>;
    adhocConnections?: {
      invokedBy: Array<{ agent_id: string; agent_name: string; count: number; last_at: string }>;
      invoked: Array<{ agent_id: string; agent_name: string; count: number; last_at: string }>;
    };
  } | null = null;
  let detailLoading = false;

  async function loadAgentDetail(id: string) {
    detailLoading = true;
    try {
      const r = await fetch(`/api/agents/${id}`);
      agentDetail = await r.json();
    } catch { agentDetail = null; }
    detailLoading = false;
  }

  // Fire whenever a new agent is selected
  $: if (selectedAgent) loadAgentDetail(selectedAgent); else agentDetail = null;

  // Parse helpers tolerant of JSON string columns
  function safeParse(raw: unknown): any {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch { return null; }
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

  function fmtRelTime(iso?: string): string {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return iso;
    const d = Date.now() - t;
    if (d < 0) {
      const f = -d;
      if (f < 60_000) return `in ${Math.round(f / 1000)}s`;
      if (f < 3_600_000) return `in ${Math.round(f / 60_000)}m`;
      return `in ${Math.round(f / 3_600_000)}h`;
    }
    if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
    if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
    if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
    return `${Math.round(d / 86_400_000)}d ago`;
  }

  function fmtTokens(n?: number): string {
    if (!n || n < 1000) return String(n ?? 0);
    return (n / 1000).toFixed(1) + 'k';
  }

  function fmtDuration(ms?: number): string {
    if (!ms) return '—';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60_000) return (ms / 1000).toFixed(1) + 's';
    return Math.round(ms / 60_000) + 'm ' + Math.round((ms % 60_000) / 1000) + 's';
  }

  function triggerColor(t: string): string {
    switch (t) {
      case 'manual': return '#a78bfa';
      case 'chain': return '#3dd6c8';
      case 'schedule': return '#fbbf24';
      case 'event': return '#f472b6';
      default: return '#8a8fa8';
    }
  }

  // Collapsible section state (persists per-agent session)
  let collapsed = { tools: true, variables: false };
  function toggleSection(k: keyof typeof collapsed) {
    collapsed = { ...collapsed, [k]: !collapsed[k] };
  }

  // ── Talk to agent ──────────────────────────────
  const dispatch = createEventDispatcher();

  let chatInput = '';
  let chatSending = false;
  let starting = false;
  let startMsg = '';
  let togglingPause = false;
  let revisionBusy = false;
  let editingName = false;
  let editNameValue = '';
  let savingName = false;
  let chatHistory: Array<{ role: 'you' | 'agent'; text: string; ts: number }> = [];
  let chatHistoryLoading = false;
  let chatError = '';
  /** The run was accepted and the agent is working. Replaces the old trick of
   *  pushing a literal "Working on it..." bubble and later deleting whatever
   *  message happened to carry that exact text. */
  let chatPending = false;
  let chatScrollEl: HTMLDivElement | null = null;

  /** Can this agent read what you write?
   *
   *  No, if it is backed by a builtin handler. `AgentExecutor.execute` (see
   *  services/kernel/src/modules/agents/executor.ts) short-circuits on
   *  `agent.builtin_handler` and calls `await handler()` — no arguments. The
   *  whole conversational goal this panel builds is discarded, the script runs
   *  as if you had pressed Run now, and its output comes back looking like a
   *  reply to a message nothing ever read. 31 of the agents on this floor are
   *  in that shape, so the tab says so instead of pretending. */
  $: chatCanConverse = !!selData && !selData.builtin_handler;

  /** Openers built from this agent, not from whatever product the placeholder
   *  was copied out of. The old one advertised a prospecting syntax
   *  ("Prospect city=Valencia…") on every agent in the office. */
  $: chatSuggestions = (() => {
    if (!selData || !chatCanConverse) return [] as string[];
    const out: string[] = [];
    const goal = String(agentDetail?.agent?.goal_template ?? '').trim();
    if (goal) out.push(goal.length > 90 ? goal.slice(0, 88) + '…' : goal);
    if (selData.description) out.push(`What did you do about ${selData.description.toLowerCase()} this week?`);
    out.push('What are you working on right now?');
    if (selStats?.failed) out.push('Why did your last runs fail?');
    return out.slice(0, 3);
  })();

  function beginEditName() {
    if (!selData) return;
    editNameValue = selData.name;
    editingName = true;
  }
  function cancelEditName() {
    editingName = false;
    editNameValue = '';
  }
  // Skin picker — list of installed skins for the dropdown. Computed once at
  // mount when the skin registry has been initialised.
  let availableSkins: SkinDefinition[] = [];
  let savingSkin = false;

  /** DOM handler — Svelte template attributes can't contain TS `as` casts,
   *  so we route the change event through this wrapper that does the cast in
   *  the script block. */
  function onSkinChange(e: Event): void {
    const sel = e.target as HTMLSelectElement;
    if (sel?.value) changeSkin(sel.value);
  }

  /** Persist a new skin choice for the currently-selected agent. The kernel
   *  saves it; the dashboard's reactive scene rebuild renders the new look on
   *  the next fingerprint diff. */
  async function changeSkin(skinId: string): Promise<void> {
    if (!selectedAgent || savingSkin) return;
    savingSkin = true;
    try {
      const r = await fetch(`/api/agents/${selectedAgent}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skin_id: skinId }),
      });
      const data = await r.json();
      if (data?.success) {
        agents = agents.map(a => a.id === selectedAgent ? { ...a, skin_id: skinId } : a);
        dispatch('refresh');
      }
    } catch (e: any) {
      // Best-effort — fall through, will retry on next interaction.
      // eslint-disable-next-line no-console
      console.error('changeSkin failed', e);
    } finally {
      savingSkin = false;
    }
  }

  async function saveEditName() {
    if (!selectedAgent || !selData || savingName) return;
    const next = editNameValue.trim();
    if (!next || next === selData.name) { cancelEditName(); return; }
    savingName = true;
    try {
      const r = await fetch(`/api/agents/${selectedAgent}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next }),
      });
      const data = await r.json();
      if (data?.success) {
        agents = agents.map(a => a.id === selectedAgent ? { ...a, name: next } : a);
        loadAgentDetail(selectedAgent);
        editingName = false;
        // Ask the parent to re-fetch so its own `agents` (the source of truth
        // that gets re-pushed back as our prop) reflects the new name. Without
        // this, the next prop update overwrites our optimistic rename.
        dispatch('refresh');
      } else {
        startMsg = `✗ ${data?.error || 'could not rename'}`;
      }
    } catch (e: any) {
      startMsg = `✗ ${e?.message || 'network error'}`;
    } finally {
      savingName = false;
      setTimeout(() => { if (startMsg.startsWith('✗')) startMsg = ''; }, 4000);
    }
  }

  // ── Agent panel tabs ───────────────────────────
  // Core ids are literals; extension-contributed tabs use dynamic ids.
  let panelTab: 'info' | 'live' | 'history' | 'memory' | 'chat' | 'workspace' | (string & {}) = 'info';
  let agentRuns: Array<{ id: string; status: string; steps_count: number; tokens_used: number; trigger_type: string; created_at: string; result?: string; error?: string }> = [];
  let agentMemory: Array<{ role: string; content: string; created_at: string }> = [];
  let workspaceFiles: Array<{ path: string; type: string; size: number }> = [];
  let workspaceFileContent: { path: string; content: string } | null = null;
  let workspaceLoading = false;
  let workspacePreviewUrl: string | null = null;

  // Filter out lockfiles / bun cache dirs / OS junk from the workspace tree.
  const WS_HIDDEN_BASENAMES = new Set([
    'bun.lockb', 'bun.lock',
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.DS_Store', 'Thumbs.db',
  ]);
  function isWorkspacePathHidden(path: string): boolean {
    const base = path.split('/').pop() ?? path;
    if (WS_HIDDEN_BASENAMES.has(base)) return true;
    if (/\.(bun[a-z0-9-]*|lockb?|tsbuildinfo)$/i.test(base)) return true;
    if (path.split('/').some(seg => seg === '.bun' || seg.startsWith('.bun-'))) return true;
    return false;
  }
  $: visibleWorkspaceFiles = workspaceFiles.filter(f => !isWorkspacePathHidden(f.path));

  // ── Workspace tree ─────────────────────────────────────────────────
  // The API returns a flat list (full paths). Build a collapsible tree:
  // dirs derived both from explicit 'dir' entries and from file parents,
  // flattened into rows (depth-aware) so no recursive component is needed.
  type WsTreeRow = { path: string; name: string; depth: number; isDir: boolean; size: number; fileCount: number };
  let wsCollapsed: Set<string> = new Set();
  function toggleWsDir(path: string): void {
    if (wsCollapsed.has(path)) wsCollapsed.delete(path); else wsCollapsed.add(path);
    wsCollapsed = wsCollapsed;
  }
  function buildWsRows(files: Array<{ path: string; type: string; size: number }>, collapsed: Set<string>): WsTreeRow[] {
    const dirs = new Set<string>();
    const leafFiles: Array<{ path: string; size: number }> = [];
    for (const f of files) {
      if (f.type === 'dir') { dirs.add(f.path); continue; }
      leafFiles.push({ path: f.path, size: f.size });
      const segs = f.path.split('/');
      for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
    }
    const children = new Map<string, { dirs: string[]; files: Array<{ path: string; size: number }> }>();
    const bucket = (k: string) => {
      let c = children.get(k);
      if (!c) { c = { dirs: [], files: [] }; children.set(k, c); }
      return c;
    };
    for (const d of dirs) {
      const parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
      bucket(parent).dirs.push(d);
      // also register implied ancestors of explicit dir entries
      const segs = d.split('/');
      for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
    }
    for (const f of leafFiles) {
      const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      bucket(parent).files.push(f);
    }
    const countCache = new Map<string, number>();
    const countFiles = (dir: string): number => {
      const hit = countCache.get(dir);
      if (hit !== undefined) return hit;
      const c = children.get(dir);
      let n = c ? c.files.length : 0;
      if (c) for (const d of c.dirs) n += countFiles(d);
      countCache.set(dir, n);
      return n;
    };
    const rows: WsTreeRow[] = [];
    const walk = (dir: string, depth: number): void => {
      const c = children.get(dir);
      if (!c) return;
      for (const d of [...new Set(c.dirs)].sort()) {
        rows.push({ path: d, name: d.split('/').pop() ?? d, depth, isDir: true, size: 0, fileCount: countFiles(d) });
        if (!collapsed.has(d)) walk(d, depth + 1);
      }
      for (const f of [...c.files].sort((a, b) => a.path.localeCompare(b.path))) {
        rows.push({ path: f.path, name: f.path.split('/').pop() ?? f.path, depth, isDir: false, size: f.size, fileCount: 0 });
      }
    };
    walk('', 0);
    return rows;
  }
  $: wsRows = buildWsRows(visibleWorkspaceFiles, wsCollapsed);
  $: wsAllDirs = [...new Set(buildWsRows(visibleWorkspaceFiles, new Set()).filter(r => r.isDir).map(r => r.path))];
  $: wsFileCount = visibleWorkspaceFiles.filter(f => f.type !== 'dir').length;

  const WS_ICONS: Record<string, string> = {
    ts: '🔷', tsx: '🔷', js: '🟨', jsx: '🟨', mjs: '🟨', cjs: '🟨',
    json: '📋', css: '🎨', scss: '🎨', svelte: '🧩', vue: '🧩',
    html: '🌐', md: '📝', txt: '📄', log: '📄', pdf: '📕',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️', ico: '🖼️',
    sh: '⚙️', bash: '⚙️', zsh: '⚙️', py: '🐍', rs: '🦀', go: '🐹',
    sql: '🗄️', db: '🗄️', sqlite: '🗄️',
    yml: '🔧', yaml: '🔧', toml: '🔧', ini: '🔧', conf: '🔧', env: '🔧',
    zip: '📦', tar: '📦', gz: '📦', lock: '🔒',
  };
  function wsFileIcon(name: string): string {
    if (name.startsWith('.')) return '🔧';
    const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
    return WS_ICONS[ext] ?? '📄';
  }
  function wsFmtSize(n: number): string {
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  }
  let runsLoading = false;
  let memoryLoading = false;
  let expandedRunId: string | null = null;
  let runSteps: Array<{ step_number: number; type: string; content: string; tool_name: string; tool_output?: string; is_event?: boolean }> = [];

  // ── Sent-email viewer ──────────────────────────────────────────────
  // When an activity row is an email-send tool result, show a "Ver email" link
  // that opens this modal with the real sent message (from / to / subject / body).
  const EMAIL_TOOLS = new Set(['kernel_email_send', 'kernel_comms_reply', 'kernel_comms_send']);
  const EMAIL_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  let emailModalOpen = false;
  let emailModalLoading = false;
  let emailModalError: string | null = null;
  let emailModalData: any = null;

  /** Returns the communication id for an email-send tool row, or null. `raw` is
   *  the tool output/preview text (live: e.data.content_preview; history: step.tool_output). */
  function emailCommId(toolName: string | undefined, raw: string | undefined): string | null {
    if (!toolName || !EMAIL_TOOLS.has(toolName) || !raw) return null;
    try {
      const o = JSON.parse(raw);
      const id = o?.id ?? o?.comm_id ?? o?.thread_id;
      if (id) return String(id);
    } catch { /* not JSON — fall through to UUID scan */ }
    const m = String(raw).match(EMAIL_UUID_RE);
    return m ? m[0] : null;
  }

  async function openEmailModal(commId: string): Promise<void> {
    emailModalOpen = true;
    emailModalLoading = true;
    emailModalError = null;
    emailModalData = null;
    try {
      const d: any = await getCommDetail(commId);
      if (!d || d.error) throw new Error(d?.error || 'No se encontró el email');
      emailModalData = d;
    } catch (err: any) {
      emailModalError = err?.message ? String(err.message) : String(err);
    } finally {
      emailModalLoading = false;
    }
  }
  function closeEmailModal(): void { emailModalOpen = false; emailModalData = null; emailModalError = null; }
  // Track loading + error separately from `runSteps`. Without these, an empty
  // result (e.g. a meeting event, or a run that errored before producing any
  // steps) leaves the UI stuck on "Loading steps…" forever because
  // `runSteps.length === 0` is also the initial state.
  let runStepsLoading = false;
  let runStepsError: string | null = null;

  async function loadAgentRuns() {
    if (!selectedAgent || runsLoading) return;
    runsLoading = true;
    try {
      const data: any = await rpcOrCall('agents.runs.list', { agent_id: selectedAgent, limit: 20 }, async () => {
        const r = await fetch(`/api/agents/${selectedAgent}/runs?limit=20`);
        return r.json();
      });
      agentRuns = data?.runs ?? [];
    } catch { agentRuns = []; }
    runsLoading = false;
  }

  async function loadAgentMemory() {
    if (!selectedAgent || memoryLoading) return;
    memoryLoading = true;
    try {
      const res = await fetch(`/api/agents/${selectedAgent}/memory?limit=50`);
      const data: any = await res.json();
      agentMemory = (data?.memory ?? []) as Array<{ role: string; content: string; created_at: string }>;
    } catch { agentMemory = []; }
    memoryLoading = false;
  }

  async function loadChatFromMemory() {
    if (!selectedAgent) return;
    chatHistoryLoading = true;
    chatError = '';
    try {
      const res = await fetch(`/api/agents/${selectedAgent}/memory?limit=30`);
      const data: any = await res.json();
      const items = ((data?.memory ?? []) as Array<{ role: string; content: string; created_at: string }>)
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .reverse(); // chronological
      chatHistory = items.map(m => ({
        role: m.role === 'user' ? 'you' as const : 'agent' as const,
        text: m.content,
        ts: new Date(m.created_at).getTime(),
      }));
    } catch (e: any) {
      // Was swallowed silently, which made a failed fetch and a genuinely empty
      // thread look identical — and the empty one invites you to write.
      chatError = e?.message ?? String(e);
    } finally {
      chatHistoryLoading = false;
      scrollChatToEnd();
    }
  }

  /** Keep the newest message in view after loads, sends and replies. */
  async function scrollChatToEnd() {
    await tick();
    if (chatScrollEl) chatScrollEl.scrollTop = chatScrollEl.scrollHeight;
  }

  /**
   * Resolve which workspace to list for an agent. Mirrors the logic in
   * `claude-code-executor.resolveCwd`:
   *   1. variables.__workspace__ — workspace registrado bajo data/workspaces/
   *   2. fallback `agent-<id>` — el cwd default que crea el executor
   *
   * `__cwd_path__` (an absolute path outside data/workspaces) cannot be
   * navigated via the workspaces endpoint; reported as such, with no ws id.
   */
  function resolveAgentWorkspace(agent: any): { wsId: string | null; cwdPath: string | null; cwdLabel: string; cwdHint: string } {
    const vars = safeParse(agent?.variables) || {};
    if (typeof vars.__cwd_path__ === 'string' && vars.__cwd_path__.startsWith('/')) {
      return {
        wsId: null,
        cwdPath: vars.__cwd_path__,
        cwdLabel: vars.__cwd_path__,
        cwdHint: 'external repo (mounted RW) — files listed below',
      };
    }
    if (typeof vars.__workspace__ === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(vars.__workspace__)) {
      return {
        wsId: vars.__workspace__,
        cwdPath: null,
        cwdLabel: `data/workspaces/${vars.__workspace__}`,
        cwdHint: 'workspace registrado',
      };
    }
    const fallback = `agent-${agent.id}`;
    return {
      wsId: fallback,
      cwdPath: null,
      cwdLabel: `data/workspaces/${fallback}`,
      cwdHint: 'workspace default por agent id',
    };
  }

  $: selWorkspaceInfo = selData ? resolveAgentWorkspace(selData) : null;

  async function loadWorkspaceFiles() {
    if (!selectedAgent || workspaceLoading) return;
    const agent = agents.find(a => a.id === selectedAgent);
    if (!agent) return;
    const info = resolveAgentWorkspace(agent);
    workspaceLoading = true;
    workspaceFileContent = null;
    workspacePreviewUrl = null;
    wsCollapsed = new Set();
    try {
      if (info.cwdPath) {
        // External __cwd_path__ repo — listed via the agent-scoped cwd endpoint.
        const res = await fetch(`/api/agents/${agent.id}/cwd-files`);
        const data: any = await res.json();
        workspaceFiles = data?.files ?? [];
        workspacePreviewUrl = typeof data?.preview_url === 'string' ? data.preview_url : null;
      } else if (info.wsId) {
        const res = await fetch(`/api/agents/workspace/${info.wsId}`);
        const data: any = await res.json();
        workspaceFiles = data?.files ?? [];
      } else {
        workspaceFiles = [];
      }
    } catch { workspaceFiles = []; }
    workspaceLoading = false;
  }

  async function loadWorkspaceFile(path: string) {
    const agent = agents.find(a => a.id === selectedAgent);
    if (!agent) return;
    const info = resolveAgentWorkspace(agent);
    try {
      const url = info.cwdPath
        ? `/api/agents/${agent.id}/cwd-file?path=${encodeURIComponent(path)}`
        : `/api/agents/workspace/${info.wsId}/file?path=${encodeURIComponent(path)}`;
      const res = await fetch(url);
      const data: any = await res.json();
      workspaceFileContent = { path, content: data?.content ?? '' };
    } catch { workspaceFileContent = { path, content: 'Error loading file' }; }
  }

  async function loadRunSteps(runId: string) {
    if (expandedRunId === runId) {
      expandedRunId = null;
      runSteps = [];
      runStepsLoading = false;
      runStepsError = null;
      return;
    }
    expandedRunId = runId;
    runSteps = [];
    runStepsError = null;
    runStepsLoading = true;
    try {
      const data: any = await rpcOrCall('agents.runs.detail', { id: runId }, async () => {
        const r = await fetch(`/api/agents/runs/${runId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      // The user may have collapsed or switched runs while we awaited.
      if (expandedRunId !== runId) return;
      if (data?.error) throw new Error(String(data.error));
      const steps: any[] = data?.steps ?? [];
      const events: any[] = data?.events ?? [];
      // Merge event_log entries (auto_eval, learning, etc.) that aren't already
      // represented by a step into the timeline. We filter out "step" event_types
      // since those are duplicates of agent_run_steps.
      const eventSteps = events
        .filter((ev: any) => ev.event_subtype && ev.event_subtype !== 'step' && ev.event_type !== 'step')
        .map((ev: any, i: number) => {
          const sub = String(ev.event_subtype || ev.event_type || 'event');
          let rawData: Record<string, unknown> = {};
          try { rawData = JSON.parse(ev.raw_data || '{}'); } catch {}
          let detail = String(ev.detail || '');
          if (sub === 'auto_eval') {
            const score = Number(rawData.score ?? 0);
            const outcome = String(rawData.outcome ?? '');
            const stars = '★'.repeat(score) + '☆'.repeat(Math.max(0, 5 - score));
            const lesson = rawData.lesson ? `\n**Lesson**: ${rawData.lesson}` : '';
            detail = `${stars}  **${outcome.toUpperCase()}** — confidence ${Number(rawData.confidence ?? 0).toFixed(2)}${lesson}`;
          } else if (sub === 'learning_created' || sub === 'learning_deactivated') {
            const icon = sub === 'learning_created'
              ? (rawData.learning_type === 'avoid' ? '🚫' : rawData.learning_type === 'prefer' ? '⭐' : '💡')
              : '🗑️';
            detail = `${icon} ${detail}`;
          }
          return {
            step_number: 9000 + i,
            type: sub,
            content: detail,
            tool_name: '',
            is_event: true,
            _ts: ev.created_at || '',
          };
        });
      // Assign step_numbers that interleave with real steps by timestamp
      const merged = [...steps.map((s: any) => ({ ...s, is_event: false, _ts: '' })), ...eventSteps];
      // Real steps already ordered by step_number; events go at the end
      // (they happen post-run during auto-eval). Renumber for display.
      let num = 0;
      for (const m of merged) {
        num++;
        m.step_number = num;
      }
      runSteps = merged;
    } catch (err) {
      if (expandedRunId === runId) {
        runSteps = [];
        runStepsError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (expandedRunId === runId) runStepsLoading = false;
    }
  }

  function selectPanelTab(tab: typeof panelTab) {
    panelTab = tab;
    if (tab === 'history') loadAgentRuns();
    if (tab === 'info') loadLatestRun();
    // Re-read the thread from the server every time the tab is opened, not
    // only when the selected agent changes. The reply is persisted by the
    // executor the moment the run ends, so this is what makes an answer
    // recoverable after the page-side poll is interrupted — switching tabs,
    // closing the panel, a re-render — instead of lost with it.
    if (tab === 'chat' && !chatSending) loadChatFromMemory();
  }

  // ── Latest run result (shown prominently in Overview) ──
  let latestRun: { id: string; status: string; result?: string; error?: string; tokens_used: number; steps_count: number; trigger_type: string; created_at: string; duration_ms?: number } | null = null;
  let latestRunLoading = false;

  async function loadLatestRun() {
    if (!selectedAgent || latestRunLoading) return;
    latestRunLoading = true;
    try {
      const data: any = await rpcOrCall('agents.runs.list', { agent_id: selectedAgent, limit: 5 }, async () => {
        const r = await fetch(`/api/agents/${selectedAgent}/runs?limit=5`);
        return r.json();
      });
      const runs: any[] = data?.runs ?? [];
      // prefer most recent completed/failed run with a result or error
      latestRun = runs.find((r: any) => r.status === 'completed' || r.status === 'failed') ?? runs[0] ?? null;
    } catch { latestRun = null; }
    latestRunLoading = false;
  }

  // ── Re-auth helper for OAuth providers ─────────────────
  // Some integrations surface auth-expired errors as run *results* (not
  // throws), so we scan both result/error text. When the pattern matches a
  // known provider, the LAST RESULT card surfaces an inline re-auth button
  // — saves the user the trip to /providers to fix it.
  function detectExpiredAuthProvider(text: string | null | undefined): 'google' | null {
    if (!text) return null;
    // Google: explicit tool name, OAuth error code, refresh-failure phrase
    if (/kernel_google_auth|google_auth|invalid_grant|Token (refresh failed|has been expired or revoked)/i.test(text)) {
      return 'google';
    }
    return null;
  }
  // Agents whose builtin_handler starts with `gsync:` (contacts/gmail/calendar/
  // graph-enrich) speak to Google APIs. Surface a permanent inline Re-login
  // button in their description so the user can fix expired auth proactively —
  // without waiting for the next failed run to surface the LAST RESULT button.
  function dependsOnGoogleAuth(a: any): boolean {
    const h = a?.builtin_handler;
    return typeof h === 'string' && h.startsWith('gsync:');
  }

  let reauthLoading = false;
  async function startReauth(provider: 'google'): Promise<void> {
    if (reauthLoading) return;
    reauthLoading = true;
    try {
      if (provider === 'google') {
        // Direct authenticated HTTP — skip the WS race. Re-login is a one-shot
        // user action; predictability beats latency. `?force=1` bypasses the
        // backend's "already authenticated" shortcut, which would otherwise
        // trip on a stale-but-revoked token row in google_tokens.
        const token = localStorage.getItem('kernel_auth_token') ?? '';
        const r = await fetch('/api/google/auth/start?force=1', {
          method: 'POST',
          headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        });
        const d: any = await r.json().catch(() => ({ error: `HTTP ${r.status} ${r.statusText}` }));
        if (!r.ok) { alert(d?.error ?? `HTTP ${r.status}`); return; }
        if (d?.error) { alert(d.error); return; }
        if (d?.authUrl) { window.location.href = d.authUrl; return; }
        alert('No auth URL returned by /api/google/auth/start (response: ' + JSON.stringify(d).slice(0, 200) + ')');
      }
    } catch (e: any) {
      alert(e?.message ?? String(e));
    } finally {
      reauthLoading = false;
    }
  }

  // ── LIVE stream for the selected agent ────────
  $: liveIsRunning = !!selectedAgent && runningAgentIds.has(selectedAgent);
  $: liveEvents = selectedAgent
    ? flowEvents.filter(e => e.data.agent_id === selectedAgent).slice(0, 60)
    : [];
  // derive current run id (from most recent event)
  $: liveRunId = (liveEvents.find(e => e.data.run_id) as any)?.data?.run_id ?? null;
  // only show events from the current run (so we don't leak prior runs' noise)
  $: liveCurrentRunEvents = liveRunId
    ? liveEvents.filter(e => e.data.run_id === liveRunId)
    : liveEvents;
  $: liveHeadEvent = liveCurrentRunEvents[0] ?? null;

  // Auto-switch to LIVE tab when an agent starts working (but don't hijack if user navigated)
  let lastRunningFor: string | null = null;
  $: if (liveIsRunning && selectedAgent && selectedAgent !== lastRunningFor) {
    lastRunningFor = selectedAgent;
    if (panelTab === 'info') panelTab = 'live';
  }
  $: if (!liveIsRunning) lastRunningFor = null;

  function liveStepIcon(type: string): string {
    switch (type) {
      case 'tool_call': return '🔧';
      case 'tool_result': return '📥';
      case 'thought': return '💭';
      case 'final': return '✨';
      case 'rate_limit_wait': return '⏳';
      case 'error': return '⚠️';
      case 'auto_eval_started': return '📝';
      case 'auto_eval': return '📝';
      case 'learning_created': return '💡';
      case 'learning_deactivated': return '🗑️';
      case 'chain_triggered': return '🔗';
      case 'run_started': return '▶';
      case 'run_completed': return '✅';
      default: return '•';
    }
  }
  function liveStepLabel(type: string): string {
    switch (type) {
      case 'tool_call': return 'calling tool';
      case 'tool_result': return 'tool result';
      case 'thought': return 'thinking';
      case 'final': return 'finalizing';
      case 'rate_limit_wait': return 'rate limited';
      case 'error': return 'error';
      case 'auto_eval_started': return 'self-grading';
      case 'auto_eval': return 'self-eval';
      case 'learning_created': return 'lesson learned';
      case 'learning_deactivated': return 'lesson dropped';
      case 'chain_triggered': return 'handoff';
      case 'run_started': return 'run started';
      case 'run_completed': return 'run completed';
      default: return type || 'step';
    }
  }
  function liveEventSummary(e: AgentFlowEvent): string {
    const t = e.event.split(':').pop() ?? '';
    if (t === 'run_started') {
      const goalTxt = String(e.data.goal ?? '').trim();
      const isBuiltin = Boolean(e.data.builtin);
      if (isBuiltin) {
        return goalTxt
          ? `Builtin run — ${goalTxt}`
          : 'Builtin run (native code, no prompt)';
      }
      return goalTxt
        ? `Started — goal: ${goalTxt}`
        : 'Started — scheduled run';
    }
    if (t === 'run_completed') {
      const st = String(e.data.status ?? 'completed');
      return st === 'completed' ? 'Run completed successfully' : `Run ${st}`;
    }
    if (t === 'chain_triggered') return `Handoff → ${String(e.data.target_agent_name ?? 'next agent')}`;
    if (t === 'auto_eval_started') return 'Self-grading…';
    if (t === 'auto_eval') {
      const score = Number(e.data.score ?? 0);
      return `Self-graded ${score}/5 — ${String(e.data.outcome ?? '')}`;
    }
    if (t === 'learning_created') return `Lesson learned: ${String(e.data.content ?? '')}`;
    if (t === 'step') {
      const st = String(e.data.type ?? '');
      const preview = String(e.data.content_preview ?? '');
      // Server already truncates previews (tool_result=2000, tool_call input=800,
      // thought/final=200). Show the full preview — truncating again here only
      // hides useful context in the LIVE tab. Full text is in HISTORY.
      if (st === 'tool_call') {
        // Preview is a JSON.stringify of the tool input. Server caps it at
        // 800 chars — for tools with bulky inputs (e.g. Write with the full
        // markdown body of a lead dossier) the cut lands mid-string and
        // JSON.parse throws. Same forward-rule as tool_result: ALWAYS wrap
        // in a json code fence (so markdown can't mangle it), pretty-print
        // when it parses, mark truncated otherwise.
        const toolName = String(e.data.tool_name ?? 'tool');
        let body = preview;
        let truncated = false;
        try { body = JSON.stringify(JSON.parse(preview), null, 2); }
        catch {
          truncated = true;
          // Best-effort: at least undo basic JSON escapes so the raw text
          // has real newlines and quotes instead of literal `\n` / `\"`.
          body = preview.replace(/\\n/g, '\n').replace(/\\"/g, '"');
        }
        const tag = truncated ? '\n... (truncated — full payload in HISTORY tab)' : '';
        return sanitizePreview('```json\n' + toolName + '(\n' + body + tag + '\n)\n```', preview.length, 800);
      }
      if (st === 'tool_result') {
        // Tool results come in two flavours: JSON/structured payloads and
        // prose (meeting messages, agent chat, LLM answers).
        //
        // Server caps preview at 2000 chars — for big JSON payloads (e.g.
        // kernel_crm_leads with 5+ leads), the cut lands MID-STRING. The
        // old heuristic required matching brackets at both ends and fell
        // through to the prose path on truncation — markdown then chewed
        // the broken JSON into unreadable garbage with stray asterisks +
        // backslashes (the bug visible in /tmp/clipboard-1778297598.png).
        //
        // New rule: any preview that *starts* with `{` or `[` is JSON.
        // Wrap in a `json` code fence regardless of truncation so markdown
        // can't touch it. Pretty-print only when the payload parses cleanly;
        // otherwise show raw + a truncation marker.
        const trimmed = preview.trim();
        const startsWithOpen = trimmed.startsWith('{') || trimmed.startsWith('[');
        if (startsWithOpen) {
          const closesCleanly =
            (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'));
          let body = preview;
          let truncated = !closesCleanly;
          if (closesCleanly) {
            try { body = JSON.stringify(JSON.parse(trimmed), null, 2); }
            catch { truncated = true; /* malformed even though brackets match */ }
          }
          const tag = truncated ? '\n... (truncated — full payload in HISTORY tab)' : '';
          return sanitizePreview('```json\n' + body + tag + '\n```', preview.length, 2000);
        }
        // Prose — let formatRunOutput render markdown normally.
        return sanitizePreview(preview, preview.length, 2000);
      }
      if (st === 'thought') return sanitizePreview(preview, preview.length, 200);
      if (st === 'final') return sanitizePreview(preview, preview.length, 200);
      if (st === 'rate_limit_wait') return String(e.data.content_preview ?? 'waiting…');
      return preview || st;
    }
    return t;
  }
  function liveEventType(e: AgentFlowEvent): string {
    const t = e.event.split(':').pop() ?? '';
    if (t === 'step') return String(e.data.type ?? 'step');
    return t;
  }

  // ── Tool action summarizer ──────────────────────────────────────────
  // Turns raw tool payloads into one-line, human-friendly summaries so the
  // LIVE timeline reads like a story instead of a JSON dump. Falls back to
  // the tool name when the input shape is unfamiliar (extension tools, new
  // MCP servers, etc.) — better to look generic than to wrap wrong.
  type ToolCategory =
    | 'shell' | 'fs' | 'web' | 'kernel' | 'mcp' | 'think' | 'final'
    | 'error' | 'meta' | 'tool';
  function toolCategory(toolName: string): ToolCategory {
    if (!toolName) return 'tool';
    if (toolName === 'Bash') return 'shell';
    if (['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'LS'].includes(toolName)) return 'fs';
    if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'web';
    if (toolName.startsWith('kernel_')) return 'kernel';
    if (toolName.startsWith('mcp__')) return 'mcp';
    if (toolName === 'Task' || toolName === 'TodoWrite' || toolName === 'TaskCreate' || toolName === 'TaskUpdate') return 'meta';
    return 'tool';
  }
  function ellipsize(s: string, n: number): string {
    if (!s) return '';
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  function tryParseJson(raw: string): unknown {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { /* */ }
    // Some previews arrive double-escaped (JSON string of JSON). Try one peel.
    try {
      const inner = JSON.parse(raw);
      if (typeof inner === 'string') {
        try { return JSON.parse(inner); } catch { return inner; }
      }
    } catch { /* */ }
    return null;
  }
  function basenameOf(p: string): string {
    if (!p) return '';
    const norm = p.replace(/\\/g, '/');
    const idx = norm.lastIndexOf('/');
    return idx >= 0 ? norm.slice(idx + 1) : norm;
  }
  /**
   * Summarize a tool_call. Returns the line shown front-and-center in the
   * timeline ("Listing kernel agent tools", "Reading /src/index.ts:42", …).
   * Falls back to the raw tool name when the payload shape is unknown so
   * the user always sees *something* meaningful instead of `{}`.
   */
  function summarizeToolCall(toolName: string, inputPreview: string): string {
    const args = tryParseJson(inputPreview) as Record<string, unknown> | null;
    if (!toolName) return 'calling tool';
    if (!args || typeof args !== 'object') return toolName;
    switch (toolName) {
      case 'Bash': {
        const desc = typeof args.description === 'string' ? args.description : '';
        const cmd = typeof args.command === 'string' ? args.command : '';
        if (desc) return desc;
        return cmd ? `$ ${ellipsize(cmd, 96)}` : 'shell command';
      }
      case 'Read': {
        const p = String(args.file_path ?? '');
        const off = args.offset, lim = args.limit;
        const range = off != null || lim != null
          ? ` · L${off ?? 1}${lim != null ? '–' + (Number(off ?? 0) + Number(lim)) : '+'}`
          : '';
        return p ? `Read ${basenameOf(p)}${range}` : 'Read file';
      }
      case 'Write': {
        const p = String(args.file_path ?? '');
        return p ? `Write ${basenameOf(p)}` : 'Write file';
      }
      case 'Edit': {
        const p = String(args.file_path ?? '');
        const all = args.replace_all ? ' (replace all)' : '';
        return p ? `Edit ${basenameOf(p)}${all}` : 'Edit file';
      }
      case 'NotebookEdit': {
        const p = String(args.notebook_path ?? '');
        return p ? `Edit notebook ${basenameOf(p)}` : 'Edit notebook';
      }
      case 'Glob': {
        const pat = String(args.pattern ?? '');
        const dir = String(args.path ?? '');
        return pat ? `Find files matching ${ellipsize(pat, 60)}${dir ? ' in ' + basenameOf(dir) : ''}` : 'Glob';
      }
      case 'Grep': {
        const pat = String(args.pattern ?? '');
        const where = String(args.path ?? '');
        return pat ? `Search ${ellipsize(pat, 56)}${where ? ' in ' + basenameOf(where) : ''}` : 'Grep';
      }
      case 'LS': {
        const p = String(args.path ?? '');
        return p ? `List ${basenameOf(p)}` : 'List directory';
      }
      case 'WebFetch': {
        const u = String(args.url ?? '');
        return u ? `Fetch ${ellipsize(u, 84)}` : 'Fetch URL';
      }
      case 'WebSearch': {
        const q = String(args.query ?? '');
        return q ? `Search the web for ${ellipsize(q, 70)}` : 'Web search';
      }
      case 'Task': {
        const desc = String(args.description ?? args.subagent_type ?? '');
        return desc ? `Spawn subagent · ${ellipsize(desc, 60)}` : 'Spawn subagent';
      }
      case 'TodoWrite': return `Update task list (${Array.isArray(args.todos) ? (args.todos as unknown[]).length : '?'} items)`;
      case 'TaskCreate': return `Create task · ${ellipsize(String(args.subject ?? ''), 60)}`;
      case 'TaskUpdate': return `Update task · ${ellipsize(String(args.taskId ?? ''), 24)} → ${String(args.status ?? '')}`;
      default: {
        // Generic kernel_* / mcp__* / unknown tool: pretty-print 1-2 string
        // args (skip nested objects to keep the line tight).
        const entries = Object.entries(args).filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
        if (entries.length === 0) return toolName;
        const head = entries.slice(0, 2)
          .map(([k, v]) => `${k}=${ellipsize(String(v), 40)}`)
          .join(' · ');
        return `${toolName} · ${head}`;
      }
    }
  }
  /**
   * Summarize a tool_result. The preview the server sends is whatever the
   * tool returned (often JSON). We aim for a one-line "N rows" / "M lines"
   * / "ok" callout so the timeline reads vertically; the full payload is
   * still available via the expand chevron.
   */
  function summarizeToolResult(toolName: string, preview: string): string {
    if (!preview) return 'no output';
    const trimmed = preview.trim();
    // JSON envelope from MCP — `{ content: [{ type:"text", text:"..." }], isError }`
    const parsed = tryParseJson(trimmed);
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).content)) {
      const arr = ((parsed as Record<string, unknown>).content as unknown[]);
      const texts: string[] = [];
      for (const it of arr) {
        if (it && typeof it === 'object' && (it as Record<string, unknown>).type === 'text') {
          texts.push(String((it as Record<string, unknown>).text ?? ''));
        }
      }
      const joined = texts.join('\n').trim();
      if (joined) return summarizeText(toolName, joined);
    }
    if (parsed && Array.isArray(parsed)) {
      return `${(parsed as unknown[]).length} items`;
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.error === 'string') return `error · ${ellipsize(obj.error, 70)}`;
      const keys = Object.keys(obj);
      // Single-key wrappers — show the key as a hint.
      if (keys.length === 1) return `${keys[0]} (object)`;
      return `${keys.length} fields · ${ellipsize(keys.slice(0, 4).join(', '), 60)}`;
    }
    return summarizeText(toolName, trimmed);
  }
  function summarizeText(toolName: string, txt: string): string {
    const lines = txt.split('\n').filter(l => l.length > 0);
    if (lines.length === 0) return 'empty output';
    if (lines.length === 1) return ellipsize(lines[0], 100);
    // Heuristics by tool:
    //   - Grep: lines like "file:line:text" — count matches
    //   - LS / Glob: list of paths
    //   - Bash: line count + first line preview
    if (toolName === 'Grep' && lines.every(l => /:/.test(l))) {
      return `${lines.length} matches · ${ellipsize(lines[0], 80)}`;
    }
    if ((toolName === 'Glob' || toolName === 'LS') && lines.every(l => !l.includes(' ') || l.startsWith('/'))) {
      return `${lines.length} paths`;
    }
    return `${lines.length} lines · ${ellipsize(lines[0], 80)}`;
  }
  /**
   * Per-step summary for the LIVE timeline. Always returns a non-empty
   * string — falls back to the existing liveEventSummary() prose when the
   * step isn't a tool call/result (thoughts, finals, run events, etc.).
   */
  function liveStepSummary(e: AgentFlowEvent): string {
    const etype = liveEventType(e);
    const preview = String(e.data.content_preview ?? '');
    const toolName = String(e.data.tool_name ?? '');
    if (etype === 'tool_call') return summarizeToolCall(toolName, preview);
    if (etype === 'tool_result') return summarizeToolResult(toolName, preview);
    if (etype === 'thought') return ellipsize(preview, 140) || 'thinking…';
    if (etype === 'final') return ellipsize(preview, 140) || 'finalizing…';
    if (etype === 'rate_limit_wait') return ellipsize(preview, 140) || 'rate-limit cooldown';
    if (etype === 'error') return ellipsize(preview, 140) || 'error';
    // Run lifecycle + meta — defer to the existing prose helper.
    return liveEventSummary(e);
  }
  /** Category hint used to color-code the step row. */
  function liveStepCategory(e: AgentFlowEvent): ToolCategory {
    const etype = liveEventType(e);
    if (etype === 'thought') return 'think';
    if (etype === 'final') return 'final';
    if (etype === 'error' || etype === 'rate_limit_wait') return 'error';
    if (etype === 'tool_call' || etype === 'tool_result') {
      return toolCategory(String(e.data.tool_name ?? ''));
    }
    return 'meta';
  }
  // Set of step keys (`${ts}-${idx}`) that the user has expanded — controls
  // whether the detail panel renders below the summary line. Defaults to
  // collapsed for everything so the timeline stays scannable.
  let expandedLiveSteps = new Set<string>();
  function toggleLiveStep(key: string): void {
    if (expandedLiveSteps.has(key)) expandedLiveSteps.delete(key);
    else expandedLiveSteps.add(key);
    // Trigger Svelte reactivity (Set mutation isn't tracked otherwise).
    expandedLiveSteps = new Set(expandedLiveSteps);
  }

  // ── Meta chips: Δt + token usage ────────────────────────────────────
  /** Compact duration for the LIVE chips. Reuses the same shape as
   *  `fmtDuration` above but returns '' (not '—') on zero so we can use
   *  `{#if str}` for conditional rendering. */
  function liveFmtDelta(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), ss = s % 60;
    return ss === 0 ? `${m}m` : `${m}m${String(ss).padStart(2, '0')}s`;
  }
  /** Token formatter for LIVE chips. Empty string on zero (same reason
   *  as above — the existing fmtTokens returns '0'). Adds M for runs
   *  that go past a million tokens. */
  function liveFmtTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1000) return String(Math.round(n));
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  /** Δt between this event and the previous event in temporal order.
   *  Returns ms or null when this is the oldest event in the buffer. */
  function liveStepDeltaMs(i: number): number | null {
    // liveCurrentRunEvents is newest-first → previous event in time = i+1
    const e = liveCurrentRunEvents[i];
    const prev = liveCurrentRunEvents[i + 1];
    if (!e || !prev) return null;
    const a = Date.parse(e.ts), b = Date.parse(prev.ts);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const d = a - b;
    return d >= 0 ? d : null;
  }
  /** Sum of (numeric) tokens reported on this step. Backend emits tokens
   *  only on thought/final today; tool_call/tool_result carry only the
   *  cumulative `tokens_total` so the chip can stay visible. */
  function liveStepTokens(e: AgentFlowEvent): number {
    const n = Number((e.data as Record<string, unknown>).tokens);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  /** Cumulative tokens up to and including this step, as reported by the
   *  backend. Falls back to scanning later (older) events for the last
   *  known total when this event doesn't carry one. */
  function liveStepTokensTotal(i: number): number {
    for (let j = i; j < liveCurrentRunEvents.length; j++) {
      const v = Number((liveCurrentRunEvents[j].data as Record<string, unknown>).tokens_total);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return 0;
  }
  /** Total wall-clock elapsed for the current run — from the first event
   *  we've seen up to (and including) the most recent one. */
  $: liveRunElapsedMs = (() => {
    if (liveCurrentRunEvents.length < 2) return 0;
    const newest = Date.parse(liveCurrentRunEvents[0].ts);
    const oldest = Date.parse(liveCurrentRunEvents[liveCurrentRunEvents.length - 1].ts);
    if (!Number.isFinite(newest) || !Number.isFinite(oldest)) return 0;
    const d = newest - oldest;
    return d > 0 ? d : 0;
  })();
  $: liveRunTokensTotal = (() => {
    for (const e of liveCurrentRunEvents) {
      const v = Number((e.data as Record<string, unknown>).tokens_total);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return 0;
  })();

  function fmtClock(ts: string | undefined): string {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return ''; }
  }

  /** Clean up a backend preview that was sliced mid-string. Drops trailing
   * half-open markdown markers (stray `**`, trailing `#`, open `` ` ``), then
   * — if the preview actually hit the server cap — appends a sentinel that
   * formatRunOutput renders as a styled callout (not markdown, because
   * underscores/asterisks in payload IDs leak as literal chars). */
  const TRUNC_MARK = '\u0002TRUNCATED_HINT\u0002';
  // Agent step previews sometimes arrive as JSON-encoded strings (i.e. the
  // server stored the LLM's reply via JSON.stringify, so newlines are `\n`
  // and quotes are `\"` when displayed verbatim). Detect that shape and
  // unwrap it so markdown formatting actually works. Safe no-op on content
  // that wasn't encoded.
  function unescapeJsonish(s: string): string {
    if (!s) return s;
    const trimmed = s.trim();
    // Case 1: whole value is a quoted JSON string — unwrap it.
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') return parsed;
      } catch { /* fall through to inline */ }
    }
    // Case 2: literal escape sequences embedded in prose.
    if (/\\n|\\"|\\t|\\\\/.test(s)) {
      return s
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '  ')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
    }
    return s;
  }

  function sanitizePreview(text: string, rawLen: number, serverCap: number): string {
    let t = unescapeJsonish(String(text)).replace(/\s+$/, '');
    // strip trailing lone markdown markers that would render as raw asterisks
    t = t.replace(/(\*{1,3}|_{1,3})$/g, '');
    // Strip a stray trailing backtick ONLY if it isn't part of a ``` fence.
    // tool_call / tool_result previews wrap their payload in ```json … ```;
    // chopping a backtick off the closing fence breaks the markdown regex in
    // formatRunOutput and the fence renders as literal text.
    t = t.replace(/(?<!`)`$/g, '');
    t = t.replace(/\n\s*-\s*\**$/g, '');
    t = t.replace(/\n\s*#{1,6}\s*$/g, '');
    if (rawLen >= serverCap) t += '\n\n' + TRUNC_MARK;
    return t;
  }

  // ── Markdown-ish formatter + UUID detection ────
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
  }
  function linkifyUuids(html: string): string {
    return html.replace(UUID_RE, (m) => `<button type="button" class="ip-uuid-link" data-comm-id="${m}" title="Open ${m}">${m.slice(0, 8)}…</button>`);
  }
  function formatRunOutput(text: string | undefined | null): string {
    if (!text) return '';

    // ── JSON envelope unwrapping ───────────────────
    // The Claude Code SDK and several builtin handlers return a JSON envelope
    // like { most_recent_output: { content: "...markdown..." } } or
    // { content: "...", metadata: {...} }. Treating the whole envelope as
    // markdown destroys it: the `{` and `"key":` lines turn into <p>s, and
    // the `**bold**` markers inside the content string fight with the JSON
    // braces. Detect that shape and extract the human-facing payload before
    // running the regular markdown pass.
    const trimmed = String(text).trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        // MCP shape: { content: [{ type: "text", text: "..." }, …], isError?: bool }.
        // Concatenate every text part and recurse — the agent's prose lives there.
        if (Array.isArray(parsed.content)) {
          const parts: string[] = [];
          for (const item of parsed.content as unknown[]) {
            if (item && typeof item === "object" && (item as Record<string, unknown>).type === "text") {
              parts.push(String((item as Record<string, unknown>).text ?? ""));
            }
          }
          if (parts.length > 0) {
            const flag = parsed.isError ? "⚠ tool error\n\n" : "";
            return formatRunOutput(flag + parts.join("\n\n"));
          }
        }
        const mro = parsed.most_recent_output as Record<string, unknown> | undefined;
        const candidate =
          (typeof mro?.content === "string" && mro.content) ||
          (typeof parsed.content === "string" && parsed.content as string) ||
          (typeof parsed.result === "string" && parsed.result as string) ||
          (typeof parsed.summary === "string" && parsed.summary as string) ||
          "";
        if (candidate) {
          // Recurse — the extracted string IS the markdown the agent wrote.
          // Append the structured envelope at the bottom inside a collapsed
          // <details> so power users can still inspect it.
          const pretty = JSON.stringify(parsed, null, 2);
          return formatRunOutput(candidate) +
            '<details class="md-envelope"><summary>raw JSON envelope</summary>' +
            `<pre class="md-codeblock">${escapeHtml(pretty)}</pre></details>`;
        }
        // It's JSON but doesn't have a known content field — render the
        // pretty-printed JSON as a single code block instead of as markdown.
        return `<pre class="md-codeblock">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>`;
      } catch {
        // Not actually valid JSON — fall through to the markdown pass.
      }
    }

    // Protect triple-backtick fenced blocks from every markdown rule below.
    // Without this, JSON content that contains ## / ** / etc. gets mangled
    // (e.g. `## Context` inside a tool input becomes an <h3>).
    const fenceStash: string[] = [];
    const source = String(text).replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_m, body) => {
      const idx = fenceStash.length;
      fenceStash.push(escapeHtml(String(body)));
      return `\u0000CODEBLOCK${idx}\u0000`;
    });
    let html = escapeHtml(source);
    // headers
    html = html.replace(/^#{4,6}\s+(.+)$/gm, '<h5 class="md-h">$1</h5>');
    html = html.replace(/^###\s+(.+)$/gm, '<h4 class="md-h">$1</h4>');
    html = html.replace(/^##\s+(.+)$/gm, '<h3 class="md-h">$1</h3>');
    html = html.replace(/^#\s+(.+)$/gm, '<h3 class="md-h">$1</h3>');
    // bold then italic (careful order)
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // inline code
    html = html.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');
    // links [text](url) — reject anything that isn't http(s)/mailto, otherwise
    // an agent that ingested external content could output `[x](javascript:...)`
    // and pop XSS in this dashboard.
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
      let href: string | null = null;
      try {
        const u = new URL(url, window.location.href);
        if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
          href = u.toString();
        }
      } catch { href = null; }
      if (!href) return escapeHtml(text);
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });
    // lists + paragraphs
    const lines = html.split('\n');
    const out: string[] = [];
    let listType: 'ul' | 'ol' | null = null;
    const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
    for (const raw of lines) {
      const ul = /^\s*[-*]\s+(.*)$/.exec(raw);
      const ol = /^\s*\d+\.\s+(.*)$/.exec(raw);
      if (ul) {
        if (listType !== 'ul') { closeList(); out.push('<ul class="md-ul">'); listType = 'ul'; }
        out.push(`<li>${ul[1]}</li>`);
      } else if (ol) {
        if (listType !== 'ol') { closeList(); out.push('<ol class="md-ol">'); listType = 'ol'; }
        out.push(`<li>${ol[1]}</li>`);
      } else if (raw.trim() === '') {
        closeList();
      } else {
        closeList();
        if (/^<h[1-6]/.test(raw.trim())) out.push(raw);
        else out.push(`<p class="md-p">${raw}</p>`);
      }
    }
    closeList();
    let joined = linkifyUuids(out.join(''));
    // Restore the fenced code blocks as <pre>. They were escaped at stash time
    // so they're safe to drop back in as-is.
    joined = joined.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, idx) => {
      return `<pre class="md-codeblock">${fenceStash[Number(idx)]}</pre>`;
    });
    // Render the truncation sentinel as a visible callout. Both the raw
    // marker and an escaped variant (in case it went through escapeHtml
    // before the replace) are matched.
    const TRUNC_HTML = '<div class="md-trunc-hint">✂ Preview truncated by the server — open the HISTORY tab to see the full content.</div>';
    joined = joined
      .replace(/\u0002TRUNCATED_HINT\u0002/g, TRUNC_HTML)
      .replace(/TRUNCATED_HINT/g, TRUNC_HTML); // defensive fallback
    return joined;
  }

  // ── Draft (communication) modal ────────────────
  let draftModalOpen = false;
  let draftModalLoading = false;
  let draftModalError = '';
  let draftModalData: any = null;

  async function openDraftModal(entityId: string) {
    draftModalOpen = true;
    draftModalLoading = true;
    draftModalError = '';
    draftModalData = null;
    try {
      // Try communication first
      const commRes: any = await fetch('/api/dashboard/comms/detail?id=' + encodeURIComponent(entityId)).then(r => r.json()).catch(() => null);
      if (commRes?.comm) { draftModalData = commRes; draftModalLoading = false; return; }

      // Try note
      const noteRes: any = await fetch('/api/notes/' + encodeURIComponent(entityId)).then(r => r.json()).catch(() => null);
      if (noteRes?.note || noteRes?.id) {
        const n = noteRes.note ?? noteRes;
        draftModalData = { _type: 'note', note: n };
        draftModalLoading = false;
        return;
      }

      // Try prospect
      const prospRes: any = await fetch('/api/prospecting/' + encodeURIComponent(entityId)).then(r => r.json()).catch(() => null);
      if (prospRes?.prospect || prospRes?.id) {
        const p = prospRes.prospect ?? prospRes;
        draftModalData = { _type: 'prospect', prospect: p };
        draftModalLoading = false;
        return;
      }

      // Try agent run
      const runRes: any = await fetch('/api/agents/runs/' + encodeURIComponent(entityId)).then(r => r.json()).catch(() => null);
      if (runRes?.run) {
        draftModalData = { _type: 'run', run: runRes.run };
        draftModalLoading = false;
        return;
      }

      // Try agent (the entity that PRODUCES runs)
      const agentRes: any = await fetch('/api/agents/' + encodeURIComponent(entityId)).then(r => r.json()).catch(() => null);
      if (agentRes?.agent) {
        draftModalData = {
          _type: 'agent',
          agent: agentRes.agent,
          recentRuns: agentRes.runs ?? [],
        };
        draftModalLoading = false;
        return;
      }

      // Try CRM contact (used by prospector → copywriter → dispatcher pipelines)
      const contactRes: any = await fetch('/api/contacts/detail?id=' + encodeURIComponent(entityId)).then(r => r.json()).catch(() => null);
      if (contactRes?.contact) {
        draftModalData = { _type: 'contact', contact: contactRes.contact };
        draftModalLoading = false;
        return;
      }

      // Try reminder (kernel_reminders_create / kernel_reminders_schedule emit
      // these IDs in tool results; users clicking the hash should land here).
      const reminderRes: any = await fetch('/api/reminders/detail?id=' + encodeURIComponent(entityId)).then(r => r.json()).catch(() => null);
      if (reminderRes?.reminder) {
        draftModalData = { _type: 'reminder', reminder: reminderRes.reminder };
        draftModalLoading = false;
        return;
      }

      draftModalError = `ID ${entityId.slice(0, 8)}… not found in communications, notes, prospects, runs, agents, contacts, or reminders.`;
    } catch (e: any) {
      draftModalError = e?.message || 'Failed to load';
    } finally {
      draftModalLoading = false;
    }
  }

  function formatAgentRecentRuns(runs: any[]): string {
    return (runs || []).slice(0, 5).map((rr: any) => {
      const status = rr.status ?? '?';
      const steps = rr.steps_count ?? 0;
      const tokens = rr.tokens_used ?? 0;
      const when = String(rr.created_at ?? '').slice(0, 16).replace('T', ' ');
      const id = rr.id ? rr.id.slice(0, 8) : '?';
      return `[${status}] ${steps} steps · ${tokens} tokens · ${when} · ${id}`;
    }).join('\n');
  }

  function closeDraftModal() {
    draftModalOpen = false;
    draftModalData = null;
    draftModalError = '';
  }

  function handleOutputClick(e: MouseEvent) {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const btn = t.closest('.ip-uuid-link') as HTMLElement | null;
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute('data-comm-id');
      if (id) openDraftModal(id);
    }
  }

  // Reset tab when agent changes. Default to LIVE if the agent is currently
  // running (anything streaming is more interesting than stats), otherwise
  // fall back to OVERVIEW.
  let lastSelectedAgent: string | null = null;
  // ?tab=<panelTab> deep-link — consumed once, on the first agent selection.
  let _deepLinkTab: typeof panelTab | null = (() => {
    try {
      const t = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tab') : null;
      return t && ['info', 'live', 'history', 'memory', 'chat', 'workspace'].includes(t) ? (t as typeof panelTab) : null;
    } catch { return null; }
  })();
  $: if (selectedAgent && selectedAgent !== lastSelectedAgent) {
    lastSelectedAgent = selectedAgent;
    if (_deepLinkTab) {
      panelTab = _deepLinkTab;
      if (_deepLinkTab === 'workspace') loadWorkspaceFiles();
      _deepLinkTab = null;
    } else {
      panelTab = runningAgentIds.has(selectedAgent) ? 'live' : 'info';
    }
    agentRuns = []; agentMemory = []; expandedRunId = null; chatHistory = []; latestRun = null;
    loadLatestRun(); loadChatFromMemory();
  }
  $: if (!selectedAgent) lastSelectedAgent = null;

  async function togglePause() {
    if (!selectedAgent || !selData || togglingPause) return;
    togglingPause = true;
    const wasActive = selData.active === 1;
    const nextActive = !wasActive;
    try {
      const r = await fetch(`/api/agents/${selectedAgent}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: nextActive }),
      });
      const data = await r.json();
      if (data?.success) {
        // Optimistically reflect in the local list; parent will push truth soon.
        agents = agents.map(a => a.id === selectedAgent ? { ...a, active: nextActive ? 1 : 0 } : a);
        // Refresh full detail so schedule next_run / etc. update too.
        loadAgentDetail(selectedAgent);
        startMsg = nextActive ? '✓ resumed — scheduler re-enabled' : '⏸ paused — scheduler + triggers off';
      } else {
        startMsg = `✗ ${data?.error || 'could not toggle'}`;
      }
    } catch (e: any) {
      startMsg = `✗ ${e?.message || 'network error'}`;
    } finally {
      togglingPause = false;
      setTimeout(() => { if (startMsg.includes('paused') || startMsg.includes('resumed') || startMsg.startsWith('✗')) startMsg = ''; }, 4000);
    }
  }

  // REVISION resolution from the 3D detail panel.
  //   accept = clear under_revision, keep agent running
  //   reject = clear under_revision AND deactivate (active=0)
  async function resolveRevision(mode: 'accept' | 'reject') {
    if (!selectedAgent || !selData || revisionBusy) return;
    const name = selData.name || 'this agent';
    const msg = mode === 'accept'
      ? `Keep "${name}"? Clears the REVISION flag and leaves the agent running.`
      : `Reject "${name}"? It will be DEACTIVATED. Row stays in the DB — re-enable any time.`;
    if (!confirm(msg)) return;
    revisionBusy = true;
    const body = mode === 'accept'
      ? { under_revision: false }
      : { under_revision: false, active: false };
    try {
      const r = await fetch(`/api/agents/${selectedAgent}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (data?.success) {
        agents = agents.map(a => a.id === selectedAgent
          ? { ...a, under_revision: 0, ...(mode === 'reject' ? { active: 0 } : {}) }
          : a);
        loadAgentDetail(selectedAgent);
        startMsg = mode === 'accept' ? '✓ accepted — flag cleared' : '✗ rejected — agent deactivated';
      } else {
        startMsg = `✗ ${data?.error || 'could not update'}`;
      }
    } catch (e: any) {
      startMsg = `✗ ${e?.message || 'network error'}`;
    } finally {
      revisionBusy = false;
      setTimeout(() => { if (startMsg.includes('accepted') || startMsg.includes('rejected') || startMsg.startsWith('✗')) startMsg = ''; }, 4000);
    }
  }

  async function startAgent() {
    if (!selectedAgent || starting) return;
    starting = true;
    startMsg = '';
    showBubble(selectedAgent, '▶ starting…', 1200);
    try {
      const res: any = await rpcOrCall('agents.run', { agent_id: selectedAgent }, async () => {
        const r = await fetch('/api/agents/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: selectedAgent }),
        });
        return r.json();
      });
      if (res?.success || res?.run_id) {
        startMsg = `✓ started · run ${String(res.run_id || '').slice(0, 8)}`;
        if (panelTab === 'history') loadAgentRuns();
      } else {
        startMsg = `✗ ${res?.error || 'failed to start'}`;
      }
    } catch (e: any) {
      startMsg = `✗ ${e?.message || 'network error'}`;
    } finally {
      starting = false;
      setTimeout(() => { startMsg = ''; }, 5000);
    }
  }

  async function talkToAgent(text?: string) {
    const msg = (text ?? chatInput).trim();
    if (!selectedAgent || !msg || chatSending) return;
    chatInput = '';
    chatSending = true;
    chatError = '';

    chatHistory = [...chatHistory, { role: 'you', text: msg, ts: Date.now() }];
    scrollChatToEnd();
    showBubble(selectedAgent, msg, 400);

    // Persist user message to agent memory
    fetch(`/api/agents/${selectedAgent}/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: msg }),
    }).catch(() => {});

    try {
      const recentWork = await fetchRecentRunSummaries(selectedAgent, 5);
      const agentName = selData?.name ?? 'Agent';
      const agentDesc = selData?.description ?? '';

      // Build conversation context from recent chat history
      const recentChat = chatHistory.slice(-10).map(m =>
        m.role === 'you' ? `Boss: ${m.text}` : `${agentName}: ${m.text}`
      ).join('\n');

      const conversationalGoal = `The boss is talking to you directly. You are ${agentName}: ${agentDesc}.

## CONVERSATION HISTORY (this is your ongoing conversation with the boss)
${recentChat || '(first message)'}

## YOUR RECENT WORK (what you actually did — cite it when relevant)
${recentWork}

## RULES
1. This is a CONVERSATION. Read the history above and respond in context.
2. If the boss asked something before and you answered, don't repeat — build on it.
3. If asked about data, USE YOUR TOOLS to get real numbers. Never answer from memory.
4. If asked to do something, DO IT with tools. Don't promise — execute.
5. Write detailed, structured responses with markdown formatting.
6. FORBIDDEN: "I will work on it", "the team is focused", "strategic initiatives". Use tools instead.
7. If you genuinely don't know, say "I don't know" — do not invent.

Boss says: "${msg}"`;
      const res: any = await rpcOrCall('agents.run', { agent_id: selectedAgent, goal: conversationalGoal }, async () => {
        const r = await fetch('/api/agents/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: selectedAgent, goal: conversationalGoal }),
        });
        return r.json();
      });

      if (res?.run_id) {
        // The run is queued; the agent is now working. A typing indicator in the
        // thread carries that, so no fake message has to be pushed and later
        // matched by its text to be removed.
        chatPending = true;
        scrollChatToEnd();

        // Poll until the agent's own timeout, plus a grace period. The old
        // budget was a hardcoded 60 × 3s = 3 min while agents are configured
        // for 5 (timeout_ms defaults to 300000), so a slow-but-successful run
        // reported "Timed out waiting for response" and its real answer was
        // never shown.
        const askedAgent = selectedAgent;
        const budgetMs = Number(agentDetail?.agent?.timeout_ms ?? selData?.timeout_ms ?? 300000) + 30000;
        const attempts = Math.ceil(budgetMs / 3000);
        let answered = false;

        for (let i = 0; i < attempts && !answered; i++) {
          await new Promise(r => setTimeout(r, 3000));
          // The panel moved on. The run keeps going and the executor still
          // persists the reply, so it is waiting in memory the next time this
          // agent's thread is opened — but writing it into whatever thread is
          // on screen now would put one agent's answer under another's name.
          if (selectedAgent !== askedAgent) return;
          try {
            const detail: any = await rpcOrCall('agents.runs.detail', { id: res.run_id }, async () => {
              const r2 = await fetch(`/api/agents/runs/${res.run_id}`);
              return r2.json();
            });
            if (detail?.run?.status === 'completed' || detail?.run?.status === 'failed') {
              const ok = detail.run.status === 'completed';
              showBubble(askedAgent, ok ? 'Done!' : 'Failed', 200);
              answered = true;
              // Re-read the thread instead of appending the run result.
              // The executor writes the reply to the agent's memory, which is
              // the same source the tab loads from — building the thread by
              // hand here meant the two could disagree, and the reply existed
              // on the server while the pane showed a spinner.
              chatPending = false;
              await loadChatFromMemory();
              if (!chatHistory.some((m) => m.role === 'agent')) {
                // Memory had nothing (an executor that does not persist, or a
                // failure); fall back to what the run itself reported.
                const result = detail.run.result || detail.run.error || detail.run.status;
                const fullText = typeof result === 'string' ? result : JSON.stringify(result);
                chatHistory = [...chatHistory, {
                  role: 'agent',
                  text: ok ? fullText : `Failed: ${fullText}`,
                  ts: Date.now(),
                }];
              }
            }
          } catch { /* keep polling — a blip shouldn't end the wait */ }
        }

        if (!answered) {
          chatError =
            `No reply after ${Math.round(budgetMs / 60000)} min. The run may still be going — ` +
            `check History, and reopen this tab afterwards: the answer is saved with the agent ` +
            `whether or not this window was watching.`;
        }
      } else {
        chatError = 'The kernel did not start a run for this message.';
      }
    } catch (e: any) {
      chatError = e?.message ?? String(e);
    } finally {
      // Both flags clear only now. `chatSending` used to be reset here while the
      // polling ran unawaited in the background, so the field re-enabled and the
      // send button dropped its progress state seconds into a minutes-long run.
      chatPending = false;
      chatSending = false;
      scrollChatToEnd();
    }
  }

  // ── Meeting System ─────────────────────────────
  let showMeetingModal = false;
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
  let meetingSearch = '';

  $: meetingAgentOptions = agents.filter(a => a.active && !a.builtin_handler)
    .filter(a => !meetingSearch || a.name.toLowerCase().includes(meetingSearch.toLowerCase()));

  function toggleMeetingAgent(id: string) {
    if (meetingSelectedIds.has(id)) meetingSelectedIds.delete(id);
    else meetingSelectedIds.add(id);
    meetingSelectedIds = new Set(meetingSelectedIds);
  }

  // ── Auto-Meeting (autonomous agent-to-agent via MeetingExecutor) ─────
  // Distinct from "Call Meeting" above (which makes the user the moderator).
  // Here we pick a moderator agent + attendees and fire a run on the
  // moderator with a goal that calls kernel_agents_call_meeting.
  let showAutoMeetingModal = false;
  let autoMeetingTopic = '';
  let autoMeetingContext = '';
  let autoMeetingTopicsText = '';
  let autoMeetingModeratorId = '';
  let autoMeetingAttendeeIds: Set<string> = new Set();
  let autoMeetingRounds = 2;
  let autoMeetingUrgency: 'normal' | 'urgent' = 'normal';
  let autoMeetingFiring = false;
  let autoMeetingError = '';
  let autoMeetingSearch = '';

  $: autoMeetingAgentOptions = agents.filter(a => a.active && !a.builtin_handler)
    .filter(a => !autoMeetingSearch || a.name.toLowerCase().includes(autoMeetingSearch.toLowerCase()));

  // Group the agent options by office (flow) so the picker shows cohesive
  // sections instead of one big pile of pills. Each section header carries
  // the flow name + colour stripe; cards inside use the agent's rank insignia
  // as a mini avatar so the user can identify them at a glance.
  $: autoMeetingAgentsByFlow = (() => {
    const byFlow = new Map<string, { flow: { id: string; name: string; color: string }; agents: typeof autoMeetingAgentOptions }>();
    for (const a of autoMeetingAgentOptions) {
      const f = flows.find(x => x.id === a.flow_id);
      const flowKey = f?.id ?? '_none';
      const flowMeta = f ?? { id: '_none', name: 'No office', color: '#6b7088' };
      if (!byFlow.has(flowKey)) byFlow.set(flowKey, { flow: flowMeta as any, agents: [] });
      byFlow.get(flowKey)!.agents.push(a);
    }
    // Sort offices alphabetically for stable rendering; agents within a flow
    // sorted by name.
    return [...byFlow.values()]
      .sort((a, b) => a.flow.name.localeCompare(b.flow.name))
      .map(g => ({ ...g, agents: [...g.agents].sort((x, y) => x.name.localeCompare(y.name)) }));
  })();

  function rankInfoForAgent(agentId: string): { insignia: string; color: string } | null {
    const a = agents.find(x => x.id === agentId);
    if (!a?.rank_id) return null;
    const r = ranks.find(x => x.id === a.rank_id);
    return r ? { insignia: r.insignia, color: r.color } : null;
  }
  function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function toggleAutoMeetingAttendee(id: string) {
    if (id === autoMeetingModeratorId) return; // moderator can't attend itself
    if (autoMeetingAttendeeIds.has(id)) autoMeetingAttendeeIds.delete(id);
    else autoMeetingAttendeeIds.add(id);
    autoMeetingAttendeeIds = new Set(autoMeetingAttendeeIds);
  }

  function setAutoMeetingModerator(id: string) {
    autoMeetingModeratorId = id;
    if (autoMeetingAttendeeIds.has(id)) {
      autoMeetingAttendeeIds.delete(id);
      autoMeetingAttendeeIds = new Set(autoMeetingAttendeeIds);
    }
  }

  function resetAutoMeetingForm() {
    autoMeetingTopic = '';
    autoMeetingContext = '';
    autoMeetingTopicsText = '';
    autoMeetingModeratorId = '';
    autoMeetingAttendeeIds = new Set();
    autoMeetingRounds = 2;
    autoMeetingUrgency = 'normal';
    autoMeetingError = '';
    autoMeetingSearch = '';
  }

  async function fireAutoMeeting() {
    if (!autoMeetingModeratorId || autoMeetingAttendeeIds.size === 0 || !autoMeetingTopic.trim()) return;
    autoMeetingFiring = true;
    autoMeetingError = '';
    try {
      const attendeeIds = [...autoMeetingAttendeeIds];
      const attendeeJson = JSON.stringify(attendeeIds);
      // Fold description + topics into the tool's `context` param — the
      // MeetingExecutor hands context verbatim to every participant, so the
      // agents drill into each listed topic during their turns.
      const autoTopics = parseMeetingTopics(autoMeetingTopicsText);
      const ctxParts: string[] = [];
      if (autoMeetingContext.trim()) ctxParts.push(autoMeetingContext.trim());
      if (autoTopics.length > 0) ctxParts.push(`Topics to dig into (every participant must address them explicitly): ${autoTopics.map(t => `(${t})`).join(' ')}`);
      const ctxCombined = ctxParts.join(' — ');
      const ctxLine = ctxCombined
        ? `Pasale como context: "${ctxCombined.replace(/"/g, '\\"')}".`
        : '';
      const goal =
        `Call a meeting using the kernel_agents_call_meeting tool with ` +
        `attendee_ids ${attendeeJson}, topic "${autoMeetingTopic.replace(/"/g, '\\"')}", ` +
        `rounds ${autoMeetingRounds}, urgency "${autoMeetingUrgency}". ${ctxLine} ` +
        `Return the meeting summary without invoking any other tool.`;
      const res = await fetch('/api/agents/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: autoMeetingModeratorId, goal }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        autoMeetingError = body?.error || `HTTP ${res.status}`;
        return;
      }
      // Live transcript modal opens itself when meeting_requested arrives.
      showAutoMeetingModal = false;
      resetAutoMeetingForm();
    } catch (e: any) {
      autoMeetingError = e?.message || 'Failed to start meeting';
    } finally {
      autoMeetingFiring = false;
    }
  }

  /** Parse the "temas" textarea — one topic per line, bullets tolerated. */
  function parseMeetingTopics(raw: string): string[] {
    return raw.split('\n')
      .map(t => t.replace(/^[-*•\s]+/, '').trim())
      .filter(Boolean);
  }

  /** Human-readable brief injected into the chat + every agent's goal. */
  function meetingBrief(): string {
    const lines = [`Motivo: ${meetingTopic.trim()}`];
    if (meetingDescription.trim()) lines.push(`Description: ${meetingDescription.trim()}`);
    const topics = parseMeetingTopics(meetingTopicsText);
    if (topics.length > 0) {
      lines.push('Temas a profundizar:');
      for (const t of topics) lines.push(`  • ${t}`);
    }
    return lines.join('\n');
  }

  async function startMeeting() {
    if (meetingSelectedIds.size === 0 || !meetingTopic.trim() || !meetingDescription.trim()) return;
    meetingActive = true;
    meetingPanelOpen = true;
    showMeetingModal = false;
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
  function meetingRoomDoorPoint(
    mr: { cx: number; cz: number; w: number; d: number },
    hallCenter: { x: number; z: number },
  ): { x: number; y: number; z: number } {
    const wallCenters = [
      { x: mr.cx,             z: mr.cz + mr.d / 2 },
      { x: mr.cx,             z: mr.cz - mr.d / 2 },
      { x: mr.cx - mr.w / 2,  z: mr.cz },
      { x: mr.cx + mr.w / 2,  z: mr.cz },
    ];
    let best = wallCenters[1];
    let minDist = Infinity;
    for (const wc of wallCenters) {
      const d2 = (wc.x - hallCenter.x) ** 2 + (wc.z - hallCenter.z) ** 2;
      if (d2 < minDist) { minDist = d2; best = wc; }
    }
    return { x: best.x, y: 0, z: best.z };
  }

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

    sendWalkerToPoint(
      scene, walkers, srcId, seats[0], deskPos, roomMap, corGrid,
      agents, color, undefined, deskAabbs,
      'meeting', sittingWorkers, false,
      doorPoint, onArrive, false,
    );
    sendWalkerToPoint(
      scene, walkers, tgtId, seats[1], deskPos, roomMap, corGrid,
      agents, color, undefined, deskAabbs,
      'meeting', sittingWorkers, false,
      doorPoint, onArrive, false,
    );
    // Safety: if one walker never arrives (path-build failure, off-screen
    // cleanup) the seated one stays put forever. This hard ceiling guarantees
    // both go home eventually.
    setTimeout(dismiss, COORD_SAFETY_SEC * 1000);
    return true;
  }

  function sameOffice(srcId: string, tgtId: string): boolean {
    const sf = agents.find(a => a.id === srcId)?.flow_id ?? '';
    const tf = agents.find(a => a.id === tgtId)?.flow_id ?? '';
    return !!sf && !!tf && sf === tf;
  }

  function getMeetingSeatPositions(mr: { cx: number; cz: number; w: number; d: number }): Array<{ x: number; y: number; z: number }> {
    const tableW = Math.min(mr.w * 0.5, 6);
    const tableD = Math.min(mr.d * 0.3, 3);
    const seats: Array<{ x: number; y: number; z: number }> = [];
    const numPerSide = Math.max(2, Math.floor(tableW / 1.5));
    // Seats along both long sides of the table
    for (let i = 0; i < numPerSide; i++) {
      const x = mr.cx - tableW / 2 + (tableW / (numPerSide + 1)) * (i + 1);
      seats.push({ x, y: 0, z: mr.cz - tableD / 2 - 0.6 }); // front side
      seats.push({ x, y: 0, z: mr.cz + tableD / 2 + 0.6 }); // back side
    }
    // Head seats
    seats.push({ x: mr.cx - tableW / 2 - 0.6, y: 0, z: mr.cz });
    seats.push({ x: mr.cx + tableW / 2 + 0.6, y: 0, z: mr.cz });
    return seats;
  }

  /** Pick a free visitor chair in My Office (not currently targeted by another
   *  walker) so concurrent visitors don't stack on one seat. Falls back to
   *  round-robin when all four are occupied. */
  function pickFreeMyOfficeChair(): { x: number; y: number; z: number } | null {
    if (myOfficeSeats.length === 0) return null;
    const taken = new Set<number>();
    for (const w of walkers) {
      if (w.targetId !== 'myoffice' && w.targetId !== 'meeting') continue;
      const curve = (w as any).curve as Array<{ x: number; z: number }> | undefined;
      const c = curve?.[curve.length - 1];
      if (!c) continue;
      myOfficeSeats.forEach((s, idx) => {
        if (Math.abs(s.x - c.x) < 0.5 && Math.abs(s.z - c.z) < 0.5) taken.add(idx);
      });
    }
    for (let i = 0; i < myOfficeSeats.length; i++) {
      if (!taken.has(i)) return myOfficeSeats[i];
    }
    return myOfficeSeats[taken.size % myOfficeSeats.length];
  }

  // Fetch recent completed runs for an agent — used to build meeting/chat context
  async function fetchRecentRunSummaries(agentId: string, limit = 5): Promise<string> {
    try {
      const data: any = await rpcOrCall('agents.runs.list', { agent_id: agentId, limit }, async () => {
        const r = await fetch(`/api/agents/${agentId}/runs?limit=${limit}`);
        return r.json();
      });
      const runs: any[] = (data?.runs ?? []).filter((r: any) => r.status === 'completed' || r.status === 'failed');
      if (runs.length === 0) return '(no completed runs yet)';
      return runs.map((r: any) => {
        const goal = String(r.goal ?? r.trigger_type ?? '').slice(0, 200);
        const result = String(r.result ?? r.error ?? '(empty)').slice(0, 400);
        const status = r.status === 'completed' ? '✓' : '✗';
        const when = r.created_at ? r.created_at.slice(0, 16).replace('T', ' ') : '?';
        return `${status} [${when}] Goal: "${goal}"\n  → Result: "${result}"`;
      }).join('\n\n');
    } catch { return '(could not fetch runs)'; }
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
Motivo: ${meetingTopic}
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

<div class="world3d-container" on:click={() => { if (hqMenuOpen) hqMenuOpen = false; if (pendingMenuOpen) pendingMenuOpen = false; if (searchOpen) closeSearch(); }} role="presentation">
  {#if webglError}
    <div class="fb"><span class="fb-icon">&#9888;</span> {webglError}</div>
  {:else}
    <div class="world3d-canvas" bind:this={canvasEl}></div>
  {/if}

  <div class="scene-vignette" aria-hidden="true"></div>

  {#if !sceneReady && !webglError}
    <div class="boot" out:scale={{ duration: 700, start: 1.05, opacity: 0, easing: quintOut }} aria-hidden="true">
      <div class="boot-grid"></div>
      <div class="boot-vignette"></div>
      <div class="boot-core">
        <div class="boot-radar">
          <span class="boot-ring boot-ring-1"></span>
          <span class="boot-ring boot-ring-2"></span>
          <span class="boot-ring boot-ring-3"></span>
          <span class="boot-cross boot-cross-h"></span>
          <span class="boot-cross boot-cross-v"></span>
          <span class="boot-sweep"></span>
          <span class="boot-blip boot-blip-1"></span>
          <span class="boot-blip boot-blip-2"></span>
          <span class="boot-blip boot-blip-3"></span>
        </div>
        <div class="boot-info">
          <div class="boot-title">mtw<span>Kernel</span></div>
          <div class="boot-sub">H&middot;Q&nbsp;&nbsp;T A C T I C A L&nbsp;&nbsp;U P L I N K</div>
          {#if bootError || dataError}
            <div class="boot-err">
              <span class="boot-err-icon">&#9888;</span>
              <span class="boot-err-msg">{bootError ?? 'Could not load agent data.'}</span>
              <button class="boot-retry" on:click={retryBoot}>Reintentar</button>
            </div>
          {:else}
            <ul class="boot-log boot-log-live">
              {#each bootSteps as s (s.label)}
                <li class:done={s.done} class:active={!s.done}>
                  <span class="boot-check">{s.done ? '✓' : '›'}</span>
                  {s.label}{#if !s.done}<i class="boot-dots"></i>{/if}
                </li>
              {/each}
            </ul>
            <div class="boot-status">{bootStatus}</div>
            <div class="boot-bar"><span></span></div>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <PerfOverlay bind:visible={showPerfHud} stats={perfStats} extra={perfExtra} label="baseline" />

  <div class="hq-bar">
    <div class="hq-stats">
      <span class="hq-stat"><b>{agents.length}</b> staff</span>
      <span class="hq-sep"></span>
      <span class="hq-stat"><b>{runningAgentIds.size}</b> active</span>
      <span class="hq-sep"></span>
      <span class="hq-stat"><b>{chains.length}</b> chains</span>
      <span class="hq-sep"></span>
      <span class="hq-stat"><b>{triggerCount}</b> triggers</span>
      <span class="hq-sep"></span>
      <span class="hq-stat"><b>{todayRuns}</b> today</span>
      {#if runningAgentIds.size > 0}
        <span class="hq-sep"></span>
        <span class="hq-live-dot"></span>
      {/if}
      {#if pendingAgents.length > 0}
        <span class="hq-sep"></span>
        <button
          class="hq-pending-pill"
          on:click|stopPropagation={() => pendingMenuOpen = !pendingMenuOpen}
          title="Agents waiting for human approval"
        >
          <span class="hq-pending-dot"></span>
          <b>{pendingAgents.length}</b> pending
        </button>
      {/if}
      {#if pendingQuestions.length > 0}
        <span class="hq-sep"></span>
        <button
          class="hq-msg-pill"
          on:click|stopPropagation={openTopAgentMessages}
          title="Messages waiting for the top agent — click to open their office and reply"
        >
          <span class="hq-msg-dot"></span>
          <span class="hq-msg-ico">&#128236;</span>
          <b>{pendingQuestions.length}</b>
          {pendingQuestions.length === 1 ? 'mensaje' : 'mensajes'}
        </button>
      {/if}

      <!-- Agent search (lupa) — collapsed icon by default, expands inline. -->
      <span class="hq-sep"></span>
      <div class="hq-search" class:hq-search-open={searchOpen} on:click|stopPropagation role="presentation">
        {#if !searchOpen}
          <button
            class="hq-search-btn"
            on:click|stopPropagation={openSearch}
            title="Search an agent (zooms to its desk)"
            aria-label="Search agent"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>
        {:else}
          <div class="hq-search-wrap">
            <svg class="hq-search-glyph" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              bind:this={searchInputEl}
              bind:value={searchQuery}
              on:keydown={onSearchKey}
              type="text"
              class="hq-search-input"
              placeholder="agent name…"
              autocomplete="off"
              spellcheck="false"
            />
            <button
              class="hq-search-x"
              on:click|stopPropagation={closeSearch}
              title="Close (Esc)"
              aria-label="Close search"
            >×</button>
          </div>
          {#if searchQuery && searchResults.length > 0}
            <div class="hq-search-results" on:click|stopPropagation role="presentation">
              {#each searchResults as r (r.id)}
                {@const flow = flows.find(f => f.id === r.flow_id)}
                <button
                  class="hq-search-row"
                  on:click|stopPropagation={() => focusAgentById(r.id)}
                  title="Zoom camera to this agent"
                >
                  <span class="hq-search-row-dot" style="background:{flow?.color ?? '#888'}"></span>
                  <span class="hq-search-row-name">{r.name}</span>
                  <span class="hq-search-row-flow">{flow?.name ?? 'no office'}</span>
                </button>
              {/each}
            </div>
          {:else if searchQuery && searchResults.length === 0}
            <div class="hq-search-results hq-search-empty">no matches</div>
          {/if}
        {/if}
      </div>
    </div>
    <button class="hq-menu-trigger" on:click|stopPropagation={() => hqMenuOpen = !hqMenuOpen} title="Actions">
      <span class="hq-dots">&#x22EE;</span>
    </button>
    {#if hqMenuOpen}
      <div class="hq-dropdown">
        <div class="hq-section">Create</div>
        <button class="hq-action" on:click={() => { showNewOfficeWizard = true; hqMenuOpen = false; }} title="Found an office with the wizard — 3 steps, no code.">
          <span class="hq-action-ico">+</span> New Office
        </button>
        <button class="hq-action" on:click={() => { showOfficeModal = true; hqMenuOpen = false; }} title="Build the office by chatting with the AI architect.">
          <span class="hq-action-ico">&#128172;</span> New Office (AI chat)
        </button>
        <button class="hq-action" on:click={() => { showMeetingModal = true; hqMenuOpen = false; }}>
          <span class="hq-action-ico">&#9743;</span> Call Meeting
        </button>
        <button class="hq-action" on:click={() => { showAutoMeetingModal = true; hqMenuOpen = false; }} title="Trigger an autonomous agent-to-agent meeting (you don't participate)">
          <span class="hq-action-ico">&#9881;</span> Auto-Meeting
        </button>
        {#if hasReposOffice}
          <button class="hq-action" on:click={() => { openRegisterRepoModal(); hqMenuOpen = false; }} title="Track an existing local repository — files stay where they are.">
            <span class="hq-action-ico">&#128193;</span> Register Repo
          </button>
          <a class="hq-action" href="/devops" on:click={() => (hqMenuOpen = false)} style="text-decoration:none" title="Open the DevOps control panel — repos, backlog, dev stacks, 24/7 autopilot.">
            <span class="hq-action-ico">🛠</span> DevOps panel
          </a>
        {/if}

        <div class="hq-divider"></div>
        <div class="hq-section">View</div>
        <button class="hq-action hq-toggle"
                class:hq-toggle-on={showLiveMeeting && !!activeMeetingId && !!liveMeetings[activeMeetingId]}
                class:hq-toggle-disabled={!activeMeetingId || !liveMeetings[activeMeetingId]}
                on:click={() => { if (activeMeetingId && liveMeetings[activeMeetingId]) showLiveMeeting = !showLiveMeeting; }}
                title="Show / hide the live meeting transcript modal (auto-opens when a meeting starts)">
          <span class="hq-action-ico">📡</span>
          <span class="hq-action-label">Live meeting</span>
          <span class="hq-toggle-state">{showLiveMeeting && activeMeetingId ? '✓' : ''}</span>
        </button>
        <button class="hq-action hq-toggle"
                class:hq-toggle-on={showMeetingHistory}
                on:click={() => { showMeetingHistory = !showMeetingHistory; }}
                title="Show / hide the meetings history panel">
          <span class="hq-action-ico">📋</span>
          <span class="hq-action-label">Meetings panel</span>
          <span class="hq-toggle-count">{liveMeetingsList.length || ''}</span>
          <span class="hq-toggle-state">{showMeetingHistory ? '✓' : ''}</span>
        </button>
        <button class="hq-action hq-toggle"
                class:hq-toggle-on={showMgmtLog}
                class:hq-toggle-disabled={mgmtLog.length === 0}
                on:click={() => { if (mgmtLog.length > 0) showMgmtLog = !showMgmtLog; }}
                title="Show / hide the management log (manager edits, escalations)">
          <span class="hq-action-ico">🛠️</span>
          <span class="hq-action-label">Management log</span>
          <span class="hq-toggle-count">{mgmtLog.length || ''}</span>
          <span class="hq-toggle-state">{showMgmtLog ? '✓' : ''}</span>
        </button>
        <button class="hq-action hq-toggle"
                class:hq-toggle-on={showPerfHud}
                on:click={() => { showPerfHud = !showPerfHud; }}
                title="Show / hide the performance benchmark HUD (FPS, frame time, draws, triangles). Shift+P also toggles.">
          <span class="hq-action-ico">⚡</span>
          <span class="hq-action-label">Performance HUD</span>
          <span class="hq-toggle-state">{showPerfHud ? '✓' : ''}</span>
        </button>
        <button class="hq-action hq-toggle"
                class:hq-toggle-on={rotationMode === 'turntable'}
                on:click={() => setRotationMode(rotationMode === 'turntable' ? 'recenter' : 'turntable')}
                title="Rotation axis (left button). Turntable: rotates smoothly around the reception, preserving your framing. Recenter: rotating snaps the view back to the reception.">
          <span class="hq-action-ico">🎥</span>
          <span class="hq-action-label">Giro: {rotationMode === 'turntable' ? 'Turntable' : 'Recentrar'}</span>
          <span class="hq-toggle-state">{rotationMode === 'turntable' ? '✓' : '↺'}</span>
        </button>
      </div>
    {/if}

    {#if pendingMenuOpen && pendingAgents.length > 0}
      <div class="hq-pending-dropdown" on:click|stopPropagation role="presentation">
        <div class="hq-pending-head">Pending approvals ({pendingAgents.length})</div>
        <div class="hq-pending-body">
          {#each pendingAgents as a (a.id)}
            {@const flow = flows.find(f => f.id === a.flow_id)}
            <div class="hq-pending-row">
              <div class="hq-pending-info">
                <span class="hq-pending-name">{a.name}</span>
                <span class="hq-pending-flow" style="color:{flow?.color ?? '#888'}">{flow?.name ?? 'no office'}</span>
              </div>
              <button
                class="hq-pending-activate"
                on:click={() => activateAgent(a.id)}
                disabled={activatingAgentId === a.id}
              >
                {activatingAgentId === a.id ? '…' : 'Activate'}
              </button>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>

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

  <!-- New Office chat — replaces the legacy form. Talks directly to Claude
       Code, which uses the kernel_agents_* tools to spin up the flow + CEO
       + team based on the conversation. -->
  <!-- New Office wizard — Office Kit form (3 pasos + blueprint en vivo). -->
  {#if showNewOfficeWizard}
    <NewOfficeModal
      on:close={() => { showNewOfficeWizard = false; }}
      on:created={() => dispatch('refresh')}
    />
  {/if}

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

  <!-- Register Repo Modal — name + path (absolute) + optional desc/tags.
       Trigger lives in the HQ dropdown (Create section). -->
  {#if showRegisterRepoModal}
    <div class="modal-overlay" on:click={() => (showRegisterRepoModal = false)} role="button" tabindex="-1" on:keydown={e => e.key === 'Escape' && (showRegisterRepoModal = false)}>
      <div class="modal repo-modal" on:click|stopPropagation role="presentation">
        <div class="modal-title">REGISTER REPO</div>
        <div class="modal-sub">Track an existing local checkout — files stay where they are.</div>

        <label class="modal-label">
          Name
          <input
            type="text"
            class="modal-input"
            placeholder="kernl"
            bind:value={registerRepoName}
            disabled={registerRepoBusy}
            on:keydown={e => e.key === 'Enter' && registerRepoPath && submitRegisterRepo()}
          />
        </label>

        <label class="modal-label">
          Path <span class="modal-hint">(absolute, e.g. /home/you/projects/foo)</span>
          <input
            type="text"
            class="modal-input"
            placeholder="/home/you/projects/my-repo"
            bind:value={registerRepoPath}
            disabled={registerRepoBusy}
            on:keydown={e => e.key === 'Enter' && registerRepoName && submitRegisterRepo()}
          />
        </label>

        <label class="modal-label">
          Description <span class="modal-hint">(optional)</span>
          <input type="text" class="modal-input" bind:value={registerRepoDesc} disabled={registerRepoBusy} />
        </label>

        <label class="modal-label">
          Tags <span class="modal-hint">(optional, comma-separated)</span>
          <input type="text" class="modal-input" placeholder="ts, monorepo, infra" bind:value={registerRepoTags} disabled={registerRepoBusy} />
        </label>

        {#if registerRepoError}
          <div class="modal-error">{registerRepoError}</div>
        {/if}

        <div class="modal-actions">
          <button class="modal-cancel" on:click={() => (showRegisterRepoModal = false)} disabled={registerRepoBusy}>Cancel</button>
          <button class="modal-confirm repo-modal-confirm" on:click={submitRegisterRepo} disabled={registerRepoBusy || !registerRepoName.trim() || !registerRepoPath.trim()}>
            {registerRepoBusy ? 'Registering…' : 'Register'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Call Meeting Modal -->
  {#if showMeetingModal}
    <div class="modal-overlay" on:click={() => showMeetingModal = false} role="button" tabindex="-1" on:keydown={e => e.key === 'Escape' && (showMeetingModal = false)}>
      <div class="modal meeting-modal" on:click|stopPropagation role="presentation">
        <div class="modal-title">Call Meeting</div>
        <div class="modal-sub">You moderate: reason, description, and the topics the agents will dig into.</div>

        <label class="modal-label">
          Motivo
          <input type="text" class="modal-input" bind:value={meetingTopic} placeholder="ej. Revisión de estrategia Q2" />
        </label>

        <label class="modal-label">
          Description
          <textarea class="modal-textarea" bind:value={meetingDescription} rows="3"
            placeholder="Context for the meeting: what happened, what needs resolving, what decision has to be made"></textarea>
        </label>

        <label class="modal-label">
          Topics to dig into (one per line)
          <textarea class="modal-textarea" bind:value={meetingTopicsText} rows="3"
            placeholder={'e.g.\nLast week\u2019s metrics\nTeam blockers\nNext steps'}></textarea>
        </label>

        <label class="modal-label">
          Invite ({meetingSelectedIds.size} selected)
          <input type="text" class="modal-input" bind:value={meetingSearch} placeholder="Search agents..." />
        </label>

        <div class="meeting-agent-list">
          {#each meetingAgentOptions as a (a.id)}
            <button class="meeting-agent-item" class:selected={meetingSelectedIds.has(a.id)}
              on:click={() => toggleMeetingAgent(a.id)}>
              <span class="meeting-agent-dot" style="background:{flowColor(a.id)}"></span>
              <span class="meeting-agent-name">{a.name}</span>
              {#if meetingSelectedIds.has(a.id)}<span class="meeting-check">&#10003;</span>{/if}
            </button>
          {/each}
        </div>

        <div class="modal-actions">
          <button class="modal-cancel" on:click={() => showMeetingModal = false}>Cancel</button>
          <button class="modal-confirm" on:click={startMeeting}
            disabled={meetingSelectedIds.size === 0 || !meetingTopic.trim() || !meetingDescription.trim()}>
            Start Meeting ({meetingSelectedIds.size})
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Auto-Meeting Modal (autonomous: pick moderator + attendees, kernel orchestrates) -->
  {#if showAutoMeetingModal}
    <div class="modal-overlay" on:click={() => showAutoMeetingModal = false} role="button" tabindex="-1" on:keydown={e => e.key === 'Escape' && (showAutoMeetingModal = false)}>
      <div class="modal auto-meeting-modal" on:click|stopPropagation role="presentation">
        <div class="modal-title">Auto-Meeting</div>
        <div class="modal-sub">The agents talk to each other (you don't take part). You'll see the conversation live as soon as it starts.</div>

        <label class="modal-label">
          Topic
          <input type="text" class="modal-input" bind:value={autoMeetingTopic}
            placeholder="What do they need to discuss?" />
        </label>

        <label class="modal-label">
          Description / Context (optional)
          <textarea class="modal-textarea" bind:value={autoMeetingContext} rows="3"
            placeholder="Background o documento que el moderador les muestra"></textarea>
        </label>

        <label class="modal-label">
          Topics to dig into (one per line, optional)
          <textarea class="modal-textarea" bind:value={autoMeetingTopicsText} rows="3"
            placeholder={'e.g.\nStatus of each workstream\nOpen risks\nPending decisions'}></textarea>
        </label>

        <div class="modal-row">
          <label class="modal-label modal-half">
            Rounds
            <select class="modal-input" bind:value={autoMeetingRounds}>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={15}>15</option>
              <option value={20}>20</option>
            </select>
          </label>
          <label class="modal-label modal-half">
            Urgencia
            <select class="modal-input" bind:value={autoMeetingUrgency}>
              <option value="normal">normal</option>
              <option value="urgent">urgent (rojo)</option>
            </select>
          </label>
        </div>

        <div class="modal-label">Moderador (1)</div>
        <div class="am-picker am-picker-mod">
          {#each autoMeetingAgentsByFlow as group (group.flow.id)}
            <div class="am-flow-section">
              <div class="am-flow-head" style="--c:{group.flow.color}">
                <span class="am-flow-stripe" style="background:{group.flow.color}"></span>
                <span class="am-flow-name">{group.flow.name}</span>
                <span class="am-flow-count">{group.agents.length}</span>
              </div>
              <div class="am-card-grid">
                {#each group.agents as a (a.id)}
                  {@const rank = rankInfoForAgent(a.id)}
                  <button type="button"
                    class="am-card am-card-mod {autoMeetingModeratorId === a.id ? 'am-card-mod-on' : ''}"
                    style="--flow-c:{group.flow.color}"
                    title={a.name}
                    on:click={() => setAutoMeetingModerator(a.id)}>
                    <span class="am-card-av" style="background:{group.flow.color}; color:{rank?.color ?? '#fff'}">
                      {#if rank}{rank.insignia}{:else}<span class="am-card-init">{initials(a.name)}</span>{/if}
                    </span>
                    <span class="am-card-name">{a.name}</span>
                  </button>
                {/each}
              </div>
            </div>
          {/each}
        </div>

        <div class="modal-label">Attendees ({autoMeetingAttendeeIds.size})</div>
        <input type="text" class="modal-input" bind:value={autoMeetingSearch} placeholder="search agent…" />
        <div class="am-picker am-picker-att">
          {#each autoMeetingAgentsByFlow as group (group.flow.id)}
            {@const attGroupAgents = group.agents.filter(a => a.id !== autoMeetingModeratorId)}
            {#if attGroupAgents.length > 0}
              <div class="am-flow-section">
                <div class="am-flow-head" style="--c:{group.flow.color}">
                  <span class="am-flow-stripe" style="background:{group.flow.color}"></span>
                  <span class="am-flow-name">{group.flow.name}</span>
                  <span class="am-flow-count">{attGroupAgents.length}</span>
                </div>
                <div class="am-card-grid">
                  {#each attGroupAgents as a (a.id)}
                    {@const rank = rankInfoForAgent(a.id)}
                    <button type="button"
                      class="am-card am-card-att {autoMeetingAttendeeIds.has(a.id) ? 'am-card-att-on' : ''}"
                      style="--flow-c:{group.flow.color}"
                      title={a.name}
                      on:click={() => toggleAutoMeetingAttendee(a.id)}>
                      <span class="am-card-av" style="background:{group.flow.color}; color:{rank?.color ?? '#fff'}">
                        {#if rank}{rank.insignia}{:else}<span class="am-card-init">{initials(a.name)}</span>{/if}
                      </span>
                      <span class="am-card-name">{a.name}</span>
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          {/each}
        </div>

        {#if autoMeetingError}
          <div class="modal-error">{autoMeetingError}</div>
        {/if}

        <div class="modal-actions">
          <button class="modal-cancel" on:click={() => { showAutoMeetingModal = false; resetAutoMeetingForm(); }}>Cancel</button>
          <button class="modal-confirm" on:click={fireAutoMeeting}
            disabled={autoMeetingFiring || !autoMeetingModeratorId || autoMeetingAttendeeIds.size === 0 || !autoMeetingTopic.trim()}>
            {autoMeetingFiring ? 'Starting…' : `Start (${autoMeetingAttendeeIds.size + 1} agents)`}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Live Agent-to-Agent Meeting Transcript — side panel so the 3D stays visible -->
  {#if showLiveMeeting && activeMeetingId && liveMeetings[activeMeetingId]}
    {@const lm = liveMeetings[activeMeetingId]}
    <div class="lm-side-panel" role="dialog" tabindex="-1">
      <div class="modal live-meeting-modal" role="presentation">
        <div class="lm-head">
          <div class="lm-titles">
            <div class="lm-title">
              {#if lm.status === 'requested'}<span class="lm-dot lm-dot-pulse"></span> Walking to meeting room…
              {:else if lm.status === 'started'}<span class="lm-dot lm-dot-pulse"></span> LIVE
              {:else if lm.status === 'completed'}<span class="lm-dot lm-dot-done"></span> Completed
              {:else}<span class="lm-dot lm-dot-fail"></span> Failed{/if}
              <span class="lm-topic">{lm.topic || '(no topic)'}</span>
            </div>
            <div class="lm-sub">
              <span class="lm-mod">🎙️ {lm.moderatorName}</span>
              <span class="lm-parts">·</span>
              {#each lm.participants.filter(p => p.id !== lm.moderatorId) as p}
                <span class="lm-attendee" style="background:{flowColor(p.id)}22;border-color:{flowColor(p.id)}">{p.name}</span>
              {/each}
              <span class="lm-parts">·</span>
              <span class="lm-stat">{lm.turns.length} turns</span>
              <span class="lm-parts">·</span>
              <span class="lm-stat">{lm.turns.reduce((s, t) => s + (t.tokens || 0), 0).toLocaleString()} tokens</span>
            </div>
          </div>
          {#if liveMeetingsList.length > 1}
            <select class="lm-switcher" bind:value={activeMeetingId}>
              {#each liveMeetingsList as m}
                <option value={m.id}>{m.status === 'started' || m.status === 'requested' ? '● ' : '○ '}{(m.topic || m.id).slice(0, 50)}</option>
              {/each}
            </select>
          {/if}
          <button class="lm-close" on:click={() => { showLiveMeeting = false; showTranscriptBody = false; }} title="Close">✕</button>
        </div>

        <div class="lm-transcript">
          {#if !showTranscriptBody}
            <button class="lm-show-btn" on:click={() => showTranscriptBody = true}>
              Mostrar {lm.turns.length} turn{lm.turns.length === 1 ? '' : 's'}
            </button>
          {:else}
            {#if lm.turns.length === 0}
              <div class="lm-empty">
                {#if lm.status === 'requested'}Waiting for them to reach the meeting room…{:else}Waiting for the first turn…{/if}
              </div>
            {/if}
            {#each lm.turns as t, i (`${t.ts}-${t.agentId}-${t.round}-${i}`)}
              <div class="lm-turn lm-turn-{t.role}">
                <div class="lm-turn-head">
                  <span class="lm-turn-ico">{t.role === 'moderator' ? '🎙️' : '💬'}</span>
                  <span class="lm-turn-name" style="color:{flowColor(t.agentId)}">{t.agentName}</span>
                  <span class="lm-turn-meta">round {t.round} · {t.tokens > 0 ? `${t.tokens} tk` : ''}</span>
                </div>
                <div class="copy-wrap lm-turn-body-wrap">
                  <CopyTextBtn text={t.body} title="Copy message" />
                  <div class="lm-turn-body ip-out-md">{@html formatRunOutput(t.body.length > 1500 ? t.body.slice(0, 1500) + '\n\n…(truncado)' : t.body)}</div>
                </div>
              </div>
            {/each}
          {/if}
        </div>

        {#if lm.status === 'completed' && (lm.decisions?.length || lm.action_items?.length)}
          <div class="lm-summary">
            {#if lm.decisions && lm.decisions.length > 0}
              <div class="lm-summary-h">✅ Decisions</div>
              <ul class="lm-summary-list">
                {#each lm.decisions as d}<li>{d}</li>{/each}
              </ul>
            {/if}
            {#if lm.action_items && lm.action_items.length > 0}
              <div class="lm-summary-h">▶ Action items</div>
              <ul class="lm-summary-list">
                {#each lm.action_items as a}<li>{a}</li>{/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Meeting history panel — last 10 meetings, click any to re-open the
       transcript modal. Top-right corner so it doesn't fight the management
       log. Hidden by default; the badge button toggles it. -->
  {#if showMeetingHistory && liveMeetingsList.length > 0}
    {@const closedCount = liveMeetingsList.filter(m => m.status === 'completed' || m.status === 'failed').length}
    <div class="hist-panel hist-open">
      <div class="hist-head">
        <span class="hist-head-badge">{liveMeetingsList.length}</span>
        <span class="hist-head-label">Meetings</span>
        {#if closedCount > 0}
          <button class="hist-clear-all"
                  title="Archive every completed/failed meeting"
                  on:click={dismissAllReadMeetings}>
            Clear {closedCount} read
          </button>
        {/if}
        <button class="hist-head-close"
                title="Hide this panel (also via the hq-bar View menu)"
                on:click={() => showMeetingHistory = false}>×</button>
      </div>
      <div class="hist-body">
          {#each liveMeetingsList.slice(0, 10) as m (m.id)}
            <div class="hist-row hist-row-{m.status}"
                 role="button"
                 tabindex="0"
                 on:click={() => { activeMeetingId = m.id; showLiveMeeting = true; }}
                 on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { activeMeetingId = m.id; showLiveMeeting = true; } }}>
              <div class="hist-row-head">
                {#if m.status === 'started'}<span class="hist-dot hist-dot-live"></span>
                {:else if m.status === 'completed'}<span class="hist-dot hist-dot-done"></span>
                {:else if m.status === 'failed'}<span class="hist-dot hist-dot-fail"></span>
                {:else}<span class="hist-dot hist-dot-pending"></span>{/if}
                <span class="hist-row-topic">{(m.topic || '(no topic)').slice(0, 60)}</span>
                {#if m.status === 'completed' || m.status === 'failed'}
                  <button class="hist-row-x"
                          title="Dismiss this meeting"
                          on:click|stopPropagation={() => dismissMeeting(m.id)}>✕</button>
                {/if}
              </div>
              <div class="hist-row-meta">
                <span>{m.moderatorName}</span>
                <span>·</span>
                <span>{m.participants.length} participants</span>
                <span>·</span>
                <span>{m.turns.length} turns</span>
                {#if m.turns.length > 0}
                  <span>·</span>
                  <span>{m.turns.reduce((s, t) => s + (t.tokens || 0), 0).toLocaleString()} tk</span>
                {/if}
              </div>
              {#if m.summary}
                <div class="hist-row-summary">{m.summary.slice(0, 110)}{m.summary.length > 110 ? '…' : ''}</div>
              {/if}
            </div>
          {/each}
      </div>
    </div>
  {/if}

  <!-- Management log panel — manager edits + escalations, bottom-left -->
  {#if showMgmtLog && mgmtLog.length > 0}
    <div class="mgmt-log mgmt-log-open">
      <div class="mgmt-log-head">
        <span class="mgmt-log-badge">{mgmtLog.length}</span>
        <span class="mgmt-log-label">Management log</span>
        <button class="mgmt-log-close"
                title="Hide this panel (also via the hq-bar View menu)"
                on:click={() => showMgmtLog = false}>×</button>
      </div>
      <div class="mgmt-log-body">
        {#each mgmtLog.slice(0, 10) as entry}
          <div class="mgmt-entry" style="border-left-color:{mgmtKindColor(entry.kind, entry.crossOffice)}">
            <div class="mgmt-entry-head">
              <span class="mgmt-entry-ico">{mgmtKindIcon(entry.kind)}</span>
              <span class="mgmt-entry-from">{entry.from}</span>
              <span class="mgmt-entry-arrow">→</span>
              <span class="mgmt-entry-to">{entry.to}</span>
              {#if entry.crossOffice}<span class="mgmt-entry-tag">cross-office</span>{/if}
              {#if entry.role === 'manager'}<span class="mgmt-entry-tag mgmt-entry-tag-mgr">manager</span>{/if}
            </div>
            <div class="mgmt-entry-detail">{entry.detail}</div>
            {#if entry.preview}<div class="mgmt-entry-preview">{entry.preview.slice(0, 140)}{entry.preview.length > 140 ? '…' : ''}</div>{/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Floating meeting indicator — hidden by default. Users still reach live
       meetings via the hq-bar menu (📡 Live meeting / 📋 Meetings panel) so
       this floating toast was redundant and visually busy. -->


  <!-- Active Meeting Panel -->
  {#if meetingActive && meetingPanelOpen}
    <div class="meeting-panel">
      <div class="meeting-header">
        <div class="meeting-title">Meeting: {meetingTopic}</div>
        <div class="meeting-attendees">
          {#each [...meetingSelectedIds] as aid}
            {@const a = agents.find(x => x.id === aid)}
            {#if a}<span class="meeting-att-dot" style="background:{flowColor(aid)}" title={a.name}></span>{/if}
          {/each}
          <span class="meeting-att-count">{meetingSelectedIds.size} attendees</span>
        </div>
        <button class="meeting-min" title="Minimise — the meeting continues; the sign above the room reopens it"
          on:click={() => meetingPanelOpen = false}>&#8211;</button>
        <button class="meeting-end" on:click={endMeeting}>End Meeting</button>
      </div>
      <div class="meeting-messages">
        {#each meetingChat as msg}
          <div class="meeting-msg copy-wrap">
            <CopyTextBtn text={msg.text} title="Copy message" />
            <span class="meeting-msg-name" style="color:{msg.color}">{msg.name}</span>
            {#if msg.role !== 'you'}
              <div class="meeting-msg-text ip-out-md">{@html formatRunOutput(msg.text)}</div>
            {:else}
              <span class="meeting-msg-text">{msg.text}</span>
            {/if}
          </div>
        {/each}
        {#if meetingSending}
          <div class="meeting-msg meeting-typing">
            <span class="meeting-msg-name" style="color:#8899bb">Agent</span>
            <span class="meeting-msg-text">typing...</span>
          </div>
        {/if}
      </div>
      <div class="meeting-composer">
        <ChatComposer
          bind:value={meetingInput}
          sending={meetingSending}
          placeholder="Say something to the group…"
          hint="Enter sends · Shift+Enter for a new line · everyone in the room reads this"
          sendLabel="Send to the room"
          maxRows={4}
          on:send={(e) => sendMeetingMessage(e.detail)}
        />
      </div>
    </div>
  {/if}

  <!-- My Office Reports Panel -->
  {#if showMyOfficePanel}
    {@const errorReports = officeReports.filter(r => r.status === 'failed')}
    {@const activityReports = officeReports.filter(r => r.status !== 'failed')}
    <div class="info-panel office-reports-panel">
      <div class="ip-head">
        <div class="ip-head-left">
          <div class="ip-glyph" style="color:#c9a84c">&#9733;</div>
          <div class="ip-head-txt">
            <div class="ip-name">My Office</div>
            <div class="ip-sub">
              <span style="color:#f0b874">{pendingQuestions.length} questions</span>
              <span class="ip-dot"></span>
              <span style="color:#ef5d6e">{errorReports.length} errors</span>
              <span class="ip-dot"></span>
              <span style="color:#8a8fa8">{activityReports.length} activity</span>
            </div>
          </div>
        </div>
        <button class="ip-close" on:click={() => showMyOfficePanel = false} aria-label="close">×</button>
      </div>

      <!-- Tabs: Overview · Questions · Errors -->
      <div class="ip-tabs mo-tabs">
        <button class="ip-tab" class:active={myOfficeTab === 'overview'}
                on:click={() => myOfficeTab = 'overview'}>Overview</button>
        <button class="ip-tab" class:active={myOfficeTab === 'questions'}
                on:click={() => myOfficeTab = 'questions'}>
          Questions
          {#if pendingQuestions.length > 0}<span class="mo-tab-badge mo-tab-badge-q">{pendingQuestions.length}</span>{/if}
        </button>
        <button class="ip-tab" class:active={myOfficeTab === 'errors'}
                on:click={() => myOfficeTab = 'errors'}>
          Errors
          {#if errorReports.length > 0}<span class="mo-tab-badge mo-tab-badge-err">{errorReports.length}</span>{/if}
        </button>
      </div>

      <div class="or-scroll">
        {#if myOfficeTab === 'overview'}
          <!-- ═══ OVERVIEW ═══ at-a-glance summary -->
          {#if officeReports.length === 0 && pendingQuestions.length === 0}
            <div class="or-empty">No reports yet. Agents will come here when they finish tasks.</div>
          {:else}
            <div class="mo-overview">
              <!-- KPI strip -->
              <div class="mo-kpis">
                <button class="mo-kpi mo-kpi-q" disabled={pendingQuestions.length === 0}
                        on:click={() => myOfficeTab = 'questions'}>
                  <span class="mo-kpi-num">{pendingQuestions.length}</span>
                  <span class="mo-kpi-lbl">Pending Q</span>
                </button>
                <button class="mo-kpi mo-kpi-err" disabled={errorReports.length === 0}
                        on:click={() => myOfficeTab = 'errors'}>
                  <span class="mo-kpi-num">{errorReports.length}</span>
                  <span class="mo-kpi-lbl">Errors</span>
                </button>
                <div class="mo-kpi mo-kpi-act">
                  <span class="mo-kpi-num">{activityReports.length}</span>
                  <span class="mo-kpi-lbl">Activity</span>
                </div>
              </div>

              <!-- Latest question (1) -->
              {#if pendingQuestions.length > 0}
                {@const q = pendingQuestions[0]}
                {@const agent = agents.find(a => a.id === q.from_agent_id)}
                <div class="or-section">
                  <span class="or-section-title or-section-q">❓ Latest question</span>
                  {#if pendingQuestions.length > 1}
                    <button class="or-section-more" on:click={() => myOfficeTab = 'questions'}>
                      +{pendingQuestions.length - 1} more →
                    </button>
                  {/if}
                </div>
                <div class="bq-card mo-overview-q" on:click={() => myOfficeTab = 'questions'} role="button" tabindex="0"
                     on:keydown={e => e.key === 'Enter' && (myOfficeTab = 'questions')}>
                  <div class="bq-head">
                    <span class="bq-from-dot" style="background:{flowColor(q.from_agent_id)}"></span>
                    <span class="bq-from">{agent?.name ?? q.from_agent_id.slice(0, 8)}</span>
                    <span class="bq-time">{fmtRelTime(q.created_at)}</span>
                  </div>
                  <div class="bq-question">{q.question}</div>
                </div>
              {/if}

              <!-- Latest error (1) -->
              {#if errorReports.length > 0}
                {@const r = errorReports[0]}
                <div class="or-section">
                  <span class="or-section-title or-section-fail">⚠ Latest error</span>
                  {#if errorReports.length > 1}
                    <button class="or-section-more" on:click={() => myOfficeTab = 'errors'}>
                      +{errorReports.length - 1} more →
                    </button>
                  {/if}
                </div>
                <button class="or-card or-fail" on:click={() => openReport = r}>
                  <div class="or-card-header">
                    <span class="or-dot" style="background:{r.color}"></span>
                    <span class="or-status status-fail">!</span>
                    <span class="or-name" style="color:{r.color}">{r.agentName}</span>
                    <span class="or-time">{fmtRelTime(new Date(r.ts).toISOString())}</span>
                  </div>
                  <div class="or-card-body">{r.text.replace(/[#*`]/g, '').replace(/\|/g, ' ').replace(/\{[^}]*\}/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 140)}{r.text.length > 140 ? '...' : ''}</div>
                </button>
                <!-- The 140-char preview cuts exactly where the kernel says how
                     to fix it, so the fix travels as a chip instead of prose.
                     Outside the card: an <a> inside a <button> is invalid. -->
                {#if isLlmConfigError(r.text)}
                  <a class="llm-fix llm-fix-row" href={LLM_SETTINGS_HREF}>⚙ Configure LLM →</a>
                {/if}
              {/if}

              <!-- Recent activity (handoff + completed, last 5) -->
              {#if activityReports.length > 0}
                <div class="or-section">
                  <span class="or-section-title">Recent activity</span>
                  {#if activityReports.length > 5}
                    <span class="or-section-hint">showing 5 of {activityReports.length}</span>
                  {/if}
                </div>
                <div class="office-reports-list">
                  {#each activityReports.slice(0, 5) as report (report.runId ?? `${report.agentId}-${report.ts}`)}
                    <button class="or-card" class:or-handoff={report.status === 'handoff'}
                            out:slide|local={{ duration: 320, easing: quintOut }}
                            on:click={() => openReport = report}>
                      <div class="or-card-header">
                        <span class="or-dot" style="background:{report.color}"></span>
                        <span class="or-status"
                              class:status-ok={report.status === 'completed'}
                              class:status-handoff={report.status === 'handoff'}>
                          {report.status === 'completed' ? '✓' : '→'}
                        </span>
                        <span class="or-name" style="color:{report.color}">{report.agentName}</span>
                        <span class="or-time">{fmtRelTime(new Date(report.ts).toISOString())}</span>
                      </div>
                      <div class="or-card-body">{report.text.replace(/[#*`]/g, '').replace(/\|/g, ' ').replace(/\{[^}]*\}/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 140)}{report.text.length > 140 ? '...' : ''}</div>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        {:else if myOfficeTab === 'questions'}
          <!-- ═══ QUESTIONS ═══ -->
          {#if pendingQuestions.length === 0}
            <div class="or-empty">No pending questions. Agents will pin them here when stuck.</div>
          {:else}
            <div class="or-section">
              <span class="or-section-title or-section-q">❓ Pending questions · {pendingQuestions.length}</span>
              <span class="or-section-hint">agents waiting for your call</span>
              <button class="mo-bulk-btn mo-bulk-dismiss" on:click={dismissAllQuestions} disabled={bulkBusy}>
                {bulkBusy ? '…' : `Dismiss all (${pendingQuestions.length})`}
              </button>
            </div>
            <div class="bq-list">
              {#each pendingQuestions as q (q.id)}
                {@const agent = agents.find(a => a.id === q.from_agent_id)}
                {@const ctxUrl = firstUrlIn(q.context)}
                <div class="bq-card">
                  <div class="bq-head">
                    <span class="bq-from-dot" style="background:{flowColor(q.from_agent_id)}"></span>
                    <span class="bq-from">{agent?.name ?? q.from_agent_id.slice(0, 8)}</span>
                    <span class="bq-time">{fmtRelTime(q.created_at)}</span>
                    <button class="bq-dismiss" title="Dismiss without answering"
                            on:click={() => dismissQuestion(q)}
                            disabled={!!questionSubmitting[q.id]}>×</button>
                  </div>
                  <div class="bq-question">{q.question}</div>
                  {#if q.context}
                    <details class="bq-context">
                      <summary>ver contexto</summary>
                      <div class="bq-context-body">{q.context}</div>
                    </details>
                  {/if}
                  {#if ctxUrl}
                    <a class="bq-direct-link" href={ctxUrl} target="_blank" rel="noopener noreferrer" title={ctxUrl}>
                      🔗 {new URL(ctxUrl).host}
                    </a>
                  {/if}
                  <div class="bq-options">
                    {#each q.options as opt, i}
                      {@const optUrl = urlForOption(q, opt)}
                      <button class="bq-option" class:bq-option-link={!!optUrl}
                              on:click={() => answerQuestion(q, i, opt)}
                              disabled={!!questionSubmitting[q.id]}
                              title={optUrl ? `Opens ${optUrl}` : opt.label}>
                        <span class="bq-option-idx">{i + 1}</span>
                        <span class="bq-option-lbl">{opt.label}</span>
                        {#if optUrl}<span class="bq-option-linkico" aria-hidden="true">↗</span>{/if}
                      </button>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        {:else if myOfficeTab === 'errors'}
          <!-- ═══ ERRORS ═══ -->
          {#if errorReports.length === 0}
            <div class="or-empty">No errors. Failed runs will appear here for triage.</div>
          {:else}
            <div class="or-section">
              <span class="or-section-title or-section-fail">⚠ Errors · {errorReports.length}</span>
              <span class="or-section-hint">routed to Error Auditor for triage</span>
              <button class="mo-bulk-btn mo-bulk-clear" on:click={clearErrors}>
                Mark all as read ({errorReports.length})
              </button>
            </div>
            <div class="office-reports-list">
              {#each errorReports as report (report.runId ?? `${report.agentId}-${report.ts}`)}
                <button class="or-card or-fail"
                        out:slide|local={{ duration: 320, easing: quintOut }}
                        on:click={() => openReport = report}>
                  <div class="or-card-header">
                    <span class="or-dot" style="background:{report.color}"></span>
                    <span class="or-status status-fail">!</span>
                    <span class="or-name" style="color:{report.color}">{report.agentName}</span>
                    {#if report.runId && auditedRunIds.has(report.runId)}
                      <span class="or-audited" title="Error Auditor triaged this failure">✓ audited</span>
                    {:else if report.runId}
                      <span class="or-audit-pending" title="Waiting for the Error Auditor to pick this up">● pending</span>
                    {/if}
                    <span class="or-time">{fmtRelTime(new Date(report.ts).toISOString())}</span>
                  </div>
                  <div class="or-card-body">{report.text.replace(/[#*`]/g, '').replace(/\|/g, ' ').replace(/\{[^}]*\}/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 140)}{report.text.length > 140 ? '...' : ''}</div>
                </button>
                {#if isLlmConfigError(report.text)}
                  <a class="llm-fix llm-fix-row" href={LLM_SETTINGS_HREF}>⚙ Configure LLM →</a>
                {/if}
              {/each}
            </div>
          {/if}
        {/if}
      </div>  <!-- /or-scroll -->

      {#if myOfficeTab === 'overview' && (officeReports.length > 0 || pendingQuestions.length > 0)}
        <div class="or-footer">
          {#if officeReports.filter(r => r.status !== 'failed').length > 0}
            <button class="office-clear-btn office-clear-btn-soft" on:click={clearActivity}
                    title="Remove handoff + completed cards from this view">
              Mark activity read
            </button>
          {/if}
          <button class="office-clear-btn office-clear-btn-danger" on:click={clearAllOfficeData}
                  title="Dismiss every pending question AND clear all reports">
            Clear everything
          </button>
        </div>
      {:else if myOfficeTab === 'errors' && officeReports.length > 0}
        <div class="or-footer">
          <button class="office-clear-btn" on:click={() => { officeReports = []; officeReportsLoaded = false; }}>Clear all reports</button>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Report Detail Modal -->
  {#if openReport}
    <div class="modal-overlay" on:click={() => openReport = null} role="button" tabindex="-1" on:keydown={e => e.key === 'Escape' && (openReport = null)}>
      <div class="report-modal" on:click|stopPropagation role="presentation">
        <div class="rm-head">
          <div class="rm-head-left">
            <span class="rm-dot" style="background:{openReport.color}"></span>
            <span class="rm-status"
              class:status-ok={openReport.status === 'completed'}
              class:status-fail={openReport.status === 'failed'}
              class:status-handoff={openReport.status === 'handoff'}>
              {openReport.status === 'completed' ? 'Completed' : openReport.status === 'failed' ? 'Failed' : 'Handoff'}
            </span>
            <span class="rm-name" style="color:{openReport.color}">{openReport.agentName}</span>
          </div>
          <div class="rm-head-right">
            <span class="rm-time">{new Date(openReport.ts).toLocaleString()}</span>
            <button class="rm-close" on:click={() => openReport = null}>×</button>
          </div>
        </div>
        <div class="rm-body ip-out-md" on:click={handleOutputClick} role="presentation">
          {#if fullReportLoading && !fullReportText}
            <div style="color:#6a6f82;font:500 11px 'JetBrains Mono',monospace">Loading full report…</div>
          {/if}
          {@html formatRunOutput(displayReportText)}
        </div>
        <div class="rm-actions">
          <button class="rm-action" on:click={() => openReport && copy(displayReportText, 'report-' + openReport.ts)}>
            {copiedKey === 'report-' + openReport?.ts ? '✓ copied' : '⧉ Copy full text'}
          </button>
          {#if isLlmConfigError(displayReportText)}
            <a class="rm-action rm-action-fix" href={LLM_SETTINGS_HREF}>⚙ Configure LLM →</a>
          {/if}
          <button class="rm-action" on:click={() => {
            if (openReport) {
              selectedAgent = openReport.agentId;
              showMyOfficePanel = false;
              openReport = null;
              focusAgent();
            }
          }}>
            Go to agent desk →
          </button>

          <!-- Send-to-fixer: primary dispatches to the resolved fixer; the ▾
               sibling opens a small picker so the user can override the
               default. Only rendered when at least one fixer agent exists. -->
          {#if activeFixer}
            <div class="rm-fixer-wrap">
              <button class="rm-action rm-fixer-primary" on:click={sendReportToFixer} disabled={sendingToFixer}
                      title="Dispatch the report body to {activeFixer.name} so they can diagnose + fix it">
                {sendingToFixer ? '⏳ sending…' : `🛠 Send to ${activeFixer.name}`}
              </button>
              {#if fixerCandidates.length > 1}
                <button class="rm-fixer-dropdown" on:click|stopPropagation={() => fixerPickerOpen = !fixerPickerOpen}
                        disabled={sendingToFixer} title="Pick a different fixer" aria-haspopup="true" aria-expanded={fixerPickerOpen}>▾</button>
              {/if}
              {#if fixerPickerOpen}
                <div class="rm-fixer-menu" role="menu" on:click|stopPropagation>
                  {#each fixerCandidates as cand}
                    <button class="rm-fixer-menu-item" class:rm-fixer-menu-active={cand.id === activeFixer.id}
                            on:click={() => { selectedFixerId = cand.id; fixerPickerOpen = false; }}>
                      <span class="rm-fixer-menu-name">{cand.name}</span>
                      <span class="rm-fixer-menu-hint">{cand.hint}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

          {#if fixerStatus}
            <span class="rm-fixer-status">{fixerStatus}</span>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  {#if selData}
    <div class="info-panel" style={selFlow?.color ? `--flow-color:${selFlow.color}` : ''}>
      <!-- Header: type glyph + name + role + close -->
      <div class="ip-head">
        <div class="ip-head-left">
          <div class="ip-glyph">{agentType(selData) === 'llm' ? '◆' : agentType(selData) === 'claude_code' ? '◇' : agentType(selData) === 'function' ? '▣' : '▲'}</div>
          <div class="ip-head-txt">
            {#if editingName}
              <div class="ip-name-edit">
                <!-- svelte-ignore a11y-autofocus -->
                <input
                  type="text"
                  class="ip-name-input"
                  bind:value={editNameValue}
                  autofocus
                  disabled={savingName}
                  on:keydown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); saveEditName(); }
                    else if (e.key === 'Escape') { e.preventDefault(); cancelEditName(); }
                  }}
                />
                <button class="ip-name-btn ip-name-btn-ok" title="Save (Enter)"
                  on:click={saveEditName} disabled={savingName}>✓</button>
                <button class="ip-name-btn ip-name-btn-cancel" title="Cancel (Esc)"
                  on:click={cancelEditName} disabled={savingName}>×</button>
              </div>
            {:else}
              <div class="ip-name">
                {selData.name}
                <button class="ip-name-edit-btn" title="Rename agent" on:click={beginEditName}>✎</button>
              </div>
            {/if}
            <div class="ip-sub">
              {#if selFlow}<span class="ip-flow" style="--f:{selFlow.color}">{selFlow.name}</span>{/if}
              <span class="ip-dot"></span>
              <span class="ip-id" title="agent id">
                {selData.id.slice(0, 8)}
                <button class="ip-copy-inline" on:click|stopPropagation={() => copy(selData.id, 'agent-id')} title="copy full agent id">{copiedKey === 'agent-id' ? '✓' : '⧉'}</button>
              </span>
            </div>
            <div class="ip-tags">
              {#if agentType(selData) === 'llm'}
                {@const fb = modelChainFallbacks(selData.model_chain)}
                <span class="ip-tag ip-tag-llm" title="LLM-powered agent (native runToolLoop)">LLM</span>
                {#if selData.model}
                  <span class="ip-tag ip-tag-model" title={selData.provider ? `${selData.provider} / ${selData.model}` : selData.model}>{selData.model}</span>
                {/if}
                {#if fb > 0}
                  <span class="ip-tag ip-tag-fallback" title="model_chain fallbacks configured">+{fb} fallback{fb > 1 ? 's' : ''}</span>
                {/if}
              {:else if agentType(selData) === 'claude_code'}
                <span class="ip-tag ip-tag-sdk" title="Runs through the Claude Agent SDK (claude_code executor)">Claude Code SDK</span>
                <span class="ip-tag ip-tag-model" title={selData.model ? `SDK model: ${selData.model}` : `SDK default model: ${CLAUDE_CODE_DEFAULT_MODEL}`}>
                  {selData.model || CLAUDE_CODE_DEFAULT_MODEL}{!selData.model ? ' (default)' : ''}
                </span>
              {:else}
                <span class="ip-tag ip-tag-script" title="Native script / builtin handler — no LLM">SCRIPT</span>
                {#if selData.builtin_handler}
                  <span class="ip-tag ip-tag-handler" title="builtin handler id">{selData.builtin_handler}</span>
                {/if}
              {/if}
            </div>
          </div>
        </div>
        <button class="ip-close" on:click={() => { selectedAgent = null; }} aria-label="close">×</button>
      </div>

      <!-- Primary actions. The run state leads the row: it is what Pause and
           Resume change, so it belongs with them and not floating in the body. -->
      <div class="ip-actions">
        <span class="ip-state" class:ip-state-on={selData.active === 1} class:ip-state-off={selData.active !== 1}
              title={selData.active === 1
                ? 'Schedule and event triggers are live'
                : 'Paused — schedule and triggers are off. Manual runs still work.'}>
          <span class="led" class:on={selData.active === 1}></span>{selData.active ? 'active' : 'paused'}
        </span>
        <button class="ip-btn ip-btn-primary" on:click={startAgent} disabled={starting} title={selData.active !== 1 ? 'Manual run — overrides pause' : 'Run this agent now'}>
          <span class="ip-btn-ico">{starting ? '●' : '▶'}</span>
          <span>{starting ? 'starting…' : 'Run now'}</span>
        </button>
        {#if selData.active === 1}
          <button class="ip-btn ip-btn-warn" on:click={togglePause} disabled={togglingPause} title="Pause: stop schedule + event triggers. Manual Run still works.">
            <span class="ip-btn-ico">⏸</span>
            <span>{togglingPause ? '…' : 'Pause'}</span>
          </button>
        {:else}
          <button class="ip-btn ip-btn-resume" on:click={togglePause} disabled={togglingPause} title="Resume: re-enable schedule + event triggers.">
            <span class="ip-btn-ico">▶</span>
            <span>{togglingPause ? '…' : 'Resume'}</span>
          </button>
        {/if}
        <button class="ip-btn ip-btn-ghost" on:click={() => selectPanelTab('chat')}>
          <span class="ip-btn-ico">✎</span><span>Message</span>
        </button>
        {#if selDevopsOffice}
          <a class="ip-btn ip-btn-ghost" href="/devops" style="text-decoration:none" title="Open the DevOps control panel — repos, backlog, dev stacks">
            <span class="ip-btn-ico">🛠</span><span>DevOps panel</span>
          </a>
        {/if}
        {#if selData.under_revision}
          <button class="ip-btn ip-btn-accept" on:click={() => resolveRevision('accept')} disabled={revisionBusy}
                  title="Accept — clear REVISION flag, keep agent as-is">
            <span class="ip-btn-ico">✓</span><span>{revisionBusy ? '…' : 'Accept'}</span>
          </button>
          <button class="ip-btn ip-btn-reject" on:click={() => resolveRevision('reject')} disabled={revisionBusy}
                  title="Reject — deactivate (active=0). Row stays in DB, easy rollback.">
            <span class="ip-btn-ico">✗</span><span>{revisionBusy ? '…' : 'Reject'}</span>
          </button>
        {/if}
        {#if startMsg}
          <span class="ip-start-msg" class:ok={startMsg.startsWith('✓')} class:err={startMsg.startsWith('✗')} class:pause={startMsg.startsWith('⏸')}>{startMsg}</span>
        {/if}
      </div>

      <!-- Tabs -->
      <div class="ip-tabs">
        <button class="ip-tab" class:active={panelTab === 'info'} on:click={() => selectPanelTab('info')}>Overview</button>
        {#if liveIsRunning}
          <button class="ip-tab ip-tab-live" class:active={panelTab === 'live'} on:click={() => selectPanelTab('live')}>
            <span class="live-dot"></span>LIVE
          </button>
        {/if}
        <button class="ip-tab" class:active={panelTab === 'history'} on:click={() => selectPanelTab('history')}>
          History{#if agentRuns.length}<span class="ip-tab-count">{agentRuns.length}</span>{/if}
        </button>
        {#each myPanelTabs as tab (tab.id)}
          <button class="ip-tab ip-tab-ext" class:active={panelTab === tab.id} on:click={() => selectPanelTab(tab.id)}>{tab.label}</button>
        {/each}
        <button class="ip-tab" class:active={panelTab === 'chat'} on:click={() => selectPanelTab('chat')}>Message</button>
        <button class="ip-tab" class:active={panelTab === 'workspace'} on:click={() => { panelTab = 'workspace'; loadWorkspaceFiles(); }}>Workspace{#if visibleWorkspaceFiles.length}<span class="ip-tab-count">{visibleWorkspaceFiles.length}</span>{/if}</button>
      </div>

      <!-- ──────────────── OVERVIEW TAB ──────────────── -->
      {#if panelTab === 'info'}
        <div class="ip-body">
          <!-- ─── Mandate ───
               What the agent was told to be. The role used to hang loose under
               the tabs and the system prompt sat last and collapsed, so the
               panel opened on infrastructure instead of on the agent. Both now
               live in one block, and it leads. -->
          <section class="ip-sec ip-mandate">
            <div class="ip-sec-hrow">
              <h3 class="ip-sec-h">
                Mandate
                {#if selPrompt}<span class="ip-sec-c">{selPrompt.length} chars</span>{/if}
              </h3>
              {#if selPrompt}
                <button class="ip-icon-btn" title="copy system prompt" on:click={() => copy(selPrompt, 'sys')}>{copiedKey === 'sys' ? '✓ copied' : '⧉ copy'}</button>
              {/if}
            </div>
            {#if selData.description}
              <p class="ip-role">{selData.description}</p>
            {/if}
            {#if selPrompt}
              <pre class="ip-pre ip-pre-scroll">{selPrompt}</pre>
            {:else if selData.builtin_handler}
              <div class="ip-mandate-alt">
                Runs a builtin handler — no system prompt.
                <code class="ip-code">{selData.builtin_handler}</code>
              </div>
            {:else if detailLoading}
              <div class="ip-mandate-alt">Loading system prompt…</div>
            {:else}
              <div class="ip-mandate-alt">No system prompt set.</div>
            {/if}
          </section>

          {#if dependsOnGoogleAuth(selData)}
            <div class="ip-auth-cta" title="This agent talks to Google — re-login any time tokens expire.">
              <span class="ip-auth-hint">Depends on Google auth</span>
              <button
                class="ip-auth-btn"
                disabled={reauthLoading}
                on:click={() => startReauth('google')}
              >
                <span class="ip-auth-ico">🔑</span>
                <span>{reauthLoading ? '… opening Google' : 'Re-login Google'}</span>
              </button>
            </div>
          {/if}

          <!-- ─── Latest result hero card ─── -->
          {#if latestRun && (latestRun.result || latestRun.error)}
            <div class="result-hero" class:result-ok={latestRun.status === 'completed'} class:result-fail={latestRun.status === 'failed'}>
              <div class="result-hero-top">
                <div class="result-hero-badge">
                  <span class="result-hero-icon">{latestRun.status === 'completed' ? '✓' : latestRun.status === 'failed' ? '✗' : '●'}</span>
                  <span class="result-hero-lbl">Last result</span>
                </div>
                <div class="result-hero-date">
                  {fmtRelTime(latestRun.created_at)}
                  {#if latestRun.created_at}
                    <span class="result-hero-date-full">{String(latestRun.created_at).slice(0,16).replace('T',' ')}</span>
                  {/if}
                </div>
                <div class="result-hero-meta">
                  <span class="result-hero-trigger" style="--c:{triggerColor(latestRun.trigger_type)}">{latestRun.trigger_type}</span>
                  <span class="result-hero-dot">·</span>
                  <span>{latestRun.steps_count} steps</span>
                  <span class="result-hero-dot">·</span>
                  <span>{fmtTokens(latestRun.tokens_used)} tok</span>
                </div>
              </div>
              {#if latestRun.error}
                <div class="result-hero-body result-hero-err copy-wrap">
                  <CopyTextBtn text={latestRun.error} title="Copy error" />
                  <div class="result-hero-err-lbl">⚠ Error</div>
                  <pre class="result-hero-err-txt">{latestRun.error}</pre>
                </div>
              {:else if latestRun.result}
                <div class="result-hero-body ip-out-md copy-wrap" on:click={handleOutputClick} role="presentation">
                  <CopyTextBtn text={latestRun.result} title="Copy result" />
                  {@html formatRunOutput(latestRun.result)}
                </div>
              {/if}
              <div class="result-hero-actions">
                <button class="result-hero-action" on:click={() => latestRun && copy(latestRun.result ?? latestRun.error ?? '', 'hero-' + latestRun.id)}>
                  {copiedKey === 'hero-' + latestRun.id ? '✓ copied' : '⧉ copy'}
                </button>
                <button class="result-hero-action" on:click={() => { selectPanelTab('history'); }}>See all runs →</button>
                {#if detectExpiredAuthProvider(latestRun.error ?? latestRun.result) === 'google'}
                  <button
                    class="result-hero-action result-hero-reauth"
                    disabled={reauthLoading}
                    on:click={() => startReauth('google')}
                    title="Re-authenticate Google account to fix the expired token"
                  >
                    {reauthLoading ? '… opening Google' : '🔑 Re-auth Google'}
                  </button>
                {/if}
              </div>
            </div>
          {:else if latestRunLoading}
            <div class="result-hero result-hero-loading">Loading last result…</div>
          {/if}

          <!-- The status/executor/model chips that used to sit here said what
               the header tags already say. The run state moved up next to the
               Pause control; provider and model are rows in Runtime below. -->

          <!-- KPIs -->
          {#if selStats}
            <div class="ip-kpis">
              <div class="ip-kpi">
                <div class="ip-kpi-v">{selStats.total_runs}</div>
                <div class="ip-kpi-l">Total runs</div>
              </div>
              <div class="ip-kpi">
                <div class="ip-kpi-v" style="color:#78dc8c">{selStats.completed}</div>
                <div class="ip-kpi-l">Completed</div>
              </div>
              <div class="ip-kpi">
                <div class="ip-kpi-v" style="color:#ef5d6e">{selStats.failed}</div>
                <div class="ip-kpi-l">Failed</div>
              </div>
              <div class="ip-kpi">
                <div class="ip-kpi-v">{Math.round(selStats.success_rate)}<span class="ip-kpi-unit">%</span></div>
                <div class="ip-kpi-l">Success</div>
              </div>
            </div>
          {/if}

          <!-- Connections (chains + ad-hoc invocations) -->
          {#if selChains.length || (agentDetail?.adhocConnections?.invokedBy?.length ?? 0) + (agentDetail?.adhocConnections?.invoked?.length ?? 0) > 0}
            <section class="ip-sec">
              <h3 class="ip-sec-h">Connections <span class="ip-sec-c">{selChains.length}{#if (agentDetail?.adhocConnections?.invokedBy?.length ?? 0) + (agentDetail?.adhocConnections?.invoked?.length ?? 0) > 0} + {(agentDetail?.adhocConnections?.invokedBy?.length ?? 0) + (agentDetail?.adhocConnections?.invoked?.length ?? 0)} ad-hoc{/if}</span></h3>
              <div class="ip-chain-list">
                {#each selChains as c}
                  {@const isOut = c.source_agent_id === selectedAgent}
                  <div class="ip-chain" class:out={isOut}>
                    <span class="ip-chain-dir">{isOut ? '↗ out' : '↙ in'}</span>
                    <span class="ip-chain-name">{isOut ? (agents.find(a => a.id === c.target_agent_id)?.name ?? '?') : (agents.find(a => a.id === c.source_agent_id)?.name ?? '?')}</span>
                    {#if c.label}<span class="ip-chain-label">{c.label}</span>{/if}
                  </div>
                {/each}
                {#if agentDetail?.adhocConnections?.invokedBy?.length}
                  {#each agentDetail.adhocConnections.invokedBy as inv}
                    <div class="ip-chain ip-chain-adhoc">
                      <span class="ip-chain-dir ip-chain-dir-adhoc">↙ called by</span>
                      <span class="ip-chain-name">{inv.agent_name}</span>
                      <span class="ip-chain-label">{inv.count}× · {fmtRelTime(inv.last_at)}</span>
                    </div>
                  {/each}
                {/if}
                {#if agentDetail?.adhocConnections?.invoked?.length}
                  {#each agentDetail.adhocConnections.invoked as inv}
                    <div class="ip-chain ip-chain-adhoc out">
                      <span class="ip-chain-dir ip-chain-dir-adhoc">↗ called</span>
                      <span class="ip-chain-name">{inv.agent_name}</span>
                      <span class="ip-chain-label">{inv.count}× · {fmtRelTime(inv.last_at)}</span>
                    </div>
                  {/each}
                {/if}
              </div>
            </section>
          {/if}

          {#if agentDetail?.schedules && agentDetail.schedules.length}
            <section class="ip-sec">
              <h3 class="ip-sec-h">Schedule</h3>
              {#each agentDetail.schedules as s}
                <div class="ip-sched">
                  <div class="ip-sched-row">
                    <span class="ip-sched-lbl">cron</span>
                    <code class="ip-code">{s.cron_expression || `every ${Math.round((s.interval_ms ?? 0) / 1000)}s`}</code>
                  </div>
                  {#if s.next_run_at}
                    <div class="ip-sched-row">
                      <span class="ip-sched-lbl">next</span>
                      <span class="ip-sched-v">{fmtRelTime(s.next_run_at)}</span>
                      <span class="ip-sched-abs">{s.next_run_at.slice(5, 16).replace('T', ' ')}</span>
                    </div>
                  {/if}
                  {#if s.last_run_at}
                    <div class="ip-sched-row">
                      <span class="ip-sched-lbl">last</span>
                      <span class="ip-sched-v">{fmtRelTime(s.last_run_at)}</span>
                    </div>
                  {/if}
                </div>
              {/each}
            </section>
          {/if}

          {#if agentDetail?.triggers && agentDetail.triggers.length}
            <section class="ip-sec">
              <h3 class="ip-sec-h">Event triggers <span class="ip-sec-c">{agentDetail.triggers.length}</span></h3>
              <div class="ip-trig-list">
                {#each agentDetail.triggers as t}
                  <div class="ip-trig">
                    <span class="ip-trig-evt">{t.event_name}</span>
                    {#if t.cooldown_ms && t.cooldown_ms > 0}<span class="ip-trig-cd">cooldown {fmtDuration(t.cooldown_ms)}</span>{/if}
                    <span class="ip-trig-st" class:on={t.active}>{t.active ? 'on' : 'off'}</span>
                  </div>
                {/each}
              </div>
            </section>
          {/if}

          {#if agentDetail?.agent}
            {@const ag = agentDetail.agent}

            {#if ag.goal_template}
              <section class="ip-sec">
                <div class="ip-sec-hrow">
                  <h3 class="ip-sec-h">Default goal</h3>
                  <button class="ip-icon-btn" title="copy" on:click={() => copy(ag.goal_template, 'goal')}>{copiedKey === 'goal' ? '✓ copied' : '⧉ copy'}</button>
                </div>
                <pre class="ip-pre">{ag.goal_template}</pre>
              </section>
            {/if}

            <!-- Runtime — where the loose provider/model chips landed, beside
                 the limits that govern the same loop. -->
            <section class="ip-sec">
              <h3 class="ip-sec-h">Runtime</h3>
              <div class="ip-kv-grid">
                <div class="ip-kv"><span>provider</span><code>{selData.provider || (agentType(selData) === 'claude_code' ? 'claude-code-sdk' : '—')}</code></div>
                <div class="ip-kv"><span>model</span><code>{selData.model || (agentType(selData) === 'claude_code' ? CLAUDE_CODE_DEFAULT_MODEL : '—')}</code></div>
                <div class="ip-kv"><span>max iterations</span><code>{ag.max_iterations ?? '—'}</code></div>
                <div class="ip-kv"><span>token budget</span><code>{fmtTokens(ag.max_tokens)}</code></div>
                <div class="ip-kv"><span>timeout</span><code>{fmtDuration(ag.timeout_ms)}</code></div>
                <div class="ip-kv"><span>max errors</span><code>{ag.max_errors ?? '—'}</code></div>
              </div>
            </section>

            {@const tools = safeParse(ag.allowed_tools) || []}
            {#if Array.isArray(tools) && tools.length}
              <section class="ip-sec">
                <div class="ip-sec-hrow">
                  <button class="ip-sec-h ip-sec-btn" on:click={() => toggleSection('tools')}>
                    <span class="ip-caret" class:open={!collapsed.tools}>▸</span>
                    Allowed tools <span class="ip-sec-c">{tools.length}</span>
                  </button>
                </div>
                {#if !collapsed.tools}
                  <div class="ip-tools">
                    {#each tools as t}
                      <code class="ip-tool">{t}</code>
                    {/each}
                  </div>
                {/if}
              </section>
            {/if}

            {@const vars = safeParse(ag.variables) || {}}
            {#if vars && Object.keys(vars).length}
              <section class="ip-sec">
                <div class="ip-sec-hrow">
                  <button class="ip-sec-h ip-sec-btn" on:click={() => toggleSection('variables')}>
                    <span class="ip-caret" class:open={!collapsed.variables}>▸</span>
                    Variables <span class="ip-sec-c">{Object.keys(vars).length}</span>
                  </button>
                </div>
                {#if !collapsed.variables}
                  <div class="ip-vars">
                    {#each Object.entries(vars) as [k, v]}
                      <div class="ip-var">
                        <span class="ip-var-k">{k}</span>
                        <span class="ip-var-v">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
              </section>
            {/if}

            {#if availableSkins.length > 1}
              <section class="ip-sec">
                <h3 class="ip-sec-h">Appearance</h3>
                <div class="skin-picker">
                  <label class="skin-lbl">skin</label>
                  <select
                    class="skin-sel"
                    disabled={savingSkin}
                    value={selData?.skin_id || ag.skin_id || 'office-worker'}
                    on:change={onSkinChange}
                  >
                    {#each availableSkins as s}
                      <option value={s.manifest.id}>{s.manifest.name}</option>
                    {/each}
                  </select>
                </div>
                {#each availableSkins as s}
                  {#if (selData?.skin_id || ag.skin_id || 'office-worker') === s.manifest.id && s.manifest.description}
                    <p class="skin-desc">{s.manifest.description}</p>
                  {/if}
                {/each}
              </section>
            {/if}
          {/if}

          <!-- ─── Office environment ───
               Office-scoped, not agent-scoped, and this panel is its only entry
               point in the dashboard — so it is never hidden, only folded. It
               opens for agents that can reach a shell or a filesystem, and for
               any office whose container is already up; for a pure LLM agent
               with a dormant environment it stays one quiet line. -->
          {#if selData.flow_id}
            <OfficeInfraPanel
              flowId={selData.flow_id}
              officeName={flows.find((f) => f.id === selData.flow_id)?.name ?? ''}
              color={flowColor(selData.id)}
              startCollapsed={!canUseOfficeEnv}
            />
          {/if}

          {#if detailLoading && !agentDetail}
            <div class="ip-loading">Loading full details…</div>
          {/if}
        </div>
      {/if}

      <!-- ──────────────── LIVE TAB ──────────────── -->
      {#if panelTab === 'live'}
        <div class="ip-body live-body">
          <div class="live-hero">
            <div class="live-hero-head">
              <span class="live-badge"><span class="live-dot-big"></span>LIVE</span>
              <span class="live-hero-name">{selData.name}</span>
            </div>
            {#if liveHeadEvent}
              {@const hType = liveEventType(liveHeadEvent)}
              {@const hCat = liveStepCategory(liveHeadEvent)}
              <div class="live-now live-cat-{hCat}">
                <div class="live-now-icon-wrap">
                  <span class="live-now-icon">{liveStepIcon(hType)}</span>
                  <span class="live-now-halo"></span>
                </div>
                <div class="live-now-body copy-wrap">
                  <CopyTextBtn text={String(liveHeadEvent.data.content_preview ?? '') || liveEventSummary(liveHeadEvent)} title="Copy event content" />
                  <div class="live-now-lbl">{liveStepLabel(hType)}</div>
                  {#if hType === 'tool_call' && liveHeadEvent.data.tool_name}
                    <code class="live-tool">{liveHeadEvent.data.tool_name}</code>
                  {/if}
                  <div class="live-now-summary">{liveStepSummary(liveHeadEvent)}</div>
                </div>
                <div class="live-now-clock">{fmtClock(liveHeadEvent.ts)}</div>
              </div>
            {:else}
              <div class="live-now live-waiting">
                <div class="live-now-icon-wrap">
                  <span class="live-now-icon">✨</span>
                  <span class="live-now-halo"></span>
                </div>
                <div class="live-now-body">
                  <div class="live-now-lbl">warming up</div>
                  <div class="live-now-txt">Agent just started — waiting for the first step…</div>
                </div>
              </div>
            {/if}
          </div>

          <div class="live-timeline-head">
            <span class="live-timeline-h">Activity</span>
            <span class="ip-sec-c">{liveCurrentRunEvents.length}</span>
            {#if liveRunElapsedMs > 0 || liveRunTokensTotal > 0}
              <span class="live-totals">
                {#if liveRunElapsedMs > 0}<span class="live-totals-chip live-totals-time" title="Wall-clock elapsed since the first event in this run">⏱ {liveFmtDelta(liveRunElapsedMs)}</span>{/if}
                {#if liveRunTokensTotal > 0}<span class="live-totals-chip live-totals-tok" title="Cumulative tokens reported by the model so far">◉ {liveFmtTokens(liveRunTokensTotal)} tok</span>{/if}
              </span>
            {/if}
          </div>

          {#if liveCurrentRunEvents.length === 0}
            <div class="ip-empty">No events yet — stay tuned.</div>
          {:else}
            <ol class="live-timeline">
              {#each liveCurrentRunEvents as e, i (e.ts + '-' + i)}
                {@const etype = liveEventType(e)}
                {@const ecat = liveStepCategory(e)}
                {@const stepKey = e.ts + '-' + i}
                {@const isOpen = expandedLiveSteps.has(stepKey)}
                {@const hasDetail = etype === 'tool_call' || etype === 'tool_result' || etype === 'thought' || etype === 'final' || etype === 'error'}
                {@const dt = liveStepDeltaMs(i)}
                {@const stepTok = liveStepTokens(e)}
                {@const cumTok = liveStepTokensTotal(i)}
                <li class="live-step live-step-{etype} live-cat-{ecat}" class:live-step-head={i === 0} class:live-step-open={isOpen}>
                  <span class="live-step-dot"></span>
                  <button
                    type="button"
                    class="live-step-summary"
                    disabled={!hasDetail}
                    on:click={() => hasDetail && toggleLiveStep(stepKey)}
                    title={hasDetail ? (isOpen ? 'Hide details' : 'Show details') : ''}
                  >
                    <span class="live-step-icon">{liveStepIcon(etype)}</span>
                    <span class="live-step-type">{liveStepLabel(etype)}</span>
                    {#if e.data.tool_name}<code class="live-step-tool">{e.data.tool_name}</code>{/if}
                    <span class="live-step-text">{liveStepSummary(e)}</span>
                    <span class="live-step-clock">{fmtClock(e.ts)}</span>
                    {#if hasDetail}
                      <span class="live-step-chev" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                    {/if}
                  </button>
                  {#if etype === 'tool_result'}
                    {@const _cid = emailCommId(e.data.tool_name, String(e.data.content_preview ?? e.data.result ?? ''))}
                    {#if _cid}
                      <button class="email-view-link" on:click|stopPropagation={() => openEmailModal(_cid)} title="Ver el email enviado (de/para/asunto/cuerpo)">📧 Ver email</button>
                    {/if}
                  {/if}
                  {#if dt !== null || stepTok > 0 || cumTok > 0}
                    <div class="live-step-meta">
                      {#if dt !== null && dt > 50}
                        <span class="live-meta-chip live-meta-time" title="Time since the previous event">+{liveFmtDelta(dt)}</span>
                      {/if}
                      {#if stepTok > 0}
                        <span class="live-meta-chip live-meta-tok" title="Tokens reported by the model for this step">◉ {liveFmtTokens(stepTok)} tok</span>
                      {/if}
                      {#if cumTok > 0 && cumTok !== stepTok}
                        <span class="live-meta-chip live-meta-cum" title="Cumulative tokens for this run up to this step">Σ {liveFmtTokens(cumTok)}</span>
                      {/if}
                    </div>
                  {/if}
                  {#if hasDetail && isOpen}
                    <div class="live-step-detail copy-wrap">
                      <CopyTextBtn text={String(e.data.content_preview ?? '') || liveEventSummary(e)} title="Copy event content" />
                      <div class="live-step-txt ip-out-md" on:click={handleOutputClick} role="presentation">
                        {@html formatRunOutput(liveEventSummary(e))}
                      </div>
                    </div>
                  {/if}
                </li>
              {/each}
            </ol>
          {/if}
        </div>
      {/if}

      <!-- ──────────────── HISTORY TAB ──────────────── -->
      {#if panelTab === 'history'}
        <div class="ip-body">
          {#if runsLoading}
            <div class="ip-loading">Loading runs…</div>
          {:else if agentRuns.length === 0}
            <div class="ip-empty">No runs yet. Hit <b>Run now</b> to start one.</div>
          {:else}
            <div class="ip-runs">
              {#each agentRuns as run}
                <div class="ip-run-card" class:expanded={expandedRunId === run.id} class:run-fail={run.status === 'failed'} class:run-ok={run.status === 'completed'} class:run-live={run.status === 'running'}>
                  <button class="ip-run-head" on:click={() => loadRunSteps(run.id)}>
                    <span class="ip-run-status" class:ok={run.status === 'completed'} class:fail={run.status === 'failed'} class:running={run.status === 'running'}>
                      {run.status === 'completed' ? '✓' : run.status === 'failed' ? '✗' : '●'}
                    </span>
                    <span class="ip-run-trigger" style="--c:{triggerColor(run.trigger_type)}">{run.trigger_type}</span>
                    <span class="ip-run-steps">{run.steps_count} steps</span>
                    <span class="ip-run-tokens">{fmtTokens(run.tokens_used)} tok</span>
                    <span class="ip-run-time" title={run.created_at}>{fmtRelTime(run.created_at)}</span>
                    <span class="ip-run-caret" class:open={expandedRunId === run.id}>▾</span>
                  </button>

                  {#if run.error && expandedRunId !== run.id}
                    <div class="ip-run-err-pre">
                      <span class="ip-run-err-lbl">error</span>
                      <span class="ip-run-err-txt">{run.error.slice(0, 160)}{run.error.length > 160 ? '…' : ''}</span>
                    </div>
                  {/if}
                  {#if run.result && expandedRunId !== run.id}
                    <div class="ip-run-prev">{run.result.slice(0, 160)}{run.result.length > 160 ? '…' : ''}</div>
                  {/if}

                  <!-- handled below in expanded state via formatRunOutput -->


                  {#if expandedRunId === run.id}
                    <div class="ip-run-body">
                      <div class="ip-run-meta-row">
                        <span class="ip-run-meta-item">run <code>{run.id.slice(0, 8)}</code>
                          <button class="ip-copy-inline" title="copy run id" on:click={() => copy(run.id, 'run-' + run.id)}>{copiedKey === 'run-' + run.id ? '✓' : '⧉'}</button>
                        </span>
                        <span class="ip-run-meta-item">{new Date(run.created_at).toLocaleString()}</span>
                      </div>

                      {#if run.error}
                        <div class="ip-err-box">
                          <div class="ip-err-head">
                            <span class="ip-err-lbl">⚠ error</span>
                            <button class="ip-icon-btn ip-icon-btn-err" title="copy error" on:click={() => copy(run.error ?? '', 'err-' + run.id)}>{copiedKey === 'err-' + run.id ? '✓ copied' : '⧉ copy'}</button>
                          </div>
                          <pre class="ip-err-txt">{run.error}</pre>
                        </div>
                      {/if}

                      {#if run.result}
                        <div class="ip-out-box">
                          <div class="ip-out-head">
                            <span class="ip-out-lbl">📤 agent output (handoff)</span>
                            <button class="ip-icon-btn" title="copy output" on:click={() => copy(run.result ?? '', 'out-' + run.id)}>{copiedKey === 'out-' + run.id ? '✓ copied' : '⧉ copy'}</button>
                          </div>
                          <div class="ip-out-md" on:click={handleOutputClick} role="presentation">
                            {@html formatRunOutput(run.result)}
                          </div>
                        </div>
                      {/if}

                      {#if runStepsLoading}
                        <div class="ip-loading">Loading steps…</div>
                      {:else if runStepsError}
                        <div class="ip-loading ip-error">
                          ⚠ Failed to load steps: {runStepsError}
                          <button class="ip-retry" on:click={() => { expandedRunId = null; loadRunSteps(run.id); }}>retry</button>
                        </div>
                      {:else if runSteps.length > 0}
                        {@const regularSteps = runSteps.filter(s => !s.is_event)}
                        {@const eventEntries = runSteps.filter(s => s.is_event)}
                        <div class="ip-steps-h">Steps <span class="ip-sec-c">{regularSteps.length}</span>{#if eventEntries.length}<span class="ip-sec-c ip-sec-c-ev">+ {eventEntries.length} events</span>{/if}</div>
                        <ol class="ip-steps">
                          {#each runSteps as step}
                            <li class="ip-step step-{step.type}" class:step-event={step.is_event}>
                              <span class="ip-step-dot"></span>
                              <div class="ip-step-body">
                                <div class="ip-step-head">
                                  <span class="ip-step-num">{step.step_number}</span>
                                  {#if step.is_event}
                                    <span class="ip-step-ev-badge">{step.type === 'auto_eval' ? '📝' : step.type === 'learning_created' ? '💡' : step.type === 'learning_deactivated' ? '🗑️' : '📌'}</span>
                                  {/if}
                                  <span class="ip-step-type">{step.type.replace(/_/g, ' ')}</span>
                                  {#if step.tool_name}<code class="ip-step-tool">{step.tool_name}</code>{/if}
                                  {#if emailCommId(step.tool_name, step.tool_output ?? step.content)}
                                    <button class="email-view-link" on:click|stopPropagation={() => { const id = emailCommId(step.tool_name, step.tool_output ?? step.content); if (id) openEmailModal(id); }} title="Ver el email enviado (de/para/asunto/cuerpo)">📧 Ver email</button>
                                  {/if}
                                  {#if step.content}
                                    <button class="ip-copy-inline" title="copy step content" on:click={() => copy(step.content, 'step-' + run.id + '-' + step.step_number)}>{copiedKey === 'step-' + run.id + '-' + step.step_number ? '✓' : '⧉'}</button>
                                  {/if}
                                </div>
                                {#if step.content}
                                  <div class="ip-step-content ip-out-md" on:click={handleOutputClick} role="presentation">
                                    {@html formatRunOutput(step.content)}
                                  </div>
                                {/if}
                              </div>
                            </li>
                          {/each}
                        </ol>
                      {:else}
                        <div class="ip-loading ip-empty-steps">
                          No steps recorded for this run.
                          {#if run.status === 'failed'}<br/><span class="ip-loading-dim">The run errored before producing any steps.</span>{/if}
                          {#if run.status === 'running'}<br/><span class="ip-loading-dim">Still running — refresh in a moment.</span>{/if}
                        </div>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- ──────────────── TABS CONTRIBUIDOS POR EXTENSIONES ──────────────── -->
      {#each myPanelTabs as tab (tab.id)}
        {#if panelTab === tab.id}
          <div class="ip-body ip-ext-body">
            <svelte:component this={panelTabComponents[tab.id]} />
          </div>
        {/if}
      {/each}

      <!-- ──────────────── CHAT TAB ──────────────── -->
      {#if panelTab === 'chat'}
        <div class="chat-section">
          {#if !chatCanConverse}
            <!-- A builtin agent never sees what you type: the executor calls
                 `handler()` with no arguments and throws the goal away. Rather
                 than offer a field that quietly does something else, say what
                 this agent is and point at the controls that do work. -->
            <div class="chat-noop">
              <div class="chat-noop-glyph" aria-hidden="true">▣</div>
              <h4 class="chat-noop-h">{selData.name} doesn't read messages</h4>
              <p class="chat-noop-p">
                It's a script agent. Anything sent here would be discarded and the script
                would run unchanged — the same thing <b>Run now</b> does.
              </p>
              <div class="chat-noop-kv">
                <span class="chat-noop-lbl">runs</span>
                <code class="ip-code">{selData.builtin_handler}</code>
              </div>
              {#if selData.description}
                <div class="chat-noop-kv">
                  <span class="chat-noop-lbl">does</span>
                  <span class="chat-noop-desc">{selData.description}</span>
                </div>
              {/if}
              <div class="chat-noop-actions">
                <button class="ip-btn ip-btn-primary" on:click={startAgent} disabled={starting}>
                  <span class="ip-btn-ico">{starting ? '●' : '▶'}</span>
                  <span>{starting ? 'starting…' : 'Run now'}</span>
                </button>
                <button class="ip-btn ip-btn-ghost" on:click={() => selectPanelTab('history')}>
                  <span class="ip-btn-ico">◷</span><span>See what it did</span>
                </button>
              </div>
            </div>
          {:else}
            <div class="chat-messages" bind:this={chatScrollEl}>
              {#if chatHistoryLoading && chatHistory.length === 0}
                <div class="ip-loading">Loading the conversation…</div>
              {:else if chatHistory.length === 0}
                <div class="chat-intro">
                  <div class="chat-intro-h">Talk to {selData.name}</div>
                  <p class="chat-intro-p">
                    {#if selData.description}{selData.description} — a{:else}A{/if}sk a question or hand
                    over a one-off task. It answers here using its own tools, and the thread is
                    stored with the agent, so it's still here next time you open this panel.
                  </p>
                </div>
              {:else}
                {#each chatHistory as msg, i (msg.ts + '-' + msg.role + '-' + i)}
                  <div class="chat-msg copy-wrap" class:chat-you={msg.role === 'you'} class:chat-agent={msg.role === 'agent'}>
                    <CopyTextBtn text={msg.text} title="Copy message" />
                    <div class="chat-meta">
                      <span class="chat-role">{msg.role === 'you' ? 'You' : selData.name}</span>
                      <span class="chat-time">{fmtClock(new Date(msg.ts).toISOString())}</span>
                    </div>
                    {#if msg.role === 'agent'}
                      <div class="chat-text ip-out-md" on:click={handleOutputClick} role="presentation">{@html formatRunOutput(msg.text)}</div>
                      {#if isLlmConfigError(msg.text)}
                        <a class="llm-fix" href={LLM_SETTINGS_HREF}>⚙ Configure LLM →</a>
                      {/if}
                    {:else}
                      <span class="chat-text">{msg.text}</span>
                    {/if}
                  </div>
                {/each}
              {/if}

              {#if chatPending}
                <!-- Named work, not a bare spinner: these runs take minutes and
                     an unlabelled dot reads as a hang. -->
                <div class="chat-msg chat-agent chat-typing" aria-live="polite">
                  <div class="chat-meta"><span class="chat-role">{selData.name}</span></div>
                  <div class="chat-typing-row">
                    <span class="chat-typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>
                    <span class="chat-typing-txt">working — running its tools, this can take a few minutes</span>
                  </div>
                </div>
              {/if}
            </div>

            {#if chatError}
              <div class="chat-err" role="alert">
                <span class="chat-err-ico" aria-hidden="true">⚠</span>
                <span>{chatError}</span>
                {#if isLlmConfigError(chatError)}
                  <a class="llm-fix" href={LLM_SETTINGS_HREF}>⚙ Configure LLM →</a>
                {/if}
              </div>
            {/if}

            <ChatComposer
              bind:value={chatInput}
              sending={chatSending}
              placeholder={`Ask ${selData.name} something, or hand over a task…`}
              hint="Enter sends · Shift+Enter for a new line · the thread is saved with the agent"
              suggestions={chatSuggestions}
              sendLabel={`Send to ${selData.name}`}
              on:send={(e) => talkToAgent(e.detail)}
            />
          {/if}
        </div>
      {/if}

      {#if panelTab === 'workspace'}
        <div class="ws-panel">
          {#if selWorkspaceInfo}
            {@const vars = safeParse(selData?.variables) || {}}
            {@const extraDirs = Array.isArray(vars.__additional_directories__)
              ? vars.__additional_directories__
              : (typeof vars.__additional_directories__ === 'string'
                  ? (safeParse(vars.__additional_directories__) || [])
                  : [])}
            {@const sandboxDriver = vars.__sandbox_driver__ || (vars.__container_sandbox__ ? 'docker' : '')}
            <div class="ws-cwd-card">
              <div class="ws-cwd-row">
                <span class="ws-cwd-lbl">cwd</span>
                <code class="ws-cwd-path">{selWorkspaceInfo.cwdLabel}</code>
              </div>
              <div class="ws-cwd-hint">{selWorkspaceInfo.cwdHint}</div>
              {#if workspacePreviewUrl}
                <div class="ws-cwd-row ws-cwd-preview">
                  <span class="ws-cwd-lbl">preview</span>
                  <a class="ws-preview-link" style="color:#4ade80;word-break:break-all;text-decoration:none" href={workspacePreviewUrl} target="_blank" rel="noopener noreferrer">🔗 {workspacePreviewUrl}</a>
                </div>
              {/if}
              {#if extraDirs.length}
                <div class="ws-cwd-row ws-cwd-extra">
                  <span class="ws-cwd-lbl">+dirs</span>
                  <div class="ws-cwd-paths">
                    {#each extraDirs as d}<code class="ws-cwd-path">{d}</code>{/each}
                  </div>
                </div>
              {/if}
              <div class="ws-cwd-row ws-cwd-guard" class:warn={!sandboxDriver}>
                <span class="ws-cwd-lbl">guard</span>
                {#if sandboxDriver}
                  <span class="ws-guard-ok">📦 sandbox: {sandboxDriver} — Bash confinado al sandbox</span>
                {:else}
                  <span class="ws-guard-warn">⚠ no sandbox — Read/Edit/Write/Glob/Grep are scoped to the cwd, but <strong>Bash is unrestricted inside the kernel container</strong></span>
                {/if}
              </div>
            </div>
          {/if}
          {#if workspaceLoading}
            <div class="ws-loading">Loading workspace...</div>
          {:else if !selWorkspaceInfo?.wsId && !selWorkspaceInfo?.cwdPath}
            <div class="ws-empty">This agent uses <code>__cwd_path__</code> (an absolute path). To see it, register it as a workspace or browse via the global Workspace tab.</div>
          {:else if workspaceFileContent}
            <div class="ws-file-view">
              <div class="ws-file-header">
                <button class="ws-back" on:click={() => workspaceFileContent = null}>← Back</button>
                <span class="ws-file-path">{workspaceFileContent.path}</span>
                {#if detectLang(workspaceFileContent.path)}
                  <span class="ws-file-lang">{detectLang(workspaceFileContent.path)}</span>
                {/if}
              </div>
              <div class="copy-wrap">
                <CopyTextBtn text={workspaceFileContent.content} title="Copy file contents" />
                {#if workspaceFileContent.path.endsWith('.md')}
                  <div class="ws-file-md md-body">{@html renderMarkdown(workspaceFileContent.content)}</div>
                {:else}
                  <pre class="ws-file-code"><code>{@html highlightCode(workspaceFileContent.content, detectLang(workspaceFileContent.path))}</code></pre>
                {/if}
              </div>
            </div>
          {:else if visibleWorkspaceFiles.length === 0}
            <div class="ws-empty">No files yet. This agent hasn't created anything in its workspace.</div>
          {:else}
            <div class="ws-toolbar">
              <span class="ws-count">{wsFileCount} {wsFileCount === 1 ? 'file' : 'files'}</span>
              <button class="ws-tb-btn" on:click={() => { wsCollapsed = new Set(wsAllDirs); }} disabled={wsCollapsed.size >= wsAllDirs.length}>⊟ Collapse all</button>
              <button class="ws-tb-btn" on:click={() => { wsCollapsed = new Set(); }} disabled={wsCollapsed.size === 0}>⊞ Expand all</button>
            </div>
            <div class="ws-tree">
              {#each wsRows as r (r.path)}
                {#if r.isDir}
                  <button class="ws-row ws-dir" on:click={() => toggleWsDir(r.path)} title={r.path}>
                    {#each { length: r.depth } as _}<span class="ws-guide"></span>{/each}
                    <span class="ws-chev" class:open={!wsCollapsed.has(r.path)}>▸</span>
                    <span class="ws-icon">{wsCollapsed.has(r.path) ? '📁' : '📂'}</span>
                    <span class="ws-name ws-dirname">{r.name}</span>
                    <span class="ws-badge">{r.fileCount}</span>
                  </button>
                {:else}
                  <button class="ws-row ws-file" on:click={() => loadWorkspaceFile(r.path)} title={r.path}>
                    {#each { length: r.depth } as _}<span class="ws-guide"></span>{/each}
                    <span class="ws-chev-spacer"></span>
                    <span class="ws-icon">{wsFileIcon(r.name)}</span>
                    <span class="ws-name">{r.name}</span>
                    <span class="ws-size">{wsFmtSize(r.size)}</span>
                  </button>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if runningAgentIds.size > 0}
    <div class="hud">
      <div class="hud-t"><span class="hud-p"></span> WORKING</div>
      {#each [...runningAgentIds] as rid}
        {@const a = agents.find(x => x.id === rid)}
        {#if a}<div class="hud-i" on:click={() => { selectedAgent = rid; focusAgent(); }} on:keydown role="button" tabindex="0"><span class="hud-d" style="background:{flowColor(rid)}"></span>{a.name}</div>{/if}
      {/each}
    </div>
  {/if}

  <!-- Draft preview modal -->
  {#if draftModalOpen}
    <div class="modal-overlay" on:click={closeDraftModal} role="button" tabindex="-1" on:keydown={e => e.key === 'Escape' && closeDraftModal()}>
      <div class="modal draft-modal" on:click|stopPropagation role="presentation">
        <div class="draft-modal-head">
          <div>
            <div class="modal-title">
              {#if draftModalData?._type === 'note'}Note
              {:else if draftModalData?._type === 'prospect'}Prospect
              {:else if draftModalData?._type === 'run'}Agent Run
              {:else if draftModalData?._type === 'agent'}Agent
              {:else if draftModalData?._type === 'contact'}Contact
              {:else if draftModalData?._type === 'reminder'}Reminder
              {:else}Draft{/if}
            </div>
            <div class="modal-sub">
              {#if draftModalData?.comm}
                {draftModalData.comm.channel ?? 'email'} · <span class="draft-status">{draftModalData.comm.status}</span>
                {#if draftModalData.comm.id}· <code>{draftModalData.comm.id.slice(0,8)}</code>{/if}
              {:else if draftModalData?._type === 'note'}
                {draftModalData.note.tags || 'note'} · <code>{draftModalData.note.id?.slice(0,8)}</code>
              {:else if draftModalData?._type === 'prospect'}
                {draftModalData.prospect.city || ''} · <code>{draftModalData.prospect.id?.slice(0,8)}</code>
              {:else if draftModalData?._type === 'run'}
                {draftModalData.run.status} · {draftModalData.run.steps_count ?? 0} steps · <code>{draftModalData.run.id?.slice(0,8)}</code>
              {:else if draftModalData?._type === 'agent'}
                {draftModalData.agent.role || 'worker'} · {draftModalData.agent.active ? 'active' : 'inactive'} · <code>{draftModalData.agent.id?.slice(0,8)}</code>
              {:else if draftModalData?._type === 'contact'}
                {draftModalData.contact.relationship || 'contact'} · <code>{draftModalData.contact.id?.slice(0,8)}</code>
              {:else if draftModalData?._type === 'reminder'}
                {draftModalData.reminder.status} · {draftModalData.reminder.repeat} · <code>{draftModalData.reminder.id?.slice(0,8)}</code>
              {:else}Loading…{/if}
            </div>
          </div>
          <button class="draft-modal-close" on:click={closeDraftModal} title="Close">×</button>
        </div>

        {#if draftModalLoading}
          <div class="ip-loading">Loading…</div>
        {:else if draftModalError}
          <div class="modal-error">{draftModalError}</div>

        {:else if draftModalData?.comm}
          {@const c = draftModalData.comm}
          <div class="draft-field">
            <span class="draft-lbl">To</span>
            <span class="draft-val">{c.recipients_to || '—'}</span>
          </div>
          {#if c.recipients_cc}
            <div class="draft-field"><span class="draft-lbl">Cc</span><span class="draft-val">{c.recipients_cc}</span></div>
          {/if}
          {#if c.recipients_bcc}
            <div class="draft-field"><span class="draft-lbl">Bcc</span><span class="draft-val">{c.recipients_bcc}</span></div>
          {/if}
          <div class="draft-field">
            <span class="draft-lbl">Subject</span>
            <span class="draft-val draft-subject">{c.subject || '(no subject)'}</span>
          </div>
          {#if draftModalData.contact}
            <div class="draft-field"><span class="draft-lbl">Contact</span><span class="draft-val">{draftModalData.contact.name} &lt;{draftModalData.contact.email}&gt;</span></div>
          {/if}
          <div class="draft-body copy-wrap">
            <CopyTextBtn text={c.body || c.body_html || ''} title="Copy body" />
            {#if c.body_html}
              <iframe title="draft-body" class="draft-iframe" srcdoc={c.body_html}></iframe>
            {:else}
              <pre class="draft-body-pre">{c.body || '(empty body)'}</pre>
            {/if}
          </div>
          {#if draftModalData.attachments?.length}
            <div class="draft-field">
              <span class="draft-lbl">Files</span>
              <span class="draft-val">{draftModalData.attachments.length} attachment(s)</span>
            </div>
          {/if}

        {:else if draftModalData?._type === 'note'}
          {@const n = draftModalData.note}
          <div class="draft-field"><span class="draft-lbl">Title</span><span class="draft-val draft-subject">{n.title || '(untitled)'}</span></div>
          {#if n.tags}<div class="draft-field"><span class="draft-lbl">Tags</span><span class="draft-val">{n.tags}</span></div>{/if}
          {#if n.created_at}<div class="draft-field"><span class="draft-lbl">Created</span><span class="draft-val">{String(n.created_at).slice(0,16).replace('T',' ')}</span></div>{/if}
          <div class="draft-body copy-wrap">
            <CopyTextBtn text={n.body || n.content || ''} title="Copy note" />
            <div class="draft-body-pre ip-out-md">{@html formatRunOutput(n.body || n.content || '(empty)')}</div>
          </div>

        {:else if draftModalData?._type === 'prospect'}
          {@const p = draftModalData.prospect}
          <div class="draft-field"><span class="draft-lbl">Name</span><span class="draft-val draft-subject">{p.name || p.business_name || '?'}</span></div>
          {#if p.city}<div class="draft-field"><span class="draft-lbl">City</span><span class="draft-val">{p.city}{p.country ? ', ' + p.country : ''}</span></div>{/if}
          {#if p.industry}<div class="draft-field"><span class="draft-lbl">Industry</span><span class="draft-val">{p.industry}</span></div>{/if}
          {#if p.email || p.phone}<div class="draft-field"><span class="draft-lbl">Contact</span><span class="draft-val">{[p.email, p.phone].filter(Boolean).join(' · ')}</span></div>{/if}
          {#if p.website}<div class="draft-field"><span class="draft-lbl">Website</span><span class="draft-val"><a href={p.website} target="_blank" rel="noopener">{p.website}</a></span></div>{/if}
          {#if p.score != null}<div class="draft-field"><span class="draft-lbl">Score</span><span class="draft-val">{p.score}/100</span></div>{/if}
          {#if p.notes}<div class="draft-body copy-wrap"><CopyTextBtn text={p.notes} title="Copy notes" /><pre class="draft-body-pre">{p.notes}</pre></div>{/if}

        {:else if draftModalData?._type === 'run'}
          {@const r = draftModalData.run}
          <div class="draft-field"><span class="draft-lbl">Status</span><span class="draft-val">{r.status}</span></div>
          <div class="draft-field"><span class="draft-lbl">Trigger</span><span class="draft-val">{r.trigger_type}</span></div>
          <div class="draft-field"><span class="draft-lbl">Steps</span><span class="draft-val">{r.steps_count ?? 0}</span></div>
          <div class="draft-field"><span class="draft-lbl">Tokens</span><span class="draft-val">{r.tokens_used ?? 0}</span></div>
          {#if r.created_at}<div class="draft-field"><span class="draft-lbl">Date</span><span class="draft-val">{String(r.created_at).slice(0,16).replace('T',' ')}</span></div>{/if}
          {#if r.result || r.error}
            <div class="draft-body copy-wrap">
              <CopyTextBtn text={r.result || r.error || ''} title="Copy run output" />
              <div class="draft-body-pre ip-out-md">{@html formatRunOutput(r.result || r.error || '')}</div>
            </div>
          {/if}

        {:else if draftModalData?._type === 'agent'}
          {@const a = draftModalData.agent}
          <div class="draft-field"><span class="draft-lbl">Name</span><span class="draft-val draft-subject">{a.name}</span></div>
          {#if a.description}<div class="draft-field"><span class="draft-lbl">Description</span><span class="draft-val">{a.description}</span></div>{/if}
          <div class="draft-field"><span class="draft-lbl">Role</span><span class="draft-val">{a.role || 'worker'}</span></div>
          {#if a.provider || a.model}<div class="draft-field"><span class="draft-lbl">Model</span><span class="draft-val">{[a.provider, a.model].filter(Boolean).join(' / ') || '—'}</span></div>{/if}
          <div class="draft-field"><span class="draft-lbl">Active</span><span class="draft-val">{a.active ? 'yes' : 'no'}</span></div>
          {#if draftModalData.recentRuns?.length}
            <div class="draft-field"><span class="draft-lbl">Recent</span><span class="draft-val">{draftModalData.recentRuns.length} run(s)</span></div>
            <div class="draft-body copy-wrap">
              <CopyTextBtn text={formatAgentRecentRuns(draftModalData.recentRuns)} title="Copy recent runs" />
              <pre class="draft-body-pre">{formatAgentRecentRuns(draftModalData.recentRuns)}</pre>
            </div>
          {/if}

        {:else if draftModalData?._type === 'contact'}
          {@const k = draftModalData.contact}
          <div class="draft-field"><span class="draft-lbl">Name</span><span class="draft-val draft-subject">{k.name || '?'}</span></div>
          {#if k.company}<div class="draft-field"><span class="draft-lbl">Company</span><span class="draft-val">{k.company}</span></div>{/if}
          {#if k.relationship}<div class="draft-field"><span class="draft-lbl">Relationship</span><span class="draft-val">{k.relationship}</span></div>{/if}
          {#if k.email && k.email !== ''}<div class="draft-field"><span class="draft-lbl">Email</span><span class="draft-val">{k.email}</span></div>{/if}
          {#if k.phone && k.phone !== ''}<div class="draft-field"><span class="draft-lbl">Phone</span><span class="draft-val">{k.phone}</span></div>{/if}
          {#if k.notes && k.notes !== ''}<div class="draft-body copy-wrap"><CopyTextBtn text={k.notes} title="Copy notes" /><pre class="draft-body-pre">{k.notes}</pre></div>{/if}

        {:else if draftModalData?._type === 'reminder'}
          {@const rem = draftModalData.reminder}
          <div class="draft-field"><span class="draft-lbl">Title</span><span class="draft-val draft-subject">{rem.title || '(no title)'}</span></div>
          {#if rem.trigger_at}<div class="draft-field"><span class="draft-lbl">Trigger</span><span class="draft-val">{String(rem.trigger_at).slice(0,16).replace('T',' ')}</span></div>{/if}
          <div class="draft-field"><span class="draft-lbl">Status</span><span class="draft-val">{rem.status}</span></div>
          <div class="draft-field"><span class="draft-lbl">Repeat</span><span class="draft-val">{rem.repeat}</span></div>
          {#if rem.snoozed_until}<div class="draft-field"><span class="draft-lbl">Snoozed until</span><span class="draft-val">{String(rem.snoozed_until).slice(0,16).replace('T',' ')}</span></div>{/if}
          {#if rem.last_fired_at}<div class="draft-field"><span class="draft-lbl">Last fired</span><span class="draft-val">{String(rem.last_fired_at).slice(0,16).replace('T',' ')}</span></div>{/if}
          <div class="draft-field"><span class="draft-lbl">Notify</span><span class="draft-val">{[rem.notify_mattermost ? 'Mattermost' : null, rem.notify_telegram ? 'Telegram' : null].filter(Boolean).join(', ') || '—'}</span></div>
          {#if rem.body && rem.body !== ''}
            <div class="draft-body copy-wrap">
              <CopyTextBtn text={rem.body} title="Copy body" />
              <pre class="draft-body-pre">{rem.body}</pre>
            </div>
          {/if}
        {/if}

        <div class="modal-actions">
          {#if draftModalData?.comm?.id}
            <a class="modal-cancel" href={'/comms/edit/' + draftModalData.comm.id} target="_blank" rel="noopener">Open editor →</a>
          {/if}
          <button class="modal-confirm" on:click={closeDraftModal}>Close</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<!-- Sent-email viewer modal (opened from email-send activity rows) -->
{#if emailModalOpen}
  <div class="email-modal-backdrop" on:click={closeEmailModal} role="presentation">
    <div class="email-modal" on:click|stopPropagation role="dialog" aria-modal="true">
      <div class="email-modal-head">
        <span class="email-modal-title">📧 Email enviado</span>
        <button class="email-modal-close" on:click={closeEmailModal} title="Close">×</button>
      </div>
      {#if emailModalLoading}
        <div class="email-modal-body email-modal-dim">Loading email…</div>
      {:else if emailModalError}
        <div class="email-modal-body email-modal-err">⚠ {emailModalError}</div>
      {:else if emailModalData?.comm}
        {@const c = emailModalData.comm}
        {@const acc = emailModalData.account}
        {@const fromAddr = c.direction === 'outbound' ? (acc?.email ?? '—') : (acc?.email ?? '—')}
        <div class="email-modal-meta">
          <div class="emm-row"><span class="emm-k">De</span><span class="emm-v">{acc?.label ? acc.label + ' · ' : ''}{fromAddr}</span></div>
          <div class="emm-row"><span class="emm-k">Para</span><span class="emm-v">{c.recipients_to || '—'}</span></div>
          {#if c.recipients_cc}<div class="emm-row"><span class="emm-k">CC</span><span class="emm-v">{c.recipients_cc}</span></div>{/if}
          <div class="emm-row"><span class="emm-k">Asunto</span><span class="emm-v emm-subj">{c.subject || '(sin asunto)'}</span></div>
          {#if c.sent_at}<div class="emm-row"><span class="emm-k">Enviado</span><span class="emm-v">{fmtClock(c.sent_at)} · {c.status}</span></div>{/if}
        </div>
        <div class="email-modal-body">
          {#if c.body_html}
            <div class="email-modal-html">{@html sanitizeHtml(c.body_html)}</div>
          {:else}
            <div class="email-modal-text">{c.body || '(sin cuerpo)'}</div>
          {/if}
        </div>
      {:else}
        <div class="email-modal-body email-modal-dim">No se encontró el email.</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .world3d-container{position:relative;width:100%;height:100%;overflow:hidden;background:#020206}
  .world3d-canvas{width:100%;height:100%;position:relative}
  .scene-vignette{position:absolute;inset:0;z-index:2;pointer-events:none;
    background:radial-gradient(125% 115% at 50% 42%, transparent 55%, rgba(2,4,10,.42) 100%);
    mix-blend-mode:multiply}
  .fb{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;gap:8px;background:#0d0f18;font:400 12px 'Manrope',sans-serif;color:#8a8fa8}
  .fb-icon{font-size:20px;color:#d4a84b}

  /* ── Boot loader — "HQ tactical uplink" radar console ─────────── */
  .boot{position:absolute;inset:0;z-index:45;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(125% 120% at 50% 38%, #0c1525 0%, #070b16 52%, #04060d 100%);
    overflow:hidden;font-family:'Manrope',-apple-system,sans-serif;will-change:transform,opacity}
  .boot-grid{position:absolute;inset:-2px;opacity:.55;pointer-events:none;
    background-image:linear-gradient(rgba(40,70,130,.55) 1px,transparent 1px),
      linear-gradient(90deg,rgba(40,70,130,.55) 1px,transparent 1px);
    background-size:46px 46px;
    -webkit-mask-image:radial-gradient(circle at 50% 44%, #000 0%, transparent 68%);
    mask-image:radial-gradient(circle at 50% 44%, #000 0%, transparent 68%);
    animation:bootGridDrift 16s linear infinite}
  @keyframes bootGridDrift{to{background-position:46px 46px}}
  .boot-vignette{position:absolute;inset:0;pointer-events:none;
    background:radial-gradient(circle at 50% 42%, transparent 40%, rgba(2,4,10,.55) 100%)}

  .boot-core{position:relative;display:flex;flex-direction:column;align-items:center;gap:30px}

  .boot-radar{position:relative;width:190px;height:190px;border-radius:50%;
    background:radial-gradient(circle, rgba(46,92,168,.20) 0%, rgba(10,20,40,.04) 72%);
    box-shadow:inset 0 0 44px rgba(64,116,210,.22),0 0 0 1px rgba(96,140,220,.40),
      0 0 70px rgba(60,110,200,.14)}
  .boot-ring{position:absolute;border-radius:50%;border:1px solid rgba(96,140,220,.28)}
  .boot-ring-1{inset:24px}.boot-ring-2{inset:55px}.boot-ring-3{inset:86px;border-color:rgba(120,165,240,.5)}
  .boot-cross{position:absolute;background:rgba(96,140,220,.20)}
  .boot-cross-h{left:0;right:0;top:50%;height:1px}
  .boot-cross-v{top:0;bottom:0;left:50%;width:1px}
  .boot-sweep{position:absolute;inset:0;border-radius:50%;
    background:conic-gradient(from 0deg,rgba(130,195,255,.58) 0deg,rgba(130,195,255,.10) 24deg,transparent 58deg,transparent 360deg);
    -webkit-mask:radial-gradient(circle,#000 99%,transparent 100%);
    mask:radial-gradient(circle,#000 99%,transparent 100%);
    animation:bootSweep 2.4s linear infinite}
  @keyframes bootSweep{to{transform:rotate(360deg)}}
  .boot-radar::after{content:'';position:absolute;top:50%;left:50%;width:5px;height:5px;border-radius:50%;
    transform:translate(-50%,-50%);background:#a8caff;box-shadow:0 0 11px 2px rgba(130,195,255,.75)}
  .boot-blip{position:absolute;width:7px;height:7px;border-radius:50%;background:#cfa94e;
    box-shadow:0 0 9px 2px rgba(207,169,78,.65);opacity:0}
  .boot-blip-1{top:33%;left:61%;animation:bootBlip 2.4s linear infinite .35s}
  .boot-blip-2{top:63%;left:39%;animation:bootBlip 2.4s linear infinite 1.05s}
  .boot-blip-3{top:49%;left:71%;animation:bootBlip 2.4s linear infinite 1.75s}
  @keyframes bootBlip{0%{opacity:0;transform:scale(.4)}7%{opacity:1;transform:scale(1)}50%{opacity:0}100%{opacity:0}}

  .boot-info{text-align:center}
  .boot-title{font-weight:800;font-size:27px;letter-spacing:.3px;color:#e4ebf8;
    text-shadow:0 0 22px rgba(109,168,255,.30)}
  .boot-title span{color:#6da8ff}
  .boot-sub{margin-top:5px;font-size:9.5px;font-weight:700;color:#5f7299;letter-spacing:1px}
  .boot-log{list-style:none;margin:22px 0 0;padding:0;display:inline-block;min-width:216px;text-align:left;
    font:500 11px/1.95 ui-monospace,'SFMono-Regular',Menlo,monospace;color:#8298bd}
  .boot-log li{opacity:0;transform:translateX(-7px);display:flex;align-items:center;gap:7px;
    animation:bootLine .42s ease forwards;animation-delay:var(--d)}
  .boot-log li::before{content:'\203A';color:#6da8ff;font-weight:800}
  @keyframes bootLine{to{opacity:1;transform:none}}
  .boot-dots::after{content:'';animation:bootDots 1.5s steps(1,end) infinite}
  @keyframes bootDots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}100%{content:''}}
  /* Live checklist — driven by real boot state (no entrance animation). */
  .boot-log-live li{opacity:1;transform:none;animation:none;color:#6f86ab;transition:color .3s}
  .boot-log-live li::before{content:none}
  .boot-log-live li.done{color:#8fe3b3}
  .boot-check{display:inline-block;width:12px;text-align:center;font-weight:800;color:#6da8ff}
  .boot-log-live li.done .boot-check{color:#33d27e}
  .boot-status{margin-top:12px;font:600 10px/1 ui-monospace,monospace;color:#5f7299;letter-spacing:.5px;min-height:11px}
  .boot-err{margin:20px auto 0;max-width:300px;display:flex;flex-direction:column;align-items:center;gap:10px;
    color:#ffb3b3;font:600 12px/1.5 ui-monospace,monospace}
  .boot-err-icon{font-size:22px;color:#ff6b6b}
  .boot-err-msg{color:#d9a7a7;text-align:center}
  .boot-retry{margin-top:4px;background:#1a1018;border:1px solid #5a2030;color:#ff8a8a;
    padding:5px 16px;border-radius:4px;cursor:pointer;font:700 11px ui-monospace,monospace;letter-spacing:.5px}
  .boot-retry:hover{border-color:#ff6b6b;color:#ffb3b3}

  .boot-bar{margin:24px auto 0;width:236px;height:2px;border-radius:2px;
    background:rgba(96,140,220,.16);overflow:hidden}
  .boot-bar span{display:block;height:100%;width:38%;border-radius:2px;
    background:linear-gradient(90deg,transparent,#6da8ff,#a8caff,transparent);
    animation:bootScan 1.5s ease-in-out infinite}
  @keyframes bootScan{0%{transform:translateX(-130%)}100%{transform:translateX(360%)}}

  @media (prefers-reduced-motion:reduce){
    .boot-sweep,.boot-blip,.boot-bar span,.boot-grid,.boot-dots::after{animation:none}
    .boot-log li{opacity:1;transform:none;animation:none}
  }

  .hq-bar{
    position:absolute;top:12px;left:12px;
    display:flex;align-items:center;gap:0;
    background:rgba(14,16,24,.85);backdrop-filter:blur(12px);
    border:1px solid rgba(74,79,106,.25);border-radius:8px;
    padding:0;z-index:10;overflow:visible;
  }
  .hq-stats{
    display:flex;align-items:center;gap:0;padding:6px 10px;
  }
  .hq-stat{
    font:500 10px 'Manrope',sans-serif;color:#6a6f82;white-space:nowrap;
  }
  .hq-stat b{
    font:700 11px 'Fira Code',monospace;color:#e0e2ea;margin-right:3px;
  }
  .hq-sep{
    width:1px;height:12px;background:rgba(74,79,106,.3);margin:0 8px;
  }
  .hq-menu-trigger{
    display:flex;align-items:center;justify-content:center;
    width:28px;height:100%;padding:6px 0;
    background:transparent;border:none;border-left:1px solid rgba(74,79,106,.2);
    color:#6a6f82;cursor:pointer;transition:color .12s, background .12s;
    border-radius:0 7px 7px 0;
  }
  .hq-menu-trigger:hover{color:#e0e2ea;background:rgba(255,255,255,.04)}
  .hq-dots{font-size:14px;line-height:1}
  .hq-dropdown{
    position:absolute;top:calc(100% + 4px);right:0;
    background:rgba(14,16,24,.95);backdrop-filter:blur(16px);
    border:1px solid rgba(74,79,106,.35);border-radius:8px;
    padding:4px;min-width:220px;
    box-shadow:0 8px 24px rgba(0,0,0,.5);
    animation:hq-drop .12s ease-out;
  }
  @keyframes hq-drop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  .hq-section{
    padding:6px 10px 3px; font:700 9px 'JetBrains Mono',monospace;
    color:#5a5f7a; letter-spacing:1.4px; text-transform:uppercase;
  }
  .hq-divider{
    height:1px; background:rgba(74,79,106,.25); margin:4px 6px;
  }
  .hq-action{
    display:flex;align-items:center;gap:8px;width:100%;
    padding:7px 10px;border:none;border-radius:5px;
    background:transparent;color:#c0c5d8;
    font:500 11px 'Manrope',sans-serif;cursor:pointer;
    transition:background .1s;text-align:left;
  }
  .hq-action:hover{background:rgba(255,255,255,.06)}
  .hq-action-ico{
    width:18px;text-align:center;font-size:13px;color:#8a8fa8;
  }
  .hq-toggle .hq-action-label{ flex:1; }
  .hq-toggle-on{ background:rgba(255,209,102,.10); color:#fff; }
  .hq-toggle-on .hq-action-ico{ color:#ffd166; }
  .hq-toggle-on:hover{ background:rgba(255,209,102,.18); }
  .hq-toggle-disabled{ opacity:.45; cursor:default; }
  .hq-toggle-disabled:hover{ background:transparent; }
  .hq-toggle-state{
    width:14px; text-align:right; color:#ffd166; font-weight:700;
  }
  .hq-toggle-count{
    font:700 9px 'JetBrains Mono',monospace;
    background:rgba(91,141,239,.18); color:#9bb6f0;
    padding:1px 6px; border-radius:8px;
  }
  .hq-live-dot{
    width:7px;height:7px;border-radius:50%;background:#3dd68c;
    box-shadow:0 0 6px #3dd68c;flex-shrink:0;
    animation:hq-pulse 1.2s ease-in-out infinite;
  }
  @keyframes hq-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.75)}}

  .hq-pending-pill{
    display:inline-flex; align-items:center; gap:6px;
    background:rgba(250,204,21,.14); border:1px solid rgba(250,204,21,.4);
    color:#facc15; padding:2px 9px; border-radius:10px;
    font:600 11px 'Manrope',sans-serif;
    cursor:pointer;
  }
  .hq-pending-pill:hover{ background:rgba(250,204,21,.22); }
  .hq-pending-pill b{ color:#facc15; font-weight:700; }
  .hq-pending-dot{
    width:6px; height:6px; border-radius:50%; background:#facc15;
    box-shadow:0 0 6px #facc15;
    animation:hq-pulse 1.6s ease-in-out infinite;
  }

  /* Top-agent "new messages" alert pill — red, glowing, fast pulse so
     it grabs the eye, and one click opens his office Questions tab. */
  .hq-msg-pill{
    display:inline-flex; align-items:center; gap:6px;
    background:rgba(239,93,110,.18); border:1px solid rgba(239,93,110,.55);
    color:#ff8a98; padding:2px 10px; border-radius:10px;
    font:700 11px 'Manrope',sans-serif; cursor:pointer;
    animation:hq-msg-glow 1.4s ease-in-out infinite;
  }
  .hq-msg-pill:hover{ background:rgba(239,93,110,.3); border-color:rgba(239,93,110,.85); }
  .hq-msg-pill b{ color:#ff5d6e; font-weight:800; }
  .hq-msg-ico{ font-size:12px; line-height:1; }
  .hq-msg-dot{
    width:7px; height:7px; border-radius:50%; background:#ff3344;
    box-shadow:0 0 8px #ff3344;
    animation:hq-pulse 1s ease-in-out infinite;
  }
  @keyframes hq-msg-glow{
    0%,100%{ box-shadow:0 0 0 0 rgba(239,93,110,0); }
    50%{ box-shadow:0 0 14px 1px rgba(239,93,110,.5); }
  }

  .hq-pending-dropdown{
    position:absolute; top:46px; right:48px; z-index:30;
    min-width:280px; max-width:380px; max-height:60vh;
    background:rgba(13,15,24,.97);
    border:1px solid rgba(250,204,21,.4);
    border-radius:8px;
    box-shadow:0 16px 40px rgba(0,0,0,.55);
    overflow:hidden; display:flex; flex-direction:column;
  }
  .hq-pending-head{
    padding:8px 12px; border-bottom:1px solid rgba(120,130,160,.18);
    font:700 11px 'Manrope',sans-serif; color:#facc15;
    letter-spacing:.3px; text-transform:uppercase;
  }
  .hq-pending-body{ overflow-y:auto; padding:4px 0; }
  .hq-pending-row{
    display:flex; align-items:center; justify-content:space-between;
    gap:10px; padding:8px 12px;
    border-bottom:1px solid rgba(120,130,160,.08);
  }
  .hq-pending-row:last-child{ border-bottom:none; }
  .hq-pending-info{ display:flex; flex-direction:column; min-width:0; gap:2px; }
  .hq-pending-name{
    font:600 12px 'Manrope',sans-serif; color:#e0e2ea;
    white-space:nowrap; text-overflow:ellipsis; overflow:hidden; max-width:220px;
  }
  .hq-pending-flow{ font:500 10px ui-monospace,monospace; }
  .hq-pending-activate{
    background:#facc15; color:#1a1a1a; border:none;
    padding:4px 12px; border-radius:5px; cursor:pointer;
    font:700 11px 'Manrope',sans-serif;
  }
  .hq-pending-activate:hover:not(:disabled){ filter:brightness(1.08); }
  .hq-pending-activate:disabled{ opacity:.5; cursor:wait; }

  /* ── Agent search (lupa) ─────────────────────────────────────── */
  .hq-search { position:relative; display:inline-flex; align-items:center; }
  .hq-search-btn {
    display:inline-flex; align-items:center; justify-content:center;
    width:24px; height:22px; padding:0;
    background:transparent; border:1px solid transparent;
    border-radius:6px; color:#8a8fa8; cursor:pointer;
    transition: color .12s, background .12s, border-color .12s, transform .15s;
  }
  .hq-search-btn:hover {
    color:#3dd6c8;
    background: rgba(61,214,200,.10);
    border-color: rgba(61,214,200,.30);
    transform: scale(1.12);
  }
  .hq-search-btn svg { display:block; }

  .hq-search-wrap {
    display:inline-flex; align-items:center; gap:6px;
    padding: 2px 4px 2px 8px;
    height:24px;
    background: rgba(61,214,200,.06);
    border: 1px solid rgba(61,214,200,.35);
    border-radius:6px;
    animation: hq-search-grow .14s cubic-bezier(.2,.7,.3,1.1);
    transform-origin: left center;
  }
  @keyframes hq-search-grow {
    from { transform: scaleX(.4); opacity:0; }
    to   { transform: scaleX(1); opacity:1; }
  }
  .hq-search-glyph { color:#3dd6c8; flex:0 0 auto; }
  .hq-search-input {
    width: 200px;
    background: transparent; border:none; outline:none;
    color:#e0e2ea;
    font: 500 12px 'Manrope', sans-serif;
    padding: 0;
  }
  .hq-search-input::placeholder { color:#5a5f7a; }
  .hq-search-x {
    background: transparent; border:none;
    color:#5a5f7a; cursor:pointer;
    width:18px; height:18px;
    border-radius: 50%;
    line-height: 1; font-size: 14px;
    display:inline-flex; align-items:center; justify-content:center;
  }
  .hq-search-x:hover { color:#f04770; background: rgba(240,71,112,.18); }

  .hq-search-results {
    position: absolute;
    top: calc(100% + 6px); left: 0;
    min-width: 280px; max-width: 360px;
    background: rgba(14,16,24,.96); backdrop-filter: blur(16px);
    border: 1px solid rgba(61,214,200,.35);
    border-radius: 8px;
    padding: 4px;
    box-shadow: 0 8px 24px rgba(0,0,0,.55);
    z-index: 30;
    animation: hq-drop .12s ease-out;
    max-height: 320px; overflow-y: auto;
  }
  .hq-search-empty {
    padding: 10px 12px;
    font: 500 11px 'JetBrains Mono', monospace;
    color: #5a5f7a; font-style: italic;
  }
  .hq-search-row {
    width: 100%; text-align: left;
    background: transparent; border: none;
    padding: 7px 10px;
    border-radius: 6px;
    cursor: pointer;
    color: #e0e2ea;
    display: flex; align-items: center; gap: 8px;
    font: 500 12px 'Manrope', sans-serif;
  }
  .hq-search-row:hover { background: rgba(61,214,200,.10); }
  .hq-search-row-dot {
    flex: 0 0 auto;
    width: 8px; height: 8px; border-radius: 50%;
  }
  .hq-search-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hq-search-row-flow {
    flex: 0 0 auto;
    font: 500 10px 'JetBrains Mono', monospace;
    color: #6a6f82;
  }

  /* ═══════════════════════════════════════════════════════════════
     INFO PANEL — editorial/technical console, refined & data-dense
     ═══════════════════════════════════════════════════════════════ */
  .info-panel{
    position:absolute;top:12px;right:12px;bottom:12px;
    width:min(720px, 55vw); min-width:560px;
    overflow:hidden;
    background:linear-gradient(180deg, rgba(16,18,28,.96) 0%, rgba(11,13,20,.97) 100%);
    backdrop-filter:blur(16px) saturate(1.1);
    border:1px solid rgba(120,130,160,.15);
    border-radius:14px;
    box-shadow:0 20px 60px -20px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.02) inset;
    z-index:10;
    animation:slide .25s cubic-bezier(.2,.9,.25,1);
    display:flex;flex-direction:column;
    color:#d8dae3;
    --flow-color:#3dd6c8;
  }
  .info-panel::before{
    content:'';position:absolute;top:0;left:0;bottom:0;width:2px;
    background:linear-gradient(180deg, var(--flow-color) 0%, transparent 70%);
    opacity:.75;pointer-events:none;
  }
  @keyframes slide{from{transform:translateX(20px);opacity:0}}

  /* ── Header ───────────────────── */
  .ip-head{
    display:flex;justify-content:space-between;align-items:flex-start;gap:12px;
    padding:18px 18px 12px;
    border-bottom:1px solid rgba(120,130,160,.08);
    flex-shrink:0;
  }
  .ip-head-left{display:flex;gap:12px;align-items:flex-start;min-width:0;flex:1}
  .ip-glyph{
    width:32px;height:32px;border-radius:8px;
    display:grid;place-items:center;
    font:500 15px 'JetBrains Mono',monospace;
    color:var(--flow-color);
    background:color-mix(in srgb, var(--flow-color) 8%, transparent);
    border:1px solid color-mix(in srgb, var(--flow-color) 30%, transparent);
    flex-shrink:0;
  }
  /* One rhythm for the whole header. The name, the identity row and the tag
     row used ad-hoc 4px/5px margins, so nothing lined up with anything. */
  .ip-head-txt{min-width:0;flex:1;display:flex;flex-direction:column;gap:7px}
  .ip-name{
    font:600 17px/1.1 'Syne',sans-serif;
    color:#f0f2f7;
    letter-spacing:-.01em;
    word-break:break-word;
    display:inline-flex;align-items:center;gap:8px;
  }
  .ip-name-edit-btn{
    border:none;background:transparent;color:#7a7f92;cursor:pointer;
    font-size:13px;padding:2px 4px;border-radius:3px;opacity:0;
    transition:opacity .12s, color .12s, background .12s;
  }
  .ip-name:hover .ip-name-edit-btn{opacity:1}
  .ip-name-edit-btn:hover{color:#ecc968;background:rgba(201,168,76,0.12)}
  .ip-name-edit{display:flex;align-items:center;gap:6px}
  .ip-name-input{
    font:600 17px/1.1 'Syne',sans-serif;color:#f0f2f7;
    background:rgba(10,12,22,0.7);
    border:1px solid rgba(201,168,76,0.4);
    border-radius:3px;padding:3px 8px;min-width:180px;flex:1;outline:none;
  }
  .ip-name-input:focus{border-color:#c9a84c;box-shadow:0 0 0 2px rgba(201,168,76,0.2)}
  .ip-name-btn{
    border:1px solid rgba(255,255,255,0.15);background:rgba(20,24,38,0.8);
    color:#c9d0e0;cursor:pointer;font-size:13px;
    padding:3px 8px;border-radius:3px;line-height:1;
  }
  .ip-name-btn-ok:hover{border-color:#3dd68c;color:#3dd68c;background:rgba(61,214,140,0.1)}
  .ip-name-btn-cancel:hover{border-color:#f04770;color:#f04770;background:rgba(240,71,112,0.1)}
  .ip-name-btn:disabled{opacity:0.5;cursor:wait}
  /* Wraps instead of overflowing: a long flow name plus an id used to push the
     row past the panel edge. */
  .ip-sub{
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;row-gap:7px;
    font:500 10px 'JetBrains Mono',monospace;
    color:#7a7f92;
  }
  .ip-flow{
    color:var(--f, var(--flow-color));
    font-weight:600;text-transform:uppercase;letter-spacing:.6px;
    font-size:10px;line-height:1.5;padding:3px 8px;border-radius:5px;
    background:color-mix(in srgb, var(--f, var(--flow-color)) 10%, transparent);
    border:1px solid color-mix(in srgb, var(--f, var(--flow-color)) 25%, transparent);
  }
  .ip-dot{width:3px;height:3px;border-radius:50%;background:#4a4f66}
  .ip-tags{
    display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  }
  /* Same metrics as .ip-flow so every chip in the header sits on one baseline
     and reads as one family. */
  .ip-tag{
    font:700 10px/1.5 'JetBrains Mono',monospace;letter-spacing:.6px;
    padding:3px 8px;border-radius:5px;text-transform:uppercase;
    border:1px solid transparent;white-space:nowrap;
  }
  .ip-tag-llm{
    color:#6fe4b8;background:rgba(111,228,184,0.1);border-color:rgba(111,228,184,0.35);
  }
  .ip-tag-model{
    color:#c9d0e0;background:rgba(70,90,130,0.18);border-color:rgba(120,140,180,0.25);
    font-weight:500;letter-spacing:0;text-transform:none;
  }
  .ip-tag-script{
    color:#f0a040;background:rgba(240,160,64,0.1);border-color:rgba(240,160,64,0.4);
  }
  .ip-tag-handler{
    color:#b8a060;background:rgba(184,160,96,0.08);border-color:rgba(184,160,96,0.22);
    font-weight:500;letter-spacing:0;text-transform:none;
  }
  .ip-tag-sdk{
    color:#c8a8ff;background:rgba(160,120,240,0.12);border-color:rgba(160,120,240,0.4);
  }
  .ip-tag-fallback{
    color:#8a8fa8;background:rgba(80,90,120,0.12);border-color:rgba(120,130,160,0.22);
    font-weight:500;letter-spacing:0;text-transform:none;
  }
  /* Containers that host a <CopyTextBtn /> overlay. The component positions
     itself absolutely in the top-right corner and fades in on hover. */
  :global(.copy-wrap){position:relative}
  .ip-id{display:inline-flex;align-items:center;gap:4px;color:#8a8fa8}
  .ip-close{
    background:rgba(255,255,255,.03);border:1px solid rgba(120,130,160,.12);
    color:#8a8fa8;
    width:28px;height:28px;
    border-radius:8px;
    font:400 18px/1 'Syne',sans-serif;
    cursor:pointer;transition:all .15s;
    display:grid;place-items:center;
    flex-shrink:0;
  }
  .ip-close:hover{background:rgba(239,93,110,.12);border-color:rgba(239,93,110,.3);color:#ef5d6e}

  /* ── Primary actions ─────────── */
  .ip-actions{
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;
    padding:12px 18px;
    border-bottom:1px solid rgba(120,130,160,.08);
    flex-shrink:0;
  }
  .ip-btn{
    display:inline-flex;align-items:center;gap:6px;
    padding:8px 14px;border-radius:8px;
    font:600 11px 'Syne',sans-serif;letter-spacing:.4px;
    cursor:pointer;transition:all .15s;
    border:1px solid transparent;
  }
  .ip-btn-ico{font:500 11px 'JetBrains Mono',monospace}
  .ip-btn-primary{
    background:#78dc8c;color:#0a0e14;border-color:#78dc8c;
    box-shadow:0 6px 16px -8px rgba(120,220,140,.5);
  }
  .ip-btn-primary:hover:not(:disabled){background:#8ee4a0;border-color:#8ee4a0}
  .ip-btn-primary:disabled{opacity:.5;cursor:wait;background:rgba(120,220,140,.3);border-color:rgba(120,220,140,.2)}
  .ip-btn-ghost{
    background:rgba(255,255,255,.03);
    border-color:rgba(120,130,160,.2);
    color:#d8dae3;
  }
  .ip-btn-ghost:hover{background:rgba(255,255,255,.06);border-color:rgba(120,130,160,.35)}
  .ip-btn-warn{
    background:rgba(251,191,36,.08);
    border-color:rgba(251,191,36,.35);
    color:#fbbf24;
  }
  .ip-btn-warn:hover:not(:disabled){background:rgba(251,191,36,.18);border-color:rgba(251,191,36,.55)}
  .ip-btn-warn:disabled{opacity:.5;cursor:wait}
  .ip-btn-resume{
    background:rgba(120,220,140,.08);
    border-color:rgba(120,220,140,.35);
    color:#78dc8c;
  }
  .ip-btn-resume:hover:not(:disabled){background:rgba(120,220,140,.18);border-color:rgba(120,220,140,.55)}
  .ip-btn-resume:disabled{opacity:.5;cursor:wait}
  /* REVISION resolution buttons — only shown when agent.under_revision = 1.
   * Green accept (mirror of ip-btn-resume), orange reject (matches the REVISION
   * pill that lives over the agent's head in the 3D office). */
  .ip-btn-accept{
    background:rgba(120,220,140,.08);
    border-color:rgba(120,220,140,.35);
    color:#78dc8c;
  }
  .ip-btn-accept:hover:not(:disabled){background:rgba(120,220,140,.18);border-color:rgba(120,220,140,.55)}
  .ip-btn-accept:disabled{opacity:.5;cursor:wait}
  .ip-btn-reject{
    background:rgba(251,146,60,.08);
    border-color:rgba(251,146,60,.4);
    color:#fb923c;
  }
  .ip-btn-reject:hover:not(:disabled){background:rgba(251,146,60,.2);border-color:rgba(251,146,60,.6)}
  .ip-btn-reject:disabled{opacity:.5;cursor:wait}
  .ip-start-msg{
    font:500 10px 'JetBrains Mono',monospace;
    color:#8a8fa8;margin-left:4px;
  }
  .ip-start-msg.ok{color:#78dc8c}
  .ip-start-msg.err{color:#ef5d6e}
  .ip-start-msg.pause{color:#fbbf24}

  /* ── Tabs ─────────────────────── */
  .ip-tabs{
    display:flex;gap:2px;
    padding:0 18px;
    border-bottom:1px solid rgba(120,130,160,.08);
    flex-shrink:0;
  }
  .ip-tab{
    position:relative;
    padding:12px 16px;
    font:600 10px 'Syne',sans-serif;letter-spacing:1px;text-transform:uppercase;
    background:none;border:none;
    color:#6a6f82;cursor:pointer;transition:color .15s;
    display:inline-flex;align-items:center;gap:6px;
  }
  .ip-tab:hover{color:#b0b5c8}
  .ip-tab.active{color:#f0f2f7}
  .ip-tab.active::after{
    content:'';position:absolute;bottom:-1px;left:12px;right:12px;height:2px;
    background:var(--flow-color);border-radius:2px 2px 0 0;
  }
  .ip-tab-count{
    font:600 9px 'JetBrains Mono',monospace;
    padding:1px 5px;border-radius:6px;
    background:rgba(120,130,160,.15);color:#a0a5b8;
  }

  /* ── Body (scrollable) ────────── */
  .ip-body{
    flex:1;overflow-y:auto;overflow-x:hidden;
    padding:16px 18px 24px;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  .ip-body::-webkit-scrollbar{width:6px}
  .ip-body::-webkit-scrollbar-thumb{background:rgba(120,130,160,.2);border-radius:3px}
  .ip-body::-webkit-scrollbar-thumb:hover{background:rgba(120,130,160,.35)}

  /* ── Run state ─────────────────
     Leads the action row and is separated from the buttons by a rule, so it
     reads as the state those buttons act on rather than a fourth control.
     Same 8px/14px box as .ip-btn so both sit on one baseline. */
  .ip-state{
    display:inline-flex;align-items:center;gap:6px;
    padding:8px 12px 8px 0;margin-right:4px;
    border-right:1px solid rgba(120,130,160,.15);
    font:600 10px 'JetBrains Mono',monospace;
    text-transform:lowercase;letter-spacing:.4px;
  }
  .ip-state-on{color:#78dc8c}
  .ip-state-off{color:#fbbf24}
  .ip-state .led{
    width:6px;height:6px;border-radius:50%;
    background:#fbbf24;
  }
  .ip-state .led.on{
    background:#78dc8c;box-shadow:0 0 6px #78dc8c;
    animation:led-pulse 2s ease-in-out infinite;
  }
  @keyframes led-pulse{50%{opacity:.55}}

  /* ── Mandate ───────────────────
     The block that opens Overview: the role the agent was given and the prompt
     that spells it out. The role is the lead line of the card it belongs to,
     not a loose paragraph under the tabs. */
  .ip-mandate{
    padding-left:12px;
    border-left:2px solid color-mix(in srgb, var(--flow-color) 55%, transparent);
  }
  .ip-mandate .ip-role{
    font:500 13px/1.5 'Manrope',sans-serif;
    color:#dfe2ec;margin:0 0 8px;
  }
  .ip-mandate-alt{
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;
    padding:10px 12px;border-radius:8px;
    background:rgba(120,130,160,.05);
    border:1px dashed rgba(120,130,160,.18);
    font:400 11px 'Manrope',sans-serif;color:#8a8fa8;
  }

  /* ── KPI grid ────────────────── */
  .ip-kpis{
    display:grid;grid-template-columns:repeat(4,1fr);gap:1px;
    background:rgba(120,130,160,.1);border:1px solid rgba(120,130,160,.12);
    border-radius:10px;overflow:hidden;
    margin-bottom:18px;
  }
  .ip-kpi{
    padding:12px 8px;background:#0f1219;
    display:flex;flex-direction:column;align-items:center;gap:4px;
  }
  .ip-kpi-v{
    font:600 22px/1 'Syne',sans-serif;color:#f0f2f7;
    font-variant-numeric:tabular-nums;
  }
  .ip-kpi-unit{font-size:13px;color:#8a8fa8;font-weight:500;margin-left:1px}
  .ip-kpi-l{
    font:500 9px 'JetBrains Mono',monospace;
    color:#6a6f82;text-transform:uppercase;letter-spacing:.5px;
  }

  /* ── Sections ────────────────── */
  .ip-sec{margin-bottom:18px}
  .ip-sec-h, .ip-sec-btn{
    font:600 10px 'Syne',sans-serif;
    color:#8a8fa8;text-transform:uppercase;letter-spacing:1.5px;
    margin:0 0 8px;display:inline-flex;align-items:center;gap:6px;
  }
  .ip-sec-btn{
    background:none;border:none;cursor:pointer;padding:0;
    color:#8a8fa8;font:inherit;letter-spacing:inherit;
  }
  .ip-sec-btn:hover{color:#d8dae3}
  .ip-sec-hrow{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .ip-sec-hrow .ip-sec-h{margin-bottom:0}
  .ip-sec-c{
    font:600 9px 'JetBrains Mono',monospace;
    padding:1px 6px;border-radius:4px;
    background:rgba(120,130,160,.15);color:#a0a5b8;
    letter-spacing:0;text-transform:none;
  }
  /* Skin picker — Appearance section dropdown */
  .skin-picker{display:flex;align-items:center;gap:10px}
  .skin-lbl{
    font:700 10px 'JetBrains Mono',monospace;letter-spacing:1.5px;
    color:#8a8fa8;text-transform:uppercase;min-width:38px;
  }
  .skin-sel{
    flex:1;background:rgba(20,24,38,.85);color:#dde0ea;
    border:1px solid rgba(120,130,160,.3);border-radius:6px;
    padding:6px 10px;font:600 12px 'Manrope',sans-serif;
    cursor:pointer;outline:none;
  }
  .skin-sel:hover{border-color:rgba(120,130,160,.55)}
  .skin-sel:focus{border-color:rgba(120,170,255,.6);box-shadow:0 0 0 2px rgba(120,170,255,.12)}
  .skin-sel:disabled{opacity:.5;cursor:not-allowed}
  .skin-desc{
    margin:6px 0 0;font:400 11px/1.4 'Manrope',sans-serif;color:#8a8fa8;
  }
  .ip-caret{
    display:inline-block;font:400 9px monospace;
    transition:transform .2s;color:#6a6f82;
  }
  .ip-caret.open{transform:rotate(90deg)}

  /* ── Chains (connections) ────── */
  .ip-chain-list{display:flex;flex-direction:column;gap:4px}
  .ip-chain{
    display:grid;grid-template-columns:48px 1fr auto;gap:10px;
    padding:8px 10px;border-radius:6px;
    background:rgba(120,130,160,.04);
    border:1px solid rgba(120,130,160,.08);
    align-items:center;
  }
  .ip-chain.out{border-left:2px solid var(--flow-color)}
  .ip-chain:not(.out){border-left:2px solid #a78bfa}
  .ip-chain-dir{font:600 9px 'JetBrains Mono',monospace;color:#6a6f82}
  .ip-chain.out .ip-chain-dir{color:var(--flow-color)}
  .ip-chain:not(.out) .ip-chain-dir{color:#a78bfa}
  .ip-chain-name{font:500 12px 'Manrope',sans-serif;color:#d8dae3}
  .ip-chain-label{
    font:500 9px 'JetBrains Mono',monospace;color:#8a8fa8;
    padding:2px 6px;border-radius:4px;background:rgba(120,130,160,.1);
  }

  .ip-chain-adhoc{border-left-style:dashed !important;opacity:.85}
  .ip-chain-adhoc.out{border-left-color:#f59e0b !important}
  .ip-chain-adhoc:not(.out){border-left-color:#f59e0b !important}
  .ip-chain-dir-adhoc{color:#f59e0b !important;font-style:italic}

  /* ── Schedule ────────────────── */
  .ip-sched{
    padding:10px 12px;border-radius:8px;
    background:rgba(251,191,36,.04);
    border:1px solid rgba(251,191,36,.15);
    border-left:3px solid #fbbf24;
  }
  .ip-sched-row{display:flex;align-items:baseline;gap:10px;padding:3px 0}
  .ip-sched-lbl{font:600 9px 'JetBrains Mono',monospace;color:#fbbf24;text-transform:uppercase;letter-spacing:.5px;min-width:38px}
  .ip-sched-v{font:500 12px 'Manrope',sans-serif;color:#d8dae3}
  .ip-sched-abs{font:500 10px 'JetBrains Mono',monospace;color:#6a6f82;margin-left:auto}
  .ip-code{
    font:500 11px 'JetBrains Mono',monospace;
    background:rgba(0,0,0,.3);color:#d8dae3;
    padding:2px 7px;border-radius:4px;
    border:1px solid rgba(120,130,160,.12);
  }

  /* ── Triggers ────────────────── */
  .ip-trig-list{display:flex;flex-direction:column;gap:4px}
  .ip-trig{
    display:flex;align-items:center;gap:10px;
    padding:7px 10px;border-radius:6px;
    background:rgba(244,114,182,.04);
    border:1px solid rgba(244,114,182,.12);
    border-left:2px solid #f472b6;
  }
  .ip-trig-evt{font:500 11px 'JetBrains Mono',monospace;color:#f0f2f7;flex:1}
  .ip-trig-cd{font:500 9px 'JetBrains Mono',monospace;color:#6a6f82}
  .ip-trig-st{font:600 9px 'JetBrains Mono',monospace;color:#6a6f82;text-transform:uppercase}
  .ip-trig-st.on{color:#78dc8c}

  /* ── KV grid (limits etc) ────── */
  .ip-kv-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  .ip-kv{
    display:flex;justify-content:space-between;align-items:center;gap:10px;
    padding:8px 12px;border-radius:6px;
    background:rgba(120,130,160,.04);
    border:1px solid rgba(120,130,160,.08);
  }
  .ip-kv span{font:500 10px 'Manrope',sans-serif;color:#8a8fa8;flex-shrink:0}
  /* A model id is long enough to squash the label out of a two-up grid. */
  .ip-kv code{
    font:600 11px 'JetBrains Mono',monospace;color:#f0f2f7;
    min-width:0;text-align:right;overflow-wrap:anywhere;
  }

  /* ── Pre blocks ─────────────── */
  .ip-pre{
    margin:0;padding:12px;border-radius:8px;
    background:rgba(0,0,0,.3);
    border:1px solid rgba(120,130,160,.1);
    font:400 11px/1.55 'JetBrains Mono',monospace;
    color:#d8dae3;white-space:pre-wrap;word-break:break-word;
  }
  .ip-pre-scroll{max-height:260px;overflow-y:auto}

  /* ── Icon buttons ─────────── */
  .ip-icon-btn{
    background:rgba(120,130,160,.08);
    border:1px solid rgba(120,130,160,.15);
    color:#a0a5b8;
    padding:4px 8px;border-radius:5px;
    font:500 9px 'JetBrains Mono',monospace;letter-spacing:.3px;
    cursor:pointer;transition:all .12s;
    display:inline-flex;align-items:center;gap:4px;
    white-space:nowrap;
  }
  .ip-icon-btn:hover{background:rgba(120,130,160,.16);color:#f0f2f7}
  .ip-icon-btn-err{color:#ef5d6e;background:rgba(239,93,110,.08);border-color:rgba(239,93,110,.2)}
  .ip-icon-btn-err:hover{background:rgba(239,93,110,.18);color:#ff7280}
  .ip-copy-inline{
    background:transparent;border:none;
    color:#6a6f82;cursor:pointer;
    font:400 11px monospace;line-height:1;padding:1px 4px;border-radius:3px;
    transition:color .12s;margin-left:4px;
  }
  .ip-copy-inline:hover{color:#d8dae3;background:rgba(120,130,160,.1)}

  /* ── Tool chips ─────────────── */
  .ip-tools{display:flex;flex-wrap:wrap;gap:4px}
  .ip-tool{
    font:500 10px 'JetBrains Mono',monospace;
    color:#b0b5c8;
    padding:3px 8px;border-radius:4px;
    background:rgba(120,130,160,.06);
    border:1px solid rgba(120,130,160,.12);
  }

  /* ── Variables ────────────────── */
  .ip-vars{display:flex;flex-direction:column;gap:4px}
  .ip-var{
    display:grid;grid-template-columns:140px 1fr;gap:12px;
    padding:7px 10px;border-radius:6px;
    background:rgba(120,130,160,.04);
    border:1px solid rgba(120,130,160,.08);
    align-items:start;
  }
  .ip-var-k{font:500 10px 'JetBrains Mono',monospace;color:#8a8fa8}
  .ip-var-v{font:500 11px 'Manrope',sans-serif;color:#d8dae3;word-break:break-word;line-height:1.45}

  .hud{position:absolute;bottom:12px;left:12px;background:rgba(14,16,24,.9);backdrop-filter:blur(12px);border:1px solid rgba(16,185,129,.2);border-radius:10px;padding:10px 14px;z-index:10}
  .hud-t{display:flex;align-items:center;gap:6px;font:700 8px 'Syne',sans-serif;color:var(--green,#3dd68c);letter-spacing:1.5px;margin-bottom:6px}
  .hud-p{width:6px;height:6px;border-radius:50%;background:var(--green,#3dd68c);animation:p 1.5s ease-in-out infinite}
  @keyframes p{0%,100%{opacity:1;box-shadow:0 0 4px var(--green)}50%{opacity:.5;box-shadow:0 0 8px var(--green)}}
  .hud-i{display:flex;align-items:center;gap:6px;font:500 10px 'Manrope',sans-serif;color:var(--text-2);padding:3px 0;cursor:pointer;transition:color .15s}
  .hud-i:hover{color:var(--text-1)}
  .hud-d{width:6px;height:6px;border-radius:50%;flex-shrink:0}

  /* ═══════════════════════════════════════════════════════════════
     HISTORY TAB — run cards with expandable timeline
     ═══════════════════════════════════════════════════════════════ */
  .ip-runs{display:flex;flex-direction:column;gap:8px}
  .ip-run-card{
    border-radius:10px;
    background:linear-gradient(180deg, rgba(255,255,255,.02) 0%, rgba(255,255,255,0) 100%);
    border:1px solid rgba(120,130,160,.14);
    overflow:hidden;
    transition:border-color .15s;
  }
  .ip-run-card:hover{border-color:rgba(120,130,160,.25)}
  .ip-run-card.expanded{border-color:rgba(61,214,200,.35);background:rgba(61,214,200,.02)}
  .ip-run-card.run-fail{border-left:3px solid #ef5d6e}
  .ip-run-card.run-ok{border-left:3px solid #78dc8c}
  .ip-run-card.run-live{border-left:3px solid #6aa0ff}

  .ip-run-head{
    display:grid;
    grid-template-columns:18px auto auto auto 1fr auto;
    align-items:center;gap:10px;
    padding:10px 12px;
    background:none;border:none;
    color:#b0b5c8;
    cursor:pointer;text-align:left;
    font-family:inherit;width:100%;
    transition:background .1s;
  }
  .ip-run-head:hover{background:rgba(255,255,255,.02)}
  .ip-run-status{font:700 12px 'JetBrains Mono',monospace;width:16px;text-align:center}
  .ip-run-status.ok{color:#78dc8c}
  .ip-run-status.fail{color:#ef5d6e}
  .ip-run-status.running{color:#6aa0ff;animation:led-pulse 1s ease-in-out infinite}
  .ip-run-trigger{
    font:600 9px 'JetBrains Mono',monospace;
    color:var(--c,#8a8fa8);
    background:color-mix(in srgb, var(--c,#8a8fa8) 12%, transparent);
    border:1px solid color-mix(in srgb, var(--c,#8a8fa8) 25%, transparent);
    padding:2px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:.5px;
  }
  .ip-run-steps{font:500 10px 'JetBrains Mono',monospace;color:#a0a5b8}
  .ip-run-tokens{font:500 10px 'JetBrains Mono',monospace;color:#8a8fa8}
  .ip-run-time{
    font:500 10px 'Manrope',sans-serif;color:#6a6f82;
    text-align:right;
  }
  .ip-run-caret{
    color:#6a6f82;transition:transform .2s;font-size:11px;
  }
  .ip-run-caret.open{transform:rotate(180deg);color:var(--flow-color)}

  .ip-run-err-pre{
    display:flex;gap:8px;align-items:baseline;
    padding:0 12px 10px;
    font:500 11px 'Manrope',sans-serif;
  }
  .ip-run-err-lbl{
    font:600 9px 'JetBrains Mono',monospace;
    color:#ef5d6e;text-transform:uppercase;letter-spacing:.5px;
    padding:2px 6px;border-radius:4px;
    background:rgba(239,93,110,.12);
  }
  .ip-run-err-txt{color:#ef8090;word-break:break-word;line-height:1.4;flex:1}
  .ip-run-prev{
    padding:0 12px 12px;
    font:400 12px/1.5 'Manrope',sans-serif;
    color:#8a8fa8;word-break:break-word;
  }

  .ip-run-body{
    padding:12px;
    border-top:1px solid rgba(120,130,160,.1);
    background:rgba(0,0,0,.15);
  }
  .ip-run-meta-row{
    display:flex;gap:12px;flex-wrap:wrap;align-items:center;
    padding-bottom:10px;margin-bottom:12px;
    border-bottom:1px dashed rgba(120,130,160,.12);
  }
  .ip-run-meta-item{
    font:500 10px 'JetBrains Mono',monospace;color:#8a8fa8;
    display:inline-flex;align-items:center;gap:4px;
  }
  .ip-run-meta-item code{color:#d8dae3;background:rgba(0,0,0,.3);padding:1px 6px;border-radius:3px}

  /* Error + output blocks */
  .ip-err-box{
    border:1px solid rgba(239,93,110,.3);
    background:rgba(239,93,110,.06);
    border-radius:8px;
    margin-bottom:12px;
    overflow:hidden;
  }
  .ip-err-head{
    display:flex;justify-content:space-between;align-items:center;
    padding:8px 12px;
    background:rgba(239,93,110,.1);
    border-bottom:1px solid rgba(239,93,110,.15);
  }
  .ip-err-lbl{font:600 10px 'JetBrains Mono',monospace;color:#ef5d6e;text-transform:uppercase;letter-spacing:.5px}
  .ip-err-txt{
    margin:0;padding:12px;
    font:400 11px/1.55 'JetBrains Mono',monospace;
    color:#ff9ba8;white-space:pre-wrap;word-break:break-word;
    max-height:240px;overflow-y:auto;
  }

  .ip-out-box{
    border:1px solid rgba(61,214,200,.25);
    background:rgba(61,214,200,.04);
    border-radius:8px;
    margin-bottom:12px;
    overflow:hidden;
  }
  .ip-out-head{
    display:flex;justify-content:space-between;align-items:center;
    padding:8px 12px;
    background:rgba(61,214,200,.08);
    border-bottom:1px solid rgba(61,214,200,.15);
  }
  .ip-out-lbl{font:600 10px 'Syne',sans-serif;color:#3dd6c8;text-transform:uppercase;letter-spacing:.8px}
  .ip-out-txt{
    margin:0;padding:12px;
    font:400 11px/1.55 'JetBrains Mono',monospace;
    color:#d8dae3;white-space:pre-wrap;word-break:break-word;
    max-height:280px;overflow-y:auto;
  }

  /* Steps timeline */
  .ip-steps-h{
    font:600 10px 'Syne',sans-serif;color:#8a8fa8;
    text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;
    display:inline-flex;align-items:center;gap:6px;
  }
  .ip-steps{
    list-style:none;margin:0;padding:0;
    display:flex;flex-direction:column;gap:2px;
    position:relative;padding-left:22px;
  }
  .ip-steps::before{
    content:'';position:absolute;left:7px;top:8px;bottom:8px;width:1px;
    background:linear-gradient(180deg, rgba(120,130,160,.3) 0%, rgba(120,130,160,.05) 100%);
  }
  .ip-step{
    position:relative;padding:6px 10px;border-radius:6px;
    transition:background .1s;
  }
  .ip-step:hover{background:rgba(255,255,255,.02)}
  .ip-step-dot{
    position:absolute;left:-18px;top:11px;
    width:9px;height:9px;border-radius:50%;
    background:#3a3f52;border:2px solid #0b0d14;
  }
  .step-tool_call .ip-step-dot{background:#fbbf24}
  .step-tool_result .ip-step-dot{background:#6aa0ff}
  .step-thought .ip-step-dot{background:#8a8fa8}
  .step-final .ip-step-dot{background:#78dc8c;box-shadow:0 0 8px rgba(120,220,140,.5)}
  .step-error .ip-step-dot{background:#ef5d6e}
  .step-auto_eval .ip-step-dot{background:#f59e0b;box-shadow:0 0 8px rgba(245,158,11,.5)}
  .step-learning_created .ip-step-dot{background:#d4a84b;box-shadow:0 0 8px rgba(212,168,75,.5)}
  .step-learning_deactivated .ip-step-dot{background:#8a8fa8}
  .step-chain_triggered .ip-step-dot{background:#a78bfa}

  .ip-step-head{display:flex;align-items:center;gap:8px;font:500 10px 'JetBrains Mono',monospace;flex-wrap:wrap}
  .ip-step-num{color:#6a6f82;min-width:18px}
  .ip-step-ev-badge{font-size:13px;line-height:1}
  .ip-step-type{
    color:#a0a5b8;text-transform:uppercase;letter-spacing:.5px;font-size:9px;font-weight:600;
    padding:1px 6px;border-radius:3px;background:rgba(120,130,160,.1);
  }
  .step-tool_call .ip-step-type{color:#fbbf24;background:rgba(251,191,36,.1)}
  .step-tool_result .ip-step-type{color:#6aa0ff;background:rgba(106,160,255,.1)}
  .step-final .ip-step-type{color:#78dc8c;background:rgba(120,220,140,.1)}
  .step-error .ip-step-type{color:#ef5d6e;background:rgba(239,93,110,.1)}
  .step-auto_eval .ip-step-type{color:#f59e0b;background:rgba(245,158,11,.12)}
  .step-learning_created .ip-step-type{color:#d4a84b;background:rgba(212,168,75,.12)}
  .step-learning_deactivated .ip-step-type{color:#8a8fa8;background:rgba(120,130,160,.1)}
  .step-event{border-left:2px solid rgba(212,168,75,.4);margin-left:-2px}
  .step-event .ip-step-content{background:rgba(212,168,75,.06);border:1px solid rgba(212,168,75,.12)}
  .ip-sec-c-ev{color:#d4a84b;margin-left:6px}
  .ip-step-tool{color:#d8dae3;font-weight:500;word-break:break-all}
  .ip-step-content{
    margin-top:4px;padding:6px 8px;border-radius:4px;
    background:rgba(0,0,0,.2);
    font:400 10px/1.5 'JetBrains Mono',monospace;
    color:#b0b5c8;word-break:break-word;white-space:pre-wrap;
  }

  /* Misc */
  .ip-loading,.ip-empty{
    font:500 11px 'Manrope',sans-serif;color:#6a6f82;
    text-align:center;padding:24px 12px;
  }
  .ip-empty b{color:#d8dae3;font-weight:600}
  .ip-error{color:#f47070;display:flex;flex-direction:column;gap:8px;align-items:center}
  .ip-empty-steps{color:#8a8f9e}
  .ip-loading-dim{color:#5a5f70;font-size:10px}
  .ip-retry{
    background:transparent;border:1px solid #5a5f70;color:#aab0c0;
    font:500 10px 'Manrope',sans-serif;padding:3px 10px;border-radius:3px;cursor:pointer;
  }
  .ip-retry:hover{border-color:#aab0c0;color:#fff}

  /* ── Chat with agent ─────────── */
  /* ═══════════════════════════════════════════════════════════════
     CHAT — message input + conversation thread
     ═══════════════════════════════════════════════════════════════ */
  .chat-section{
    flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;
    padding:16px 18px;
  }
  .chat-messages{
    flex:1;overflow-y:auto;margin-bottom:12px;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
    display:flex;flex-direction:column;gap:10px;
  }
  .chat-msg{
    padding:10px 12px;border-radius:10px;
    font:400 13px/1.5 'Manrope',sans-serif;
    max-width:90%;
    word-break:break-word;
  }
  .chat-you{
    align-self:flex-end;
    background:color-mix(in srgb, var(--flow-color) 14%, transparent);
    border:1px solid color-mix(in srgb, var(--flow-color) 28%, transparent);
  }
  .chat-agent{
    align-self:flex-start;
    background:rgba(120,130,160,.06);
    border:1px solid rgba(120,130,160,.15);
  }
  /* Author and clock on one line — a reply that lands minutes after you asked
     needs a timestamp to be readable as a conversation. */
  .chat-meta{display:flex;align-items:baseline;gap:8px;margin-bottom:4px}
  .chat-role{
    font:600 9px 'JetBrains Mono',monospace;
    text-transform:uppercase;letter-spacing:.5px;
  }
  .chat-time{font:400 9px 'JetBrains Mono',monospace;color:#6a6f82;font-variant-numeric:tabular-nums}
  .chat-you .chat-role{color:var(--flow-color)}
  .chat-agent .chat-role{color:#a78bfa}
  .chat-text{color:#e0e2ea}
  .chat-agent .chat-text{max-height:300px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.2) transparent}

  /* ── Empty thread ──
     Says who you are about to talk to and what happens to the thread, instead
     of a one-liner floating over 500px of nothing. */
  .chat-intro{margin:auto 0;padding:4px 2px;max-width:46ch}
  .chat-intro-h{font:600 14px 'Syne',sans-serif;color:#e0e2ea;margin-bottom:6px}
  .chat-intro-p{font:400 12px/1.6 'Manrope',sans-serif;color:#8a8fa8;margin:0}

  /* ── Working ────────────────── */
  .chat-typing{opacity:.9}
  .chat-typing-row{display:flex;align-items:center;gap:8px}
  .chat-typing-txt{font:400 11px 'Manrope',sans-serif;color:#8a8fa8}
  .chat-typing-dots{display:inline-flex;gap:3px;flex-shrink:0}
  .chat-typing-dots span{
    width:5px;height:5px;border-radius:50%;background:#a78bfa;
    animation:chat-blink 1.2s ease-in-out infinite;
  }
  .chat-typing-dots span:nth-child(2){animation-delay:.18s}
  .chat-typing-dots span:nth-child(3){animation-delay:.36s}
  @keyframes chat-blink{0%,80%,100%{opacity:.25}40%{opacity:1}}
  @media (prefers-reduced-motion: reduce){
    .chat-typing-dots span{animation:none;opacity:.7}
  }

  .chat-err{
    display:flex;align-items:flex-start;gap:8px;
    margin-bottom:10px;padding:8px 10px;border-radius:8px;
    background:rgba(239,93,110,.08);
    border:1px solid rgba(239,93,110,.25);
    font:400 11px/1.45 'Manrope',sans-serif;color:#f0a0aa;
  }
  .chat-err-ico{flex-shrink:0}

  /* ── "Configure LLM" chip ──
     A run that dies with no provider configured is not a report, it is a task.
     The kernel already names the screen in prose ("Settings → AI"); this is
     that sentence as something you can click, wherever the failure surfaces:
     the chat error banner, the failed reply, and the office error card. */
  .llm-fix{
    flex-shrink:0;align-self:center;
    padding:3px 9px;border-radius:999px;text-decoration:none;white-space:nowrap;
    font:600 10px 'JetBrains Mono',monospace;letter-spacing:.3px;
    background:rgba(201,168,76,.10);
    border:1px solid rgba(201,168,76,.45);
    color:#d4a84b;transition:background .12s,border-color .12s;
  }
  .llm-fix:hover{background:rgba(201,168,76,.20);border-color:#d4a84b}
  /* Under a card rather than beside a message: own line, indented to the card. */
  .llm-fix-row{display:inline-block;align-self:flex-start;margin:6px 0 2px 12px}

  /* ── Script agents ──
     The tab stays, the input does not. Same call as the office environment:
     an affordance that cannot work is explained, not silently removed. */
  .chat-noop{
    margin:auto 0;padding:18px;border-radius:12px;max-width:52ch;
    background:rgba(120,130,160,.04);
    border:1px solid rgba(120,130,160,.14);
  }
  .chat-noop-glyph{font:400 20px 'JetBrains Mono',monospace;color:#8a8fa8;margin-bottom:8px}
  .chat-noop-h{font:600 14px 'Syne',sans-serif;color:#e0e2ea;margin:0 0 6px}
  .chat-noop-p{font:400 12px/1.6 'Manrope',sans-serif;color:#8a8fa8;margin:0 0 14px}
  .chat-noop-kv{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
  .chat-noop-lbl{
    flex-shrink:0;width:38px;
    font:600 9px 'JetBrains Mono',monospace;color:#6a6f82;
    text-transform:uppercase;letter-spacing:.5px;
  }
  .chat-noop-desc{font:400 12px/1.5 'Manrope',sans-serif;color:#c0c5d8}
  .chat-noop-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}

  /* ── Workspace panel ──────────── */
  .ws-panel{padding:8px 0;overflow-y:auto;max-height:calc(100% - 120px);scrollbar-width:thin}
  .ws-loading,.ws-empty{padding:24px 16px;text-align:center;color:#6a6f82;font:500 12px 'Manrope',sans-serif}
  .ws-empty code{padding:1px 6px;border-radius:3px;background:rgba(120,130,160,.12);color:#c0c5d8;font:500 10px 'JetBrains Mono',monospace}
  /* cwd card — header of the workspace tab showing the agent's working
     directory and the guardrails applied on top of it */
  .ws-cwd-card{
    margin:0 8px 10px;padding:10px 12px;border-radius:8px;
    background:linear-gradient(180deg,rgba(99,102,241,.08),rgba(99,102,241,.03));
    border:1px solid rgba(99,102,241,.18);
    display:flex;flex-direction:column;gap:6px;
  }
  .ws-cwd-row{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}
  .ws-cwd-lbl{
    flex-shrink:0;padding:2px 8px;border-radius:3px;
    background:rgba(99,102,241,.18);color:#a5a8e8;
    font:600 9px/14px 'JetBrains Mono',monospace;letter-spacing:.5px;text-transform:uppercase;
  }
  .ws-cwd-path{
    flex:1;min-width:0;padding:2px 6px;border-radius:3px;
    background:rgba(0,0,0,.25);color:#e2e4f0;
    font:500 11px/16px 'JetBrains Mono',monospace;
    word-break:break-all;
  }
  .ws-cwd-paths{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
  .ws-cwd-hint{font:500 10px 'Manrope',sans-serif;color:#7a7f96;padding-left:2px}
  .ws-cwd-extra .ws-cwd-lbl{background:rgba(180,140,80,.18);color:#d8b878}
  .ws-cwd-guard{margin-top:2px;padding-top:6px;border-top:1px dashed rgba(120,130,160,.2)}
  .ws-cwd-guard .ws-cwd-lbl{background:rgba(80,180,120,.18);color:#7ed8a4}
  .ws-cwd-guard.warn .ws-cwd-lbl{background:rgba(220,140,60,.20);color:#e8b070}
  .ws-guard-ok{flex:1;font:500 11px 'Manrope',sans-serif;color:#7ed8a4}
  .ws-guard-warn{flex:1;font:500 11px 'Manrope',sans-serif;color:#e8b070;line-height:1.45}
  .ws-guard-warn strong{color:#f0d8a0}
  /* Workspace file tree — collapsible dirs with indent guides */
  .ws-toolbar{
    display:flex;align-items:center;gap:6px;margin:0 8px 6px;padding:0 4px;
  }
  .ws-count{
    flex:1;font:600 10px 'JetBrains Mono',monospace;color:#6a6f82;
    letter-spacing:.04em;text-transform:uppercase;
  }
  .ws-tb-btn{
    padding:3px 9px;border-radius:5px;border:1px solid rgba(120,130,160,.18);
    background:rgba(120,130,160,.06);color:#8a8fa8;cursor:pointer;
    font:500 10px 'Manrope',sans-serif;transition:all .12s;
  }
  .ws-tb-btn:hover:not(:disabled){background:rgba(120,130,160,.14);color:#e0e2ea}
  .ws-tb-btn:disabled{opacity:.35;cursor:default}
  .ws-tree{
    display:flex;flex-direction:column;margin:0 8px;padding:4px;
    border-radius:8px;background:rgba(0,0,0,.18);
    border:1px solid rgba(120,130,160,.08);
  }
  .ws-row{
    display:flex;align-items:center;gap:6px;width:100%;padding:5px 8px 5px 6px;
    border:none;border-radius:5px;background:transparent;
    cursor:pointer;text-align:left;transition:background .1s,color .1s;
  }
  .ws-row:hover{background:rgba(120,130,160,.1)}
  .ws-guide{
    flex-shrink:0;width:9px;margin:-5px 5px -5px 6px;align-self:stretch;
    border-left:1px solid rgba(120,130,160,.16);
  }
  .ws-chev{
    flex-shrink:0;width:10px;font-size:9px;color:#6a6f82;
    display:inline-block;transition:transform .12s ease;line-height:1;
  }
  .ws-chev.open{transform:rotate(90deg)}
  .ws-chev-spacer{flex-shrink:0;width:10px}
  .ws-icon{font-size:12px;flex-shrink:0;line-height:1}
  .ws-name{
    flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    font:400 11px 'JetBrains Mono',monospace;color:#b8bdd2;
  }
  .ws-row:hover .ws-name{color:#e8ecf5}
  .ws-dirname{font:600 11px 'Manrope',sans-serif;color:#cdd2e4;letter-spacing:.01em}
  .ws-badge{
    flex-shrink:0;min-width:16px;padding:1px 6px;border-radius:8px;text-align:center;
    background:rgba(120,130,160,.12);color:#7a7f96;
    font:600 9px/14px 'JetBrains Mono',monospace;
  }
  .ws-size{color:#4a4f6a;font:400 10px 'JetBrains Mono',monospace;flex-shrink:0}
  .ws-file-view{display:flex;flex-direction:column;height:100%}
  .ws-file-header{
    display:flex;align-items:center;gap:8px;padding:8px 12px;
    border-bottom:1px solid rgba(120,130,160,.1);
  }
  .ws-back{
    padding:4px 10px;border-radius:5px;border:1px solid rgba(120,130,160,.2);
    background:rgba(120,130,160,.06);color:#8a8fa8;cursor:pointer;
    font:500 10px 'Manrope',sans-serif;transition:all .1s;
  }
  .ws-back:hover{background:rgba(120,130,160,.15);color:#fff}
  .ws-file-path{font:500 11px 'JetBrains Mono',monospace;color:#c0c5d8;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ws-file-lang{
    padding:2px 8px;border-radius:4px;flex-shrink:0;
    background:rgba(99,102,241,.14);border:1px solid rgba(99,102,241,.3);
    color:#a5a9ff;font:500 9px 'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.04em;
  }
  .ws-file-code{
    flex:1;overflow:auto;padding:12px 16px;margin:0;
    font:400 11px/1.5 'JetBrains Mono',monospace;color:#c0c5d8;
    background:rgba(0,0,0,.2);border-radius:0 0 8px 8px;
    white-space:pre;tab-size:2;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.2) transparent;
  }
  .ws-file-code code{display:block;min-width:max-content}
  /* Syntax highlighting — neutral dark palette */
  .ws-file-code :global(.hl-kw) { color:#c586c0; }
  .ws-file-code :global(.hl-str) { color:#ce9178; }
  .ws-file-code :global(.hl-num) { color:#b5cea8; }
  .ws-file-code :global(.hl-com) { color:#6a9955; font-style:italic; }
  .ws-file-code :global(.hl-fn)  { color:#dcdcaa; }
  .ws-file-code :global(.hl-typ) { color:#4ec9b0; }
  .ws-file-code :global(.hl-key) { color:#9cdcfe; }
  .ws-file-code :global(.hl-pun) { color:#9a9fb2; }

  /* Rendered-markdown view (when the file is .md). Mirrors the styles on
     the top-level /workspace page so proposals render readable, not raw. */
  .ws-file-md{
    flex:1;overflow:auto;padding:14px 18px;
    font:400 12.5px/1.65 'Manrope','Inter',sans-serif;color:#e8ecf5;
    background:rgba(0,0,0,.18);border-radius:0 0 8px 8px;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.2) transparent;
  }
  .ws-file-md :global(h1),
  .ws-file-md :global(h2),
  .ws-file-md :global(h3),
  .ws-file-md :global(h4),
  .ws-file-md :global(h5),
  .ws-file-md :global(h6){ margin:1.2em 0 .4em; line-height:1.3; color:#f0f4ff; }
  .ws-file-md :global(h1){ font-size:18px; }
  .ws-file-md :global(h2){ font-size:15px; border-bottom:1px solid rgba(90,110,160,.18); padding-bottom:3px; }
  .ws-file-md :global(h3){ font-size:13px; color:#bcc7e5; }
  .ws-file-md :global(p){ margin:8px 0; }
  .ws-file-md :global(ul), .ws-file-md :global(ol){ padding-left:20px; margin:6px 0; }
  .ws-file-md :global(li){ margin:2px 0; }
  .ws-file-md :global(code){ background:rgba(90,110,160,.14); padding:1px 5px; border-radius:3px;
    font:90% 'JetBrains Mono',monospace; }
  .ws-file-md :global(pre.md-code){
    background:rgba(0,0,0,.32); border:1px solid rgba(90,110,160,.2);
    padding:10px 12px; border-radius:6px; overflow-x:auto; margin:10px 0;
    font:400 11px/1.5 'JetBrains Mono',monospace;
  }
  .ws-file-md :global(pre.md-code code){ background:transparent; padding:0; }
  .ws-file-md :global(blockquote){
    border-left:3px solid rgba(99,102,241,.5);
    margin:10px 0; padding:2px 12px;
    color:#a8b5d1; background:rgba(99,102,241,.06);
  }
  .ws-file-md :global(a){ color:#7c92ff; text-decoration:underline; }
  .ws-file-md :global(a:hover){ color:#a3b3ff; }
  .ws-file-md :global(table.md-table){ border-collapse:collapse; margin:10px 0; font-size:11.5px; }
  .ws-file-md :global(table.md-table th),
  .ws-file-md :global(table.md-table td){
    border:1px solid rgba(90,110,160,.2); padding:5px 9px; text-align:left;
  }
  .ws-file-md :global(table.md-table th){ background:rgba(90,110,160,.1); font-weight:600; }
  .ws-file-md :global(hr){ border:none; border-top:1px solid rgba(90,110,160,.2); margin:16px 0; }

  /* ── Meeting modal ──────────── */
  .meeting-modal{width:460px}
  .meeting-agent-list{max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;margin-bottom:12px;scrollbar-width:thin}
  .meeting-agent-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;
    background:#141620;border:1px solid rgba(74,79,106,.2);color:var(--text-2);font:500 11px 'Manrope',sans-serif;
    cursor:pointer;transition:all .12s;text-align:left}
  .meeting-agent-item:hover{background:#1a1e30;border-color:rgba(74,79,106,.4)}
  .meeting-agent-item.selected{background:rgba(99,102,241,.1);border-color:rgba(99,102,241,.4);color:var(--text-1)}
  .meeting-agent-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .meeting-agent-name{flex:1}
  .meeting-check{color:#6366f1;font-size:14px;font-weight:700}

  /* ── Active meeting panel ──── */
  .meeting-panel{position:absolute;bottom:12px;right:12px;width:380px;max-height:60vh;
    background:rgba(14,16,24,.95);backdrop-filter:blur(12px);border:1px solid rgba(99,102,241,.3);
    border-radius:12px;z-index:15;display:flex;flex-direction:column;animation:slide .2s ease-out}
  .meeting-header{padding:10px 14px;border-bottom:1px solid rgba(74,79,106,.2)}
  .meeting-title{font:700 11px 'Syne',sans-serif;color:#8b8cf6;letter-spacing:1px;margin-bottom:4px}
  .meeting-attendees{display:flex;align-items:center;gap:4px;margin-bottom:6px}
  .meeting-att-dot{width:8px;height:8px;border-radius:50%}
  .meeting-att-count{font:500 9px 'Manrope',sans-serif;color:var(--text-3);margin-left:4px}
  .meeting-end{padding:4px 12px;border-radius:5px;font:600 9px 'Syne',sans-serif;
    background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#ef4444;cursor:pointer;transition:all .15s}
  .meeting-end:hover{background:rgba(239,68,68,.22)}
  .meeting-min{padding:4px 10px;border-radius:5px;font:700 11px 'Syne',sans-serif;margin-right:6px;
    background:rgba(99,102,241,.10);border:1px solid rgba(99,102,241,.3);color:#8b8cf6;cursor:pointer;transition:all .15s}
  .meeting-min:hover{background:rgba(99,102,241,.22)}
  .meeting-messages{flex:1;overflow-y:auto;padding:8px 14px;max-height:300px;scrollbar-width:thin}
  .meeting-msg{margin-bottom:8px}
  .meeting-msg-name{display:block;font:700 8px 'Syne',sans-serif;letter-spacing:.5px;text-transform:uppercase;margin-bottom:2px}
  .meeting-msg-text{font:400 11px 'Manrope',sans-serif;color:var(--text-2);line-height:1.4;word-break:break-word}
  .meeting-typing{opacity:.5}
  /* The room's own input row is gone — ChatComposer supplies it. Only the
     surrounding padding and the accent it focuses to stay local. */
  .meeting-composer{padding:0 14px 10px;--flow-color:#8b8cf6}

  /* ── Modal ──────────────────── */
  .modal-overlay{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center}
  .modal{background:#0e1018;border:1px solid rgba(74,79,106,.4);border-radius:16px;padding:24px;width:420px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.6);animation:mslide .2s ease-out}
  @keyframes mslide{from{transform:translateY(12px);opacity:0}}
  .modal-title{font:700 16px 'Syne',sans-serif;color:var(--text-1,#e0e2ea);margin-bottom:4px}
  .modal-sub{font:400 11px 'Manrope',sans-serif;color:var(--text-3,#4a4f6a);margin-bottom:16px;line-height:1.4}
  .modal-label{display:block;font:600 9px 'Manrope',sans-serif;color:var(--text-3,#4a4f6a);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
  .modal-input{display:block;width:100%;margin-top:5px;padding:8px 12px;border-radius:8px;background:#141620;border:1px solid rgba(74,79,106,.3);color:var(--text-1,#e0e2ea);font:400 13px 'Manrope',sans-serif;outline:none;box-sizing:border-box}
  .modal-input:focus{border-color:#6366f1}
  .modal-textarea{display:block;width:100%;margin-top:5px;padding:8px 12px;border-radius:8px;background:#141620;border:1px solid rgba(74,79,106,.3);color:var(--text-1,#e0e2ea);font:400 12px 'Manrope',sans-serif;outline:none;resize:vertical;box-sizing:border-box;line-height:1.5}
  .modal-textarea:focus{border-color:#6366f1}
  .modal-row{display:flex;gap:10px}
  .modal-half{flex:1}
  .modal-error{font:500 11px 'Manrope',sans-serif;color:#ef4444;background:rgba(239,68,68,.1);padding:6px 10px;border-radius:6px;margin-bottom:8px}
  .modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  .modal-cancel{padding:8px 18px;border-radius:8px;font:600 11px 'Manrope',sans-serif;background:#1a1d2a;border:1px solid rgba(74,79,106,.3);color:var(--text-2,#8a8fa8);cursor:pointer;transition:all .15s}
  .modal-cancel:hover{background:#22253a}
  .modal-confirm{padding:8px 18px;border-radius:8px;font:600 11px 'Syne',sans-serif;letter-spacing:.5px;background:#10b981;border:none;color:#fff;cursor:pointer;transition:all .15s}
  .modal-confirm:hover{filter:brightness(1.1)}
  .modal-confirm:disabled{opacity:.4;cursor:not-allowed}

  /* ── Register-Repo modal (data-center amber accent) ── */
  .repo-modal{border:1px solid #ffb84a40;box-shadow:0 20px 60px rgba(0,0,0,.6),0 0 24px rgba(255,184,74,.08)}
  .repo-modal .modal-title{color:#ffb84a;letter-spacing:3px;text-shadow:0 0 8px #ffb84a30}
  .repo-modal-confirm{background:#ffb84a;color:#1a1410}
  .repo-modal-confirm:hover{filter:brightness(1.08)}
  .modal-hint{color:#7a7a7a;font-weight:400;text-transform:none;letter-spacing:0}

  /* ── Markdown output (run.result / step.content) ── */
  .ip-out-md{
    font:400 12.5px/1.6 'Manrope',sans-serif;color:#d0d4e0;
    padding:14px 18px;border-radius:6px;background:rgba(0,0,0,.22);
    word-break:break-word;overflow-wrap:anywhere;max-height:380px;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
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

  /* ── Latest result hero card (Overview) ── */
  .result-hero{
    position:relative;margin:0 0 14px;padding:14px 16px 10px;
    border-radius:12px;
    background:
      linear-gradient(180deg, rgba(120,220,140,.08) 0%, rgba(120,220,140,.02) 60%, rgba(0,0,0,0) 100%),
      #0f121c;
    border:1px solid rgba(120,220,140,.28);
    box-shadow:0 4px 18px rgba(0,0,0,.25), inset 0 0 0 1px rgba(255,255,255,.02);
    overflow:hidden;
  }
  .result-hero::before{
    content:'';position:absolute;top:0;left:0;right:0;height:2px;
    background:linear-gradient(90deg, transparent, #78dc8c, transparent);
    opacity:.6;
  }
  .result-hero.result-fail{
    background:linear-gradient(180deg, rgba(239,93,110,.08) 0%, rgba(239,93,110,.02) 60%, rgba(0,0,0,0) 100%), #0f121c;
    border-color:rgba(239,93,110,.32);
  }
  .result-hero.result-fail::before{background:linear-gradient(90deg, transparent, #ef5d6e, transparent)}
  .result-hero-loading{padding:14px;color:#6a6f82;font:500 11px 'Manrope',sans-serif;text-align:center}
  .result-hero-top{
    display:flex;justify-content:space-between;align-items:center;gap:10px;
    margin-bottom:10px;flex-wrap:wrap;
  }
  .result-hero-badge{display:flex;align-items:center;gap:8px}
  .result-hero-icon{
    width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;
    border-radius:50%;font:700 12px 'JetBrains Mono',monospace;
    background:rgba(120,220,140,.18);color:#78dc8c;border:1px solid rgba(120,220,140,.4);
  }
  .result-hero.result-fail .result-hero-icon{background:rgba(239,93,110,.18);color:#ef5d6e;border-color:rgba(239,93,110,.4)}
  .result-hero-lbl{
    font:700 10px 'Syne',sans-serif;color:#d0d4e0;
    letter-spacing:1.2px;text-transform:uppercase;
  }
  .result-hero-date{
    font:700 13px 'Manrope',sans-serif;color:#e0e2ea;margin-bottom:2px;
  }
  .result-hero-date-full{
    font:400 10px 'JetBrains Mono',monospace;color:#6a6f82;margin-left:8px;
  }
  .result-hero-meta{
    display:flex;align-items:center;gap:5px;flex-wrap:wrap;
    font:500 9px 'JetBrains Mono',monospace;color:#8a8fa8;
  }
  .result-hero-dot{color:#4a4f6a}
  .result-hero-trigger{
    padding:2px 7px;border-radius:4px;
    background:color-mix(in srgb, var(--c, #6366f1) 15%, transparent);
    border:1px solid color-mix(in srgb, var(--c, #6366f1) 35%, transparent);
    color:var(--c, #6366f1);
    font:600 9px 'JetBrains Mono',monospace;letter-spacing:.4px;
  }
  .result-hero-body{
    padding:2px 0;max-height:260px;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  .result-hero-err{padding:10px 12px;border-radius:8px;background:rgba(239,93,110,.08);border:1px solid rgba(239,93,110,.22)}
  .result-hero-err-lbl{font:700 10px 'Syne',sans-serif;color:#ef5d6e;letter-spacing:.8px;margin-bottom:6px}
  .result-hero-err-txt{margin:0;font:400 11px/1.55 'JetBrains Mono',monospace;color:#ffb3bc;white-space:pre-wrap;word-break:break-word}
  .result-hero-actions{
    display:flex;justify-content:flex-end;gap:8px;margin-top:10px;
    padding-top:8px;border-top:1px dashed rgba(120,130,160,.12);
  }
  .result-hero-action{
    padding:5px 10px;border-radius:6px;
    font:600 9px 'JetBrains Mono',monospace;letter-spacing:.3px;
    background:rgba(120,130,160,.08);border:1px solid rgba(120,130,160,.22);
    color:#c0c5d8;cursor:pointer;transition:all .12s;
  }
  .result-hero-action:hover{background:rgba(120,130,160,.16);border-color:rgba(120,130,160,.38);color:#fff}
  .result-hero-action[disabled]{opacity:.55;cursor:wait}
  .result-hero-reauth{
    /* Amber call-to-action — pops out when the user lands on an auth-expired run. */
    background:linear-gradient(180deg, rgba(245,158,11,.22), rgba(245,158,11,.08));
    border-color:rgba(245,158,11,.55);color:#ffd175;
  }
  .result-hero-reauth:hover{
    background:linear-gradient(180deg, rgba(245,158,11,.32), rgba(245,158,11,.12));
    border-color:rgba(245,158,11,.85);color:#fff;
  }

  /* ── Inline "Re-login Google" CTA in the description area ── */
  /* Always visible for gsync:* agents, regardless of last-run status. */
  .ip-auth-cta{
    display:flex;align-items:center;gap:10px;
    padding:8px 12px;margin:0 0 14px;
    background:linear-gradient(180deg, rgba(245,158,11,.10), rgba(245,158,11,.03));
    border:1px solid rgba(245,158,11,.30);border-radius:10px;
  }
  .ip-auth-hint{
    flex:1;min-width:0;
    font:600 10.5px 'JetBrains Mono',monospace;letter-spacing:.4px;text-transform:uppercase;
    color:#ffd175;
  }
  .ip-auth-btn{
    display:inline-flex;align-items:center;gap:6px;
    padding:6px 12px;border-radius:7px;
    font:700 11px 'JetBrains Mono',monospace;letter-spacing:.3px;
    background:linear-gradient(180deg, rgba(245,158,11,.28), rgba(245,158,11,.10));
    border:1px solid rgba(245,158,11,.65);color:#fff;cursor:pointer;
    transition:all .12s;
  }
  .ip-auth-btn:hover:not(:disabled){
    background:linear-gradient(180deg, rgba(245,158,11,.42), rgba(245,158,11,.16));
    border-color:rgba(245,158,11,.95);
  }
  .ip-auth-btn:disabled{opacity:.55;cursor:wait}
  .ip-auth-ico{font-size:13px;line-height:1}

  /* ── LIVE tab ── */
  .ip-tab-live{
    position:relative;display:flex;align-items:center;gap:6px;
    color:#ef5d6e !important;
    background:linear-gradient(180deg, rgba(239,93,110,.12), rgba(239,93,110,.04)) !important;
    border-color:rgba(239,93,110,.35) !important;
    font-weight:700;letter-spacing:.5px;
  }
  .ip-tab-live.active{
    background:rgba(239,93,110,.22) !important;
    border-color:#ef5d6e !important;
    color:#fff !important;
    box-shadow:0 0 12px rgba(239,93,110,.35);
  }
  .live-dot{
    width:7px;height:7px;border-radius:50%;background:#ef5d6e;
    box-shadow:0 0 8px #ef5d6e;
    animation:live-pulse 1s ease-in-out infinite;
  }
  @keyframes live-pulse{
    0%,100%{opacity:1;transform:scale(1)}
    50%{opacity:.45;transform:scale(.82)}
  }

  .live-body{padding-top:4px}
  .live-hero{
    margin:0 0 14px;padding:14px 16px;border-radius:12px;
    background:
      radial-gradient(600px 200px at 50% -80%, rgba(239,93,110,.18), transparent 70%),
      linear-gradient(180deg, #161a28 0%, #0d1020 100%);
    border:1px solid rgba(239,93,110,.25);
    box-shadow:0 4px 22px rgba(239,93,110,.12);
    position:relative;overflow:hidden;
  }
  .live-hero::before{
    content:'';position:absolute;inset:0;pointer-events:none;
    background:linear-gradient(90deg, transparent 0%, rgba(239,93,110,.08) 50%, transparent 100%);
    animation:live-sheen 3s ease-in-out infinite;
  }
  @keyframes live-sheen{
    0%{transform:translateX(-100%)}100%{transform:translateX(100%)}
  }
  .live-hero-head{
    display:flex;align-items:center;gap:10px;margin-bottom:12px;position:relative;z-index:1;
  }
  .live-badge{
    display:inline-flex;align-items:center;gap:6px;
    padding:3px 9px;border-radius:5px;
    background:rgba(239,93,110,.22);
    border:1px solid rgba(239,93,110,.5);
    font:700 9px 'Syne',sans-serif;letter-spacing:2px;color:#ff7a8a;
  }
  .live-dot-big{
    width:8px;height:8px;border-radius:50%;background:#ff3b4f;
    box-shadow:0 0 10px #ff3b4f, 0 0 18px rgba(255,59,79,.5);
    animation:live-pulse 1s ease-in-out infinite;
  }
  .live-hero-name{font:600 13px 'Manrope',sans-serif;color:#e0e2ea}

  .live-now{
    display:flex;align-items:flex-start;gap:14px;position:relative;z-index:1;
    padding:10px 12px;border-radius:10px;
    background:rgba(255,255,255,.02);border:1px solid rgba(120,130,160,.12);
  }
  .live-waiting{opacity:.75}
  .live-now-icon-wrap{position:relative;width:40px;height:40px;flex-shrink:0}
  .live-now-icon{
    position:relative;z-index:2;
    width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;
    background:linear-gradient(135deg, rgba(239,93,110,.25), rgba(239,93,110,.1));
    border:1px solid rgba(239,93,110,.4);
    border-radius:50%;font-size:18px;
  }
  .live-now-halo{
    position:absolute;inset:-4px;border-radius:50%;
    border:2px solid rgba(239,93,110,.45);
    animation:live-halo 1.6s ease-out infinite;
  }
  @keyframes live-halo{
    0%{transform:scale(.9);opacity:.8}
    100%{transform:scale(1.7);opacity:0}
  }
  .live-now-body{flex:1;min-width:0}
  .live-now-lbl{
    font:700 9px 'Syne',sans-serif;letter-spacing:1.2px;text-transform:uppercase;
    color:#ff7a8a;margin-bottom:3px;
  }
  .live-now-txt{
    font:500 12px/1.5 'Manrope',sans-serif;color:#e5e8f0;
    word-break:break-word;overflow-wrap:anywhere;white-space:pre-wrap;
    max-height:480px;overflow-y:auto;padding-right:4px;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  .live-tool{
    font:600 10px 'JetBrains Mono',monospace;
    background:rgba(251,191,36,.14);color:#fbbf24;
    padding:1px 6px;border-radius:3px;margin-right:6px;
  }
  .live-now-clock{
    flex-shrink:0;font:500 9px 'JetBrains Mono',monospace;color:#6a6f82;
  }

  .live-timeline-head{
    display:flex;align-items:center;justify-content:space-between;
    padding:0 2px 6px;margin-bottom:4px;
    border-bottom:1px solid rgba(120,130,160,.12);
  }
  .live-timeline-h{
    font:700 9px 'Syne',sans-serif;letter-spacing:1.2px;
    text-transform:uppercase;color:#8a8fa8;
  }

  .live-timeline{
    list-style:none;margin:0;padding:0 0 0 20px;position:relative;
    display:flex;flex-direction:column;gap:2px;
  }
  .live-timeline::before{
    content:'';position:absolute;left:7px;top:10px;bottom:10px;width:1px;
    background:linear-gradient(180deg, rgba(239,93,110,.35) 0%, rgba(120,130,160,.08) 100%);
  }
  .live-step{
    position:relative;padding:4px 0 4px 6px;border-radius:7px;
    transition:background .12s;
  }
  .live-step-dot{
    position:absolute;left:-18px;top:11px;
    width:9px;height:9px;border-radius:50%;
    background:#3a3f52;border:2px solid #0d1020;
    z-index:1;
  }
  /* Category-driven dot color — replaces the old per-event-type overrides
     so kernel_* tools, MCP tools, web fetches all get their own hue. */
  .live-cat-shell  .live-step-dot{background:#fbbf24}
  .live-cat-fs     .live-step-dot{background:#6aa0ff}
  .live-cat-web    .live-step-dot{background:#4dd6e0}
  .live-cat-kernel .live-step-dot{background:#5fdba0}
  .live-cat-mcp    .live-step-dot{background:#c693ff}
  .live-cat-think  .live-step-dot{background:#a78bfa}
  .live-cat-final  .live-step-dot{background:#78dc8c;box-shadow:0 0 8px rgba(120,220,140,.55)}
  .live-cat-error  .live-step-dot{background:#ef5d6e}
  .live-cat-meta   .live-step-dot{background:#9aa3c0}
  .live-cat-tool   .live-step-dot{background:#d0b87a}
  .live-step-run_started .live-step-dot{background:#3dd68c}
  .live-step-run_completed .live-step-dot{background:#78dc8c}
  .live-step-head .live-step-dot{
    box-shadow:0 0 0 4px rgba(239,93,110,.18), 0 0 14px rgba(239,93,110,.55);
    animation:live-pulse 1.2s ease-in-out infinite;
  }

  /* ── Summary row — one line of plain-language action description.
     Whole row is a button: click to expand the JSON payload below. */
  .live-step-summary{
    width:100%;display:flex;align-items:center;gap:8px;flex-wrap:nowrap;
    padding:6px 10px;border-radius:7px;border:1px solid transparent;
    background:transparent;color:inherit;text-align:left;cursor:pointer;
    font:500 10.5px 'JetBrains Mono',monospace;
    transition:background .12s, border-color .12s;
    min-width:0;
  }
  .live-step-summary:disabled{cursor:default}
  .live-step-summary:hover:not(:disabled){
    background:rgba(255,255,255,.025);
    border-color:rgba(120,130,160,.15);
  }
  .live-step-open .live-step-summary{
    background:rgba(255,255,255,.03);
    border-color:rgba(120,130,160,.18);
    border-bottom-left-radius:0;border-bottom-right-radius:0;
  }
  .live-step-icon{font-size:11px;flex-shrink:0}
  .live-step-type{
    text-transform:uppercase;letter-spacing:.6px;font-size:9px;font-weight:700;
    padding:1px 6px;border-radius:3px;background:rgba(120,130,160,.12);color:#a0a5b8;
    flex-shrink:0;
  }
  .live-cat-shell  .live-step-type{background:rgba(251,191,36,.14);color:#fbbf24}
  .live-cat-fs     .live-step-type{background:rgba(106,160,255,.14);color:#6aa0ff}
  .live-cat-web    .live-step-type{background:rgba(77,214,224,.14);color:#4dd6e0}
  .live-cat-kernel .live-step-type{background:rgba(95,219,160,.14);color:#5fdba0}
  .live-cat-mcp    .live-step-type{background:rgba(198,147,255,.14);color:#c693ff}
  .live-cat-think  .live-step-type{background:rgba(167,139,250,.14);color:#a78bfa}
  .live-cat-final  .live-step-type{background:rgba(120,220,140,.14);color:#78dc8c}
  .live-cat-error  .live-step-type{background:rgba(239,93,110,.16);color:#ef8090}
  .live-cat-meta   .live-step-type{background:rgba(154,163,192,.14);color:#9aa3c0}
  .live-cat-tool   .live-step-type{background:rgba(208,184,122,.14);color:#d0b87a}
  .live-step-tool{
    font:600 10px 'JetBrains Mono',monospace;color:#d0b87a;flex-shrink:0;
    padding:1px 5px;border-radius:3px;background:rgba(208,184,122,.10);
  }
  .live-cat-shell  .live-step-tool{color:#fbbf24;background:rgba(251,191,36,.10)}
  .live-cat-fs     .live-step-tool{color:#6aa0ff;background:rgba(106,160,255,.10)}
  .live-cat-web    .live-step-tool{color:#4dd6e0;background:rgba(77,214,224,.10)}
  .live-cat-kernel .live-step-tool{color:#5fdba0;background:rgba(95,219,160,.10)}
  .live-cat-mcp    .live-step-tool{color:#c693ff;background:rgba(198,147,255,.10)}
  /* The human-readable summary — takes the rest of the row and truncates
     gracefully when the description is long. */
  .live-step-text{
    flex:1;min-width:0;
    color:#d6dae8;font:400 11.5px/1.4 'Manrope',sans-serif;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }
  .live-step-open .live-step-text{white-space:normal}
  .live-step-clock{color:#4a4f6a;font-size:9px;flex-shrink:0}
  .live-step-chev{
    color:#6a6f82;font-size:11px;width:14px;text-align:center;flex-shrink:0;
    transition:transform .14s;
  }
  .live-step-open .live-step-chev{color:#a0a5b8}

  /* Expanded detail panel — the full JSON payload that used to live
     inline. Renders inside a card connected to the summary row above. */
  .live-step-detail{
    position:relative;
    margin:0 0 4px 0;padding:10px 12px;
    border:1px solid rgba(120,130,160,.18);border-top:none;
    border-radius:0 0 7px 7px;
    background:rgba(8,10,18,.7);
    animation:live-step-detail-in .14s ease-out;
  }
  @keyframes live-step-detail-in{
    from{opacity:0;transform:translateY(-3px)}
    to{opacity:1;transform:translateY(0)}
  }
  /* Subtle left border colored by category so the expand visually anchors
     to the same accent as the dot above. */
  .live-cat-shell  .live-step-detail{border-left-color:rgba(251,191,36,.35)}
  .live-cat-fs     .live-step-detail{border-left-color:rgba(106,160,255,.35)}
  .live-cat-web    .live-step-detail{border-left-color:rgba(77,214,224,.35)}
  .live-cat-kernel .live-step-detail{border-left-color:rgba(95,219,160,.35)}
  .live-cat-mcp    .live-step-detail{border-left-color:rgba(198,147,255,.35)}
  .live-cat-think  .live-step-detail{border-left-color:rgba(167,139,250,.35)}
  .live-cat-error  .live-step-detail{border-left-color:rgba(239,93,110,.45)}
  .live-step-txt{
    margin-top:0;padding:5px 8px;border-radius:5px;
    background:rgba(0,0,0,.25);
    font:400 10.5px/1.5 'Manrope',sans-serif;color:#c0c5d8;
    word-break:break-word;overflow-wrap:anywhere;white-space:pre-wrap;
    max-height:420px;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  /* Plain-language summary line under the LIVE hero icon — same idea as
     .live-step-text but bigger because it's the headline action. */
  .live-now-summary{
    margin-top:4px;color:#e0e3ee;
    font:500 13px/1.45 'Manrope',sans-serif;
    word-break:break-word;
  }

  /* ── Per-step meta chips (Δt + tokens). Sit just under the summary row,
     small enough not to compete with the description but always visible
     so the user gets a feel for cost without opening the step. */
  .live-step-meta{
    display:flex;flex-wrap:wrap;gap:5px;
    padding:1px 0 3px 30px;
    font:500 9px 'JetBrains Mono',monospace;
  }
  .live-meta-chip{
    display:inline-flex;align-items:center;gap:3px;
    padding:1px 5px;border-radius:3px;
    background:rgba(120,130,160,.08);color:#7a83a0;
    border:1px solid rgba(120,130,160,.10);
    letter-spacing:.3px;
  }
  .live-meta-time{color:#9ec0ef;background:rgba(106,160,255,.07);border-color:rgba(106,160,255,.15)}
  .live-meta-tok {color:#c4e8a8;background:rgba(120,220,140,.07);border-color:rgba(120,220,140,.18)}
  .live-meta-cum {color:#8e8fa8;background:rgba(120,130,160,.05);border-color:rgba(120,130,160,.10)}

  /* ── Totals row inside the timeline header — current run elapsed + tok */
  .live-totals{display:inline-flex;gap:6px;margin-left:auto}
  .live-totals-chip{
    display:inline-flex;align-items:center;gap:3px;
    padding:2px 7px;border-radius:4px;
    font:600 10px 'JetBrains Mono',monospace;letter-spacing:.4px;
    background:rgba(120,130,160,.10);color:#a8b0c8;
    border:1px solid rgba(120,130,160,.15);
  }
  .live-totals-time{color:#9ec0ef;background:rgba(106,160,255,.10);border-color:rgba(106,160,255,.22)}
  .live-totals-tok {color:#bee2a3;background:rgba(120,220,140,.10);border-color:rgba(120,220,140,.22)}

  /* ── Draft modal ── */
  .draft-modal{width:620px;max-width:92vw;padding:18px 20px}
  .draft-modal-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}
  .draft-modal-close{
    background:transparent;border:none;color:#8a8fa8;font:400 22px/1 'Manrope',sans-serif;
    cursor:pointer;padding:0 4px;transition:color .12s;
  }
  .draft-modal-close:hover{color:#fff}
  .draft-status{text-transform:uppercase;font:700 9px 'JetBrains Mono',monospace;color:#fbbf24;letter-spacing:.5px}
  .draft-field{
    display:flex;gap:10px;align-items:baseline;
    padding:4px 0;border-bottom:1px dashed rgba(120,130,160,.12);
    font:400 11px 'Manrope',sans-serif;
  }
  .draft-field:last-of-type{border-bottom:none}
  .draft-lbl{
    flex:0 0 70px;font:600 9px 'JetBrains Mono',monospace;
    color:#6a6f82;text-transform:uppercase;letter-spacing:.5px;
  }
  .draft-val{flex:1;color:#d0d4e0;word-break:break-word}
  .draft-subject{color:#fff;font-weight:600}
  .draft-body{margin:12px 0 4px;border:1px solid rgba(74,79,106,.25);border-radius:8px;overflow:hidden;background:#0a0c14}
  .draft-iframe{width:100%;height:340px;border:none;background:#fff;display:block}
  .draft-body-pre{
    margin:0;padding:12px 14px;max-height:340px;overflow-y:auto;
    font:400 11px/1.55 'JetBrains Mono',monospace;
    color:#d0d4e0;white-space:pre-wrap;word-break:break-word;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }

  /* ── My Office reports panel ── */
  .office-reports-panel{
    border-color:rgba(201,168,76,.35);
    background:linear-gradient(180deg, rgba(201,168,76,.06) 0%, #0d1020 40%);
  }
  .or-empty{padding:24px 16px;text-align:center;color:#6a6f82;font:500 12px 'Manrope',sans-serif}
  /* Single scrollable body for the My Office panel — wraps the pending
   * question cards AND the report list so they share one scrollbar instead
   * of each fighting for height inside the flex column. */
  .or-scroll{
    flex:1;min-height:0;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(201,168,76,.25) transparent;
  }
  .office-reports-list{
    padding:8px 10px;
    display:flex;flex-direction:column;gap:6px;
  }

  /* ── My Office tabs ────────────────────────────── */
  .mo-tabs{
    padding:0 14px;
    border-bottom:1px solid rgba(120,130,160,.1);
    flex-shrink:0;
  }
  .mo-tab-badge{
    display:inline-flex;align-items:center;justify-content:center;
    min-width:18px;height:16px;padding:0 5px;margin-left:6px;
    border-radius:8px;
    font:700 9px 'JetBrains Mono',monospace;
    background:rgba(120,130,160,.18);color:#cbd0e8;
  }
  .mo-tab-badge-q{background:rgba(240,184,116,.22);color:#f0b874}
  .mo-tab-badge-err{background:rgba(239,93,110,.22);color:#ef5d6e}

  /* ── My Office overview (KPIs + previews) ──────── */
  .mo-overview{padding:8px 4px}
  .mo-kpis{
    display:grid;grid-template-columns:repeat(3,1fr);gap:8px;
    padding:8px 10px 4px;
  }
  .mo-kpi{
    display:flex;flex-direction:column;gap:2px;align-items:flex-start;
    padding:10px 12px;border:1px solid rgba(120,130,160,.18);border-radius:8px;
    background:rgba(120,130,160,.04);
    color:#cbd0e8;cursor:pointer;text-align:left;
    transition:background .12s, border-color .12s;
  }
  .mo-kpi:hover:not(:disabled){background:rgba(120,130,160,.1);border-color:rgba(120,130,160,.35)}
  .mo-kpi:disabled{cursor:default;opacity:.55}
  .mo-kpi-num{font:800 22px 'Syne',sans-serif;line-height:1}
  .mo-kpi-lbl{font:600 9px 'JetBrains Mono',monospace;letter-spacing:.6px;text-transform:uppercase;color:#8a8fa8}
  .mo-kpi-q .mo-kpi-num{color:#f0b874}
  .mo-kpi-q{border-color:rgba(240,184,116,.25)}
  .mo-kpi-err .mo-kpi-num{color:#ef5d6e}
  .mo-kpi-err{border-color:rgba(239,93,110,.25)}
  .mo-kpi-act .mo-kpi-num{color:#7a9aff}
  .mo-kpi-act{border-color:rgba(122,154,255,.25)}

  /* Compact overview question preview — clickable card hint */
  .mo-overview-q{cursor:pointer;transition:background .12s}
  .mo-overview-q:hover{background:linear-gradient(180deg, rgba(240,184,116,.16) 0%, rgba(240,184,116,.04) 100%)}
  .or-section-more{
    margin-left:auto;background:none;border:none;cursor:pointer;
    font:600 10px 'JetBrains Mono',monospace;color:#7a9aff;padding:2px 4px;
  }
  .or-section-more:hover{color:#a0b7ff;text-decoration:underline}

  /* ── Bulk action buttons (tab toolbars) ────────── */
  .mo-bulk-btn{
    margin-left:auto;
    padding:3px 10px;border-radius:6px;cursor:pointer;
    font:600 10px 'JetBrains Mono',monospace;letter-spacing:.3px;
    border:1px solid transparent;transition:all .12s;
  }
  .mo-bulk-btn:disabled{opacity:.5;cursor:wait}
  .mo-bulk-dismiss{
    background:rgba(240,184,116,.08);border-color:rgba(240,184,116,.3);color:#f0b874;
  }
  .mo-bulk-dismiss:hover:not(:disabled){background:rgba(240,184,116,.18);border-color:rgba(240,184,116,.5)}
  .mo-bulk-clear{
    background:rgba(239,93,110,.08);border-color:rgba(239,93,110,.3);color:#ef5d6e;
  }
  .mo-bulk-clear:hover:not(:disabled){background:rgba(239,93,110,.18);border-color:rgba(239,93,110,.5)}

  /* Footer bulk action variants */
  .office-clear-btn-soft{
    background:rgba(120,130,160,.08);border-color:rgba(120,130,160,.3);color:#8a8fa8;
  }
  .office-clear-btn-soft:hover{background:rgba(120,130,160,.16);border-color:rgba(120,130,160,.5);color:#cbd0e8}
  .office-clear-btn-danger{
    background:rgba(239,93,110,.08);border-color:rgba(239,93,110,.3);color:#ef5d6e;
    margin-left:auto;
  }
  .office-clear-btn-danger:hover{background:rgba(239,93,110,.18);border-color:rgba(239,93,110,.5)}
  .or-card{
    display:flex;flex-direction:column;gap:4px;width:100%;
    padding:10px 12px;border:none;border-radius:8px;
    background:rgba(120,130,160,.04);color:#c0c5d8;cursor:pointer;
    text-align:left;transition:background .12s;
    border-left:3px solid transparent;
  }
  .or-card:hover{background:rgba(201,168,76,.08)}
  .or-card.or-fail{border-left-color:rgba(239,93,110,.5);background:rgba(239,93,110,.04)}
  .or-card.or-handoff{border-left-color:rgba(61,214,200,.4);background:rgba(61,214,200,.03)}
  .or-section{
    display:flex;align-items:baseline;gap:8px;
    padding:6px 4px 2px 4px;margin-top:4px;
  }
  .or-section:first-child{margin-top:0}
  .or-section-title{
    font:700 10px 'Syne',sans-serif;letter-spacing:1px;text-transform:uppercase;
    color:#8a8fa8;
  }
  .or-section-title.or-section-fail{color:#ef5d6e}
  .or-section-title.or-section-q{color:#f0b874}
  .or-section-hint{font:500 9px 'JetBrains Mono',monospace;color:#5a5f7a}

  /* ── Top-agent question cards ─────────────────────── */
  .bq-list{ display:flex; flex-direction:column; gap:10px; padding:0 14px 12px; }
  .bq-card{
    background:linear-gradient(180deg, rgba(240,184,116,.08) 0%, rgba(240,184,116,.02) 100%);
    border:1px solid rgba(240,184,116,.25); border-left:3px solid #f0b874;
    border-radius:8px; padding:10px 12px;
  }
  .bq-head{ display:flex; align-items:center; gap:8px; margin-bottom:6px; font:600 10px 'JetBrains Mono',monospace; color:#cbd0e8; }
  .bq-from-dot{ width:7px; height:7px; border-radius:50%; }
  .bq-from{ color:#e7e9f4; }
  .bq-time{ margin-left:auto; color:#6b7090; font-size:9px; }
  .bq-dismiss{
    background:transparent; border:none; color:#6b7090; font-size:16px;
    cursor:pointer; padding:0 3px; line-height:1;
  }
  .bq-dismiss:hover{ color:#ef5d6e; }
  .bq-question{
    font:600 13px/1.45 'Manrope',sans-serif; color:#e7e9f4;
    margin:0 0 8px; word-break:break-word;
  }
  .bq-context{ margin:0 0 8px; }
  .bq-context summary{
    cursor:pointer; color:#8b90af; font:500 10px 'JetBrains Mono',monospace;
    list-style:none;
  }
  .bq-context summary::-webkit-details-marker{ display:none; }
  .bq-context summary::before{ content:'▸ '; color:#6b7090; }
  .bq-context[open] summary::before{ content:'▾ '; }
  .bq-context-body{
    margin-top:6px; padding:8px 10px; background:#0a0b14; border:1px solid #1f2236;
    border-radius:4px; font:500 11px/1.5 'JetBrains Mono',monospace; color:#8b90af;
    white-space:pre-wrap; word-break:break-word; max-height:160px; overflow-y:auto;
  }
  .bq-options{ display:flex; flex-direction:column; gap:5px; }
  .bq-option{
    display:flex; align-items:center; gap:8px;
    padding:8px 10px; background:#161827; color:#cbd0e8;
    border:1px solid #2a2f4a; border-radius:5px;
    font:600 11px 'Manrope',sans-serif;
    cursor:pointer; transition:all .12s; text-align:left;
  }
  .bq-option:hover:not(:disabled){
    background:#252840; border-color:#f0b874; color:#f4e1a3;
    transform:translateY(-1px);
  }
  .bq-option:disabled{ opacity:.5; cursor:not-allowed; }
  .bq-option-idx{
    flex-shrink:0; width:20px; height:20px; border-radius:3px;
    background:#0a0b14; display:inline-flex; align-items:center; justify-content:center;
    font:700 10px 'JetBrains Mono',monospace; color:#f0b874;
  }
  .bq-option-lbl{ flex:1; word-break:break-word; }
  /* Options that open a URL — make them visually distinct (subtle teal tint
     + arrow chevron). */
  .bq-option-link{
    border-color:rgba(61,214,200,.35);
    background:linear-gradient(180deg, #161827 0%, #15212a 100%);
  }
  .bq-option-link:hover:not(:disabled){
    border-color:#3dd6c8;
    background:linear-gradient(180deg, #1a2f33 0%, #142329 100%);
    color:#a8e4dc;
  }
  .bq-option-link .bq-option-idx{ color:#3dd6c8; }
  .bq-option-linkico{
    flex-shrink:0; color:#3dd6c8; font:700 11px 'JetBrains Mono',monospace;
    opacity:.7; transition:opacity .12s, transform .12s;
  }
  .bq-option-link:hover:not(:disabled) .bq-option-linkico{
    opacity:1; transform:translate(2px,-2px);
  }
  /* Direct link chip — surfaces the URL from `context` above the options
     so the user can preview the link without having to commit to an answer. */
  .bq-direct-link{
    display:inline-flex; align-items:center; gap:5px;
    margin:6px 0 2px;
    padding:4px 9px;
    border:1px solid rgba(61,214,200,.3);
    background:rgba(61,214,200,.08);
    border-radius:14px;
    color:#88e0d6; text-decoration:none;
    font:600 10.5px 'JetBrains Mono',monospace;
    letter-spacing:.2px;
    transition:all .12s;
    max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .bq-direct-link:hover{
    background:rgba(61,214,200,.16);
    border-color:rgba(61,214,200,.5);
    color:#c8f0ea;
  }
  .or-audited{
    font:700 8px 'JetBrains Mono',monospace;letter-spacing:.4px;
    padding:2px 6px;border-radius:4px;
    background:rgba(120,220,140,.13);color:#78dc8c;
    border:1px solid rgba(120,220,140,.3);
  }
  .or-audit-pending{
    font:700 8px 'JetBrains Mono',monospace;letter-spacing:.4px;
    padding:2px 6px;border-radius:4px;
    background:rgba(201,168,76,.08);color:#c9a84c;
    border:1px dashed rgba(201,168,76,.3);
  }
  .or-card-header{
    display:flex;align-items:center;gap:6px;
  }
  .or-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
  .or-status{
    font:700 9px 'JetBrains Mono',monospace;
    width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;
    border-radius:4px;flex-shrink:0;
  }
  .status-ok{background:rgba(120,220,140,.15);color:#78dc8c}
  .status-fail{background:rgba(239,93,110,.15);color:#ef5d6e}
  .status-handoff{background:rgba(61,214,200,.15);color:#3dd6c8}
  .or-name{font:600 11px 'Manrope',sans-serif;flex-shrink:0;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .or-time{margin-left:auto;flex-shrink:0;font:500 9px 'JetBrains Mono',monospace;color:#4a4f6a}
  .or-card-body{
    font:400 11px/1.4 'Manrope',sans-serif;color:#8a8fa8;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
    overflow:hidden;word-break:break-word;padding-left:29px;
  }
  .or-card.or-fail .or-card-body{color:#cf7080}
  .or-footer{
    padding:8px 12px;border-top:1px solid rgba(120,130,160,.1);
    display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap;
  }
  .office-clear-btn{
    padding:5px 12px;border-radius:6px;
    font:600 10px 'JetBrains Mono',monospace;letter-spacing:.3px;
    background:rgba(120,130,160,.06);border:1px solid rgba(120,130,160,.18);
    color:#8a8fa8;cursor:pointer;transition:all .12s;
  }
  .office-clear-btn:hover{background:rgba(120,130,160,.16);color:#fff}

  /* ── Report detail modal ── */
  .report-modal{
    width:min(700px, 90vw);max-height:85vh;
    background:#0d1020;border:1px solid rgba(201,168,76,.35);border-radius:14px;
    display:flex;flex-direction:column;overflow:hidden;
    box-shadow:0 20px 60px rgba(0,0,0,.7), 0 0 40px rgba(201,168,76,.08);
  }
  .rm-head{
    display:flex;align-items:center;justify-content:space-between;
    padding:16px 20px;border-bottom:1px solid rgba(120,130,160,.12);
    gap:12px;flex-wrap:wrap;
  }
  .rm-head-left{display:flex;align-items:center;gap:10px}
  .rm-head-right{display:flex;align-items:center;gap:12px}
  .rm-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
  .rm-status{
    font:700 10px 'Syne',sans-serif;letter-spacing:1px;text-transform:uppercase;
    padding:3px 10px;border-radius:5px;
  }
  .rm-status.status-ok{background:rgba(120,220,140,.15);color:#78dc8c;border:1px solid rgba(120,220,140,.35)}
  .rm-status.status-fail{background:rgba(239,93,110,.15);color:#ef5d6e;border:1px solid rgba(239,93,110,.35)}
  .rm-status.status-handoff{background:rgba(61,214,200,.15);color:#3dd6c8;border:1px solid rgba(61,214,200,.35)}
  .rm-name{font:600 14px 'Manrope',sans-serif}
  .rm-time{font:500 10px 'JetBrains Mono',monospace;color:#6a6f82}
  .rm-close{
    background:transparent;border:none;color:#8a8fa8;font:400 22px/1 'Manrope',sans-serif;
    cursor:pointer;padding:0 4px;transition:color .12s;
  }
  .rm-close:hover{color:#fff}
  .rm-body{
    flex:1;min-height:0;overflow-y:auto;padding:20px 24px;
    scrollbar-width:thin;scrollbar-color:rgba(201,168,76,.2) transparent;
    word-break:break-word;white-space:pre-wrap;
    font:400 12px/1.6 'Manrope',sans-serif;color:#c0c5d8;
  }
  .rm-actions{
    display:flex;justify-content:flex-end;gap:8px;align-items:center;flex-wrap:wrap;
    padding:12px 20px;border-top:1px solid rgba(120,130,160,.12);
  }
  .rm-action{
    padding:7px 14px;border-radius:7px;
    font:600 10px 'JetBrains Mono',monospace;letter-spacing:.3px;
    background:rgba(120,130,160,.08);border:1px solid rgba(120,130,160,.22);
    color:#c0c5d8;cursor:pointer;transition:all .12s;
  }
  .rm-action:hover{background:rgba(120,130,160,.16);border-color:rgba(120,130,160,.4);color:#fff}
  /* Same row, same shape — but it is a link, and it is the one action that
     fixes the cause rather than routing the symptom somewhere. */
  .rm-action-fix{
    display:inline-flex;align-items:center;text-decoration:none;
    background:rgba(201,168,76,.10);border-color:rgba(201,168,76,.45);color:#d4a84b;
  }
  .rm-action-fix:hover{background:rgba(201,168,76,.20);border-color:#d4a84b;color:#f0d9a0}
  .rm-action:disabled{opacity:.5;cursor:not-allowed}

  /* Send-to-fixer split button + dropdown */
  .rm-fixer-wrap{position:relative;display:inline-flex;align-items:stretch}
  .rm-fixer-primary{
    border-color:#ffb84a55;background:rgba(255,184,74,.08);color:#ffb84a;
    border-top-right-radius:0;border-bottom-right-radius:0;
  }
  .rm-fixer-primary:hover{background:rgba(255,184,74,.18);border-color:#ffb84a;color:#ffd28a}
  .rm-fixer-primary:disabled{color:#7a6a3a}
  .rm-fixer-dropdown{
    padding:7px 9px;border-radius:7px;
    border-top-left-radius:0;border-bottom-left-radius:0;border-left:none;
    font:600 11px 'JetBrains Mono',monospace;line-height:1;
    background:rgba(255,184,74,.08);border:1px solid #ffb84a55;color:#ffb84a;cursor:pointer;
  }
  .rm-fixer-dropdown:hover{background:rgba(255,184,74,.18);color:#ffd28a}
  .rm-fixer-dropdown:disabled{opacity:.5;cursor:not-allowed}
  .rm-fixer-menu{
    position:absolute;right:0;bottom:calc(100% + 4px);z-index:120;
    min-width:240px;max-width:340px;
    background:rgba(8,6,2,.96);border:1px solid #ffb84a55;border-radius:8px;
    box-shadow:0 8px 28px rgba(0,0,0,.55),0 0 18px rgba(255,184,74,.15);
    overflow:hidden;
  }
  .rm-fixer-menu-item{
    display:flex;flex-direction:column;align-items:flex-start;gap:2px;
    width:100%;padding:8px 12px;border:none;background:transparent;cursor:pointer;
    border-bottom:1px solid rgba(255,184,74,.08);text-align:left;
    transition:background .1s;
  }
  .rm-fixer-menu-item:last-child{border-bottom:none}
  .rm-fixer-menu-item:hover{background:rgba(255,184,74,.1)}
  .rm-fixer-menu-active{background:rgba(255,184,74,.16)}
  .rm-fixer-menu-name{font:700 11px 'Syne',sans-serif;color:#ffb84a;letter-spacing:.5px}
  .rm-fixer-menu-hint{font:400 10px 'Manrope',sans-serif;color:#8a7a5a;letter-spacing:.2px}
  .rm-fixer-status{
    font:600 10px 'JetBrains Mono',monospace;color:#9aa5b8;
    margin-right:auto;padding-left:4px;
  }

  /* Floating toast that confirms a "send to fixer" dispatch after the
     report modal closes. Anchored top-center to stay clear of the HQ bar. */
  .fixer-toast{
    position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:150;
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
  :global(.atag-anim-pulse   .atag-icon) { animation-name: -global-tag-pulse;   animation-duration: 1.0s; }
  :global(.atag-anim-spin    .atag-icon) { animation-name: -global-tag-spin;    animation-duration: 1.6s; animation-timing-function: linear; }
  :global(.atag-anim-shake   .atag-icon) { animation-name: -global-tag-shake;   animation-duration: .55s; animation-iteration-count: 3; }
  :global(.atag-anim-wobble  .atag-icon) { animation-name: -global-tag-wobble;  animation-duration: .8s; }
  :global(.atag-anim-bounce  .atag-icon) { animation-name: -global-tag-bounce;  animation-duration: .65s; }
  :global(.atag-anim-sparkle .atag-icon) { animation-name: -global-tag-sparkle; animation-duration: .9s; }
  :global(.atag-anim-pop     .atag-icon) { animation-name: -global-tag-pop;     animation-duration: .45s; animation-iteration-count: 1; }
  :global(.atag) { animation: -global-tag-card-in .22s cubic-bezier(.17,.88,.32,1.28); }

  /* ── Live agent meeting side panel — does NOT cover the 3D ────── */
  .lm-side-panel{
    position:absolute; top:64px; right:14px; bottom:14px; z-index:50;
    width:min(640px, 52vw);
    min-width:420px;
    pointer-events:auto;
    animation:lm-side-in .25s ease-out;
    /* Establish a real flex parent so .live-meeting-modal can size its
       children correctly when the panel itself sits in absolute position. */
    display:flex;
  }
  @keyframes lm-side-in {
    from { opacity:0; transform:translateX(20px); }
    to   { opacity:1; transform:translateX(0); }
  }
  .live-meeting-modal{
    width:100%; height:100%;
    min-height:0; /* allow flex children below to overflow:auto correctly */
    display:flex; flex-direction:column; padding:0;
    border:1px solid #2a2f4a; background:#0f1018;
    border-radius:8px;
    box-shadow:-8px 18px 60px rgba(0,0,0,.55);
    overflow:hidden; /* clip rounded corners */
  }
  .lm-head{
    flex-shrink:0;
    display:flex; align-items:flex-start; gap:10px;
    padding:14px 16px 10px; border-bottom:1px solid #1f2236;
  }
  .lm-titles{ flex:1; min-width:0; }
  .lm-title{
    font:700 14px 'Manrope',sans-serif; color:#e7e9f4;
    display:flex; align-items:center; gap:8px;
  }
  .lm-topic{
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .lm-sub{
    margin-top:6px; display:flex; flex-wrap:wrap; gap:6px; align-items:center;
    font:500 11px 'JetBrains Mono',monospace; color:#8b90af;
  }
  .lm-mod{ color:#c9a84c; }
  .lm-attendee{
    padding:1px 6px; border-radius:9px; border:1px solid #444; color:#cbd0e8;
    font-size:10px;
  }
  .lm-stat{ color:#6b7090; }
  .lm-parts{ color:#3a3f5a; }
  .lm-dot{ width:8px; height:8px; border-radius:50%; display:inline-block; }
  .lm-dot-pulse{ background:#5b8def; box-shadow:0 0 0 0 rgba(91,141,239,.6); animation:lm-pulse 1.6s infinite; }
  .lm-dot-done{ background:#78dc8c; }
  .lm-dot-fail{ background:#ef5d6e; }
  @keyframes lm-pulse {
    0%   { box-shadow:0 0 0 0 rgba(91,141,239,.55); }
    70%  { box-shadow:0 0 0 10px rgba(91,141,239,0); }
    100% { box-shadow:0 0 0 0 rgba(91,141,239,0); }
  }
  .lm-switcher{
    background:#161827; color:#cbd0e8; border:1px solid #2a2f4a;
    border-radius:6px; padding:4px 8px; font:500 11px 'JetBrains Mono',monospace;
    max-width:240px;
  }
  .lm-close{
    background:transparent; color:#6b7090; border:none; font-size:18px;
    cursor:pointer; padding:0 4px; line-height:1;
  }
  .lm-close:hover{ color:#e7e9f4; }

  .lm-transcript{
    flex:1 1 0; min-height:0; /* required so overflow-y:auto actually scrolls */
    overflow-y:auto; padding:12px 16px;
    display:flex; flex-direction:column; gap:12px;
    scroll-behavior:smooth;
  }
  .lm-transcript::-webkit-scrollbar{ width:8px; }
  .lm-transcript::-webkit-scrollbar-thumb{ background:#2a2f4a; border-radius:4px; }
  .lm-transcript::-webkit-scrollbar-thumb:hover{ background:#3a3f5a; }
  .lm-empty{
    text-align:center; color:#6b7090; padding:24px 0;
    font:500 12px 'JetBrains Mono',monospace;
  }
  .lm-turn{
    border:1px solid #1f2236; border-left:3px solid #2a2f4a;
    border-radius:6px; padding:10px 12px; background:#13152099;
    animation:lm-turn-in .25s ease-out;
  }
  .lm-turn-moderator{ border-left-color:#c9a84c; background:#1a160e80; }
  @keyframes lm-turn-in {
    from { opacity:0; transform:translateY(6px); }
    to   { opacity:1; transform:translateY(0); }
  }
  .lm-turn-head{
    display:flex; align-items:center; gap:8px; margin-bottom:6px;
    font:600 11px 'JetBrains Mono',monospace;
  }
  .lm-turn-name{ font-weight:700; }
  .lm-turn-meta{ margin-left:auto; color:#5a5f7a; font-size:10px; }
  .lm-turn-body{
    font:400 13px/1.55 'Manrope',sans-serif; color:#cbd0e8;
    word-break:break-word;
  }
  .lm-turn-body :global(p.md-p){ margin:.4em 0; }
  .lm-turn-body :global(h3.md-h){ margin:.7em 0 .25em; font:700 13px 'Manrope',sans-serif; color:#e7e9f4; }
  .lm-turn-body :global(h4.md-h){ margin:.6em 0 .2em; font:700 12px 'Manrope',sans-serif; color:#cbd0e8; }
  .lm-turn-body :global(h5.md-h){ margin:.5em 0 .15em; font:700 11px 'Manrope',sans-serif; color:#a8aec8; }
  .lm-turn-body :global(strong){ color:#e7e9f4; }
  .lm-turn-body :global(em){ color:#cbe0ff; }
  .lm-turn-body :global(code.md-code){ background:#161827; padding:1px 5px; border-radius:3px; font:500 11px 'JetBrains Mono',monospace; color:#cbe0ff; }
  .lm-turn-body :global(pre.md-codeblock){ background:#0a0b14; border:1px solid #1f2236; border-radius:4px; padding:8px 10px; margin:.4em 0; font:500 11px/1.45 'JetBrains Mono',monospace; color:#cbd0e8; overflow-x:auto; white-space:pre-wrap; }
  .lm-turn-body :global(ul.md-ul), .lm-turn-body :global(ol.md-ol){ margin:.3em 0 .3em 18px; padding:0; }
  .lm-turn-body :global(ul.md-ul li), .lm-turn-body :global(ol.md-ol li){ margin:.15em 0; }
  .lm-turn-body :global(a){ color:#5b8def; text-decoration:underline; }
  /* Plain-text variant (avoids markdown rendering CPU spike that froze 3D) */
  .lm-turn-body-pre{
    font:400 12px/1.5 'JetBrains Mono',monospace; color:#cbd0e8;
    margin:0; white-space:pre-wrap; word-break:break-word;
    background:transparent; padding:0; max-height:none;
  }
  .lm-show-btn{
    margin:auto;
    padding:10px 18px;
    background:#1a1d2c; color:#cbd0e8;
    border:1.5px solid #5b8def; border-radius:6px;
    font:600 12px 'JetBrains Mono',monospace;
    cursor:pointer; transition:all .12s;
  }
  .lm-show-btn:hover{ background:#252840; transform:translateY(-1px); }

  .lm-summary{
    flex-shrink:0;
    /* Cap so a long action_items list doesn't push the panel beyond the
       viewport — when it does grow past max-height it scrolls internally. */
    max-height:45%;
    overflow-y:auto;
    border-top:1px solid #1f2236; padding:10px 16px 14px;
    background:#0c0d14;
  }
  .lm-summary::-webkit-scrollbar{ width:8px; }
  .lm-summary::-webkit-scrollbar-thumb{ background:#2a2f4a; border-radius:4px; }
  .lm-summary::-webkit-scrollbar-thumb:hover{ background:#3a3f5a; }
  .lm-summary-h{
    font:700 11px 'JetBrains Mono',monospace; color:#78dc8c;
    margin:6px 0 4px; letter-spacing:.5px;
  }
  .lm-summary-list{
    margin:0 0 4px; padding-left:18px; color:#cbd0e8;
    font:400 12px/1.5 'Manrope',sans-serif;
    word-break:break-word;
  }
  .lm-summary-list li{ margin:2px 0; }

  /* ── Auto-Meeting modal: per-office grouped agent picker ─────────────── */
  .auto-meeting-modal{ width:min(720px, 94vw); max-height:88vh; overflow-y:auto; }
  /* Outer picker container — vertical stack of office sections. */
  .am-picker{
    display:flex; flex-direction:column; gap:10px;
    margin:4px 0 12px;
    max-height:260px; overflow-y:auto;
    padding:8px; border:1px solid #1f2236; border-radius:8px;
    background:#0c0d14;
  }
  /* One office's group: small flow-coloured header + grid of agent cards. */
  .am-flow-section{ display:flex; flex-direction:column; gap:6px; }
  .am-flow-head{
    display:flex; align-items:center; gap:8px;
    padding:2px 0 4px;
    border-bottom:1px dashed rgba(255,255,255,.06);
  }
  .am-flow-stripe{
    width:3px; height:14px; border-radius:2px;
    box-shadow:0 0 6px var(--c);
  }
  .am-flow-name{
    font:700 11px 'Manrope',sans-serif; letter-spacing:.4px;
    color:#e0e2ea; text-transform:uppercase;
  }
  .am-flow-count{
    font:600 10px 'JetBrains Mono',monospace;
    color:#8d92a8; background:rgba(255,255,255,.04);
    padding:1px 6px; border-radius:8px;
  }
  /* Medium square cards laid out in an auto-fill grid — names wrap to 2
   * lines if needed but the card height stays consistent. */
  .am-card-grid{
    display:grid;
    grid-template-columns:repeat(auto-fill, minmax(130px, 1fr));
    gap:6px;
  }
  .am-card{
    display:flex; flex-direction:column; align-items:center;
    gap:6px; padding:8px 6px;
    min-height:74px;
    background:#161827; color:#cbd0e8;
    border:1.5px solid #2a2f4a; border-radius:8px;
    cursor:pointer; transition:all .12s;
    text-align:center;
  }
  .am-card:hover{ background:#1a1d2c; border-color:var(--flow-c); }
  .am-card-av{
    width:28px; height:28px; border-radius:50%;
    display:inline-flex; align-items:center; justify-content:center;
    font:900 14px 'Manrope',sans-serif; line-height:1;
    text-shadow:0 1px 2px rgba(0,0,0,0.85);
    box-shadow:0 0 0 2px rgba(0,0,0,.35), 0 0 6px var(--flow-c);
    flex-shrink:0;
  }
  .am-card-init{ font:700 10px 'JetBrains Mono',monospace; color:#fff; }
  .am-card-name{
    font:600 10.5px/1.3 'Manrope',sans-serif;
    color:#cbd0e8;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
    overflow:hidden; word-break:break-word;
  }
  /* Selected states — gold for moderator, blue for attendee. */
  .am-card-mod-on{
    background:rgba(201,168,76,.18); color:#f4e1a3;
    border-color:#c9a84c; box-shadow:0 0 0 1px #c9a84c44, 0 0 12px rgba(201,168,76,.35);
  }
  .am-card-mod-on .am-card-name{ color:#f4e1a3; }
  .am-card-att-on{
    background:rgba(91,141,239,.18); color:#cbe0ff;
    border-color:#5b8def; box-shadow:0 0 0 1px #5b8def44, 0 0 10px rgba(91,141,239,.3);
  }
  .am-card-att-on .am-card-name{ color:#cbe0ff; }

  /* ── Management log panel (bottom-left) ─────────────────── */
  .mgmt-log{
    position:absolute; bottom:18px; left:18px; z-index:11;
    width:min(360px, 40vw);
    background:#0f1018; border:1px solid #2a2f4a; border-radius:8px;
    box-shadow:0 6px 22px rgba(0,0,0,.35);
    animation:lm-turn-in .3s ease-out;
    font:500 11px 'JetBrains Mono',monospace; color:#cbd0e8;
  }
  .mgmt-log-head{
    display:flex; align-items:center; gap:8px;
    padding:8px 12px; color:#e7e9f4;
    font:700 11px 'JetBrains Mono',monospace;
    border-bottom:1px solid #1f2236;
  }
  .mgmt-log-badge{
    background:#c67fe8; color:#0f1018; padding:1px 7px; border-radius:10px;
    font:700 10px 'JetBrains Mono',monospace;
  }
  .mgmt-log-label{ flex:1; text-align:left; }
  .mgmt-log-close{
    background:transparent; border:none; color:#6b7090; cursor:pointer;
    font:700 14px 'JetBrains Mono',monospace; padding:0 4px; line-height:1;
  }
  .mgmt-log-close:hover{ color:#fff; }
  .mgmt-log-body{
    max-height:360px; overflow-y:auto; padding:4px;
  }
  .mgmt-log-body::-webkit-scrollbar{ width:6px; }
  .mgmt-log-body::-webkit-scrollbar-thumb{ background:#2a2f4a; border-radius:3px; }
  .mgmt-entry{
    border-left:3px solid #c67fe8; padding:6px 10px; margin:2px 0;
    background:#13152080;
  }
  .mgmt-entry-head{
    display:flex; align-items:center; gap:6px; flex-wrap:wrap;
    font:600 11px 'JetBrains Mono',monospace;
  }
  .mgmt-entry-from{ color:#e7e9f4; }
  .mgmt-entry-arrow{ color:#5a5f7a; }
  .mgmt-entry-to{ color:#cbe0ff; }
  .mgmt-entry-tag{
    font-size:9px; padding:0 5px; border-radius:3px;
    background:#1a1d2c; color:#8b90af; border:1px solid #2a2f4a;
  }
  .mgmt-entry-tag-mgr{ background:#3a2812; color:#f0b874; border-color:#6a4820; }
  .mgmt-entry-detail{
    margin-top:3px; color:#cbd0e8; font:500 11px 'Manrope',sans-serif;
    word-break:break-word;
  }
  .mgmt-entry-preview{
    margin-top:3px; padding:4px 6px; background:#0a0b14; border-radius:3px;
    color:#8b90af; font:400 10px 'JetBrains Mono',monospace;
    white-space:pre-wrap; word-break:break-word;
  }

  /* ── Meeting history panel (top-left, under stats bar) ──────────
     Positioned on the left so it doesn't fight the live-meeting modal,
     which now occupies the entire right column. */
  .hist-panel{
    position:absolute; top:60px; left:18px; z-index:11;
    width:min(340px, 38vw);
    background:#0f1018; border:1px solid #2a2f4a; border-radius:8px;
    box-shadow:0 6px 22px rgba(0,0,0,.35);
    animation:lm-turn-in .3s ease-out;
    font:500 11px 'JetBrains Mono',monospace; color:#cbd0e8;
  }
  .hist-head{
    display:flex; align-items:center; gap:8px;
    padding:8px 12px; color:#e7e9f4;
    font:700 11px 'JetBrains Mono',monospace;
    border-bottom:1px solid #1f2236;
  }
  .hist-head-badge{
    background:#ffd166; color:#0f1018; padding:1px 7px; border-radius:10px;
    font:700 10px 'JetBrains Mono',monospace;
  }
  .hist-head-label{ flex:1; }
  .hist-head-close{
    background:transparent; border:none; color:#6b7090; cursor:pointer;
    font:700 14px 'JetBrains Mono',monospace; padding:0 4px; line-height:1;
  }
  .hist-head-close:hover{ color:#fff; }
  .hist-clear-all{
    padding:2px 8px; background:#2a1818; color:#ffb4b4;
    border:1px solid #553030; border-radius:4px;
    cursor:pointer; font:600 10px 'JetBrains Mono',monospace;
    transition:background .12s, color .12s;
  }
  .hist-clear-all:hover{ background:#3a2020; color:#ff7a7a; }
  .hist-row-x{
    margin-left:auto; padding:0 6px; background:transparent;
    color:#5a5f7a; border:1px solid transparent; border-radius:3px;
    cursor:pointer; font:700 11px 'JetBrains Mono',monospace;
    line-height:1.2;
    transition:color .12s, border-color .12s, background .12s;
  }
  .hist-row-x:hover{ color:#ff7a7a; border-color:#553030; background:#2a1818; }
  .hist-badge{
    background:#ffd166; color:#0f1018; padding:1px 7px; border-radius:10px;
    font:700 10px 'JetBrains Mono',monospace;
  }
  .hist-label{ flex:1; text-align:left; }
  .hist-chev{ color:#6b7090; }
  .hist-body{
    max-height:50vh; overflow-y:auto; padding:4px;
  }
  .hist-body::-webkit-scrollbar{ width:6px; }
  .hist-body::-webkit-scrollbar-thumb{ background:#2a2f4a; border-radius:3px; }
  .hist-row{
    display:block; width:100%; text-align:left;
    border:none; background:#13152080;
    border-left:3px solid #5b8def;
    padding:7px 10px; margin:3px 0;
    cursor:pointer; color:#cbd0e8;
    font:500 11px 'JetBrains Mono',monospace;
    transition:background .12s, transform .12s;
  }
  .hist-row:hover{ background:#1a1d2c; transform:translateX(-2px); }
  .hist-row-started{ border-left-color:#ffd166; }
  .hist-row-completed{ border-left-color:#78dc8c; }
  .hist-row-failed{ border-left-color:#ff6b6b; }
  .hist-row-requested{ border-left-color:#5b8def; }
  .hist-row-head{
    display:flex; align-items:center; gap:6px; font:700 11px 'JetBrains Mono',monospace;
    color:#e7e9f4;
  }
  .hist-dot{
    width:7px; height:7px; border-radius:50%;
    flex-shrink:0;
  }
  .hist-dot-live{ background:#ffd166; animation:hist-pulse 1.4s ease-in-out infinite; }
  .hist-dot-done{ background:#78dc8c; }
  .hist-dot-fail{ background:#ff6b6b; }
  .hist-dot-pending{ background:#5b8def; }
  @keyframes hist-pulse{ 0%,100%{opacity:1;} 50%{opacity:.4;} }
  .hist-row-topic{ flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .hist-row-meta{
    display:flex; gap:5px; flex-wrap:wrap; margin-top:3px;
    font-size:10px; color:#7e84a3;
  }
  .hist-row-summary{
    margin-top:4px; font-size:10px; color:#9298b8; line-height:1.4;
  }

  .lm-toast{
    position:absolute; bottom:18px; right:18px; z-index:10;
    background:#161827; color:#e7e9f4;
    padding:10px 16px; border-radius:22px; cursor:pointer;
    font:700 12px 'JetBrains Mono',monospace;
    display:flex; align-items:center; gap:10px;
    animation:lm-turn-in .3s ease-out;
  }
  .lm-toast-live{ border:1.5px solid #5b8def; box-shadow:0 6px 22px rgba(91,141,239,.4); }
  .lm-toast-done{ border:1.5px solid #78dc8c; box-shadow:0 4px 14px rgba(120,220,140,.25); }
  .lm-toast:hover{ background:#1a1d2c; transform:translateY(-1px); }

  /* ── Sent-email link + modal ── */
  .email-view-link{
    display:inline-flex; align-items:center; gap:3px; margin-left:6px;
    padding:1px 7px; font:600 10px 'Manrope',sans-serif; cursor:pointer;
    color:#9fd0ff; background:rgba(91,141,239,.12); border:1px solid rgba(91,141,239,.45);
    border-radius:999px; white-space:nowrap;
  }
  .email-view-link:hover{ background:rgba(91,141,239,.28); color:#fff; }
  .email-modal-backdrop{
    position:fixed; inset:0; z-index:9999; display:flex; align-items:center; justify-content:center;
    background:rgba(2,2,6,.72); backdrop-filter:blur(3px); padding:24px;
  }
  .email-modal{
    width:min(680px,94vw); max-height:86vh; display:flex; flex-direction:column;
    background:#0d1018; border:1px solid #2a3350; border-radius:12px;
    box-shadow:0 18px 60px rgba(0,0,0,.6); overflow:hidden;
  }
  .email-modal-head{
    display:flex; align-items:center; justify-content:space-between;
    padding:12px 16px; border-bottom:1px solid #1e2335; background:#11151f;
  }
  .email-modal-title{ font:700 13px 'Manrope',sans-serif; color:#e6ecff; }
  .email-modal-close{
    width:26px; height:26px; border-radius:6px; border:1px solid #2a3350; background:transparent;
    color:#9aa3bd; font-size:18px; line-height:1; cursor:pointer;
  }
  .email-modal-close:hover{ background:#1a1f30; color:#fff; }
  .email-modal-meta{ padding:12px 16px; border-bottom:1px solid #1a1f30; display:flex; flex-direction:column; gap:4px; }
  .emm-row{ display:grid; grid-template-columns:64px 1fr; gap:8px; font:500 12px 'Manrope',sans-serif; }
  .emm-k{ color:#6b7390; font-weight:600; text-transform:uppercase; font-size:10px; padding-top:2px; }
  .emm-v{ color:#cdd5ec; word-break:break-word; }
  .emm-subj{ color:#fff; font-weight:600; }
  .email-modal-body{ padding:14px 16px; overflow:auto; }
  .email-modal-text{ font:400 13px/1.6 'Manrope',sans-serif; color:#cdd5ec; white-space:pre-wrap; }
  .email-modal-html{ font-size:13px; line-height:1.6; color:#cdd5ec; }
  .email-modal-html :global(a){ color:#9fd0ff; }
  .email-modal-dim{ color:#6b7390; }
  .email-modal-err{ color:#ff8a8a; }
</style>
