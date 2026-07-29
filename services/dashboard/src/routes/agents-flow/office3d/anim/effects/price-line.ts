/**
 * Price line — a procedural random-walk polyline drawn along the X axis,
 * trace-animated left-to-right (via `setDrawRange`), held, then faded.
 * The walk has an optional bias matching the trade side so a BUY ends with
 * an upward tilt and a SELL ends downward.
 */

import type { Ticker } from '../registry.js';
import { easeInOutQuad } from '../easing.js';
import { getThree } from './_init.js';

export interface PriceLineOpts {
  /** Line origin (leftmost point). */
  origin: { x: number; y: number; z: number };
  /** Total length along X. Default 1.6. */
  length?: number;
  /** Data point count. Default 22. */
  samples?: number;
  /** Y oscillation amplitude. Default 0.45. */
  amplitude?: number;
  /** Color hex. Default white. */
  color?: number;
  /** Trade side — biases the walk in the matching direction. */
  trend?: 'BUY' | 'SELL' | 'flat';
  /** Draw-in duration. Default 0.6. */
  drawSec?: number;
  /** Hold-after-draw duration. Default 1.2. */
  holdSec?: number;
  /** Fade-out duration. Default 0.5. */
  fadeSec?: number;
  /** Optional deterministic seed. */
  seed?: number;
  /** Append a small sphere marker at the latest point. Default true. */
  showMarker?: boolean;
  tag?: string;
}

/** Mulberry32 — tiny seeded PRNG so a price-line can be reproducible. */
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function (): number {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function priceLine(scene: any, opts: PriceLineOpts): Ticker {
  const THREE = getThree();
  const length = opts.length ?? 1.6;
  const samples = opts.samples ?? 22;
  const amplitude = opts.amplitude ?? 0.45;
  const color = opts.color ?? 0xffffff;
  const drawSec = opts.drawSec ?? 0.6;
  const holdSec = opts.holdSec ?? 1.2;
  const fadeSec = opts.fadeSec ?? 0.5;
  const trend = opts.trend ?? 'flat';
  const showMarker = opts.showMarker !== false;

  // Random walk with per-side bias. Soft clamp so the line stays inside ±1.
  const rng = mulberry32(opts.seed ?? Math.floor(Math.random() * 1e9));
  const bias = trend === 'BUY' ? 0.035 : trend === 'SELL' ? -0.035 : 0;
  const pts: any[] = [];
  let y = 0;
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    y += (rng() - 0.5) * 0.45 + bias;
    if (y > 1) y = 1; if (y < -1) y = -1;
    pts.push(new THREE.Vector3(
      opts.origin.x + t * length,
      opts.origin.y + y * amplitude,
      opts.origin.z,
    ));
  }

  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const line = new THREE.Line(geo, mat);
  geo.setDrawRange(0, 0);
  scene.add(line);

  // Optional marker — a small glowing sphere at the head of the line.
  let marker: any = null;
  let markerGeo: any = null;
  let markerMat: any = null;
  if (showMarker) {
    markerGeo = new THREE.SphereGeometry(0.055, 8, 8);
    markerMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 });
    marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.copy(pts[0]);
    scene.add(marker);
  }

  let elapsed = 0;
  const total = drawSec + holdSec + fadeSec;

  return {
    tag: opts.tag ?? 'price-line',
    update(deltaSec: number): boolean {
      elapsed += deltaSec;
      if (elapsed >= total) return true;

      if (elapsed < drawSec) {
        const t = elapsed / drawSec;
        const n = Math.max(2, Math.floor(easeInOutQuad(t) * pts.length));
        geo.setDrawRange(0, n);
        if (marker) {
          marker.position.copy(pts[Math.min(n - 1, pts.length - 1)]);
          markerMat.opacity = 0;
        }
      } else if (elapsed < drawSec + holdSec) {
        geo.setDrawRange(0, pts.length);
        if (marker) {
          marker.position.copy(pts[pts.length - 1]);
          markerMat.opacity = 1;
        }
      } else {
        const ft = (elapsed - drawSec - holdSec) / fadeSec;
        const op = Math.max(0, 1 - ft);
        mat.opacity = 0.9 * op;
        if (markerMat) markerMat.opacity = op;
      }
      return false;
    },
    dispose() {
      if (line.parent) line.parent.remove(line);
      geo.dispose();
      mat.dispose();
      if (marker) {
        if (marker.parent) marker.parent.remove(marker);
        markerGeo?.dispose();
        markerMat?.dispose();
      }
    },
  };
}
