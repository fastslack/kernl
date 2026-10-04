/**
 * Where to set a package down so it never lands on top of another one.
 *
 * Every delivery used to drop at the one counter point. That holds only while
 * a single package exists, and it stops holding as soon as one is left behind
 * (a dev reload restarts the delivery module and orphans the parcel already on
 * the counter) or two deliveries overlap. The result was a pile of boxes
 * inside each other at the same coordinates.
 *
 * The answer walks outwards along the counter (x) from the base point,
 * alternating sides; when the counter is full it stacks on the base point.
 */

export interface Spot { x: number; y: number; z: number }

/** Package box footprint (delivery.ts builds 0.4 × 0.3 × 0.3). */
const PKG_W = 0.4;
const PKG_H = 0.3;
const PKG_D = 0.3;
/** Gap left between neighbours, so they read as separate boxes. */
const GAP = 0.12;
/** Side steps tried along the counter before stacking (each side). */
const SIDE_STEPS = 4;
/** Stack levels tried once the counter row is full. */
const STACK_LEVELS = 6;

/** True when a box centred at `s` would overlap a box centred at `o`. */
export function overlaps(s: Spot, o: Spot): boolean {
  return Math.abs(s.x - o.x) < PKG_W && Math.abs(s.z - o.z) < PKG_D && Math.abs(s.y - o.y) < PKG_H;
}

/** The first free spot near `base`, never overlapping any of `occupied`. */
export function freeDropSpot(base: Spot, occupied: Spot[]): Spot {
  const free = (s: Spot) => !occupied.some((o) => overlaps(s, o));
  const step = PKG_W + GAP;
  const candidates: Spot[] = [base];
  for (let k = 1; k <= SIDE_STEPS; k++) {
    candidates.push({ ...base, x: base.x + k * step }, { ...base, x: base.x - k * step });
  }
  for (const c of candidates) if (free(c)) return c;
  for (let level = 1; level <= STACK_LEVELS; level++) {
    for (const c of candidates) {
      const up = { ...c, y: c.y + level * PKG_H };
      if (free(up)) return up;
    }
  }
  // Absurdly full counter: still never inside another box — go above them all.
  const top = Math.max(base.y, ...occupied.map((o) => o.y));
  return { ...base, y: top + PKG_H };
}
