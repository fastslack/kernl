/**
 * Rising particles + scaling ring — the trade-celebration animation.
 *
 * Particles drift upward with a tiny random vertical jitter and fade out
 * uniformly over `maxAgeSec`. The wrapping group also pulses scale on X/Z
 * so the floor ring inside it breathes. When the animation ends the ticker
 * disposes its scene attachment.
 */

import type { Ticker } from '../registry.js';

export interface RisingParticlesOpts {
  /** Total lifetime in seconds. */
  maxAgeSec: number;
  /** Base upward velocity (units/sec). Default 1.5. */
  riseSpeed?: number;
  /** Random vertical jitter added per particle per frame. Default 0.5. */
  riseJitter?: number;
  /** Scale-pulse rate on the parent group (rad/s). Default 8. */
  scalePulseSpeed?: number;
  /** Scale-pulse amplitude. Default 0.3. */
  scalePulseAmp?: number;
  /** Called when the animation finishes; the host typically removes `group`
   *  from the scene + disposes geometries here. */
  onDispose?: () => void;
  tag?: string;
}

/** `group` is any THREE.Group containing particle Meshes as children. */
export function risingParticles(group: any, opts: RisingParticlesOpts): Ticker {
  const riseSpeed = opts.riseSpeed ?? 1.5;
  const riseJitter = opts.riseJitter ?? 0.5;
  const pulseSpeed = opts.scalePulseSpeed ?? 8;
  const pulseAmp = opts.scalePulseAmp ?? 0.3;
  let age = 0;

  return {
    tag: opts.tag ?? 'rising-particles',
    update(deltaSec: number): boolean {
      age += deltaSec;
      const t = age / opts.maxAgeSec;
      if (t >= 1) return true;

      // Particles rise + fade
      for (const child of group.children) {
        child.position.y += deltaSec * (riseSpeed + Math.random() * riseJitter);
        if (child.material) {
          child.material.opacity = Math.max(0, 1 - t);
        }
      }

      // Scale pulse on the host group
      const scale = 1 + pulseAmp * Math.sin(age * pulseSpeed);
      group.scale.set(scale, 1, scale);
      return false;
    },
    dispose() {
      opts.onDispose?.();
    },
  };
}
