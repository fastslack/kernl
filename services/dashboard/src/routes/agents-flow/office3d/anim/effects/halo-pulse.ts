/**
 * Halo pulse — breathing opacity + slow spin on a circular floor ring under
 * an active meeting. Indefinite duration; lives until `dispose()` (the host
 * does that when the meeting ends via disposeMeetingDecor).
 */

import type { Ticker } from '../registry.js';

export interface HaloPulseOpts {
  /** Breath frequency (rad/s). Default 1.6. */
  breathSpeed?: number;
  /** Min opacity at the breath trough. Default 0.27. */
  opacityMin?: number;
  /** Max opacity at the breath crest. Default 0.63. */
  opacityMax?: number;
  /** Slow Z-spin rate (rad/s). Default 0.25. */
  spinSpeed?: number;
  /** Predicate; when it returns false the ticker self-removes. Useful so the
   *  caller can tie the lifetime to "this meeting is still live". */
  while?: () => boolean;
  tag?: string;
}

/** halo: any THREE.Mesh whose material has an `opacity` field. */
export function haloPulse(halo: any, opts: HaloPulseOpts = {}): Ticker {
  const breathSpeed = opts.breathSpeed ?? 1.6;
  const spinSpeed = opts.spinSpeed ?? 0.25;
  const opMin = opts.opacityMin ?? 0.27;
  const opMax = opts.opacityMax ?? 0.63;
  const mid = (opMin + opMax) / 2;
  const amp = (opMax - opMin) / 2;

  return {
    tag: opts.tag ?? 'halo-pulse',
    update(deltaSec: number, sceneTimeSec: number): boolean {
      if (opts.while && !opts.while()) return true;
      if (halo?.material) {
        halo.material.opacity = mid + amp * Math.sin(sceneTimeSec * breathSpeed);
      }
      if (halo) halo.rotation.z += deltaSec * spinSpeed;
      return false;
    },
  };
}
