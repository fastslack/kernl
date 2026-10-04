/**
 * Where the construction crew stands and how it gets there. Pure geometry —
 * the stage (stage.ts) turns these into motion.
 */

import type { RoomInfo, Vec3 } from '../types.js';
import type { CorridorGrid } from '../floor-plan.js';
import { nearestCorridorNode } from '../floor-plan.js';
import {
  avoidDesks, enterViaDoor, meetingRoomAabbs, nearestHCorrZ, nearestVCorrX, nearestVCorrXBetween,
  roomAabbs, zoneObstacles,
} from '../walkers/pathfinding.js';

export const WALL_IDS = ['top', 'bottom', 'left', 'right'] as const;
export type WallId = (typeof WALL_IDS)[number];

/** How far inside the wall a builder stands. */
const SPOT_INSET = 1.4;

export interface WorkSpot {
  wall: WallId;
  pos: Vec3;
  /** Y rotation that faces the builder at the wall (humanoids face +Z at 0). */
  facing: number;
}

/** One spot per wall, just inside it. At the door wall the builder stands beside the doorway. */
export function workSpots(room: RoomInfo): WorkSpot[] {
  const { cx, cz, w, d } = room;
  const door = room.doorDir ?? (room.side === 1 ? 'top' : 'bottom');
  const out: WorkSpot[] = [];
  for (const wall of WALL_IDS) {
    const along = wall === door ? (wall === 'top' || wall === 'bottom' ? w : d) / 4 : 0;
    if (wall === 'top') out.push({ wall, pos: { x: cx + along, y: 0, z: cz + d / 2 - SPOT_INSET }, facing: 0 });
    if (wall === 'bottom') out.push({ wall, pos: { x: cx + along, y: 0, z: cz - d / 2 + SPOT_INSET }, facing: Math.PI });
    if (wall === 'right') out.push({ wall, pos: { x: cx + w / 2 - SPOT_INSET, y: 0, z: cz + along }, facing: Math.PI / 2 });
    if (wall === 'left') out.push({ wall, pos: { x: cx - w / 2 + SPOT_INSET, y: 0, z: cz + along }, facing: -Math.PI / 2 });
  }
  return out;
}

/**
 * From a point in the open (the lobby, below the entrance) along the
 * corridors and in through the lot's door to `spot`. The same H/V corridor
 * legs every walker uses, then around every other office, meeting room and
 * the reception. Reverse it to walk back out.
 */
export function crewRoute(
  from: Vec3,
  spot: Vec3,
  room: RoomInfo,
  rooms: Map<string, RoomInfo>,
  grid: CorridorGrid,
  coreRooms: ReadonlyArray<{ cx: number; cz: number; w: number; d: number }>,
): Vec3[] {
  // The hall (core index 1) is open lobby — everything else in the core is walled.
  const walledCore = coreRooms.filter((_, i) => i !== 1);
  const obstacles = [
    ...roomAabbs(rooms, new Set([room])),
    ...meetingRoomAabbs(walledCore),
    ...zoneObstacles(),
  ];

  const pts: Vec3[] = [{ ...from }];
  if (grid.segments.length > 0) {
    const door = { x: (room as any).doorX ?? room.cx, y: 0, z: (room as any).doorCZ ?? room.doorZ };
    const src = entryNode(from, door, grid);
    const tgt = nearestCorridorNode(door, grid);
    pts.push({ ...src });
    if (Math.abs(src.x - tgt.x) > 1 || Math.abs(src.z - tgt.z) > 1) {
      const srcHZ = nearestHCorrZ(src.z, grid);
      const tgtHZ = nearestHCorrZ(tgt.z, grid);
      if (Math.abs(src.x - tgt.x) > 1) {
        const vx = nearestVCorrXBetween(src.x, tgt.x, grid);
        pts.push({ x: vx, y: 0, z: srcHZ });
        if (Math.abs(srcHZ - tgtHZ) > 1) pts.push({ x: vx, y: 0, z: tgtHZ });
        pts.push({ x: tgt.x, y: 0, z: tgtHZ });
      } else if (Math.abs(srcHZ - tgtHZ) > 1) {
        const vx = nearestVCorrX(src.x, grid);
        pts.push({ x: vx, y: 0, z: srcHZ });
        pts.push({ x: vx, y: 0, z: tgtHZ });
      }
    }
    pts.push({ ...tgt });
  }
  pts.push(...enterViaDoor(spot, room));
  pts.push({ ...spot });

  const dedup: Vec3[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = dedup[dedup.length - 1];
    if (Math.abs(pts[i].x - prev.x) > 0.3 || Math.abs(pts[i].z - prev.z) > 0.3) dedup.push(pts[i]);
  }
  return avoidDesks(dedup, obstacles);
}

/**
 * The corridor node to step into from `from`. The lobby sits between two
 * corridors at the same distance, so "the nearest" is a coin toss that sent
 * half the crew the long way round. Among the nodes about as near as the
 * nearest, take the one on the side of the destination.
 */
function entryNode(from: Vec3, toward: Vec3, grid: CorridorGrid): Vec3 {
  const d = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
  const nearest = nearestCorridorNode(from, grid);
  const reach = d(from, nearest) + 4;
  let best = nearest;
  for (const n of grid.nodes) {
    if (d(from, n) <= reach && d(n, toward) < d(best, toward)) best = n;
  }
  return best;
}

/** Overshoot-and-settle, so each tier lands with a little bounce. */
function easeOutBack(t: number): number {
  const c1 = 1.4, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

const TIERS = 3;

/**
 * Height fraction (0..1) of wall `k` of `n` at `progress` through the build
 * phase. Walls start one after another and each goes up in three tiers, each
 * tier landing with a bounce. Done by 85% of the phase; the rest is for the
 * furniture.
 */
export function wallRise(progress: number, k: number, n: number): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const span = 0.55;
  const start = n > 1 ? (k / (n - 1)) * (0.85 - span) : 0;
  const u = (progress - start) / span;
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const x = u * TIERS;
  const tier = Math.floor(x);
  const f = x - tier;
  // First 60% of each tier is the lift, the rest a pause while it is nailed down.
  const lift = f < 0.6 ? easeOutBack(f / 0.6) : 1;
  return Math.min(1.08, (tier + lift) / TIERS);
}
