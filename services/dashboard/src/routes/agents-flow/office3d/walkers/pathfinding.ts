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

    // 2–4. Out to the nearest corridor, the shortest way along the corridors,
    //      and up to the corridor outside the target's door.
    const srcCorrNode = nearestCorridorNode({ x: srcDoorX, y: 0, z: srcDoorZ }, grid);
    const tgtCorrNode = nearestCorridorNode({ x: tgtDoorX, y: 0, z: tgtDoorZ }, grid, srcCorrNode);
    pts.push(...corridorRoute(srcCorrNode, tgtCorrNode, grid));

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
  // The line-up point is only a hint: in a room whose door shares an X (or Z)
  // with a desk it lands on that desk, and avoidDesks drops it and walks round.
  // The step inside, the gap and the doorstep are pinned — they are what keeps
  // the crossing perpendicular to the wall.
  if (d.sideways) {
    return [
      { x: from.x, y: 0, z: d.z },                          // align to the opening, inside
      ...pin([
        { x: d.x - d.out * DOORSTEP, y: 0, z: d.z },        // one step inside
        { x: d.x, y: 0, z: d.z },                           // through the gap
        { x: d.x + d.out * DOORSTEP, y: 0, z: d.z },        // doorstep, clear of the wall
      ]),
    ];
  }
  return [
    { x: d.x, y: 0, z: from.z },
    ...pin([
      { x: d.x, y: 0, z: d.z - d.out * DOORSTEP },
      { x: d.x, y: 0, z: d.z },
      { x: d.x, y: 0, z: d.z + d.out * DOORSTEP },
    ]),
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
  pin(legs);
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

// ── Grid detour ─────────────────────────────────────────────────────────────
//
// avoidDesks used to fix a blocked leg with one of four L-shaped detours and
// try again, up to 8 passes. In a room packed with desks the L lands on the
// next desk, and after 8 passes it gave up with the leg still blocked: on the
// live floor 1 in 5 desk-to-desk walks still went through a desk, and the
// detours piled up as runs of duplicate waypoints and short there-and-back
// steps — the agent dithering before it leaves its office. A shortest path on
// a fine grid around the blocked leg finds the way between the desks instead.

const CELL = 0.5;
/** How far beyond the leg's own bounding box the detour may wander. */
const DETOUR_PAD = 8;
/** Extra cost per turn, so of two equally short ways the straighter wins. */
const TURN_COST = CELL * 3;
const MAX_CELLS = 250_000;

/** Grid lines: every CELL step across [lo, hi], plus the exact `extra` values. */
function gridLines(lo: number, hi: number, extra: number[]): number[] {
  const out: number[] = [];
  for (let v = Math.floor(lo / CELL) * CELL; v <= hi + 1e-9; v += CELL) out.push(v);
  out.push(...extra);
  out.sort((x, y) => x - y);
  return out.filter((v, i) => i === 0 || v - out[i - 1] > 1e-6);
}

/**
 * Shortest axis-aligned way from `p1` to `p2` around `boxes`, as the waypoints
 * strictly between them (turns only). Both points are exact grid nodes (the
 * grid is a CELL lattice plus their own coordinates), so the route leaves and
 * arrives squarely with no rounding step. Returns null when there is no way
 * within the search window.
 */
export function gridDetour(p1: Vec3, p2: Vec3, boxes: Aabb2D[]): Vec3[] | null {
  const minX = Math.min(p1.x, p2.x) - DETOUR_PAD, maxX = Math.max(p1.x, p2.x) + DETOUR_PAD;
  const minZ = Math.min(p1.z, p2.z) - DETOUR_PAD, maxZ = Math.max(p1.z, p2.z) + DETOUR_PAD;
  const xs = gridLines(minX, maxX, [p1.x, p2.x]);
  const zs = gridLines(minZ, maxZ, [p1.z, p2.z]);
  const nx = xs.length, nz = zs.length;
  if (nx * nz > MAX_CELLS) return null;

  // A box holding either endpoint is one the walker is already inside (its
  // own desk's margin, a doorway); blocking it would leave no way out.
  const inside = (p: Vec3, b: Aabb2D) => p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ;
  const local = boxes.filter(b =>
    b.maxX >= minX && b.minX <= maxX && b.maxZ >= minZ && b.minZ <= maxZ && !inside(p1, b) && !inside(p2, b));
  const blocked = new Uint8Array(nx * nz);
  for (const b of local) {
    for (let i = 0; i < nx; i++) {
      if (xs[i] < b.minX - 0.01 || xs[i] > b.maxX + 0.01) continue;
      for (let k = 0; k < nz; k++) {
        if (zs[k] >= b.minZ - 0.01 && zs[k] <= b.maxZ + 0.01) blocked[k * nx + i] = 1;
      }
    }
  }
  const si = xs.findIndex(v => Math.abs(v - p1.x) < 1e-6), sk = zs.findIndex(v => Math.abs(v - p1.z) < 1e-6);
  const gi = xs.findIndex(v => Math.abs(v - p2.x) < 1e-6), gk = zs.findIndex(v => Math.abs(v - p2.z) < 1e-6);
  blocked[sk * nx + si] = 0;
  blocked[gk * nx + gi] = 0;

  // A* over (node, heading). Headings: 0 +x, 1 -x, 2 +z, 3 -z; 4 = none (start).
  const DI = [1, -1, 0, 0], DK = [0, 0, 1, -1];
  const g = new Float64Array(nx * nz * 5).fill(Infinity);
  const from = new Int32Array(nx * nz * 5).fill(-1);
  const h = (i: number, k: number) => Math.abs(xs[i] - p2.x) + Math.abs(zs[k] - p2.z);
  // Binary heap of [f, state].
  const heapF: number[] = [], heapS: number[] = [];
  const push = (f: number, st: number) => {
    let n = heapF.length; heapF.push(f); heapS.push(st);
    while (n > 0) { const q = (n - 1) >> 1; if (heapF[q] <= f) break; heapF[n] = heapF[q]; heapS[n] = heapS[q]; n = q; }
    heapF[n] = f; heapS[n] = st;
  };
  const pop = (): number => {
    const top = heapS[0], lastF = heapF.pop()!, lastS = heapS.pop()!;
    if (heapF.length) {
      let n = 0;
      for (;;) {
        const l = 2 * n + 1, r = l + 1; let m = n, mf = lastF;
        if (l < heapF.length && heapF[l] < mf) { m = l; mf = heapF[l]; }
        if (r < heapF.length && heapF[r] < mf) { m = r; mf = heapF[r]; }
        if (m === n) break;
        heapF[n] = heapF[m]; heapS[n] = heapS[m]; n = m;
      }
      heapF[n] = lastF; heapS[n] = lastS;
    }
    return top;
  };
  const start = (sk * nx + si) * 5 + 4;
  g[start] = 0; push(h(si, sk), start);
  let goal = -1;
  while (heapF.length) {
    const st = pop();
    const node = Math.floor(st / 5), dir = st % 5;
    const i = node % nx, k = Math.floor(node / nx);
    if (i === gi && k === gk) { goal = st; break; }
    for (let d = 0; d < 4; d++) {
      const ni = i + DI[d], nk = k + DK[d];
      if (ni < 0 || ni >= nx || nk < 0 || nk >= nz || blocked[nk * nx + ni]) continue;
      const ns = (nk * nx + ni) * 5 + d;
      const step = Math.abs(xs[ni] - xs[i]) + Math.abs(zs[nk] - zs[k]);
      const ng = g[st] + step + (dir !== 4 && dir !== d ? TURN_COST : 0);
      if (ng < g[ns]) { g[ns] = ng; from[ns] = st; push(ng + h(ni, nk), ns); }
    }
  }
  if (goal < 0) return null;

  const nodes: Vec3[] = [];
  for (let st = goal; st >= 0; st = from[st]) {
    const node = Math.floor(st / 5);
    nodes.unshift({ x: xs[node % nx], y: 0, z: zs[Math.floor(node / nx)] });
  }
  const out: Vec3[] = [];
  for (let n = 1; n < nodes.length - 1; n++) {
    const a = nodes[n - 1], b = nodes[n], c = nodes[n + 1];
    if (!((Math.abs(a.x - b.x) < 1e-6 && Math.abs(b.x - c.x) < 1e-6) || (Math.abs(a.z - b.z) < 1e-6 && Math.abs(b.z - c.z) < 1e-6))) out.push(b);
  }
  return out;
}

/** Waypoints that carry meaning — doorways, corridor turns — and must survive
 *  avoidDesks even when a desk's margin reaches over them. Everything else a
 *  builder emits (a room's L-corner, the slide toward a desk) is only a hint. */
const PINNED = new WeakSet<Vec3>();
function pin<T extends Vec3[]>(pts: T): T {
  for (const p of pts) PINNED.add(p);
  return pts;
}

const strictlyInside = (p: Vec3, b: Aabb2D) => p.x > b.minX && p.x < b.maxX && p.z > b.minZ && p.z < b.maxZ;
const isDiagonal = (a: Vec3, b: Vec3) => Math.abs(a.x - b.x) > 0.01 && Math.abs(a.z - b.z) > 0.01;

/** A leg is clear when it touches no box — except boxes one of its own ends
 *  already stands in (a desk margin, a doorway), which it can only leave. */
function legClear(a: Vec3, b: Vec3, boxes: Aabb2D[]): boolean {
  return !boxes.some(x => segHitsAabb(a, b, x) && !strictlyInside(a, x) && !strictlyInside(b, x));
}

/**
 * Drop the points that make a walker dither: duplicates, and a middle point
 * that sits on the same line as its neighbours (a straight run, or a spike
 * out and back) when the direct leg between those neighbours is clear.
 */
function straighten(pts: Vec3[], boxes: Aabb2D[]): Vec3[] {
  let cur = pts;
  for (let changed = true; changed;) {
    changed = false;
    const out: Vec3[] = [cur[0]];
    for (let i = 1; i < cur.length; i++) {
      const a = out[out.length - 1], b = cur[i], c = cur[i + 1];
      if (Math.abs(a.x - b.x) < 0.05 && Math.abs(a.z - b.z) < 0.05 && i < cur.length - 1) { changed = true; continue; }
      if (c) {
        const line = (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.z - b.z) < 0.01 && Math.abs(b.z - c.z) < 0.01);
        if (line && legClear(a, c, boxes)) { changed = true; continue; }
      }
      out.push(b);
    }
    cur = out;
  }
  return cur;
}

/**
 * Post-process a waypoint list to route around desk AABBs. Hints stranded
 * inside an obstacle are dropped; every leg that hits a box, or runs
 * diagonally, is replaced by the shortest square way around (gridDetour) —
 * only when that finds none does it fall back to the four L-shaped detours,
 * picking the one with the fewest collateral collisions, ties broken by
 * length. Finally the result is straightened.
 */
export function avoidDesks(pts: Vec3[], boxes: Aabb2D[], maxPasses: number = 8): Vec3[] {
  if (boxes.length === 0 || pts.length < 2) return pts;
  let current = pts.filter((p, i) =>
    i === 0 || i === pts.length - 1 || PINNED.has(p) || !boxes.some(b => strictlyInside(p, b)));
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    const out: Vec3[] = [current[0]];
    for (let i = 1; i < current.length; i++) {
      const p1 = out[out.length - 1], p2 = current[i];
      const hit = !legClear(p1, p2, boxes) ? boxes.find(b => segHitsAabb(p1, p2, b)) : undefined;
      if (!hit && !isDiagonal(p1, p2)) { out.push(p2); continue; }
      const around = gridDetour(p1, p2, boxes);
      if (around) { out.push(...around, p2); if (around.length) changed = true; continue; }
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
  return straighten(current, boxes);
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

// ── Corridor routing ────────────────────────────────────────────────────────
//
// The corridor leg used to be hand-rolled in three builders: "walk to the
// vertical corridor between us, at my horizontal corridor's Z". That assumes
// the walker starts ON a horizontal corridor. An office whose door opens onto
// a vertical one is not, so the walker jumped diagonally from its doorstep to
// a junction 30 units away — across a meeting room or a block of offices (545
// of 6816 desk-to-desk walks on the live floor). And picking "the" vertical
// corridor between two points is a guess, not the shortest way, which is what
// read as agents wandering.
//
// So: a shortest path over the corridor network itself. Stops are every
// segment end, every crossing of two segments and the two endpoints; edges
// join consecutive stops along one segment. Every leg therefore lies on a
// corridor, and the route is the shortest one the corridors allow.

const ON_SEG = 0.5;

function onSegment(p: { x: number; z: number }, s: CorridorGrid['segments'][number]): boolean {
  const minX = Math.min(s.x1, s.x2) - ON_SEG, maxX = Math.max(s.x1, s.x2) + ON_SEG;
  const minZ = Math.min(s.z1, s.z2) - ON_SEG, maxZ = Math.max(s.z1, s.z2) + ON_SEG;
  if (p.x < minX || p.x > maxX || p.z < minZ || p.z > maxZ) return false;
  if (Math.abs(s.z1 - s.z2) < 0.1) return Math.abs(p.z - s.z1) <= ON_SEG;
  if (Math.abs(s.x1 - s.x2) < 0.1) return Math.abs(p.x - s.x1) <= ON_SEG;
  return false;
}

/** `p` moved onto the segment's centre line. */
function snapTo(p: Vec3, s: CorridorGrid['segments'][number]): Vec3 {
  if (Math.abs(s.z1 - s.z2) < 0.1) return { x: p.x, y: 0, z: s.z1 };
  return { x: s.x1, y: 0, z: p.z };
}

/**
 * Shortest walk from `a` to `b` along the corridors, as waypoints from `a` to
 * `b` inclusive. Both are normally corridor nodes; a point off every corridor
 * is first squared onto the nearest one. Returns `[a, b]` when the corridors
 * do not connect them (a plugin site without a link, an empty grid).
 */
export function corridorRoute(a: Vec3, b: Vec3, grid: CorridorGrid): Vec3[] {
  const segs = grid.segments.filter(s => Math.abs(s.x1 - s.x2) < 0.1 || Math.abs(s.z1 - s.z2) < 0.1);
  if (segs.length === 0) return [{ ...a }, { ...b }];

  // Two corridors equally near (the lobby has one each side) tie; take the one
  // on the side the walker comes from, or it crosses the lobby and back.
  const nearestSeg = (p: Vec3, toward: Vec3) => {
    let best = segs[0], bestD = Infinity, bestT = Infinity;
    for (const s of segs) {
      const q = snapTo(p, s);
      const cx = Math.max(Math.min(s.x1, s.x2), Math.min(Math.max(s.x1, s.x2), q.x));
      const cz = Math.max(Math.min(s.z1, s.z2), Math.min(Math.max(s.z1, s.z2), q.z));
      const d = (cx - p.x) ** 2 + (cz - p.z) ** 2;
      const t = Math.abs(cx - toward.x) + Math.abs(cz - toward.z);
      if (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && t < bestT)) { bestD = d; bestT = t; best = s; }
    }
    return best;
  };
  const entry = segs.some(s => onSegment(a, s)) ? a : snapTo(a, nearestSeg(a, b));
  const exit = segs.some(s => onSegment(b, s)) ? b : snapTo(b, nearestSeg(b, entry));

  // Stops per segment, deduplicated by rounded position.
  const pts: Vec3[] = [];
  const key = (p: { x: number; z: number }) => `${Math.round(p.x * 10)},${Math.round(p.z * 10)}`;
  const index = new Map<string, number>();
  const idOf = (p: Vec3) => {
    const k = key(p);
    let i = index.get(k);
    if (i === undefined) { i = pts.length; pts.push({ x: p.x, y: 0, z: p.z }); index.set(k, i); }
    return i;
  };
  const adj = new Map<number, Array<[number, number]>>();
  const link = (i: number, j: number) => {
    if (i === j) return;
    const d = Math.abs(pts[i].x - pts[j].x) + Math.abs(pts[i].z - pts[j].z);
    (adj.get(i) ?? adj.set(i, []).get(i)!).push([j, d]);
    (adj.get(j) ?? adj.set(j, []).get(j)!).push([i, d]);
  };
  for (const s of segs) {
    const horiz = Math.abs(s.z1 - s.z2) < 0.1;
    const stops: Vec3[] = [{ x: s.x1, y: 0, z: s.z1 }, { x: s.x2, y: 0, z: s.z2 }];
    for (const o of segs) {
      if (o === s) continue;
      const crossing = horiz ? { x: o.x1, y: 0, z: s.z1 } : { x: s.x1, y: 0, z: o.z1 };
      if (onSegment(crossing, s) && onSegment(crossing, o)) stops.push(crossing);
    }
    for (const p of [entry, exit]) if (onSegment(p, s)) stops.push(snapTo(p, s));
    const ids = [...new Set(stops.map(idOf))].sort((i, j) => horiz ? pts[i].x - pts[j].x : pts[i].z - pts[j].z);
    for (let k = 1; k < ids.length; k++) link(ids[k - 1], ids[k]);
  }

  const start = index.get(key(entry)), goal = index.get(key(exit));
  if (start === undefined || goal === undefined) return [{ ...a }, { ...b }];

  // Dijkstra — the network is a few hundred stops at most.
  const dist = new Map<number, number>([[start, 0]]);
  const prev = new Map<number, number>();
  const open = new Set<number>([start]);
  while (open.size) {
    let u = -1, du = Infinity;
    for (const i of open) { const d = dist.get(i)!; if (d < du) { du = d; u = i; } }
    open.delete(u);
    if (u === goal) break;
    for (const [v, w] of adj.get(u) ?? []) {
      const nd = du + w;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); open.add(v); }
    }
  }
  if (!dist.has(goal)) return [{ ...a }, { ...b }];

  const chain: Vec3[] = [];
  for (let at: number | undefined = goal; at !== undefined; at = prev.get(at)) chain.unshift(pts[at]);
  // Keep only the turns: a stop between two collinear legs is not a waypoint.
  const turns: Vec3[] = [chain[0]];
  for (let i = 1; i < chain.length - 1; i++) {
    const p = turns[turns.length - 1], q = chain[i], r = chain[i + 1];
    const straight = (Math.abs(p.x - q.x) < 0.01 && Math.abs(q.x - r.x) < 0.01)
      || (Math.abs(p.z - q.z) < 0.01 && Math.abs(q.z - r.z) < 0.01);
    if (!straight) turns.push(q);
  }
  if (chain.length > 1) turns.push(chain[chain.length - 1]);
  const out = [{ ...a }, ...turns, { ...b }];
  // Drop the endpoints' duplicates (entry === a, exit === b).
  return pin(out).filter((p, i) => i === 0 || Math.abs(p.x - out[i - 1].x) > 0.01 || Math.abs(p.z - out[i - 1].z) > 0.01);
}

// ── Walk zones: the special rooms outside the flow-room map ─────────────────
//
// The headquarters office and the reception are built from the special-room
// slots, not from `rooms`, so no router ever saw them: walkers to the top
// agent's office came down the back corridor and stepped straight through its
// north wall, and package pickups walked through the reception's back wall.
// The scene registers both here on every rebuild, and every walker builder
// treats them as solid.

export interface WalkRect { cx: number; cz: number; w: number; d: number }

export interface WalkZones {
  /** Headquarters office: a walled rectangle whose only opening is `door`. */
  myOffice?: { rect: WalkRect; door: { x: number; z: number } };
  /** Solid pieces of the reception (counter, columns, back wall). */
  reception?: Aabb2D[];
  /** Walls of buildings world plugins add (split around their doors). */
  plugins?: Aabb2D[];
  /** Meeting rooms. Every walker treats them as solid, not only the ones whose
   *  caller passes `meetingRoomObstacles` — desk-to-desk messengers, package
   *  pickups and visits to the chief never did, and walked through them. */
  meetingRooms?: WalkRect[];
}

let walkZones: WalkZones = {};

/** Register the special rooms for every walker built from now on. */
export function setWalkZones(zones: WalkZones): void {
  walkZones = zones;
}

function insideRect(p: { x: number; z: number }, r: WalkRect): boolean {
  return p.x >= r.cx - r.w / 2 && p.x <= r.cx + r.w / 2 && p.z >= r.cz - r.d / 2 && p.z <= r.cz + r.d / 2;
}

/** The registered zones as obstacles. Pass `enteringMyOffice` when the walk
 *  ends inside the headquarters office — its walls are then crossed through
 *  the door instead of avoided whole — and `enteringMeeting` with the meeting
 *  room the walk ends in, for the same reason. */
export function zoneObstacles(enteringMyOffice = false, enteringMeeting?: WalkRect): Aabb2D[] {
  const out: Aabb2D[] = [...(walkZones.reception ?? []), ...(walkZones.plugins ?? [])];
  for (const r of walkZones.meetingRooms ?? []) {
    if (enteringMeeting && Math.abs(r.cx - enteringMeeting.cx) < 0.01 && Math.abs(r.cz - enteringMeeting.cz) < 0.01) continue;
    out.push({
      minX: r.cx - r.w / 2 - WALL_HALF, maxX: r.cx + r.w / 2 + WALL_HALF,
      minZ: r.cz - r.d / 2 - WALL_HALF, maxZ: r.cz + r.d / 2 + WALL_HALF,
    });
  }
  const mo = walkZones.myOffice;
  if (mo && !enteringMyOffice) {
    const r = mo.rect;
    out.push({
      minX: r.cx - r.w / 2 - WALL_HALF, maxX: r.cx + r.w / 2 + WALL_HALF,
      minZ: r.cz - r.d / 2 - WALL_HALF, maxZ: r.cz + r.d / 2 + WALL_HALF,
    });
  }
  return out;
}

/** `to` moved `dist` toward the door along the door's axis: the spot right
 *  behind a chair that faces away from the door. */
function behindFromDoor(to: Vec3, door: { x: number; z: number }, dist: number): Vec3 {
  const dx = door.x - to.x, dz = door.z - to.z;
  return Math.abs(dz) >= Math.abs(dx)
    ? { x: to.x, y: 0, z: to.z + Math.sign(dz) * dist }
    : { x: to.x + Math.sign(dx) * dist, y: 0, z: to.z };
}

export interface PointWalkInput {
  from: Vec3;
  targetPoint: Vec3;
  /** The office the walker leaves from (its desk's room). */
  srcRoom: RoomInfo | undefined;
  rooms: Map<string, RoomInfo>;
  corridorGrid: CorridorGrid;
  /** Desks to walk around (the walker's own desk already filtered out). */
  deskObstacles: Aabb2D[];
  /** Door midpoint of the meeting room being entered, if any. */
  viaPoint?: Vec3;
  meetingRoomObstacles?: ReadonlyArray<WalkRect>;
  /** Index into meetingRoomObstacles of the room being entered. */
  meetingRoomObstacleExempt?: number;
}

/**
 * Path for a walker going from its desk to an arbitrary point: out through its
 * office door, along the corridors, and in through the destination's door —
 * an office's, a meeting room's (`viaPoint`) or the headquarters office's —
 * then around every desk, wall and special-room obstacle on the way.
 */
export function planPointWalk(input: PointWalkInput): Vec3[] {
  const { from, targetPoint, srcRoom, rooms, corridorGrid, deskObstacles, viaPoint,
    meetingRoomObstacles, meetingRoomObstacleExempt } = input;

  // Find which room contains the destination point — if the walker is
  // walking into a room (an office, a meeting room, …), that room must be
  // exempt from the avoidance pass. Otherwise its walls count as
  // obstacles and the L-shaped detour ends up cutting a diagonal back
  // across an adjacent room's wall.
  const targetRoom = roomContaining(targetPoint, rooms);
  const myOffice = walkZones.myOffice;
  const intoMyOffice = !targetRoom && !viaPoint && !!myOffice && insideRect(targetPoint, myOffice.rect);

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
    ...zoneObstacles(intoMyOffice, exemptSlot),
  ];

  // Build path: desk → door → corridor → target point (using real corridor positions)
  const pts: Vec3[] = [];
  pts.push({ ...from });

  if (srcRoom && corridorGrid.segments.length > 0) {
    // Use exact door position (respects doorDir: left/right/top/bottom)
    const srcDoorX = (srcRoom as any).doorX ?? srcRoom.cx;
    const srcDoorZ = (srcRoom as any).doorCZ ?? srcRoom.doorZ;

    // Inside room → line up on the opening → out through the door. A
    // hardcoded X-first L-shape is only correct for a door on a ±Z wall;
    // side doors with off-centre desks would step through solid wall.
    pts.push(...exitViaDoor(from, srcRoom));

    // Step into the nearest corridor and walk the corridors to the target.
    // Aim at the DOORWAY, not at the destination itself: the corridor node
    // nearest a seat can be on the far side of the room from its only door,
    // and the leg from there cuts back across it.
    const srcCorrNode = nearestCorridorNode({ x: srcDoorX, y: 0, z: srcDoorZ }, corridorGrid);
    const approach = viaPoint
      ?? (intoMyOffice ? { x: myOffice!.door.x, y: 0, z: myOffice!.door.z } : targetPoint);
    const tgtCorrNode = nearestCorridorNode(approach, corridorGrid, srcCorrNode);
    pts.push(...corridorRoute(srcCorrNode, tgtCorrNode, corridorGrid));
  }
  // Getting IN is the same problem as getting out: route through the
  // destination's own door instead of one straight shot from the corridor.
  if (targetRoom) {
    pts.push(...enterViaDoor(targetPoint, targetRoom));
  } else if (intoMyOffice) {
    // The visitor armchairs stand in one row facing away from the door: come
    // up behind the row, line up with the chair and step into it from the
    // back, instead of walking along the row through whoever already sits.
    const behind = behindFromDoor(targetPoint, myOffice!.door, 0.9);
    pts.push(...enterViaDoor(behind, rectAsRoom(myOffice!.rect, myOffice!.door)), ...pin([behind]));
  } else if (viaPoint) {
    // Meeting rooms aren't in the `rooms` map — they hand us their door
    // midpoint instead. Square up on the doorway, step through, and only then
    // turn toward the seat.
    if (exemptSlot) {
      // stopInsideDoor: the table sits on the room's centreline, so the
      // generic slide waypoint would land on it. Stop at the doorway and
      // let the avoidance pass walk around the table to the chair.
      pts.push(...enterViaDoor(targetPoint, rectAsRoom(exemptSlot, viaPoint), { stopInsideDoor: true }));
    } else {
      pts.push(...pin([{ ...viaPoint }]));
    }
  }
  pts.push({ ...targetPoint });

  // Clean duplicates
  const dedup: Vec3[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = dedup[dedup.length - 1];
    if (Math.abs(pts[i].x - prev.x) > 0.3 || Math.abs(pts[i].z - prev.z) > 0.3) dedup.push(pts[i]);
  }
  // Route around desk / wall / special-room AABBs
  return avoidDesks(dedup, obstacles);
}
