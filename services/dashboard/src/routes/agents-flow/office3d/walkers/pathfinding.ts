/** Walker pathfinding — corridor routing + desk/room obstacle avoidance.
 *  Pure geometry (no Three.js). Extracted from walkers.ts (structural refactor). */

import type { Vec3, RoomInfo, Aabb2D } from '../types.js';
import type { CorridorGrid } from '../floor-plan.js';
import { nearestCorridorNode } from '../floor-plan.js';

/**
 * Build a straight-line path through corridors (no curves = no wall clipping).
 * Path: desk → door → corridor node → walk along corridor → target corridor node → target door → target desk
 * Uses straight segments joined at waypoints.
 */
/**
 * Build path through actual corridor segments — never cuts through rooms.
 * The walker goes:
 * 1. desk → align to room center X
 * 2. walk to door Z
 * 3. step out to corridor Z (the exact corridor center outside the door)
 * 4. walk along corridor to align with target room X
 * 5. walk along corridor to target's corridor Z
 * 6. step into target door Z
 * 7. align X inside target room → desk
 */
export function buildPath(
  from: Vec3, to: Vec3,
  srcRoom: RoomInfo | undefined,
  tgtRoom: RoomInfo | undefined,
  grid: CorridorGrid,
  obstacles: Aabb2D[] = [],
): Vec3[] {
  const pts: Vec3[] = [];
  pts.push({ ...from });

  // Same-room shortcut: no need to exit through the door if both desks are
  // in the same office. Walk a short dog-leg directly across the room floor.
  if (srcRoom && tgtRoom && srcRoom === tgtRoom) {
    // Step away from the source desk first (avoid clipping through own chair),
    // then turn toward the target desk. A simple L-shape reads cleanly and
    // keeps the humanoid from walking diagonally through furniture.
    const midZ = (from.z + to.z) / 2;
    pts.push({ x: from.x, y: 0, z: midZ });
    pts.push({ x: to.x, y: 0, z: midZ });
    pts.push({ ...to });
  } else if (srcRoom && tgtRoom && grid.segments.length > 0) {
    // Use exact door positions (doorX, doorCZ) which respect doorDir
    const srcDoorX = (srcRoom as any).doorX ?? srcRoom.cx;
    const srcDoorZ = (srcRoom as any).doorCZ ?? srcRoom.doorZ;
    const tgtDoorX = (tgtRoom as any).doorX ?? tgtRoom.cx;
    const tgtDoorZ = (tgtRoom as any).doorCZ ?? tgtRoom.doorZ;

    // 1. Inside source room → line up on the opening → out through the door.
    pts.push(...exitViaDoor(from, srcRoom));

    // 2. Step out into nearest corridor
    const srcCorrNode = nearestCorridorNode({ x: srcDoorX, y: 0, z: srcDoorZ }, grid);
    pts.push({ ...srcCorrNode });

    // 3. Navigate corridors to reach target door's corridor
    const tgtCorrNode = nearestCorridorNode({ x: tgtDoorX, y: 0, z: tgtDoorZ }, grid);

    if (Math.abs(srcCorrNode.x - tgtCorrNode.x) > 1 || Math.abs(srcCorrNode.z - tgtCorrNode.z) > 1) {
      // Need to traverse corridors — use H and V corridors
      const srcHZ = nearestHCorrZ(srcCorrNode.z, grid);
      const tgtHZ = nearestHCorrZ(tgtCorrNode.z, grid);

      if (Math.abs(srcCorrNode.x - tgtCorrNode.x) > 1) {
        const vCorrX = nearestVCorrXBetween(srcCorrNode.x, tgtCorrNode.x, grid);
        pts.push({ x: vCorrX, y: 0, z: srcHZ });
        if (Math.abs(srcHZ - tgtHZ) > 1) {
          pts.push({ x: vCorrX, y: 0, z: tgtHZ });
        }
        pts.push({ x: tgtCorrNode.x, y: 0, z: tgtHZ });
      } else if (Math.abs(srcHZ - tgtHZ) > 1) {
        const vCorrX = nearestVCorrX(srcCorrNode.x, grid);
        pts.push({ x: vCorrX, y: 0, z: srcHZ });
        pts.push({ x: vCorrX, y: 0, z: tgtHZ });
        pts.push({ x: tgtCorrNode.x, y: 0, z: tgtHZ });
      }
    }

    // 4. Approach target door from corridor
    pts.push({ ...tgtCorrNode });

    // 5 + 6. In through the target door, then along the inside of the room to
    //        the desk. Both branches of the old code were identical and both
    //        slid along X at the wall's own Z — i.e. inside the wall — for a
    //        top/bottom door. enterViaDoor crosses perpendicular instead.
    pts.push(...enterViaDoor(to, tgtRoom));
    pts.push({ ...to });
  } else {
    pts.push({ ...to });
  }

  // Remove duplicate/too-close points
  const clean: Vec3[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = clean[clean.length - 1];
    if (Math.abs(pts[i].x - prev.x) > 0.3 || Math.abs(pts[i].z - prev.z) > 0.3) {
      clean.push(pts[i]);
    }
  }
  // Route around desk AABBs (obstacles). Endpoints are assumed to be outside
  // every obstacle — the caller must exclude the walker's own src/tgt desks.
  return avoidDesks(clean, obstacles);
}

// ── Doors ────────────────────────────────────────────────────────────────
//
// Everything about walking through a doorway lives here, in ONE place, because
// it did not used to. The same "leave your office" routing was written out by
// hand in three different builders (buildPath, sendWalkerToPoint, and the
// arrive/leave commuter), and only two of them ever learned that a door on a
// ±X wall has to be approached by aligning Z first. The third kept marching
// straight out sideways at whatever Z the desk happened to sit at, which on
// the live floor plan — 6 of 9 offices have side doors, desks 2.25 units off
// centre, opening only ±1.25 wide — means walking out through solid wall.
// Fixing one copy always left the others, which is why this bug kept coming
// back. Route through these helpers; never hand-roll the door leg again.

/** Half-width of the gap the wall builder cuts. Mirrors `doorW / 2` in office/rooms.ts. */
export const DOOR_HALF = 1.25;

/** How far past the wall face the doorstep waypoint sits, so the corridor leg
 *  starts clear of the wall instead of turning while still inside it. */
const DOORSTEP = 1.0;

type DoorDir = 'left' | 'right' | 'top' | 'bottom';

interface DoorGeom {
  dir: DoorDir;
  /** Point dead centre of the opening, on the wall plane. */
  x: number;
  z: number;
  /** Outward normal (+1/-1) along the door's axis. */
  out: number;
  /** True when the door is on a ±X wall, so the walker crosses in X. */
  sideways: boolean;
}

function doorGeom(room: RoomInfo): DoorGeom {
  const r = room as unknown as { doorDir?: DoorDir; doorX?: number; doorCZ?: number; side?: number };
  const dir: DoorDir = r.doorDir ?? (r.side === 1 ? 'top' : 'bottom');
  const sideways = dir === 'left' || dir === 'right';
  return {
    dir,
    x: r.doorX ?? room.cx,
    z: r.doorCZ ?? room.doorZ,
    out: dir === 'right' || dir === 'top' ? 1 : -1,
    sideways,
  };
}

/** The span of floor the doorway actually leaves open, on the wall it sits in. */
export function doorOpening(room: RoomInfo): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const d = doorGeom(room);
  return d.sideways
    ? { minX: d.x, maxX: d.x, minZ: d.z - DOOR_HALF, maxZ: d.z + DOOR_HALF }
    : { minX: d.x - DOOR_HALF, maxX: d.x + DOOR_HALF, minZ: d.z, maxZ: d.z };
}

/**
 * Waypoints taking a walker from an interior point out through its own door,
 * ending one step outside the wall. Does NOT include `from`.
 *
 * The order is what matters: line up on the door's centreline while still
 * inside the room, and only then cross. Crossing first and sliding along the
 * wall afterwards is the same thing as walking through it.
 */
export function exitViaDoor(from: Vec3, room: RoomInfo): Vec3[] {
  const d = doorGeom(room);
  if (d.sideways) {
    return [
      { x: from.x, y: 0, z: d.z },                    // align to the opening, inside
      { x: d.x, y: 0, z: d.z },                       // through the gap
      { x: d.x + d.out * DOORSTEP, y: 0, z: d.z },    // doorstep, clear of the wall
    ];
  }
  return [
    { x: d.x, y: 0, z: from.z },
    { x: d.x, y: 0, z: d.z },
    { x: d.x, y: 0, z: d.z + d.out * DOORSTEP },
  ];
}

/**
 * Mirror of `exitViaDoor` for arriving: from the doorstep, through the gap,
 * then along the inside of the room until it is lined up with `to`. Does NOT
 * include `to` — append it yourself.
 */
export function enterViaDoor(
  to: Vec3,
  room: RoomInfo,
  opts: {
    /**
     * Stop one step inside the doorway instead of sliding across the room to
     * line up with `to`. Use it when the room has furniture in the middle: the
     * slide waypoint aims at the room's own centreline, which in a meeting
     * room is the table — and a waypoint sitting ON an obstacle breaks the
     * avoidance pass, which assumes its endpoints are clear. Stopping at the
     * door hands a clean start point to `avoidDesks`, which then walks around
     * the table on its own.
     */
    stopInsideDoor?: boolean;
  } = {},
): Vec3[] {
  const d = doorGeom(room);
  const legs: Vec3[] = d.sideways
    ? [
        { x: d.x + d.out * DOORSTEP, y: 0, z: d.z },
        { x: d.x, y: 0, z: d.z },
        { x: d.x - d.out * DOORSTEP, y: 0, z: d.z },  // one step inside
      ]
    : [
        { x: d.x, y: 0, z: d.z + d.out * DOORSTEP },
        { x: d.x, y: 0, z: d.z },
        { x: d.x, y: 0, z: d.z - d.out * DOORSTEP },
      ];
  if (opts.stopInsideDoor) return legs;
  // Otherwise line up with the destination before the caller appends it.
  legs.push(d.sideways ? { x: to.x, y: 0, z: d.z } : { x: d.x, y: 0, z: to.z });
  return legs;
}

/**
 * Wrap a bare rectangle (a meeting-room slot) as something `exitViaDoor` /
 * `enterViaDoor` can route through, given the door's midpoint on one of its
 * walls.
 *
 * Meeting rooms are cut a 2.5-wide doorway just like offices are
 * (office/meeting-rooms.ts, `addWallWithDoor`), on whichever wall faces the
 * central hall. But they live in their own `meetingRooms` array instead of the
 * `rooms` map, so none of the door-aware routing applied to them and every
 * attendee approached their seat on a diagonal straight from the doorway —
 * clipping the inside of the wall on the way past it. Measured on the live
 * floor: 38 of 40 seats across the four rooms. Meetings are the thing most
 * worth watching in this scene, so that was most of what anyone ever saw.
 */
export function rectAsRoom(
  rect: { cx: number; cz: number; w: number; d: number },
  doorPoint: { x: number; z: number },
): RoomInfo {
  // Which wall is the door on? Whichever plane it sits closest to.
  const dLeft = Math.abs(doorPoint.x - (rect.cx - rect.w / 2));
  const dRight = Math.abs(doorPoint.x - (rect.cx + rect.w / 2));
  const dBottom = Math.abs(doorPoint.z - (rect.cz - rect.d / 2));
  const dTop = Math.abs(doorPoint.z - (rect.cz + rect.d / 2));
  const min = Math.min(dLeft, dRight, dBottom, dTop);
  const dir: DoorDir =
    min === dLeft ? 'left' : min === dRight ? 'right' : min === dBottom ? 'bottom' : 'top';
  return {
    cx: rect.cx, cz: rect.cz, w: rect.w, d: rect.d,
    color: '', name: '', side: 1,
    doorZ: doorPoint.z, doorX: doorPoint.x, doorCZ: doorPoint.z, doorDir: dir,
  } as unknown as RoomInfo;
}

/**
 * The conference table, as a solid obstacle.
 *
 * Walkers routed door → seat in a straight line, and for any seat on the far
 * side that line goes clean across the table top. The table was never in any
 * obstacle list — only desks, office walls and other meeting rooms were — so
 * as far as the router was concerned the middle of the room was open floor.
 *
 * Dimensions mirror office/meeting-rooms.ts exactly (`min(w*0.5, 6)` by
 * `min(d*0.3, 3)`, centred). The chairs sit 0.6 beyond each edge, so a seat is
 * always outside this box and stays a legal path endpoint.
 */
export function meetingTableAabb(
  rect: { cx: number; cz: number; w: number; d: number },
  margin = 0.25,
): Aabb2D {
  const tableW = Math.min(rect.w * 0.5, 6);
  const tableD = Math.min(rect.d * 0.3, 3);
  return {
    minX: rect.cx - tableW / 2 - margin,
    maxX: rect.cx + tableW / 2 + margin,
    minZ: rect.cz - tableD / 2 - margin,
    maxZ: rect.cz + tableD / 2 + margin,
  };
}

/** Which room, if any, physically contains this point. */
export function roomContaining(
  point: Vec3,
  rooms: Map<string, RoomInfo> | Iterable<RoomInfo>,
): RoomInfo | undefined {
  const list: RoomInfo[] = rooms instanceof Map ? [...rooms.values()] : [...rooms];
  return list.find(r =>
    point.x >= r.cx - r.w / 2 && point.x <= r.cx + r.w / 2 &&
    point.z >= r.cz - r.d / 2 && point.z <= r.cz + r.d / 2,
  );
}

/** Segment-vs-AABB intersection test in the XZ plane (Liang-Barsky). */
export function segHitsAabb(p1: Vec3, p2: Vec3, box: Aabb2D): boolean {
  const dx = p2.x - p1.x, dz = p2.z - p1.z;
  let t0 = 0, t1 = 1;
  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (p1.x < box.minX || p1.x > box.maxX) return false;
  } else {
    const a = (box.minX - p1.x) / dx, b = (box.maxX - p1.x) / dx;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return false;
  }
  // Z slab
  if (Math.abs(dz) < 1e-9) {
    if (p1.z < box.minZ || p1.z > box.maxZ) return false;
  } else {
    const a = (box.minZ - p1.z) / dz, b = (box.maxZ - p1.z) / dz;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return false;
  }
  return true;
}

/** Four possible L-shaped detours around a box (via left/right/bottom/top edge). */
function detourCandidates(p1: Vec3, p2: Vec3, box: Aabb2D, margin: number = 0.6): Array<[Vec3, Vec3]> {
  const m = margin;
  return [
    [{ x: box.minX - m, y: 0, z: p1.z }, { x: box.minX - m, y: 0, z: p2.z }], // left
    [{ x: box.maxX + m, y: 0, z: p1.z }, { x: box.maxX + m, y: 0, z: p2.z }], // right
    [{ x: p1.x, y: 0, z: box.minZ - m }, { x: p2.x, y: 0, z: box.minZ - m }], // bottom
    [{ x: p1.x, y: 0, z: box.maxZ + m }, { x: p2.x, y: 0, z: box.maxZ + m }], // top
  ];
}

/** Total hit count of three segments (p1→wp1→wp2→p2) against a set of boxes. */
function detourHitScore(
  p1: Vec3, wp1: Vec3, wp2: Vec3, p2: Vec3, boxes: Aabb2D[],
): number {
  let n = 0;
  for (const b of boxes) {
    if (segHitsAabb(p1, wp1, b)) n++;
    if (segHitsAabb(wp1, wp2, b)) n++;
    if (segHitsAabb(wp2, p2, b)) n++;
  }
  return n;
}

/** Squared length (cheap tie-breaker so we prefer shorter detours). */
function segLenSq(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  return dx * dx + dz * dz;
}

/**
 * Post-process a waypoint list to route around desk AABBs. For each hit,
 * considers all four possible detour sides and picks the one with the fewest
 * collateral collisions against all other desks; ties broken by path length.
 * This avoids the greedy spiral where a detour lands inside another box.
 */
export function avoidDesks(pts: Vec3[], boxes: Aabb2D[], maxPasses: number = 8): Vec3[] {
  if (boxes.length === 0 || pts.length < 2) return pts;
  let current = pts;
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    const out: Vec3[] = [current[0]];
    for (let i = 1; i < current.length; i++) {
      const p1 = out[out.length - 1], p2 = current[i];
      const hit = boxes.find(b => segHitsAabb(p1, p2, b));
      if (!hit) { out.push(p2); continue; }
      const candidates = detourCandidates(p1, p2, hit);
      let best = candidates[0];
      let bestScore = Infinity;
      let bestLen = Infinity;
      for (const cand of candidates) {
        const score = detourHitScore(p1, cand[0], cand[1], p2, boxes);
        const len = segLenSq(p1, cand[0]) + segLenSq(cand[0], cand[1]) + segLenSq(cand[1], p2);
        if (score < bestScore || (score === bestScore && len < bestLen)) {
          bestScore = score; bestLen = len; best = cand;
        }
      }
      out.push(best[0], best[1], p2);
      changed = true;
    }
    current = out;
    if (!changed) break;
  }
  return current;
}

// Half of WALL_T (0.45 in office.ts). Used to inflate the room AABB so the
// outside face of the wall — not the wall centerline — counts as the limit.
const WALL_HALF = 0.225;

/** Convert every room into a wall-inclusive AABB so the path-avoidance pass
 *  treats them as forbidden zones. `exempt` lists the rooms the path is
 *  *allowed* to enter (source/target offices — their desks live inside the
 *  AABB). Any other room is a wall the walker must NEVER cross. */
export function roomAabbs(
  rooms: Map<string, RoomInfo> | Iterable<RoomInfo>,
  exempt: Set<RoomInfo | undefined>,
): Aabb2D[] {
  const list: RoomInfo[] = rooms instanceof Map ? [...rooms.values()] : [...rooms];
  const out: Aabb2D[] = [];
  for (const r of list) {
    if (exempt.has(r)) continue;
    out.push({
      minX: r.cx - r.w / 2 - WALL_HALF,
      maxX: r.cx + r.w / 2 + WALL_HALF,
      minZ: r.cz - r.d / 2 - WALL_HALF,
      maxZ: r.cz + r.d / 2 + WALL_HALF,
    });
  }
  return out;
}

/** Same shape as roomAabbs but for meeting-room slots, which aren't in the
 *  flow `RoomInfo` map (they live in their own `meetingRooms` array). The
 *  walker is just as forbidden from crossing a meeting room's walls as a
 *  flow office's. Pass `exemptIndex` when the walker's destination IS this
 *  meeting room (e.g. sendWalkerToPoint sending an agent to a seat). */
export function meetingRoomAabbs(
  rooms: ReadonlyArray<{ cx: number; cz: number; w: number; d: number }>,
  exemptIndex: number = -1,
): Aabb2D[] {
  const out: Aabb2D[] = [];
  for (let i = 0; i < rooms.length; i++) {
    if (i === exemptIndex) continue;
    const r = rooms[i];
    out.push({
      minX: r.cx - r.w / 2 - WALL_HALF,
      maxX: r.cx + r.w / 2 + WALL_HALF,
      minZ: r.cz - r.d / 2 - WALL_HALF,
      maxZ: r.cz + r.d / 2 + WALL_HALF,
    });
  }
  return out;
}

/** Find the Z of the nearest horizontal corridor segment */
export function nearestHCorrZ(z: number, grid: CorridorGrid): number {
  let best = z, bestD = Infinity;
  for (const s of grid.segments) {
    if (Math.abs(s.z1 - s.z2) > 0.1) continue; // skip vertical
    const d = Math.abs(s.z1 - z);
    if (d < bestD) { bestD = d; best = s.z1; }
  }
  return best;
}

/** Find the X of the nearest vertical corridor segment */
export function nearestVCorrX(x: number, grid: CorridorGrid): number {
  let best = x, bestD = Infinity;
  for (const s of grid.segments) {
    if (Math.abs(s.x1 - s.x2) > 0.1) continue; // skip horizontal
    const d = Math.abs(s.x1 - x);
    if (d < bestD) { bestD = d; best = s.x1; }
  }
  return best;
}

/** Find the vertical corridor between two X positions */
export function nearestVCorrXBetween(x1: number, x2: number, grid: CorridorGrid): number {
  const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
  let best = (x1 + x2) / 2, bestD = Infinity;
  for (const s of grid.segments) {
    if (Math.abs(s.x1 - s.x2) > 0.1) continue;
    if (s.x1 >= minX - 2 && s.x1 <= maxX + 2) {
      const d = Math.abs(s.x1 - (x1 + x2) / 2);
      if (d < bestD) { bestD = d; best = s.x1; }
    }
  }
  return best;
}
