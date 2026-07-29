/**
 * Lazy Three.js + CSS2DObject handles for effect factories that need to
 * construct new scene objects. Mirrors the init pattern used by humanoid.ts /
 * delivery.ts — the host calls `initAnimEffects(THREE, CSS2DObject)` once at
 * scene boot and every effect import gets the same handles.
 */

let _THREE: any = null;
let _CSS2D: any = null;

export function initAnimEffects(three: any, css2d: any): void {
  _THREE = three;
  _CSS2D = css2d;
}

export function getThree(): any {
  if (!_THREE) throw new Error('[anim/effects] initAnimEffects(THREE, CSS2DObject) must run before any effect that builds geometry');
  return _THREE;
}

export function getCSS2D(): any {
  if (!_CSS2D) throw new Error('[anim/effects] CSS2DObject not provided to initAnimEffects()');
  return _CSS2D;
}
