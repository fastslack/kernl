/**
 * Easing + interpolation primitives — pure, framework-agnostic, allocation-free.
 *
 * Replaces ad-hoc inline math like `1 - Math.pow(1 - t, 3)` and
 * `cur + (target - cur) * 0.18` scattered through the office3d animation code.
 */

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** One-pole exponential approach. `factor` is the lerp weight per frame (0..1). */
export function damp(current: number, target: number, factor: number): number {
  return current + (target - current) * factor;
}

/** Hermite smoothstep — symmetrical ease in/out. */
export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
}

export function easeInOutQuad(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

export function easeOutQuad(t: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) * (1 - x);
}
