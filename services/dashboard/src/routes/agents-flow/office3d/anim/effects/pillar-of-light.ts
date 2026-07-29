/**
 * Pillar of light — a translucent emissive cylinder that rises around a
 * point, slowly spins, fades in/out. Drives the "rank promotion" visual.
 *
 * No PointLight — the effect is purely a transparent cylinder so the GPU
 * cost is the same whether one or twenty pillars are running.
 */

import type { Ticker } from '../registry.js';
import { easeOutCubic } from '../easing.js';
import { getThree } from './_init.js';

export interface PillarOfLightOpts {
  /** Base of the pillar. */
  position: { x: number; y?: number; z: number };
  /** Pillar height. Default 8. */
  height?: number;
  /** Pillar radius at the top. Default 0.8. */
  radius?: number;
  /** Color (hex). Default gold. */
  color?: number;
  /** Total duration. Default 2.5s. */
  durationSec?: number;
  /** Revolutions per second. Default 0.3. */
  spinSpeed?: number;
  /** Peak opacity. Default 0.45. */
  peakOpacity?: number;
  tag?: string;
}

export function pillarOfLight(scene: any, opts: PillarOfLightOpts): Ticker {
  const THREE = getThree();
  const height = opts.height ?? 8;
  const radius = opts.radius ?? 0.8;
  const duration = opts.durationSec ?? 2.5;
  const spinSpeed = opts.spinSpeed ?? 0.3;
  const peakOp = opts.peakOpacity ?? 0.45;
  const color = new THREE.Color(opts.color ?? 0xffd166);
  const y0 = opts.position.y ?? 0;

  // Open-ended cylinder (no caps) so the inside doesn't depth-fight with the
  // outside surface.
  const geo = new THREE.CylinderGeometry(radius, radius * 1.4, height, 16, 1, true);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const pillar = new THREE.Mesh(geo, mat);
  pillar.position.set(opts.position.x, y0 + height / 2, opts.position.z);
  scene.add(pillar);

  let elapsed = 0;
  return {
    tag: opts.tag ?? 'pillar-of-light',
    update(deltaSec: number): boolean {
      elapsed += deltaSec;
      const t = elapsed / duration;
      if (t >= 1) return true;

      // Ramps: 25% in, 45% hold, 30% out.
      let op: number;
      if (t < 0.25) op = easeOutCubic(t / 0.25) * peakOp;
      else if (t < 0.7) op = peakOp;
      else op = peakOp * (1 - (t - 0.7) / 0.3);
      mat.opacity = op;
      pillar.rotation.y += deltaSec * spinSpeed * 2 * Math.PI;
      return false;
    },
    dispose() {
      if (pillar.parent) pillar.parent.remove(pillar);
      geo.dispose();
      mat.dispose();
    },
  };
}
