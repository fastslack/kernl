/**
 * Office Worker skin — the default civilian look. Tie, hair, eyes, head
 * elongation, deterministic per-agent palette (skin/hair/pants).
 *
 * This skin is just a wrapper around the legacy humanoid.ts + humanoid-pool.ts
 * + humanoid-palette.ts which encode the same visuals; future skins (RA
 * soldier, robot, etc.) ship as self-contained alternates.
 */

import type { SkinDefinition, SkinPalette, SkinCreateOpts } from './skin-types.js';
import { createHumanoid, initHumanoid } from '../humanoid.js';
import { createSittingHumanoidPool, initHumanoidPool } from '../humanoid-pool.js';
import { pickHumanoidPalette } from '../humanoid-palette.js';
import type { HumanoidParts } from '../types.js';
import type { SittingHumanoidPool } from '../humanoid-pool.js';

export const officeWorkerSkin: SkinDefinition = {
  manifest: {
    id: 'office-worker',
    name: 'Office Worker',
    description: 'Civilian shirt + tie + slacks. The default agent look.',
    author: 'core',
    version: '1.0.0',
    category: 'humanoid',
  },

  init(three: any) {
    initHumanoid(three);
    initHumanoidPool(three);
  },

  createHumanoid(opts: SkinCreateOpts): HumanoidParts {
    return createHumanoid(
      opts.flowColor,
      opts.palette.skin,
      opts.scale ?? 1,
      opts.palette.hair,
      opts.palette.pants,
    );
  },

  createPool(scene: any, capacity: number): SittingHumanoidPool {
    return createSittingHumanoidPool(scene, capacity);
  },

  pickPalette(seed: string): SkinPalette {
    return pickHumanoidPalette(seed);
  },
};
