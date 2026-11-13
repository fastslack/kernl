/**
 * Lesson thread — what one agent learned travelling to another.
 *
 * `thread`: a glowing tube draws itself along an arc from the agent that
 * learned a lesson to the head of the agent now using it, a bright bead
 * riding its tip; the tube's thickness is the lesson's score. It holds, then
 * fades.
 *
 * `spark`: the way back — a bead runs along the same arc from the agent that
 * used the lesson to the one that learned it (green when the run backed the
 * lesson up, red when it did not), trailing a thin ghost of the arc, and
 * bursts on arrival.
 *
 * The arc is the same function in both modes, so a reinforcement spark
 * retraces the thread that brought the lesson.
 */

import type { Ticker } from '../registry.js';
import { easeInOutQuad, easeOutCubic } from '../easing.js';
import { getThree } from './_init.js';

type P = { x: number; y: number; z: number };

export interface LessonThreadOpts {
  from: P;
  to: P;
  mode?: 'thread' | 'spark';
  /** Hex color. Thread default violet; spark: pass green or red. */
  color?: number;
  /** 0..1 — thread thickness (the lesson's score). Default 0.6. */
  weight?: number;
  /** Apex above the higher end. Default 3.5 (more for long hops). */
  archHeight?: number;
  /** Travel time. Default 1.1 s (thread), 0.9 s (spark). */
  travelSec?: number;
  /** Hold after arrival. Default 1.6 s (thread), 0.25 s (spark). */
  holdSec?: number;
  /** Fade-out. Default 0.6 s. */
  fadeSec?: number;
  tag?: string;
}

/** The arc both modes follow, from `a` to `b`. Exported for tests and labels. */
export function lessonArcPoint(a: P, b: P, t: number, arch?: number): P {
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  const h = arch ?? Math.min(7, 2.5 + dist * 0.12);
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, my = Math.max(a.y, b.y) + h;
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * mx + t * t * b.x,
    y: u * u * a.y + 2 * u * t * my + t * t * b.y,
    z: u * u * a.z + 2 * u * t * mz + t * t * b.z,
  };
}

export function lessonThread(scene: any, opts: LessonThreadOpts): Ticker {
  const THREE = getThree();
  const mode = opts.mode ?? 'thread';
  const color = new THREE.Color(opts.color ?? (mode === 'thread' ? 0xa66bff : 0x50ff88));
  const travel = opts.travelSec ?? (mode === 'thread' ? 1.1 : 0.9);
  const hold = opts.holdSec ?? (mode === 'thread' ? 1.6 : 0.25);
  const fade = opts.fadeSec ?? 0.6;
  const total = travel + hold + fade;

  const SEGMENTS = 72, RADIAL = 6;
  const v0 = new THREE.Vector3(opts.from.x, opts.from.y, opts.from.z);
  const mid = lessonArcPoint(opts.from, opts.to, 0.5, opts.archHeight);
  // A quadratic through the arc's apex: control point solves B(0.5) = mid.
  const ctrl = new THREE.Vector3(
    2 * mid.x - (opts.from.x + opts.to.x) / 2,
    2 * mid.y - (opts.from.y + opts.to.y) / 2,
    2 * mid.z - (opts.from.z + opts.to.z) / 2,
  );
  const v2 = new THREE.Vector3(opts.to.x, opts.to.y, opts.to.z);
  const curve = new THREE.QuadraticBezierCurve3(v0, ctrl, v2);

  const group = new THREE.Group();
  scene.add(group);

  const weight = Math.max(0, Math.min(1, opts.weight ?? 0.6));
  // Sized for the office camera: a person is ~2 units tall and seen from far.
  const radius = mode === 'thread' ? 0.07 + 0.13 * weight : 0.05;
  const tubeGeo = new THREE.TubeGeometry(curve, SEGMENTS, radius, RADIAL, false);
  const tubeMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: mode === 'thread' ? 0.95 : 0.45, depthWrite: false,
  });
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  const indexCount = tubeGeo.index ? tubeGeo.index.count : 0;
  tubeGeo.setDrawRange(0, 0);
  group.add(tube);

  // A halo tube around the thread: the glow without postprocessing.
  let haloGeo: any = null, haloMat: any = null;
  if (mode === 'thread') {
    haloGeo = new THREE.TubeGeometry(curve, SEGMENTS, radius * 2.4, RADIAL, false);
    haloMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false });
    haloGeo.setDrawRange(0, 0);
    group.add(new THREE.Mesh(haloGeo, haloMat));
  }

  const beadGeo = new THREE.SphereGeometry(mode === 'thread' ? 0.3 + 0.15 * weight : 0.32, 16, 12);
  const beadMat = new THREE.MeshBasicMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), 0.45), transparent: true, opacity: 1 });
  const bead = new THREE.Mesh(beadGeo, beadMat);
  bead.position.copy(v0);
  group.add(bead);

  // The burst on arrival: a ring that widens and fades.
  const ringGeo = new THREE.RingGeometry(0.3, 0.45, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.copy(v2);
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  let elapsed = 0;
  return {
    tag: opts.tag ?? `lesson-${mode}`,
    update(deltaSec: number): boolean {
      elapsed += deltaSec;
      if (elapsed >= total) return true;
      if (elapsed < travel) {
        const t = easeInOutQuad(elapsed / travel);
        const drawn = Math.max(1, Math.floor(t * SEGMENTS)) * RADIAL * 6;
        tubeGeo.setDrawRange(0, Math.min(indexCount, drawn));
        haloGeo?.setDrawRange(0, Math.min(indexCount, drawn));
        bead.position.copy(curve.getPoint(t));
        bead.scale.setScalar(1 + 0.25 * Math.sin(elapsed * 18));
      } else {
        tubeGeo.setDrawRange(0, indexCount);
        haloGeo?.setDrawRange(0, indexCount);
        bead.position.copy(v2);
        const a = elapsed - travel;
        // Burst: the ring widens over the first 0.7 s after arrival.
        const rt = Math.min(1, a / 0.7);
        ring.scale.setScalar(1 + 5 * easeOutCubic(rt));
        ringMat.opacity = 0.8 * (1 - rt);
        bead.scale.setScalar(Math.max(0, 1 - rt));
        if (elapsed > travel + hold) {
          const ft = (elapsed - travel - hold) / fade;
          tubeMat.opacity = (mode === 'thread' ? 0.95 : 0.45) * (1 - ft);
          if (haloMat) haloMat.opacity = 0.3 * (1 - ft);
        }
      }
      return false;
    },
    dispose() {
      if (group.parent) group.parent.remove(group);
      tubeGeo.dispose(); tubeMat.dispose();
      haloGeo?.dispose(); haloMat?.dispose();
      beadGeo.dispose(); beadMat.dispose();
      ringGeo.dispose(); ringMat.dispose();
    },
  };
}
