// Auto-generated wrapper. The extension loader expects `createModule()` or
// a `default` export. The kernel module uses `createGoogleSyncModule()`, so
// we re-export it under the name the loader looks for.
import { createGoogleSyncModule } from "../_module/index.js";

export function createModule() {
  return createGoogleSyncModule();
}

export default createModule;
