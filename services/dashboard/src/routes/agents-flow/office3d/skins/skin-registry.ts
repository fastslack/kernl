/**
 * Skin registry — central lookup for installable agent skins. Skins call
 * `registerSkin(def)` at module load (or after dynamic-import for extension
 * packages); the host then `resolveSkin(id)` to look one up per agent.
 *
 * Resolution falls back to the registered default skin when:
 *   - The requested id is unknown (e.g. the user uninstalled the extension)
 *   - `id` is null/undefined (agent has no skin_id set)
 *
 * No Three.js dependency here — the registry is pure metadata + functions.
 */

import type { SkinDefinition } from './skin-types.js';

const skins = new Map<string, SkinDefinition>();
let defaultSkinId = 'office-worker';

export function registerSkin(skin: SkinDefinition): void {
  if (!skin?.manifest?.id) {
    // eslint-disable-next-line no-console
    console.warn('[skin-registry] ignored skin without manifest.id');
    return;
  }
  skins.set(skin.manifest.id, skin);
}

/** Set which skin is used when an agent has no `skin_id` (or unknown id). */
export function setDefaultSkin(id: string): void {
  if (!skins.has(id)) {
    // eslint-disable-next-line no-console
    console.warn(`[skin-registry] setDefaultSkin: unknown skin "${id}"`);
    return;
  }
  defaultSkinId = id;
}

/** Resolve a skin by id, falling back to the registered default. */
export function resolveSkin(id: string | null | undefined): SkinDefinition {
  if (id && skins.has(id)) return skins.get(id)!;
  const fallback = skins.get(defaultSkinId);
  if (!fallback) {
    throw new Error(`[skin-registry] no default skin registered (id="${defaultSkinId}")`);
  }
  return fallback;
}

/** List every registered skin — used by the agent-panel skin dropdown. */
export function listSkins(): SkinDefinition[] {
  return Array.from(skins.values());
}

/** Init every registered skin with a shared THREE / CSS2DObject. Call once
 *  at scene boot, after all built-in skins have registered themselves. */
export function initAllSkins(three: any, css2d?: any): void {
  for (const s of skins.values()) {
    try {
      s.init?.(three, css2d);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[skin-registry] init failed for "${s.manifest.id}":`, err);
    }
  }
}

/** For tests / dynamic reload — remove every registered skin. */
export function clearSkins(): void {
  skins.clear();
}
