/**
 * Skin system — interfaces every installable agent-skin must implement.
 *
 * A skin describes how an agent LOOKS — geometry + materials + per-agent
 * palette. The animation system (anim/poses) is shared across all skins, so
 * skins must produce `HumanoidParts` with the same { head, torso, leftArm,
 * rightArm, leftLeg, rightLeg } structure for the poses to drive limbs.
 */

import type { HumanoidParts } from '../types.js';
import type { SittingHumanoidPool } from '../humanoid-pool.js';

export interface SkinPalette {
  /** Skin tone color (numeric hex). */
  skin: number;
  /** Top-of-head color — hair, helmet paint, hat color, etc. */
  hair: number;
  /** Pants / trouser color. */
  pants: number;
}

export interface SkinCreateOpts {
  /** Flow color string (`#rrggbb`) — the agent's team color, used for torso/uniform. */
  flowColor: string;
  /** Pre-resolved per-agent palette (skin / hair / pants). */
  palette: SkinPalette;
  /** Visual scale multiplier. Default 1. Walkers usually pass 1.3. */
  scale?: number;
  /** Whether this is a walker (moving humanoid) vs seated worker. Skins use
   *  this to enable/disable accessories like rifles, name tags, etc. */
  walker?: boolean;
}

export interface SkinManifest {
  /** Unique identifier — referenced by `agents.skin_id`. */
  id: string;
  /** Human-readable name shown in the agent panel dropdown. */
  name: string;
  /** Short description / flavor text. */
  description?: string;
  /** Author / extension package. */
  author?: string;
  version?: string;
  /** Family of model the skin produces — guides which animation poses apply. */
  category?: 'humanoid' | 'mech' | 'drone';
  /** Optional preview image (URL or data-uri). */
  preview?: string;
}

/**
 * A skin definition. Skins are registered into the skin-registry at boot and
 * referenced by id from `agents.skin_id`. The dashboard resolves the skin per
 * agent and uses it to build both the seated worker (via `createPool`, if
 * available) and the walker (via `createHumanoid`).
 */
export interface SkinDefinition {
  manifest: SkinManifest;
  /** Initialize the skin once at scene boot — gets handed the THREE module
   *  (and CSS2DObject if the skin uses CSS labels). Mirrors initHumanoid /
   *  initAnimEffects. Optional. */
  init?(three: any, css2d?: any): void;
  /** Build a per-mesh humanoid (used by walkers + any non-pool fallback). */
  createHumanoid(opts: SkinCreateOpts): HumanoidParts;
  /** Optional InstancedMesh-backed pool factory. Skins that omit this fall
   *  back to per-mesh humanoids for seated workers (slower with many agents). */
  createPool?(scene: any, capacity: number): SittingHumanoidPool;
  /** Per-agent palette picker — deterministic from a seed (typically agent.id). */
  pickPalette(seed: string): SkinPalette;
}
