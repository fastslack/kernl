/**
 * Host-folder reachability for the kernel's own entry points (office repo,
 * Office Kit, agent `__cwd_path__` edits, the boot audit).
 *
 * The check itself lives in the SDK (`src/sdk/host-paths.ts`) because the
 * claude_code executor extension runs it too, and extensions only import the
 * kernel through `@kernl/extension-sdk`. This module re-exports it and adds
 * one seam: tests point every entry point at a fake mount table at once,
 * instead of threading options through each caller.
 */

import { hostPathReachable as probe, type HostPathCheck, type HostPathOptions } from "../sdk/host-paths.js";

export { parseMountinfo, mountFor, type HostPathCheck, type HostPathOptions, type MountEntry } from "../sdk/host-paths.js";

let environment: Pick<HostPathOptions, "inContainer" | "mountinfo"> | null = null;

/** Tests only: pretend the kernel runs (or not) in a container with this mount table. `null` restores detection. */
export function setHostPathEnvironment(env: Pick<HostPathOptions, "inContainer" | "mountinfo"> | null): void {
  environment = env;
}

export function hostPathReachable(path: string, opts: HostPathOptions = {}): HostPathCheck {
  return probe(path, { ...environment, ...opts });
}
