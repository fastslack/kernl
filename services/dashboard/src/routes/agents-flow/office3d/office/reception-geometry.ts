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

/** Waiting lounges, one each side of the lobby runner, south of the counter:
 *  a rug with a sofa against its outer edge facing the runner, a coffee table
 *  in front of it and a plant at each end. Centre offsets from (cx, counterZ). */
export const RECEPTION_LOUNGE_X = 6.9;
export const RECEPTION_LOUNGE_Z = 7.5;
/** Rug size (x, z). The furniture fits inside it. */
export const RECEPTION_LOUNGE_RUG_W = 3.4;
export const RECEPTION_LOUNGE_RUG_D = 3.8;

/** Centre of each lounge; `side` is -1 west of the runner, +1 east. */
export function receptionLounges(cx: number, counterZ: number): Array<{ x: number; z: number; side: -1 | 1 }> {
  return ([-1, 1] as const).map((side) => ({ x: cx + side * RECEPTION_LOUNGE_X, z: counterZ + RECEPTION_LOUNGE_Z, side }));
}

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
 * overhanging top and rims), the two columns, the back wall and the two
 * waiting lounges (the whole rug, so nobody walks across the coffee table). Kept as
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
    ...receptionLounges(cx, counterZ).map((l) => box(
      l.x - RECEPTION_LOUNGE_RUG_W / 2, l.x + RECEPTION_LOUNGE_RUG_W / 2,
      l.z - RECEPTION_LOUNGE_RUG_D / 2, l.z + RECEPTION_LOUNGE_RUG_D / 2,
    )),
  ];
}
