/**
 * Locate the tree that ships alongside the kernel: `assets/extensions`,
 * `assets/bundles`, `assets/skills`, `assets/plugins`.
 *
 * This exists because resolving it from `process.cwd()` is correct in
 * development and in Docker, and wrong in every native package. Each launcher
 * chdirs into the user's DATA directory before starting the kernel:
 *
 *   .app (macOS)   ~/Library/Application Support/Kernl
 *   start.bat      %LOCALAPPDATA%\Kernl
 *   deb/rpm        ~/.local/share/kernl
 *
 * None of those contain `assets/`. A packaged install therefore seeded 12
 * extensions where Docker seeded 81 — the 69 bundled modules were present on
 * disk and never registered, so the dashboard rendered one menu entry. The
 * call site returned silently when the directory was missing, so nothing in
 * the boot log ever said so.
 *
 * Keep every consumer on this helper. The bug was originally fixed in one of
 * the two places that resolved the path independently, which changed nothing
 * observable and cost a round of "it's fixed" that wasn't.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

let cached: string | null = null;

/**
 * Absolute path to the directory holding `assets/`. Falls back to
 * `process.cwd()` — and says so loudly — when nothing matches.
 */
export function assetsRoot(): string {
  if (cached) return cached;

  const here = dirname(fileURLToPath(import.meta.url));
  // Verified against the built artifacts, not assumed:
  //   rpm/deb  bin/mcp-server.js + assets/ under /opt/kernl   → here/..
  //   .app     Resources/mcp-server.js + Resources/assets/    → here
  //   win zip  <root>/mcp-server.js + <root>/assets/          → here
  const candidates = [
    process.cwd(),        // dev (services/kernel) and Docker (/app)
    here,                 // .app Resources/ and the Windows zip root
    resolve(here, ".."),  // deb/rpm: /opt/kernl/bin → /opt/kernl
  ];

  // Probe for assets/extensions, not assets/. The kernel creates an
  // `assets/skills/` directory inside the user's DATA dir at runtime, so
  // `<data>/assets` exists — and since cwd is that data dir in every native
  // install, testing for `assets` alone matched the wrong tree and resolved
  // to a folder holding one empty subdirectory. `extensions` is present in
  // every genuine tree (dev, Docker, and all three packages) and never in the
  // runtime-created one.
  const hit = candidates.find((c) => existsSync(resolve(c, "assets", "extensions")));
  if (!hit) {
    log.warn(
      `assets/ not found from any known location (cwd=${process.cwd()}, module=${here}) — ` +
        `bundled modules will not be registered and the dashboard will look empty`,
    );
    cached = process.cwd();
    return cached;
  }

  cached = hit;
  return cached;
}

/** `<assetsRoot>/assets/<sub>` — e.g. `assetsDir("extensions")`. */
export function assetsDir(sub: string): string {
  return resolve(assetsRoot(), "assets", sub);
}
