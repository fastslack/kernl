/**
 * Walking pose — pure math, no Three.js Object3D mutation. Both the per-mesh
 * humanoid (humanoid.ts) and the InstancedMesh pool (humanoid-pool.ts) consume
 * the same numbers, so a tweak to the cadence/swing curve is a single edit.
 */

export interface WalkPose {
  /** X rotation for left leg pivot. */
  legL: number;
  /** X rotation for right leg pivot. */
  legR: number;
  /** X rotation for left arm pivot. */
  armL: number;
  /** X rotation for right arm pivot. */
  armR: number;
  /** Vertical bob (Y offset on the root group). */
  bobY: number;
  /** Slight torso side-to-side roll (Z rotation). */
  torsoZ: number;
  /** Optional forward lean (X rotation on torso) — running only. */
  torsoX: number;
  /** Head Y rotation — gentle "looking around". */
  headY: number;
  /** Head X rotation — running pose tilts head forward. */
  headX: number;
}

/** Walking pose at accumulated time `t` (seconds). */
export function computeWalkPose(timeSec: number): WalkPose {
  // Step cadence scaled with the brisker travel speed (WALK_SPEED 5→7) so the
  // feet keep pace with the ground instead of moonwalking. 7.2 × (7/5) ≈ 10.
  const t = timeSec * 10;
  const swing = Math.sin(t) * 0.6;
  return {
    legL: swing,
    legR: -swing,
    armL: -swing * 0.5,
    armR: swing * 0.5,
    bobY: Math.abs(Math.sin(t * 2)) * 0.04,
    torsoZ: Math.sin(t) * 0.03,
    torsoX: 0,
    headY: Math.sin(t * 0.3) * 0.1,
    headX: 0,
  };
}

/** Running pose — wider stride, faster cadence, forward lean. */
export function computeRunPose(timeSec: number): WalkPose {
  const t = timeSec * 11;
  const swing = Math.sin(t) * 0.85;
  return {
    legL: swing,
    legR: -swing,
    armL: -swing * 0.7,
    armR: swing * 0.7,
    bobY: Math.abs(Math.sin(t * 2)) * 0.08,
    torsoZ: Math.sin(t) * 0.05,
    torsoX: -0.12,
    headY: Math.sin(t * 0.5) * 0.06,
    headX: -0.08,
  };
}

/** Carrier (delivery driver) pose — walking, but right arm holds the package
 *  against the chest so it barely swings. Re-uses cadence from `computeWalkPose`. */
export function computeCarrierPose(timeSec: number, running = false): WalkPose {
  const base = running ? computeRunPose(timeSec) : computeWalkPose(timeSec);
  const cadence = running ? 11 : 7.2;
  return {
    ...base,
    armL: -base.legL * 0.4, // mirror leg swing for L arm (driver's free arm)
    armR: -0.9 + Math.sin(timeSec * cadence) * 0.05, // pinned to chest
  };
}
