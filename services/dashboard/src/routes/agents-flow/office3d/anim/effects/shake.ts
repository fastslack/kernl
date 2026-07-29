/**
 * Decaying shake — perturbs any numeric property (e.g. `rotation.x`,
 * `position.y`) with a sine-based jitter whose amplitude decays linearly to
 * zero over `durationSec`. Restores the original value on dispose so a
 * cancelled shake doesn't leave the target tilted forever.
 *
 * Drives the "failed run" desk-rattle and is reusable for any "oops" reaction.
 */

import type { Ticker } from '../registry.js';

export interface ShakeOpts {
  /** Dot-path to the numeric property. Default `'rotation.x'`. */
  property?: string;
  /** Peak amplitude (radians or units). */
  amplitude: number;
  /** Oscillation frequency in Hz. Default 22. */
  frequencyHz?: number;
  /** Lifetime in seconds. */
  durationSec: number;
  /** Optional random jitter on amplitude (0..1). Default 0.5 — adds chaos. */
  randomness?: number;
  tag?: string;
}

export function shake(target: any, opts: ShakeOpts): Ticker {
  const prop = (opts.property ?? 'rotation.x').split('.');
  const omega = (opts.frequencyHz ?? 22) * 2 * Math.PI;
  const randomness = opts.randomness ?? 0.5;

  // Walk the dot-path to find host + leaf so we can mutate in place.
  let host: any = target;
  for (let i = 0; i < prop.length - 1; i++) host = host[prop[i]];
  const leaf = prop[prop.length - 1];
  const original = host[leaf];

  let elapsed = 0;

  return {
    tag: opts.tag ?? 'shake',
    update(deltaSec: number): boolean {
      elapsed += deltaSec;
      if (elapsed >= opts.durationSec) {
        host[leaf] = original;
        return true;
      }
      const decay = 1 - elapsed / opts.durationSec;
      const r = 1 - randomness + Math.random() * randomness;
      host[leaf] = original + opts.amplitude * decay * r * Math.sin(elapsed * omega);
      return false;
    },
    dispose() {
      host[leaf] = original;
    },
  };
}
