/**
 * Polyline path math — XZ-plane navigation helpers shared by walkers and the
 * delivery animation. Y is preserved when present (delivery paths drop from
 * the plinth to street level), but distance is computed across all 3 axes so
 * cumulative-distance lookup stays correct on sloped segments.
 *
 * The functions here used to live as private helpers in walkers.ts and were
 * re-implemented (less efficiently) inside delivery.ts. Centralising them
 * here kills the duplication and gives us a single place to optimise.
 */

import type { Vec3 } from '../types.js';

/** Squared distance ignoring Y — cheap obstacle-distance tie-breaker. */
export function distXZSq(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return dx * dx + dz * dz;
}

/** Build cumulative distance array (index i = distance from start to pts[i]). */
export function buildCumDist(pts: Vec3[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = (pts[i].y ?? 0) - (pts[i - 1].y ?? 0);
    const dz = pts[i].z - pts[i - 1].z;
    cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return cum;
}

/** Total polyline length. */
export function pathLength(pts: Vec3[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = (pts[i].y ?? 0) - (pts[i - 1].y ?? 0);
    const dz = pts[i].z - pts[i - 1].z;
    d += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return d;
}

/** Binary search: which segment contains `targetDist` (O(log n)). */
export function findSegment(cumDist: number[], targetDist: number): number {
  let lo = 0;
  let hi = cumDist.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumDist[mid] <= targetDist) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Position along a polyline at progress t (0..1). When `cumDist` is supplied,
 * lookup is O(log n) instead of O(n); callers building many lookups against
 * the same path should compute `buildCumDist(pts)` once and reuse it.
 */
export function interpolatePath(pts: Vec3[], t: number, cumDist?: number[]): Vec3 {
  if (pts.length < 2) return pts[0] ?? { x: 0, y: 0, z: 0 };
  const total = cumDist ? cumDist[cumDist.length - 1] : pathLength(pts);
  if (total < 0.01) return pts[0];

  const targetDist = clamp01(t) * total;

  if (cumDist) {
    const i = findSegment(cumDist, targetDist);
    const segLen = cumDist[i + 1] - cumDist[i];
    if (segLen < 0.001) return pts[i];
    const segT = (targetDist - cumDist[i]) / segLen;
    return {
      x: pts[i].x + (pts[i + 1].x - pts[i].x) * segT,
      y: (pts[i].y ?? 0) + ((pts[i + 1].y ?? 0) - (pts[i].y ?? 0)) * segT,
      z: pts[i].z + (pts[i + 1].z - pts[i].z) * segT,
    };
  }

  // Linear scan fallback (caller didn't supply cumDist)
  let accum = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = (pts[i].y ?? 0) - (pts[i - 1].y ?? 0);
    const dz = pts[i].z - pts[i - 1].z;
    const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (accum + segLen >= targetDist) {
      const segT = (targetDist - accum) / segLen;
      return {
        x: pts[i - 1].x + dx * segT,
        y: (pts[i - 1].y ?? 0) + dy * segT,
        z: pts[i - 1].z + dz * segT,
      };
    }
    accum += segLen;
  }
  return pts[pts.length - 1];
}

/** Heading (Y-axis angle) of the path at progress t. */
export function pathDirection(pts: Vec3[], t: number, cumDist?: number[]): number {
  const p1 = interpolatePath(pts, Math.max(0, t - 0.01), cumDist);
  const p2 = interpolatePath(pts, Math.min(1, t + 0.01), cumDist);
  return Math.atan2(p2.x - p1.x, p2.z - p1.z);
}

/** Position + heading in one call — same cost as `interpolatePath` + `pathDirection`
 *  but only one allocation. Use this when both are needed each frame. */
export function sampleAlong(
  pts: Vec3[],
  t: number,
  cumDist?: number[],
): { pos: Vec3; heading: number } {
  const pos = interpolatePath(pts, t, cumDist);
  const heading = pathDirection(pts, t, cumDist);
  return { pos, heading };
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
