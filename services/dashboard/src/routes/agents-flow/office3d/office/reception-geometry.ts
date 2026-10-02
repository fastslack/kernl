/** Reception footprint — the numbers reception.ts builds the counter from,
 *  shared with the walker router so the two can never drift apart.
 *  Pure geometry (no Three.js). */

import type { Aabb2D, Vec3 } from '../types.js';

export const RECEPTION_COUNTER_W = 10.0;
export const RECEPTION_COUNTER_D = 1.6;
/** Columns stand this far beyond each end of the counter (centre to counter edge). */
export const RECEPTION_COLUMN_GAP = 0.9;
/** Half-width of a column's base plinth (0.7 square). */
const COLUMN_HALF = 0.35;
/** Space between the counter and the tall back wall behind it.
 *  NOTE: ambiance.ts:buildActivityBoard uses the same gap. Keep them in sync. */
export const RECEPTION_WALL_GAP = 2.5;
/** Clearance kept between a walker's centre line and any reception piece. */
const MARGIN = 0.25;

/** Z of the back wall's centre plane. */
export function receptionBackWallZ(counterZ: number): number {
  return counterZ - RECEPTION_COUNTER_D / 2 - RECEPTION_WALL_GAP;
}

/** Where a walker collecting a package stands: behind the counter, between it
 *  and the back wall (the interior side). */
export function receptionPickupPos(cx: number, counterZ: number): Vec3 {
  return { x: cx, y: 0, z: counterZ - RECEPTION_COUNTER_D / 2 - 1.1 };
}

/** Where the delivery driver stands: in front of the counter, door side. */
export function receptionDriverPos(cx: number, counterZ: number): Vec3 {
  return { x: cx, y: 0, z: counterZ + RECEPTION_COUNTER_D / 2 + 1.1 };
}

/**
 * The solid pieces of the reception as walker obstacles: the counter (with its
 * overhanging top and rims), the two columns and the back wall. Kept as
 * separate boxes, not one block: the pickup spot sits between the counter and
 * the back wall, and walkers reach it through the open sides.
 */
export function receptionObstacles(cx: number, counterZ: number): Aabb2D[] {
  const halfW = RECEPTION_COUNTER_W / 2;
  const halfD = RECEPTION_COUNTER_D / 2;
  const colOff = halfW + RECEPTION_COLUMN_GAP;
  const backZ = receptionBackWallZ(counterZ);
  const box = (x0: number, x1: number, z0: number, z1: number): Aabb2D => ({
    minX: x0 - MARGIN, maxX: x1 + MARGIN, minZ: z0 - MARGIN, maxZ: z1 + MARGIN,
  });
  return [
    // Counter top overhangs the body by 0.15 + rim on each side.
    box(cx - halfW - 0.2, cx + halfW + 0.2, counterZ - halfD - 0.1, counterZ + halfD + 0.1),
    box(cx - colOff - COLUMN_HALF, cx - colOff + COLUMN_HALF, counterZ - COLUMN_HALF, counterZ + COLUMN_HALF),
    box(cx + colOff - COLUMN_HALF, cx + colOff + COLUMN_HALF, counterZ - COLUMN_HALF, counterZ + COLUMN_HALF),
    // Back wall is counterW + 0.8 wide; its gold crown overhangs to counterW + 1.2.
    box(cx - halfW - 0.6, cx + halfW + 0.6, backZ - 0.08, backZ + 0.08),
  ];
}
