/**
 * Hammering pose — a builder standing at a wall, right arm raising a hammer
 * and bringing it down; the left arm steadies the work. Pure math, like the
 * other poses: the construction crew (construction/crew.ts) applies it.
 */

/** Strikes per second. A strike lands each time `hammerStrikeIndex` ticks over. */
export const HAMMER_HZ = 1.6;

export interface HammerPose {
  /** X rotation of the right arm pivot (negative = raised forward/up). */
  armRX: number;
  armLX: number;
  headX: number;
  torsoX: number;
  legL: number;
  legR: number;
}

/** Fraction 0..1 through the current swing: 0 = hammer raised, ~0.8 = impact. */
function swingPhase(timeSec: number, phase: number): number {
  const x = timeSec * HAMMER_HZ + phase;
  return x - Math.floor(x);
}

export function computeHammerPose(timeSec: number, phase = 0): HammerPose {
  const s = swingPhase(timeSec, phase);
  // Slow wind-up (0 → 0.65), fast strike (0.65 → 0.8), short recoil.
  let lift: number;
  if (s < 0.65) lift = s / 0.65;
  else if (s < 0.8) lift = 1 - (s - 0.65) / 0.15;
  else lift = (s - 0.8) / 0.2 * 0.15;
  return {
    armRX: -0.5 - lift * 2.1,
    armLX: -0.7 + Math.sin(timeSec * 2 + phase) * 0.05,
    headX: 0.12 - lift * 0.1,
    torsoX: 0.06 + (1 - lift) * 0.06,
    legL: 0.08,
    legR: -0.08,
  };
}

/** Counts strikes: changes value exactly when a swing lands. */
export function hammerStrikeIndex(timeSec: number, phase = 0): number {
  return Math.floor(timeSec * HAMMER_HZ + phase - 0.8);
}
