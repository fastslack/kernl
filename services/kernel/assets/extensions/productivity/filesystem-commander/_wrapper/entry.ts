// Auto-bundled wrapper. The extension loader expects `createModule()` or a
// `default` export. Our canonical kernel module uses the factory name
// `createFilesystemCommanderModule()`, so we re-export it here.
import { createFilesystemCommanderModule } from "../_module/index.js";

export function createModule() {
  return createFilesystemCommanderModule();
}

export default createModule;
