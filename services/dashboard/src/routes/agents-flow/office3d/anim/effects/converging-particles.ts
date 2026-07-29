/**
 * Converging particles — N small spheres spawn on a circle around `target`
 * and lerp inward, fading slightly as they collapse. The mirror image of
 * `risingParticles`. Drives the "lesson learned" effect: knowledge flowing
 * into the agent's head.
 */

import type { Ticker } from '../registry.js';
import { easeInOutQuad } from '../easing.js';
import { getThree } from './_init.js';

export interface ConvergingParticlesOpts {
  /** World position where particles converge. */
  target: { x: number; y: number; z: number };
  /** Spawn radius around the target. Default 1.5. */
  spawnRadius?: number;
  /** Vertical spread of spawn positions. Default 0.6. */
  spawnVerticalSpread?: number;
  /** Particle count. Default 8. */
  count?: number;
  /** Color (hex). Default gold. */
  color?: number;
  /** Particle radius. Default 0.06. */
  particleRadius?: number;
  /** Lifetime in seconds. Default 1.0. */
  durationSec?: number;
  tag?: string;
}

export function convergingParticles(scene: any, opts: ConvergingParticlesOpts): Ticker {
  const THREE = getThree();
  const count = opts.count ?? 8;
  const radius = opts.spawnRadius ?? 1.5;
  const vSpread = opts.spawnVerticalSpread ?? 0.6;
  const duration = opts.durationSec ?? 1.0;
  const particleR = opts.particleRadius ?? 0.06;
  const color = new THREE.Color(opts.color ?? 0xffd166);

  const group = new THREE.Group();
  scene.add(group);
  const geo = new THREE.SphereGeometry(particleR, 6, 6);

  interface P { mesh: any; mat: any; sx: number; sy: number; sz: number; }
  const ps: P[] = [];
  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
    const m = new THREE.Mesh(geo, mat);
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.3;
    const r = radius * (0.6 + Math.random() * 0.4);
    const sx = opts.target.x + Math.cos(a) * r;
    const sy = opts.target.y + (Math.random() - 0.5) * vSpread;
    const sz = opts.target.z + Math.sin(a) * r;
    m.position.set(sx, sy, sz);
    group.add(m);
    ps.push({ mesh: m, mat, sx, sy, sz });
  }

  let elapsed = 0;
  return {
    tag: opts.tag ?? 'converging-particles',
    update(deltaSec: number): boolean {
      elapsed += deltaSec;
      const t = Math.min(elapsed / duration, 1);
      const e = easeInOutQuad(t);
      for (const p of ps) {
        p.mesh.position.x = p.sx + (opts.target.x - p.sx) * e;
        p.mesh.position.y = p.sy + (opts.target.y - p.sy) * e;
        p.mesh.position.z = p.sz + (opts.target.z - p.sz) * e;
        p.mat.opacity = 1 - t * 0.4;
      }
      return t >= 1;
    },
    dispose() {
      for (const p of ps) p.mat?.dispose();
      geo.dispose();
      if (group.parent) group.parent.remove(group);
    },
  };
}
