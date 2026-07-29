/**
 * Sitting pose — three modes (idle / running / being spoken to). Shared by
 * humanoid.ts (per-mesh animation) and humanoid-pool.ts (InstancedMesh path).
 *
 * Legs are always flexed -1.5 rad for the seated pose; the pool writes that
 * value directly, the per-mesh humanoid sets it once at desk-build time.
 */

export type SittingMode = 'idle' | 'running' | 'spoken-to' | 'stretching';

export interface SittingPose {
  /** Left arm X rotation. */
  armL: number;
  /** Right arm X rotation. */
  armR: number;
  /** Head X rotation. */
  headX: number;
  /** Head Y rotation. */
  headY: number;
}

/** Constant leg flex for the seated pose. */
export const SITTING_LEG_FLEX = -1.5;

/**
 * Compute the seated body pose for the given mode at accumulated time `timeSec`,
 * desync-shifted by `phase` (radians).
 *
 * Inputs are accumulated *real seconds*, not frames — animation stays
 * frame-rate independent.
 */
export function computeSittingPose(
  mode: SittingMode,
  timeSec: number,
  phase: number,
): SittingPose {
  if (mode === 'stretching') {
    // Yawn-stretch: arms swung up past horizontal, gentle sway, head tilted
    // back. Legs remain at SITTING_LEG_FLEX (the caller handles legs — they
    // stay seated). Two-second cycle so the gesture reads slowly.
    const t = timeSec * 1.6 + phase;
    return {
      armL: 2.0 + Math.sin(t) * 0.18,
      armR: 2.0 + Math.sin(t + 0.35) * 0.18,
      headX: -0.28 + Math.sin(t * 0.4) * 0.06,
      headY: Math.sin(t * 0.5) * 0.09,
    };
  }
  if (mode === 'spoken-to') {
    const t = timeSec * 6 + phase;
    return {
      armL: -0.5 + Math.sin(t * 1.5) * 0.06,
      armR: -0.5 + Math.sin(t * 1.5 + 0.7) * 0.06,
      headX: -0.2 + Math.sin(t * 2.5) * 0.08,
      headY: 0,
    };
  }
  if (mode === 'running') {
    const t = timeSec * 4.8 + phase;
    return {
      armL: -0.8 + Math.sin(t * 2.3) * 0.12,
      armR: -0.8 + Math.sin(t * 2.3 + 1.5) * 0.12,
      headX: -0.15 + Math.sin(t * 0.5) * 0.03,
      headY: Math.sin(t * 0.3) * 0.08,
    };
  }
  // idle
  const t = timeSec * 0.9 + phase;
  return {
    armL: -0.3,
    armR: -0.3,
    headX: Math.sin(t) * 0.03,
    headY: Math.sin(t * 0.7) * 0.05,
  };
}
