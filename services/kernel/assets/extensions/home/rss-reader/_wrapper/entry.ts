// Auto-generated wrapper. The extension loader expects `createModule()` or
// a `default` export. The kernel module uses `createRssReaderModule()`,
// so we re-export it under the name the loader looks for.
import { createRssReaderModule } from "../_module/index.js";

export function createModule() {
  return createRssReaderModule();
}

export default createModule;
