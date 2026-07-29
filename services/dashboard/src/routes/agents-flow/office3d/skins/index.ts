/**
 * Skin system barrel — registers all built-in skins on import. Future
 * extension-loaded skins call `registerSkin` themselves after dynamic import.
 */

export { registerSkin, resolveSkin, listSkins, setDefaultSkin, initAllSkins, clearSkins } from './skin-registry.js';
export type { SkinDefinition, SkinManifest, SkinPalette, SkinCreateOpts } from './skin-types.js';

import { registerSkin, setDefaultSkin } from './skin-registry.js';
import { officeWorkerSkin } from './office-worker.js';
import { raSoldierSkin }    from './ra-soldier.js';

// Built-in registrations — run at module load. Order matters: the FIRST
// registered skin becomes the default until `setDefaultSkin` runs.
registerSkin(officeWorkerSkin);
registerSkin(raSoldierSkin);
setDefaultSkin('office-worker');
