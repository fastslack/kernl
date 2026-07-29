/**
 * Paper plane — flies a small cone along a quadratic bezier from `from` to
 * `to` with a high apex; rolls slightly mid-flight; fires `onArrive` when it
 * reaches the target. Drives the "question to the top agent" visual.
 */

import type { Ticker } from '../registry.js';
import { easeInOutQuad } from '../easing.js';
import { getThree } from './_init.js';

export interface PaperPlaneOpts {
  from: { x: number; y?: number; z: number };
  to: { x: number; y?: number; z: number };
  /** Apex height above midpoint. Default 4. */
  archHeight?: number;
  /** Flight duration. Default 1.8s. */
  durationSec?: number;
  /** Plane color hex. Default white. */
  color?: number;
  /** Bezier samples. Default 32. */
  samples?: number;
  /** Cone scale. Default 0.55. */
  scale?: number;
  /** Called once the plane has arrived. */
  onArrive?: () => void;
  tag?: string;
}

export function paperPlane(scene: any, opts: PaperPlaneOpts): Ticker {
  const THREE = getThree();
  const arch = opts.archHeight ?? 4;
  const duration = opts.durationSec ?? 1.8;
  const samples = opts.samples ?? 32;
  const fromY = (opts.from.y ?? 0) + 2;
  const toY = (opts.to.y ?? 0) + 2;

  const v0 = new THREE.Vector3(opts.from.x, fromY, opts.from.z);
  const v1 = new THREE.Vector3(
    (opts.from.x + opts.to.x) / 2,
    Math.max(fromY, toY) + arch,
    (opts.from.z + opts.to.z) / 2,
  );
  const v2 = new THREE.Vector3(opts.to.x, toY, opts.to.z);
  const curve = new THREE.QuadraticBezierCurve3(v0, v1, v2);
  const pts: any[] = curve.getPoints(samples);

  const scale = opts.scale ?? 0.55;
  const planeGeo = new THREE.ConeGeometry(0.22 * scale, 0.7 * scale, 3);
  const planeMat = new THREE.MeshBasicMaterial({ color: opts.color ?? 0xffffff });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  scene.add(plane);

  const up = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Vector3();
  let elapsed = 0;
  let arrived = false;

  function sample(t: number): { pos: any; dir: any } {
    const tt = Math.min(Math.max(t, 0), 1) * (pts.length - 1);
    const i = Math.min(Math.floor(tt), pts.length - 2);
    const st = tt - i;
    const a = pts[i], b = pts[i + 1];
    return {
      pos: { x: a.x + (b.x - a.x) * st, y: a.y + (b.y - a.y) * st, z: a.z + (b.z - a.z) * st },
      dir: tmp.set(b.x - a.x, b.y - a.y, b.z - a.z).normalize(),
    };
  }

  return {
    tag: opts.tag ?? 'paper-plane',
    update(deltaSec: number): boolean {
      elapsed += deltaSec;
      const t = Math.min(elapsed / duration, 1);
      const e = easeInOutQuad(t);
      const { pos, dir } = sample(e);
      plane.position.set(pos.x, pos.y, pos.z);
      // Align cone +Y axis to flight direction.
      plane.quaternion.setFromUnitVectors(up, dir);
      // Mid-flight roll for character.
      plane.rotateOnAxis(dir, Math.sin(elapsed * 6) * 0.18);

      if (t >= 1) {
        if (!arrived) { opts.onArrive?.(); arrived = true; }
        return true;
      }
      return false;
    },
    dispose() {
      if (plane.parent) plane.parent.remove(plane);
      planeGeo.dispose();
      planeMat.dispose();
    },
  };
}
