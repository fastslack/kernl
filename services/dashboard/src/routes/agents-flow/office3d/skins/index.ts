/**
 * Skin system barrel — registers all built-in skins on import. Future
 * extension-loaded skins call `registerSkin` themselves after dynamic import.
 */

export { registerSkin, resolveSkin, listSkins, setDefaultSkin, initAllSkins, clearSkins } from './skin-registry.js';
export type { SkinDefinition, SkinManifest, SkinPalette, SkinCreateOpts } from './skin-types.js';

import { inventor2DSkin, detective2DSkin, robot2DSkin } from './expressive-workers.js';
import { arcadeBrawlerSkin } from './arcade-brawler.js';
import { lifeSimSkin, toonFaceSkin } from './life-sim.js';
import { registerSkin, setDefaultSkin } from './skin-registry.js';
import { retroWorkerSkin } from './retro-worker.js';
import { adventure3DSkin } from './adventure-3d.js';
import { adventureWorkerSkin } from './adventure-worker.js';
import { officeWorkerSkin } from './office-worker.js';
import { raSoldierSkin }    from './ra-soldier.js';

// Built-in registrations — run at module load. Order matters: the FIRST
// registered skin becomes the default until `setDefaultSkin` runs.
registerSkin(officeWorkerSkin);
registerSkin(raSoldierSkin);
registerSkin(retroWorkerSkin);
registerSkin(adventureWorkerSkin);
registerSkin(adventure3DSkin);
registerSkin(lifeSimSkin);
registerSkin(toonFaceSkin);
registerSkin(arcadeBrawlerSkin);
registerSkin(inventor2DSkin);
registerSkin(detective2DSkin);
registerSkin(robot2DSkin);
setDefaultSkin('office-worker');
