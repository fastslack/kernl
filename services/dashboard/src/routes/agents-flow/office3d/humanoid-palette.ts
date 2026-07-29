/**
 * Per-agent humanoid palette — deterministic skin / hair / pants picks driven
 * by a stable hash of the agent id. A crowd of 60 agents reads as 60 distinct
 * humans instead of 60 clones, with zero per-frame cost (colors are baked
 * once on add()).
 *
 * Why these palettes:
 *   - Skin tones: 5 natural shades from light to dark — wider than the
 *     previous ad-hoc 4-entry table.
 *   - Hair tones: 5 realistic colors (black, brown, dark blonde, blonde,
 *     grey). It used to compute `clothes×0.3`, which yielded weird teal/cyan
 *     hair on flow-tinted clothes.
 *   - Pants tones: 4 office-appropriate colors (charcoal, navy, brown,
 *     khaki). Previously fixed at `0x2a2d3a`.
 */

/** Skin tones — ordered light → dark, perceptually distinct. */
export const SKIN_TONES: number[] = [
  0xf5e0cc, // very light
  0xe8d5c0, // light
  0xd4a87c, // tan
  0xa67c5b, // medium
  0x6b4a2e, // dark
];

/** Hair tones — natural human hair colors. */
export const HAIR_TONES: number[] = [
  0x1a1410, // black
  0x4a342a, // dark brown
  0x8b6f47, // chestnut
  0xc9a96e, // dirty blonde
  0x9a9a9a, // grey
];

/** Pants tones — office-appropriate trouser colors. */
export const PANTS_TONES: number[] = [
  0x2a2d3a, // charcoal
  0x1a253a, // navy
  0x3d2e1f, // brown
  0x4a4a4a, // grey
];

export interface HumanoidPalette {
  skin: number;
  hair: number;
  pants: number;
}

/**
 * DJB2 hash — small, fast, well-distributed. We only need the lower bits to
 * pick into small palettes, but we keep the full 32-bit hash so different
 * shifts give effectively-independent picks for skin/hair/pants.
 */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Deterministic palette for an agent. Same `seed` (typically the agent id)
 * always yields the same palette, so the visual identity is stable across
 * reloads and scene rebuilds.
 */
export function pickHumanoidPalette(seed: string): HumanoidPalette {
  const h = djb2(seed || 'default');
  return {
    skin:  SKIN_TONES[h % SKIN_TONES.length],
    hair:  HAIR_TONES[(h >>> 8)  % HAIR_TONES.length],
    pants: PANTS_TONES[(h >>> 16) % PANTS_TONES.length],
  };
}
