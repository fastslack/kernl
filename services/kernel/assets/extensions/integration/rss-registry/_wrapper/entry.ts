// Auto-generated wrapper. The extension loader expects `createModule()` or
// a `default` export. The kernel module uses `createRssRegistryModule()`,
// so we re-export it under the name the loader looks for.
import { createRssRegistryModule } from "../_module/index.js";

export function createModule() {
  return createRssRegistryModule();
}

export default createModule;
