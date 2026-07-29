/**
 * Coin trail — N tumbling gold cylinders that travel from `from` to `to` on
 * parabolic arcs, staggered in time so they read as a stream of money. Drives
 * the trade execution's capital-flow visual (desk→hub for BUY, hub→desk for
 * SELL).
 */

import type { Ticker } from '../registry.js';
import { getThree } from './_init.js';

export interface CoinTrailOpts {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  /** Number of coins in the stream. Default 6. */
  count?: number;
  /** Seconds between successive coin spawns. Default 0.09. */
  staggerSec?: number;
  /** Time each coin takes from spawn to arrival. Default 0.85. */
  coinDurationSec?: number;
  /** Parabola apex above the midpoint. Default 1.2. */
  archHeight?: number;
  /** Coin color (hex). Default gold. */
  color?: number;
  /** Coin disc radius. Default 0.08. */
  radius?: number;
  /** Coin disc thickness. Default 0.025. */
  thickness?: number;
  /** Tumble rate (rad/sec). Default 5. */
  spinSpeed?: number;
  tag?: string;
}

export function coinTrail(scene: any, opts: CoinTrailOpts): Ticker {
  const THREE = getThree();
  const count = opts.count ?? 6;
  const stagger = opts.staggerSec ?? 0.09;
  const duration = opts.coinDurationSec ?? 0.85;
  const arch = opts.archHeight ?? 1.2;
  const radius = opts.radius ?? 0.08;
  const thickness = opts.thickness ?? 0.025;
  const spinSpeed = opts.spinSpeed ?? 5;
  const color = new THREE.Color(opts.color ?? 0xffd966);

  // Shared geometry; per-coin material for individual opacity if needed later.
  const coinGeo = new THREE.CylinderGeometry(radius, radius, thickness, 14);

  interface Coin { mesh: any; mat: any; startSec: number; done: boolean; }
  const coins: Coin[] = [];
  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.55,
      metalness: 0.75, roughness: 0.3,
      transparent: true, opacity: 1,
    });
    const mesh = new THREE.Mesh(coinGeo, mat);
    mesh.visible = false;
    scene.add(mesh);
    coins.push({ mesh, mat, startSec: i * stagger, done: false });
  }

  const totalDuration = (count - 1) * stagger + duration + 0.1; // small grace
  let elapsed = 0;

  return {
    tag: opts.tag ?? 'coin-trail',
    update(deltaSec: number): boolean {
      elapsed += deltaSec;
      let allDone = true;
      for (const c of coins) {
        if (c.done) continue;
        const e = elapsed - c.startSec;
        if (e < 0) { allDone = false; continue; }
        if (e >= duration) {
          c.done = true;
          c.mesh.visible = false;
          continue;
        }
        allDone = false;
        c.mesh.visible = true;
        const t = e / duration;
        // Linear XZ, parabolic Y arc (peaks at t=0.5).
        const px = opts.from.x + (opts.to.x - opts.from.x) * t;
        const pz = opts.from.z + (opts.to.z - opts.from.z) * t;
        const baseY = opts.from.y + (opts.to.y - opts.from.y) * t;
        const py = baseY + 4 * arch * t * (1 - t);
        c.mesh.position.set(px, py, pz);
        // Tumble
        c.mesh.rotation.x += spinSpeed * deltaSec;
        c.mesh.rotation.y += spinSpeed * 0.7 * deltaSec;
      }
      return allDone && elapsed >= totalDuration;
    },
    dispose() {
      for (const c of coins) {
        if (c.mesh.parent) c.mesh.parent.remove(c.mesh);
        c.mat?.dispose();
      }
      coinGeo.dispose();
    },
  };
}
