/**
 * Curved arrow — a quadratic-bezier 3D Line drawn between two world points
 * with a cone arrowhead at the tip. Animates: draws in, holds, fades out.
 * Drives the "directive from manager" visual on top of the existing walker.
 */

import type { Ticker } from '../registry.js';
import { easeInOutQuad } from '../easing.js';
import { getThree } from './_init.js';

export interface CurvedArrowOpts {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  /** Apex height above midpoint. Default 4. */
  archHeight?: number;
  /** Color (hex). Default white. */
  color?: number;
  /** Draw-in duration. Default 0.5. */
  drawSec?: number;
  /** Hold-after-drawn duration. Default 0.8. */
  holdSec?: number;
  /** Fade-out duration. Default 0.4. */
  fadeSec?: number;
  /** Bezier polyline samples. Default 64. */
  samples?: number;
  tag?: string;
}

export function curvedArrow(scene: any, opts: CurvedArrowOpts): Ticker {
  const THREE = getThree();
  const arch = opts.archHeight ?? 4;
  const color = opts.color ?? 0xffffff;
  const samples = opts.samples ?? 64;
  const drawSec = opts.drawSec ?? 0.5;
  const holdSec = opts.holdSec ?? 0.8;
  const fadeSec = opts.fadeSec ?? 0.4;

  const v0 = new THREE.Vector3(opts.from.x, opts.from.y, opts.from.z);
  const v1 = new THREE.Vector3(
    (opts.from.x + opts.to.x) / 2,
    Math.max(opts.from.y, opts.to.y) + arch,
    (opts.from.z + opts.to.z) / 2,
  );
  const v2 = new THREE.Vector3(opts.to.x, opts.to.y, opts.to.z);
  const curve = new THREE.QuadraticBezierCurve3(v0, v1, v2);
  const pts = curve.getPoints(samples);
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const line = new THREE.Line(geo, mat);
  geo.setDrawRange(0, 0);
  scene.add(line);

  // Arrowhead — cone aligned to the final tangent.
  const tip = pts[pts.length - 1];
  const beforeTip = pts[pts.length - 2] ?? pts[0];
  const dir = new THREE.Vector3().subVectors(tip, beforeTip).normalize();
  const headGeo = new THREE.ConeGeometry(0.18, 0.45, 8);
  const headMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 });
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.copy(tip);
  head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  scene.add(head);

  let elapsed = 0;
  const total = drawSec + holdSec + fadeSec;

  return {
    tag: opts.tag ?? 'curved-arrow',
    update(deltaSec: number): boolean {
      elapsed += deltaSec;
      if (elapsed >= total) return true;

      if (elapsed < drawSec) {
        const t = elapsed / drawSec;
        const n = Math.floor(easeInOutQuad(t) * (pts.length - 1)) + 1;
        geo.setDrawRange(0, n);
        headMat.opacity = 0;
      } else if (elapsed < drawSec + holdSec) {
        geo.setDrawRange(0, pts.length);
        mat.opacity = 0.9;
        headMat.opacity = 0.9;
      } else {
        const ft = (elapsed - drawSec - holdSec) / fadeSec;
        mat.opacity = 0.9 * (1 - ft);
        headMat.opacity = 0.9 * (1 - ft);
      }
      return false;
    },
    dispose() {
      if (line.parent) line.parent.remove(line);
      if (head.parent) head.parent.remove(head);
      geo.dispose();
      mat.dispose();
      headGeo.dispose();
      headMat.dispose();
    },
  };
}
