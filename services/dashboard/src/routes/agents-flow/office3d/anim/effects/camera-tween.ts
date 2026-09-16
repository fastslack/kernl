/**
 * Camera tween — eases controls.target and camera.position toward a destination.
 *
 * Mirrors the inline tween that lived in AgentWorld3D.svelte's animate() loop:
 * ease-out cubic over ~0.33s, with separate damping factors for target (0.15)
 * and position (0.10) so the focus point converges slightly faster than the
 * camera body — same visual feel the original code had.
 */

import type { Ticker } from '../registry.js';
import { easeOutCubic } from '../easing.js';

export interface CameraTweenOpts {
  /** Look-at target in world space. */
  target: { x: number; y: number; z: number };
  /** Desired camera position in world space. */
  position: { x: number; y: number; z: number };
  /** Tween convergence speed — `progress += deltaSec * convergeRate`. Default 3 = ~0.33s. */
  convergeRate?: number;
  /** Damping factor applied to the target each frame. Default 0.15. */
  targetDamping?: number;
  /** Damping factor applied to the camera body each frame. Default 0.10. */
  positionDamping?: number;
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

  const convergeRate = opts.convergeRate ?? 3;
  const targetDamping = opts.targetDamping ?? 0.15;
  const positionDamping = opts.positionDamping ?? 0.10;
  let progress = 0;

  return {
    tag,
    update(deltaSec: number): boolean {
      progress += deltaSec * convergeRate;
      const t = Math.min(progress, 1);
      const ease = easeOutCubic(t);

      controls.target.x += (opts.target.x - controls.target.x) * ease * targetDamping;
      controls.target.y += (opts.target.y - controls.target.y) * ease * targetDamping;
      controls.target.z += (opts.target.z - controls.target.z) * ease * targetDamping;
      camera.position.x += (opts.position.x - camera.position.x) * ease * positionDamping;
      camera.position.y += (opts.position.y - camera.position.y) * ease * positionDamping;
      camera.position.z += (opts.position.z - camera.position.z) * ease * positionDamping;

      return t >= 1;
    },
  };
}
