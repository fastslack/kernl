/**
 * Talking pose — standing humanoid mid-conversation. Head nods, right hand
 * gestures, left arm rests. Used by walkers after they arrive at a target.
 */

export interface TalkingPose {
  legL: number;
  legR: number;
  armLX: number;
  armRX: number;
  armRZ: number;
  headX: number;
  headY: number;
  torsoZ: number;
}

export function computeTalkingPose(elapsedSec: number, phase: number): TalkingPose {
  const t = elapsedSec * 7.2 + phase;
  return {
    legL: 0,
    legR: 0,
    armLX: -0.1 + Math.sin(t * 0.7) * 0.04,
    armRX: -0.4 + Math.sin(t * 3) * 0.35,
    armRZ: -0.15 + Math.sin(t * 2.3) * 0.1,
    headX: Math.sin(t * 4) * 0.08,
    headY: Math.sin(t * 1.2) * 0.06,
    torsoZ: Math.sin(t * 0.8) * 0.02,
  };
}
