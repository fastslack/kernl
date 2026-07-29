/**
 * Ebbinghaus-inspired memory decay functions.
 *
 * Core formula: strength = e^(-t / S)
 * where t = days since last recall, S = stability = 7 * (1 + 0.5 * reinforcements)
 *
 * - New memories start strong (strength ~1.0)
 * - Unreinforced memories decay to ~0.37 after 7 days
 * - Each reinforcement increases the stability half-life
 * - Frequently recalled memories resist decay
 */

/** Base stability in days (unreinforced memory halves every ~7 days) */
const BASE_STABILITY_DAYS = 7;

/** How much each reinforcement extends stability */
const REINFORCEMENT_FACTOR = 0.5;

/** Boost factor for memories from the current episode */
const CURRENT_EPISODE_BOOST = 1.5;

/**
 * Compute memory strength using Ebbinghaus decay curve.
 *
 * @param daysSinceRecall - Days since last recall (or creation if never recalled)
 * @param reinforcements - Number of times this memory has been reinforced
 * @returns Strength value between 0.0 and 1.0
 */
export function computeStrength(
  daysSinceRecall: number,
  reinforcements: number,
): number {
  if (daysSinceRecall <= 0) return 1.0;
  const stability =
    BASE_STABILITY_DAYS * (1 + REINFORCEMENT_FACTOR * reinforcements);
  return Math.exp(-daysSinceRecall / stability);
}

/**
 * Compute final score for a memory candidate combining vector similarity
 * with temporal decay.
 *
 * @param vectorSimilarity - Cosine similarity from vector search (0.0-1.0)
 * @param strength - Ebbinghaus strength (0.0-1.0)
 * @param isCurrentEpisode - Whether this memory belongs to the active episode
 * @returns Weighted score
 */
export function scoreMemory(
  vectorSimilarity: number,
  strength: number,
  isCurrentEpisode: boolean,
): number {
  const boost = isCurrentEpisode ? CURRENT_EPISODE_BOOST : 1.0;
  return vectorSimilarity * strength * boost;
}

/**
 * Calculate days between two ISO date strings.
 */
export function daysBetween(isoA: string, isoB: string): number {
  const a = new Date(isoA).getTime();
  const b = new Date(isoB).getTime();
  return Math.abs(b - a) / (1000 * 60 * 60 * 24);
}

/**
 * Rough token count estimate (words * 1.3).
 * Used for context budget management, not billing.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.split(/\s+/).length;
  return Math.ceil(words * 1.3);
}
