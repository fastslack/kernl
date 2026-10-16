import type { SkinDefinition } from './skin-types.js';
import { initRetroHumanoid, createRetroHumanoid } from './retro-humanoid.js';
import { pickHumanoidPalette } from '../humanoid-palette.js';

export const retroWorkerSkin: SkinDefinition = {
  manifest: {
    id: 'retro-worker', name: 'Retro Worker',
    description: 'Stepped pixel silhouettes and snappy arcade animation.',
    author: 'core', version: '1.0.0', category: 'humanoid',
  },
  init: initRetroHumanoid,
  createHumanoid: ({ flowColor, palette, scale }) =>
    createRetroHumanoid(flowColor, palette.skin, scale ?? 1, palette.hair, palette.pants),
  pickPalette: pickHumanoidPalette,
};
