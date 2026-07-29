// Auto-generated wrapper. The extension loader expects `createModule()` or
// a `default` export. The kernel module uses `createTriageModule()`, so we
// re-export it under the name the loader looks for.
import { createTriageModule } from "../_module/index.js";

export function createModule() {
  return createTriageModule();
}

export default createModule;
