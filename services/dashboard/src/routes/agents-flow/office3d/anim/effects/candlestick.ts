/**
 * 3D candlestick — emissive box body that grows from a baseline (upward for
 * BUY, downward for SELL), flanked by a long wick on the moving side and a
 * shorter wick on the opposite. Drives the trade execution's central visual.
 *
 * Pivot trick: the body lives inside a child Group (`bodyAnchor`) whose
 * scale.y animates 0→1; the body Mesh is pre-positioned half-height up (or
 * down) so scaling the anchor extends the body away from the baseline,
 * keeping the base pinned in place.
 */

import type { Ticker } from '../registry.js';
import { easeOutCubic } from '../easing.js';
import { getThree } from './_init.js';

export interface CandlestickOpts {
  /** World-space baseline center (the open price). */
  position: { x: number; y: number; z: number };
  side: 'BUY' | 'SELL';
  /** Body final height. Default 1.6. */
  bodyHeight?: number;
  /** Body width and depth (square cross-section). */
  bodyWidth?: number;
  bodyDepth?: number;
  /** Length of the long wick (on the moving side). Default 0.5. */
  wickLength?: number;
  /** Color hex; defaults to green for BUY, red for SELL. */
  color?: number;
  /** Total lifetime. Default 2.5. */
  durationSec?: number;
  /** Body grow duration. Default 0.4. */
  growSec?: number;
  /** Final fade-out duration. Default 0.6. */
  fadeSec?: number;
  tag?: string;
}

export function candlestick(scene: any, opts: CandlestickOpts): Ticker {
  const THREE = getThree();
  const isBuy = opts.side === 'BUY';
  const bodyH = opts.bodyHeight ?? 1.6;
  const bodyW = opts.bodyWidth  ?? 0.5;
  const bodyD = opts.bodyDepth  ?? 0.5;
  const wickL = opts.wickLength ?? 0.5;
  const color = opts.color ?? (isBuy ? 0x00ff88 : 0xff4466);
  const duration = opts.durationSec ?? 2.5;
  const grow = opts.growSec ?? 0.4;
  const fade = opts.fadeSec ?? 0.6;

  // Root group at baseline.
  const group = new THREE.Group();
  group.position.set(opts.position.x, opts.position.y, opts.position.z);
  scene.add(group);

  // Body — pivot at baseline thanks to bodyAnchor child offset.
  const bodyGeo = new THREE.BoxGeometry(bodyW, bodyH, bodyD);
  const bodyMat = new THREE.MeshStandardMaterial({
    color, emissive: new THREE.Color(color), emissiveIntensity: 0.85,
    transparent: true, opacity: 0.92, roughness: 0.4, metalness: 0.0,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = isBuy ? bodyH / 2 : -bodyH / 2;
  const bodyAnchor = new THREE.Group();
  bodyAnchor.scale.y = 0;
  bodyAnchor.add(body);
  group.add(bodyAnchor);

  // Wicks — shared material so they fade together. Long wick on the moving
  // side, short wick on the opposite side (decorative — real charts always
  // have wicks on both sides).
  const wickGeo = new THREE.CylinderGeometry(0.025, 0.025, wickL, 6);
  const wickMat = new THREE.MeshStandardMaterial({
    color, emissive: new THREE.Color(color), emissiveIntensity: 0.55,
    transparent: true, opacity: 0,
  });
  const wickLong = new THREE.Mesh(wickGeo, wickMat);
  wickLong.position.y = isBuy ? bodyH + wickL / 2 : -bodyH - wickL / 2;
  group.add(wickLong);
  const wickShort = new THREE.Mesh(wickGeo, wickMat);
  wickShort.position.y = isBuy ? -wickL / 2 : wickL / 2;
  wickShort.scale.y = 0.4;
  group.add(wickShort);

  let elapsed = 0;
  const fadeStart = duration - fade;

  return {
    tag: opts.tag ?? 'candlestick',
    update(deltaSec: number): boolean {
      elapsed += deltaSec;
      if (elapsed >= duration) return true;

      // Grow body
      if (elapsed < grow) {
        bodyAnchor.scale.y = easeOutCubic(elapsed / grow);
      } else {
        bodyAnchor.scale.y = 1;
      }

      // Wicks fade in over 0.3s after grow finishes
      if (elapsed > grow && elapsed < fadeStart) {
        wickMat.opacity = Math.min((elapsed - grow) / 0.3, 1) * 0.9;
      }

      // Fade out everything at the end
      if (elapsed > fadeStart) {
        const ft = (elapsed - fadeStart) / fade;
        const op = Math.max(0, 1 - ft);
        bodyMat.opacity = 0.92 * op;
        wickMat.opacity = 0.9  * op;
      }
      return false;
    },
    dispose() {
      if (group.parent) group.parent.remove(group);
      bodyGeo.dispose();
      bodyMat.dispose();
      wickGeo.dispose();
      wickMat.dispose();
    },
  };
}
