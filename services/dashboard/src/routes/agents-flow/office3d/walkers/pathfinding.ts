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
    const srcDoorDir = (srcRoom as any).doorDir;
    const tgtDoorDir = (tgtRoom as any).doorDir;

    // 1. Inside source room → walk to door.
    //    If the door is on a ±X wall (left/right), align Z first so we exit
    //    THROUGH the door opening instead of grazing the wall at some random Z.
    //    For ±Z walls (top/bottom), the original X-first L-shape is correct.
    if (srcDoorDir === 'left' || srcDoorDir === 'right') {
      pts.push({ x: from.x, y: 0, z: srcDoorZ }); // align to door Z first
      pts.push({ x: srcDoorX, y: 0, z: srcDoorZ }); // exit through door
    } else {
      pts.push({ x: srcDoorX, y: 0, z: from.z }); // align to door X first
      pts.push({ x: srcDoorX, y: 0, z: srcDoorZ }); // exit through door
    }

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

    // 5. Enter through the target door
    pts.push({ x: tgtDoorX, y: 0, z: tgtDoorZ });

    // 6. Walk to desk inside target room.
    //    Mirror of step 1: for X-side doors (left/right), move X inside the
    //    room first, then Z to the desk. For Z-side doors (top/bottom), the
    //    original Z-first order is correct.
    if (tgtDoorDir === 'left' || tgtDoorDir === 'right') {
      pts.push({ x: to.x, y: 0, z: tgtDoorZ });
      pts.push({ ...to });
    } else {
      pts.push({ x: to.x, y: 0, z: tgtDoorZ });
      pts.push({ ...to });
    }
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

/** Segment-vs-AABB intersection test in the XZ plane (Liang-Barsky). */
function segHitsAabb(p1: Vec3, p2: Vec3, box: Aabb2D): boolean {
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
