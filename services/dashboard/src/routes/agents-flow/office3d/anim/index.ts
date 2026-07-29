/**
 * office3d/anim — single entry point for the modular animation system.
 *
 * Split into:
 *   - easing.ts   primitives (lerp, damp, easeOutCubic, …)
 *   - path.ts     polyline navigation (interpolatePath, pathDirection, …)
 *   - poses/      pure body-pose math, shared by humanoid.ts + humanoid-pool.ts
 *   - effects/    Ticker factories: cameraTween, haloPulse, risingParticles…
 *   - registry.ts the Ticker host — the animate() loop calls `tick(dt, t)`
 *
 * No file in this directory imports Three.js. The Three.js objects are passed
 * in by callers; effects close over them and the registry just iterates.
 */

export * from './easing.js';
export * from './path.js';
export * from './poses/index.js';
export * from './effects/index.js';
export * from './scenes/index.js';
export {
  createAnimationRegistry,
  type Ticker,
  type AnimationRegistry,
} from './registry.js';
