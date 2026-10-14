/**
 * Camera tween — eases controls.target and camera.position toward a destination.
 *
 * Ease-out cubic from wherever the camera is on the tween's first frame to the
 * destination, landing on it exactly. (It used to nudge 10–15% of the remaining
 * distance per frame and stop after ~0.33s: the camera never arrived — 20% short
 * at 60 fps, 39% at 30 — and target and body stopped at different fractions, so
 * the view ended off-centre and at the wrong angle.)
 */

import type { Ticker } from '../registry.js';
import { easeOutCubic } from '../easing.js';

export interface CameraTweenOpts {
  /** Look-at target in world space. */
  target: { x: number; y: number; z: number };
  /** Desired camera position in world space. */
  position: { x: number; y: number; z: number };
  /** Tween speed — `progress += deltaSec * convergeRate`. Default 2 = 0.5s. */
  convergeRate?: number;
  /** Tag for `registry.cancelByTag()`. Default `'camera-tween'`. */
  tag?: string;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Create a camera-tween ticker.
 *
 * Three.js types are intentionally `any` so this module stays import-light —
 * it accepts any object with a `.position.{x,y,z}` and any controls with a
 * `.target.{x,y,z}`. The Svelte component already imports Three.js itself.
 */
export function cameraTween(
  camera: any,
  controls: any,
  opts: CameraTweenOpts,
): Ticker {
  const tag = opts.tag ?? 'camera-tween';

  // prefers-reduced-motion: the camera jumps — target and position are set
  // now, and the ticker finishes on its first frame without easing.
  if (prefersReducedMotion()) {
    controls.target.x = opts.target.x;
    controls.target.y = opts.target.y;
    controls.target.z = opts.target.z;
    camera.position.x = opts.position.x;
    camera.position.y = opts.position.y;
    camera.position.z = opts.position.z;
    return { tag, update: () => true };
  }

  const convergeRate = opts.convergeRate ?? 2;
  let progress = 0;
  let from: { tx: number; ty: number; tz: number; px: number; py: number; pz: number } | null = null;

  return {
    tag,
    update(deltaSec: number): boolean {
      from ??= {
        tx: controls.target.x, ty: controls.target.y, tz: controls.target.z,
        px: camera.position.x, py: camera.position.y, pz: camera.position.z,
      };
      progress += deltaSec * convergeRate;
      const t = Math.min(progress, 1);
      if (t >= 1) {
        controls.target.x = opts.target.x;
        controls.target.y = opts.target.y;
        controls.target.z = opts.target.z;
        camera.position.x = opts.position.x;
        camera.position.y = opts.position.y;
        camera.position.z = opts.position.z;
        return true;
      }
      const e = easeOutCubic(t);
      controls.target.x = from.tx + (opts.target.x - from.tx) * e;
      controls.target.y = from.ty + (opts.target.y - from.ty) * e;
      controls.target.z = from.tz + (opts.target.z - from.tz) * e;
      camera.position.x = from.px + (opts.position.x - from.px) * e;
      camera.position.y = from.py + (opts.position.y - from.py) * e;
      camera.position.z = from.pz + (opts.position.z - from.pz) * e;
      return false;
    },
  };
}
