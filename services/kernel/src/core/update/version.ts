/**
 * The version this process is running.
 *
 * Split out of check.ts so the update bookkeeping in install.ts can ask for it
 * without importing the check, which imports install.ts in turn.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where to look for package.json, nearest first.
 *
 * Nearest first is the point. This used to try `here/../../..` before `here`:
 * right for a dev run from src/core/update, and wrong for a portable tarball
 * running from `~/apps/kernl-x/bin`, where three levels up is the user's home
 * — so a developer's own `~/package.json` was read as the kernel's version.
 * Packaged, the bundle's package.json sits beside it (Windows, macOS
 * Resources) or one level up (`bin/`); dev is three levels up.
 */
export function versionCandidates(here: string): string[] {
  return [here, resolve(here, ".."), resolve(here, "../../..")];
}

let cachedVersion: string | null = null;

/**
 * The running version, from the same package.json the release workflow's
 * version-check job compares the tag against. Reading anything else would
 * reintroduce the drift that guard exists to catch.
 */
export function currentVersion(): string | null {
  if (cachedVersion) return cachedVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of versionCandidates(here)) {
    const p = resolve(c, "package.json");
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, "utf-8")) as { name?: string; version?: string };
      // A package.json that is not ours is not an answer — the dev tree has
      // the workspace root's one above services/kernel.
      if (pkg.name && !/kernl|kernel/i.test(pkg.name)) continue;
      if (typeof pkg.version === "string" && pkg.version) {
        cachedVersion = pkg.version;
        return pkg.version;
      }
    } catch {
      /* keep looking */
    }
  }
  return null;
}
