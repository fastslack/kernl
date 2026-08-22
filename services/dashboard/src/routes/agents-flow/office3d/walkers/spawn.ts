/** Walker spawn functions — sendWalker / sendWalkerToPoint / sendCommuteWalker.
 *  Extracted from walkers.ts (structural refactor). */

import { rt } from '../runtime.js';
import type { Vec3, Walker, RoomInfo, Aabb2D } from '../types.js';
import type { CorridorGrid } from '../floor-plan.js';
import { nearestCorridorNode } from '../floor-plan.js';
import { resolveSkin } from '../skins/index.js';
import { buildCumDist, pathLength } from '../anim/path.js';
import type { SittingWorkers, CommuteWalkerOpts } from './types.js';
import {
  buildPath,
  avoidDesks,
  roomAabbs,
  meetingRoomAabbs,
  nearestHCorrZ,
  nearestVCorrX,
  nearestVCorrXBetween,
  exitViaDoor,
  enterViaDoor,
  rectAsRoom,
  meetingTableAabb,
} from './pathfinding.js';

// Local helper — resolve the agent's skin from the shared registry, then
// build the per-mesh humanoid in the right outfit.
function buildWalkerHumanoid(srcId: string, agents: Array<{ id: string; skin_id?: string }>, color: string) {
  const agent = agents.find(a => a.id === srcId);
  const skin = resolveSkin(agent?.skin_id);
  const palette = skin.pickPalette(srcId);
  return skin.createHumanoid({ flowColor: color, palette, scale: 1.3, walker: true });
}

const BASE_MAX_WALKERS = 6;
const WALK_SPEED_UNITS_PER_SEC = 7; // brisker walking pace (was 5 — read as too slow)

/** Scale max walkers with office size */
function maxWalkers(agentCount: number): number {
  return Math.max(BASE_MAX_WALKERS, Math.min(20, Math.ceil(agentCount / 4)));
}

/** Spawn a walking messenger.
 *  When sittingWorkers is provided, the source's seated humanoid is hidden during the trip
 *  and restored when the walker returns. The walker arrives in front of the target desk
 *  (not on top of the seated worker) and faces the target during the talk phase.
 */
export function sendWalker(
  scene: any,
  walkers: Walker[],
  srcId: string,
  tgtId: string,
  deskPos: Map<string, Vec3>,
  rooms: Map<string, RoomInfo>,
  corridorGrid: CorridorGrid,
  agents: Array<{ id: string; flow_id: string; skin_id?: string }>,
  color: string,
  message?: string,
  sittingWorkers?: SittingWorkers,
  deskAabbs?: Map<string, Aabb2D>,
  meetingRoomObstacles?: ReadonlyArray<{ cx: number; cz: number; w: number; d: number }>,
): void {
  if (!rt.THREE || !scene) return;
  if (walkers.length >= maxWalkers(agents.length)) return;
  // RULE: one walker per agent — if this agent already has a walker, skip
  if (walkers.some(w => w.sourceId === srcId)) return;
  const from = deskPos.get(srcId);
  const to = deskPos.get(tgtId);
  if (!from || !to) return;

  // Obstacle list: every desk except the walker's own src/tgt (endpoints are
  // at or near those desks, so including them would produce spurious detours).
  const deskObstacles: Aabb2D[] = deskAabbs
    ? Array.from(deskAabbs.values()).filter(b => b.agentId !== srcId && b.agentId !== tgtId)
    : [];

  const srcAgent = agents.find(a => a.id === srcId);
  const tgtAgent = agents.find(a => a.id === tgtId);
  const srcRoom = srcAgent ? rooms.get(srcAgent.flow_id || '_none') : undefined;
  const tgtRoom = tgtAgent ? rooms.get(tgtAgent.flow_id || '_none') : undefined;

  // Walls cannot be crossed: every room except the walker's own src/tgt
  // (their desks live inside the AABB) is a forbidden zone. Combined with
  // desk AABBs into one obstacle list that buildPath's avoidance pass will
  // route around — guaranteeing no diagonal cuts through neighbouring rooms.
  const obstacles: Aabb2D[] = [
    ...deskObstacles,
    ...roomAabbs(rooms, new Set([srcRoom, tgtRoom])),
    ...(meetingRoomObstacles ? meetingRoomAabbs(meetingRoomObstacles) : []),
  ];

  // The seated worker is at z = 0.55 from desk center (see furniture.ts).
  // The desk top extends from z = -0.65 to z = 0.65.
  // Walker should stand "in front" of the desk on the side AWAY from the chair,
  // i.e. at z = -1.0 from desk center (in front of the monitor side).
  // The seated worker faces the desk (rotation.y = PI), so "in front" = -z direction.
  const targetStandPos: Vec3 = { x: to.x, y: 0, z: to.z - 1.5 };
  // Where the seated target worker actually sits (for facing direction)
  const targetWorkerPos = { x: to.x, z: to.z + 0.55 };

  // Hide the seated source worker — they "stood up" to deliver the message
  if (sittingWorkers) {
    const seatedSrc = sittingWorkers.get(srcId);
    if (seatedSrc) seatedSrc.setVisible(false);
  }

  // Build path through corridors, ending in front of target desk (not on top of worker)
  const forwardPts = buildPath(from, targetStandPos, srcRoom, tgtRoom, corridorGrid, obstacles);
  const returnPts = [...forwardPts].reverse();
  const dist = pathLength(forwardPts);

  // Lateral offset perpendicular to first path segment to avoid walker overlap.
  // Clamped to ±1.2: corridors are 6 units wide (half-width 3), and the path
  // runs down the corridor centre line, so anything past ~1.2 risks clipping a
  // wall when several walkers are out at once (the old 0.3 + n*0.15 reached
  // ~3.3 with a full house — wider than half the corridor).
  const lateralOffset =
    (walkers.length % 2 === 0 ? 1 : -1) * Math.min(1.2, 0.3 + walkers.length * 0.15);

  // Same skin + palette as the seated worker — visual identity travels with the agent.
  const h = buildWalkerHumanoid(srcId, agents, color);
  h.group.position.set(from.x, 0, from.z);
  // Tag the moving group so the raycaster can resolve hover/click to this agent
  // wherever it currently is (walking the floor, not just seated at its desk).
  h.group.userData.agentId = srcId;
  h.group.userData.isWalker = true;
  // Collect fadeable materials once — avoids traversing the subtree every frame.
  const fadeMats: any[] = [];
  h.group.traverse((c: any) => {
    if (c.material) {
      c.material.transparent = true;
      c.material.opacity = 0;
      fadeMats.push(c.material);
    }
  });
  scene.add(h.group);

  // Glowing envelope (emissive only — no PointLight, saves GPU per walker)
  const envelope = new rt.THREE.Mesh(
    new rt.THREE.BoxGeometry(0.35, 0.25, 0.05),
    new rt.THREE.MeshBasicMaterial({ color: new rt.THREE.Color(color), transparent: true, opacity: 0.9 }),
  );
  envelope.position.set(0, -0.45, 0.15);
  h.rightArm.add(envelope);

  // Ground glow (replaces following PointLight — purely visual, zero GPU cost)
  const glow = new rt.THREE.Mesh(
    new rt.THREE.CircleGeometry(1.5, 12),
    new rt.THREE.MeshBasicMaterial({ color: new rt.THREE.Color(color), transparent: true, opacity: 0.18, side: 2 }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.03;
  h.group.add(glow);

  // Message bubble
  let bubble: any = null;
  if (message) {
    const bd = document.createElement('div');
    bd.textContent = message;
    bd.style.cssText = `font:600 9px 'Fira Code',monospace;color:#111;
      background:#f0f0e8;border:2px solid #222;padding:3px 8px;
      border-radius:4px;box-shadow:2px 3px 0 #000;
      white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis;`;
    bubble = new rt.CSS2DObject(bd);
    bubble.position.set(0, 2.4, 0);
    h.group.add(bubble);
  }

  // Pre-compute cumulative distances for O(log n) interpolation
  const fwdCumDist = buildCumDist(forwardPts);
  const retCumDist = buildCumDist(returnPts);

  const walkerObj: Walker = {
    group: h.group,
    leftLeg: h.leftLeg, rightLeg: h.rightLeg,
    leftArm: h.leftArm, rightArm: h.rightArm,
    torso: h.torso, head: h.head,
    envelope, light: glow,
    curve: forwardPts,
    returnCurve: returnPts,
    progress: 0,
    speed: 0,
    age: 0, maxAge: 30, // maxAge now in seconds (was 1800 frames @ 60fps = 30s)
    arrived: false, returning: false,
    sourceId: srcId, targetId: tgtId,
    color: new rt.THREE.Color(color), bubble,
    unitsPerSec: WALK_SPEED_UNITS_PER_SEC,
    pathLength: dist,
    fwdCumDist,
    retCumDist,
    talkPhase: Math.random() * Math.PI * 2,
    lateralOffset,
    arrivedSec: 0,
    timeSec: 0,
    talkFacingPos: targetWorkerPos,
    fadeState: 1, // fading in
    fadeProgress: 0,
    fadeMats,
  };

  walkers.push(walkerObj);
}

/** Send a walker from an agent's desk to an arbitrary point (e.g. meeting room, my office). No return trip. */
export function sendWalkerToPoint(
  scene: any,
  walkers: Walker[],
  srcId: string,
  targetPoint: Vec3,
  deskPos: Map<string, Vec3>,
  rooms: Map<string, RoomInfo>,
  corridorGrid: CorridorGrid,
  agents: Array<{ id: string; flow_id: string; skin_id?: string }>,
  color: string,
  message?: string,
  deskAabbs?: Map<string, Aabb2D>,
  customTargetId?: string,
  sittingWorkers?: SittingWorkers,
  urgent?: boolean,
  // Optional waypoint inserted between the corridor and the final target. Use
  // this for meeting rooms so walkers enter through the door midpoint instead
  // of cutting diagonally through walls to reach a chair on the far side.
  viaPoint?: Vec3,
  // Optional callback fired once the walker reaches its destination. Used by
  // report-walkers to drop a paper note on the top agent's desk.
  onArriveCallback?: () => void,
  // When true, attach a visible paper-note prop to the right hand so the
  // walker is seen carrying their report into the top agent's office.
  carryNote?: boolean,
  // Meeting rooms treated as wall obstacles. When the walker's target IS a
  // meeting room (e.g. seat inside one), the caller should pass the slot
  // index in meetingRoomObstacleExempt so that room isn't an obstacle.
  meetingRoomObstacles?: ReadonlyArray<{ cx: number; cz: number; w: number; d: number }>,
  meetingRoomObstacleExempt?: number,
  // Meeting attendees: stay seated until explicitly dismissed (meeting_ended /
  // End Meeting). Disables the auto-return timer and stretches the age-safety
  // ceiling so long LLM meetings don't evict walkers mid-conversation.
  stay?: boolean,
  // Optional point the walker should turn to face on arrival (e.g. the
  // executive desk so a seated visitor in My Office looks at the top agent).
  // When omitted the walker keeps its incoming heading.
  facePoint?: Vec3,
): void {
  if (!rt.THREE || !scene) return;
  if (walkers.length >= maxWalkers(agents.length)) return;
  // RULE: one walker per agent — if this agent already has a walker, skip
  if (walkers.some(w => w.sourceId === srcId)) return;
  const from = deskPos.get(srcId);
  if (!from) return;

  // Hide the seated source worker — they "stood up" to walk
  if (sittingWorkers) {
    const seatedSrc = sittingWorkers.get(srcId);
    if (seatedSrc) seatedSrc.setVisible(false);
  }

  const srcAgent = agents.find(a => a.id === srcId);
  const srcRoom = srcAgent ? rooms.get(srcAgent.flow_id || '_none') : undefined;

  // Find which room contains the destination point — if the walker is
  // walking into a room (My Office, a meeting room, …), that room must be
  // exempt from the avoidance pass. Otherwise its walls count as
  // obstacles and the L-shaped detour ends up cutting a diagonal back
  // across an adjacent room's wall (the user-reported bug: "el monigote
  // mete diagonales y atraviesa paredes").
  const targetRoom = (() => {
    for (const r of rooms.values()) {
      if (
        targetPoint.x >= r.cx - r.w / 2 && targetPoint.x <= r.cx + r.w / 2 &&
        targetPoint.z >= r.cz - r.d / 2 && targetPoint.z <= r.cz + r.d / 2
      ) return r;
    }
    return undefined;
  })();

  // Obstacles: every desk except the walker's own source desk + every room
  // except the source office AND the destination room. Combined into one
  // list so the avoidance pass routes around both walls and other desks.
  const deskObstacles: Aabb2D[] = deskAabbs
    ? Array.from(deskAabbs.values()).filter(b => b.agentId !== srcId)
    : [];
  // The table inside the room we are walking INTO is solid. Every other
  // meeting room is already excluded wholesale by meetingRoomAabbs, so only
  // the exempt one needs its furniture spelled out.
  const exemptSlot =
    meetingRoomObstacles && meetingRoomObstacleExempt !== undefined && meetingRoomObstacleExempt >= 0
      ? meetingRoomObstacles[meetingRoomObstacleExempt]
      : undefined;
  const obstacles: Aabb2D[] = [
    ...deskObstacles,
    ...roomAabbs(rooms, new Set([srcRoom, targetRoom])),
    ...(meetingRoomObstacles
      ? meetingRoomAabbs(meetingRoomObstacles, meetingRoomObstacleExempt ?? -1)
      : []),
    ...(exemptSlot ? [meetingTableAabb(exemptSlot)] : []),
  ];

  // Build path: desk → door → corridor → target point (using real corridor positions)
  const pts: Vec3[] = [];
  pts.push({ ...from });

  if (srcRoom && corridorGrid.segments.length > 0) {
    // Use exact door position (respects doorDir: left/right/top/bottom)
    const srcDoorX = (srcRoom as any).doorX ?? srcRoom.cx;
    const srcDoorZ = (srcRoom as any).doorCZ ?? srcRoom.doorZ;

    // Inside room → line up on the opening → out through the door. This used
    // to be a hardcoded X-first L-shape, which is only correct for a door on
    // a ±Z wall. Six of the nine offices on the live floor have side doors,
    // and their desks sit further off-centre than the opening is wide, so
    // every walker leaving one of them stepped through solid wall.
    pts.push(...exitViaDoor(from, srcRoom));

    // Step into nearest corridor
    const srcCorrNode = nearestCorridorNode({ x: srcDoorX, y: 0, z: srcDoorZ }, corridorGrid);
    pts.push({ ...srcCorrNode });

    // Walk corridors to target. Aim at the DOORWAY, not at the destination
    // itself: picking the corridor node nearest the seat can land the walker
    // on the far side of the room from its only door, and the leg from there
    // to the doorway then cuts back across the room. buildPath has always
    // aimed at the door; this one aimed at the target.
    const approach = viaPoint ?? targetPoint;
    const tgtCorrNode = nearestCorridorNode(approach, corridorGrid);
    if (Math.abs(srcCorrNode.x - tgtCorrNode.x) > 1 || Math.abs(srcCorrNode.z - tgtCorrNode.z) > 1) {
      const srcHZ = nearestHCorrZ(srcCorrNode.z, corridorGrid);
      const tgtHZ = nearestHCorrZ(tgtCorrNode.z, corridorGrid);
      if (Math.abs(srcCorrNode.x - tgtCorrNode.x) > 1) {
        const vCorrX = nearestVCorrXBetween(srcCorrNode.x, tgtCorrNode.x, corridorGrid);
        pts.push({ x: vCorrX, y: 0, z: srcHZ });
        if (Math.abs(srcHZ - tgtHZ) > 1) {
          pts.push({ x: vCorrX, y: 0, z: tgtHZ });
        }
        pts.push({ x: tgtCorrNode.x, y: 0, z: tgtHZ });
      } else if (Math.abs(srcHZ - tgtHZ) > 1) {
        const vCorrX = nearestVCorrX(srcCorrNode.x, corridorGrid);
        pts.push({ x: vCorrX, y: 0, z: srcHZ });
        pts.push({ x: vCorrX, y: 0, z: tgtHZ });
      }
    }
    pts.push({ ...tgtCorrNode });
  }
  // Getting IN is the same problem as getting out, and it was never solved
  // here at all: the path went corridor → destination in one straight shot.
  // For anything sitting inside an office — the power console in the data
  // centre, a visitor's chair — that shot crosses the office wall wherever it
  // happens to land. Route through that room's own door instead.
  if (targetRoom) {
    pts.push(...enterViaDoor(targetPoint, targetRoom));
  } else if (viaPoint) {
    // Meeting rooms aren't in the `rooms` map — they hand us their door
    // midpoint instead. Wrap the slot so the walker gets the same treatment
    // an office gets: square up on the doorway, step through, and only then
    // turn toward the seat. Dropping the raw door point in and heading
    // straight for the chair leaves on a diagonal that scrapes the wall.
    const slot =
      meetingRoomObstacles && meetingRoomObstacleExempt !== undefined && meetingRoomObstacleExempt >= 0
        ? meetingRoomObstacles[meetingRoomObstacleExempt]
        : undefined;
    if (slot) {
      // stopInsideDoor: the table sits on the room's centreline, so the
      // generic slide waypoint would land on it. Stop at the doorway and
      // let the avoidance pass walk around the table to the chair.
      pts.push(...enterViaDoor(targetPoint, rectAsRoom(slot, viaPoint), { stopInsideDoor: true }));
    } else {
      pts.push({ ...viaPoint });
    }
  }
  pts.push({ ...targetPoint });

  // Clean duplicates
  const dedup: Vec3[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = dedup[dedup.length - 1];
    if (Math.abs(pts[i].x - prev.x) > 0.3 || Math.abs(pts[i].z - prev.z) > 0.3) dedup.push(pts[i]);
  }
  // Route around desk AABBs
  const clean = avoidDesks(dedup, obstacles);

  const dist = pathLength(clean);
  const fwdCumDist = buildCumDist(clean);
  const returnPts = [...clean].reverse();
  const retCumDist = buildCumDist(returnPts);

  const h = buildWalkerHumanoid(srcId, agents, color);
  h.group.position.set(from.x, 0, from.z);
  // Hoverable/clickable while walking AND while seated in a meeting room.
  h.group.userData.agentId = srcId;
  h.group.userData.isWalker = true;
  scene.add(h.group);

  // Ground glow only (no PointLight — saves GPU)
  const glow = new rt.THREE.Mesh(
    new rt.THREE.CircleGeometry(1, 10),
    new rt.THREE.MeshBasicMaterial({ color: new rt.THREE.Color(color), transparent: true, opacity: 0.12, side: 2 }),
  );
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.03;
  h.group.add(glow);

  let bubble: any = null;
  if (message) {
    const bd = document.createElement('div');
    bd.textContent = message;
    bd.style.cssText = `font:600 9px 'Fira Code',monospace;color:#111;
      background:#f0f0e8;border:2px solid #222;padding:3px 8px;
      border-radius:4px;box-shadow:2px 3px 0 #000;white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis;`;
    bubble = new rt.CSS2DObject(bd);
    bubble.position.set(0, 2.4, 0);
    h.group.add(bubble);
  }

  // Visible paper-note prop in the right hand for report deliveries. Folded
  // letter look — white sheet, bottom strip tinted with the sender's flow
  // color so the top agent knows who walked in. The mesh is disposed when
  // the onArriveCallback fires (it hands the note off to the desk stack).
  let envelopeMesh: any = { parent: null, geometry: { dispose() {} }, material: { dispose() {} } };
  if (carryNote) {
    const noteSheet = new rt.THREE.Mesh(
      new rt.THREE.BoxGeometry(0.22, 0.28, 0.018),
      new rt.THREE.MeshStandardMaterial({ color: 0xf2eeda, roughness: 0.85, metalness: 0.02 }),
    );
    const band = new rt.THREE.Mesh(
      new rt.THREE.BoxGeometry(0.22, 0.06, 0.02),
      new rt.THREE.MeshStandardMaterial({ color: new rt.THREE.Color(color), roughness: 0.6, metalness: 0.05 }),
    );
    band.position.set(0, -0.09, 0);
    noteSheet.add(band);
    // Anchor at hand grip — slightly forward + below the shoulder so it reads
    // as "held" rather than "floating".
    noteSheet.position.set(0, -0.45, 0.18);
    noteSheet.rotation.x = -0.25;
    h.rightArm.add(noteSheet);
    envelopeMesh = noteSheet;
  }

  walkers.push({
    group: h.group,
    leftLeg: h.leftLeg, rightLeg: h.rightLeg,
    leftArm: h.leftArm, rightArm: h.rightArm,
    torso: h.torso, head: h.head,
    envelope: envelopeMesh,
    light: glow, curve: clean, returnCurve: returnPts,
    // stay=true (meetings): 2h ceiling — the dismiss comes from meeting_ended /
    // End Meeting; the safety only fires if that signal never arrives.
    progress: 0, speed: 0, age: 0, maxAge: stay ? 7200 : 60,
    arrived: false, returning: false, stayAtTarget: stay,
    sourceId: srcId, targetId: customTargetId ?? 'meeting',
    color: new rt.THREE.Color(color), bubble,
    unitsPerSec: WALK_SPEED_UNITS_PER_SEC,
    pathLength: dist,
    fwdCumDist, retCumDist,
    timeSec: 0, arrivedSec: 0,
    urgent,
    onArriveCallback,
    talkFacingPos: facePoint,
  });
}

export function sendCommuteWalker(opts: CommuteWalkerOpts): void {
  if (!rt.THREE || !opts.scene) return;
  if (opts.walkers.length >= maxWalkers(opts.agents.length)) return;
  // RULE: one walker per agent. If this agent already has any walker in
  // flight, skip — the user is button-mashing pause/resume.
  if (opts.walkers.some(w => w.sourceId === opts.agentId)) return;

  const desk = opts.deskPos.get(opts.agentId);
  if (!desk) return;

  const srcAgent = opts.agents.find(a => a.id === opts.agentId);
  const srcRoom = srcAgent ? opts.rooms.get(srcAgent.flow_id || '_none') : undefined;
  if (!srcRoom) return;

  // Hide the seated worker the instant the walker spawns — for BOTH modes.
  // LEAVE: agent stood up. ARRIVE: the agent's seated humanoid was just
  // (re)created by buildDesks when active flipped 0→1; without proactively
  // hiding it here we get the duplicate-humanoid bug (seated AND walking at
  // the same time) until the walker fades out at the desk. restoreSeated-
  // OnArrive then re-shows it at the end of the fade.
  if (opts.sittingWorkers) {
    const seated = opts.sittingWorkers.get(opts.agentId);
    if (seated) seated.setVisible(false);
  }

  // Build a desk→exit path through corridors, then reverse for ARRIVE. The
  // path MUST stay on actual corridor segments — a straight line between two
  // corridor nodes that sit at different X *and* different Z cuts diagonally
  // through office walls. Mirrors the H/V L-shape logic in sendWalker so the
  // walker turns at corridor junctions instead of teleporting through walls.
  //
  // Obstacles include every desk (minus our own) AND every room (minus the
  // walker's own office). That's the "walls can never be crossed" rule the
  // user wants: any segment that tries to cut through a neighbouring room
  // gets rerouted around it by the avoidance pass.
  const deskObstacles: Aabb2D[] = opts.deskAabbs
    ? Array.from(opts.deskAabbs.values()).filter(b => b.agentId !== opts.agentId)
    : [];
  const obstacles: Aabb2D[] = [
    ...deskObstacles,
    ...roomAabbs(opts.rooms, new Set([srcRoom])),
    ...(opts.meetingRoomObstacles ? meetingRoomAabbs(opts.meetingRoomObstacles) : []),
  ];

  const pts: Vec3[] = [];
  pts.push({ ...desk });
  if (opts.corridorGrid.segments.length > 0) {
    const srcDoorX = (srcRoom as any).doorX ?? srcRoom.cx;
    const srcDoorZ = (srcRoom as any).doorCZ ?? srcRoom.doorZ;
    pts.push(...exitViaDoor(desk, srcRoom));
    const srcCorrNode = nearestCorridorNode({ x: srcDoorX, y: 0, z: srcDoorZ }, opts.corridorGrid);
    pts.push({ ...srcCorrNode });

    // Traverse corridors with proper H/V routing — never jump diagonally
    // between corridor nodes that don't share a straight segment.
    const tgtCorrNode = nearestCorridorNode(opts.exitPoint, opts.corridorGrid);
    if (Math.abs(srcCorrNode.x - tgtCorrNode.x) > 1 || Math.abs(srcCorrNode.z - tgtCorrNode.z) > 1) {
      const srcHZ = nearestHCorrZ(srcCorrNode.z, opts.corridorGrid);
      const tgtHZ = nearestHCorrZ(tgtCorrNode.z, opts.corridorGrid);
      if (Math.abs(srcCorrNode.x - tgtCorrNode.x) > 1) {
        const vCorrX = nearestVCorrXBetween(srcCorrNode.x, tgtCorrNode.x, opts.corridorGrid);
        pts.push({ x: vCorrX, y: 0, z: srcHZ });
        if (Math.abs(srcHZ - tgtHZ) > 1) {
          pts.push({ x: vCorrX, y: 0, z: tgtHZ });
        }
        pts.push({ x: tgtCorrNode.x, y: 0, z: tgtHZ });
      } else if (Math.abs(srcHZ - tgtHZ) > 1) {
        const vCorrX = nearestVCorrX(srcCorrNode.x, opts.corridorGrid);
        pts.push({ x: vCorrX, y: 0, z: srcHZ });
        pts.push({ x: vCorrX, y: 0, z: tgtHZ });
        pts.push({ x: tgtCorrNode.x, y: 0, z: tgtHZ });
      }
    }
    pts.push({ ...tgtCorrNode });
  }
  pts.push({ ...opts.exitPoint });

  // Dedupe + obstacle-avoid (same passes as the messaging walkers).
  const dedup: Vec3[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = dedup[dedup.length - 1];
    if (Math.abs(pts[i].x - prev.x) > 0.3 || Math.abs(pts[i].z - prev.z) > 0.3) dedup.push(pts[i]);
  }
  const corridorPath = avoidDesks(dedup, obstacles);
  // Reverse for ARRIVE — same waypoints, opposite direction.
  let forward = opts.mode === 'arrive' ? [...corridorPath].reverse() : corridorPath;

  // Splice the optional outdoor segment in. For ARRIVE the agent comes from
  // OUTSIDE → prepend so the walker first traverses [car → stairs → entrance]
  // before entering the corridor system. For LEAVE we append so the walker
  // exits the building after the corridor walk. The outdoor segment is clean
  // by construction (street → stairs → plinth, no rooms in between), so we
  // do NOT re-run avoidance over the full path — that was eating waypoints
  // and making the walker vanish mid-corridor.
  if (opts.outdoorWaypoints && opts.outdoorWaypoints.length > 0) {
    if (opts.mode === 'arrive') {
      forward = [...opts.outdoorWaypoints, ...forward];
    } else {
      forward = [...forward, ...opts.outdoorWaypoints];
    }
  }

  const dist = pathLength(forward);
  const fwdCumDist = buildCumDist(forward);
  const returnPts = [...forward].reverse(); // unused for oneWay but kept for type
  const retCumDist = buildCumDist(returnPts);

  const startPt = forward[0];
  const h = buildWalkerHumanoid(opts.agentId, opts.agents, opts.color);
  // Use the first waypoint's Y so a taxi drop-off spawns the walker at street
  // level (Y = -streetDrop), not floating above the plinth.
  h.group.position.set(startPt.x, startPt.y ?? 0, startPt.z);
  // Hoverable/clickable during the commute walk too.
  h.group.userData.agentId = opts.agentId;
  h.group.userData.isWalker = true;

  // Fade-in on spawn — ARRIVE pops in from nothing at the entrance; LEAVE
  // also fades in briefly so the seated→walker handoff isn't an abrupt pop.
  const fadeMats: any[] = [];
  h.group.traverse((c: any) => {
    if (c.material) {
      c.material.transparent = true;
      c.material.opacity = 0;
      fadeMats.push(c.material);
    }
  });
  opts.scene.add(h.group);

  // Modest ground glow so the figure has a footprint while fading.
  const glow = new rt.THREE.Mesh(
    new rt.THREE.CircleGeometry(1, 10),
    new rt.THREE.MeshBasicMaterial({ color: new rt.THREE.Color(opts.color), transparent: true, opacity: 0.12, side: 2 }),
  );
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.03;
  h.group.add(glow);

  opts.walkers.push({
    group: h.group,
    leftLeg: h.leftLeg, rightLeg: h.rightLeg,
    leftArm: h.leftArm, rightArm: h.rightArm,
    torso: h.torso, head: h.head,
    envelope: { parent: null, geometry: { dispose() {} }, material: { dispose() {} } },
    light: glow,
    curve: forward, returnCurve: returnPts,
    progress: 0, speed: 0,
    age: 0, maxAge: 30,
    arrived: false, returning: false,
    sourceId: opts.agentId,
    targetId: opts.mode === 'leave' ? 'exit' : 'arrive',
    color: new rt.THREE.Color(opts.color),
    bubble: null,
    unitsPerSec: WALK_SPEED_UNITS_PER_SEC,
    pathLength: dist,
    fwdCumDist, retCumDist,
    timeSec: 0, arrivedSec: 0,
    fadeState: 1, fadeProgress: 0, fadeMats,
    oneWay: true,
    restoreSeatedOnArrive: opts.mode === 'arrive',
  });
}
