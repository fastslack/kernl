/**
 * Material property pulse — generic sine-based pulse on any numeric material
 * property (typically `emissiveIntensity` or `opacity`).
 *
 * Used by the delivery package's "pick me up" pulse and the meeting-speaker
 * warm-emissive glow.
 */

import type { Ticker } from '../registry.js';

export interface MaterialPulseOpts {
  /** Material property to drive. Default `'emissiveIntensity'`. */
  property?: string;
  /** Min value. */
  min: number;
  /** Max value. */
  max: number;
  /** Pulse rate in rad/s. Default 3. */
  speed?: number;
  /** Phase offset (radians). Useful to desync N pulses. Default 0. */
  phase?: number;
  /** Optional duration in seconds. When omitted, pulses forever. */
  durationSec?: number;
  tag?: string;
}

export function materialPulse(material: any, opts: MaterialPulseOpts): Ticker {
  const prop = opts.property ?? 'emissiveIntensity';
  const speed = opts.speed ?? 3;
  const phase = opts.phase ?? 0;
  const mid = (opts.min + opts.max) / 2;
  const amp = (opts.max - opts.min) / 2;
  let elapsed = 0;

  return {
    tag: opts.tag ?? 'material-pulse',
    update(deltaSec: number): boolean {
      elapsed += deltaSec;
      if (material) {
        material[prop] = mid + amp * Math.sin(elapsed * speed + phase);
      }
      if (opts.durationSec !== undefined && elapsed >= opts.durationSec) return true;
      return false;
    },
  };
}
