/**
 * Test helpers for the extension host. Not exported from the SDK entry point:
 * import it by path from a test.
 */

import { getHost, setHost, type KernlHost } from "./host.js";

/**
 * Install a host built from the default one with `partial` laid over it, so a
 * test only spells out what it cares about. Returns the installed host.
 */
export function installTestHost(partial: Partial<KernlHost>): KernlHost {
  setHost(undefined);
  const host: KernlHost = { ...getHost(), ...partial };
  setHost(host);
  return host;
}

/** Clear the slot; facades fall back to the default host. */
export function resetHost(): void {
  setHost(undefined);
}
