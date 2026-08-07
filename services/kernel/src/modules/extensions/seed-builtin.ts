/**
 * Seed in-tree extensions (under `assets/extensions/`) into `installed_extensions`
 * on first boot. These are extensions that ship inside the kernel repo but
 * otherwise behave like any other installed extension — the loader picks them
 * up dynamically, runs migrations via their initialize(), and exposes their
 * service/tools.
 *
 * Two flavors covered:
 *   - `built_in: true` manifests (no backend.entry) — the loader skips them,
 *     they exist only as registry stubs for the UI.
 *   - full extensions with backend.entry = "backend/entry.js" (compiled via
 *     `bun build`) — the loader imports the bundle and runs it.
 *
 * Idempotent: extensions with the same id are skipped.
 */

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../core/logger.js";
import { assetsDir } from "../../core/assets-root.js";
import type { ExtensionService } from "./service.js";

/**
 * Directory holding the shipped (in-tree) extension stubs.
 *
 * Resolved through assetsDir() rather than `resolve(process.cwd(), ...)` at
 * import time. Every native launcher chdirs into the user's data directory
 * before starting the kernel, so the old path did not exist, this seeder
 * returned silently, and a packaged install registered 12 extensions where
 * Docker registered 81 — the 69 bundled modules shipped on disk and were
 * never seen.
 */
function builtinDir(): string {
  return assetsDir("extensions");
}

export interface BuiltinSeedSummary {
  seeded: string[];
  skipped: string[];
  /** Rows that were `installed` and became `active` because their blocker lifted. */
  promoted: string[];
  errors: Array<{ slug: string; error: string }>;
}

/**
 * Walk `BUILTIN_DIR` and collect every directory that carries an
 * `extension.json`. Layout convention is `<type>/[<category>/]<slug>/`,
 * so manifests can live anywhere from depth 1 through depth 3. We stop
 * descending the moment we hit a manifest (the manifest IS the marker
 * "this is an extension, not a category folder").
 */
async function collectExtensionDirs(root: string, depthRemaining = 3): Promise<string[]> {
  const out: string[] = [];
  if (depthRemaining <= 0) return out;
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    const dir = join(root, name);
    if (existsSync(join(dir, "extension.json"))) {
      out.push(dir);
      continue;
    }
    // No manifest → treat as a category/grouping folder and recurse.
    const nested = await collectExtensionDirs(dir, depthRemaining - 1);
    out.push(...nested);
  }
  return out;
}

export async function seedBuiltinExtensions(
  service: ExtensionService,
): Promise<BuiltinSeedSummary> {
  const summary: BuiltinSeedSummary = { seeded: [], skipped: [], promoted: [], errors: [] };

  const root = builtinDir();

  // Returning quietly here is what hid the packaging bug for so long: the
  // dashboard came up with one menu entry and the boot log said nothing at
  // all. If the directory is missing now, say which one was looked for.
  if (!existsSync(root)) {
    log.warn(`Builtin extensions: ${root} does not exist — no bundled modules will be registered`);
    return summary;
  }

  const extensionDirs = await collectExtensionDirs(root);

  for (const dir of extensionDirs) {
    // Slug for error reporting in case we can't even read the manifest.
    const name = dir.slice(root.length + 1);
    try {
      const preview = await previewManifest(dir);
      if (!preview) continue;

      const existing = service.get(preview.id) ?? service.getBySlug(preview.slug);
      if (existing) {
        // Row exists — refresh manifest_json + install_path from disk so edits
        // to the on-disk manifest (e.g. flipping built_in → backend.entry)
        // take effect without a DB wipe. Status is preserved.
        const refreshed = await service.refreshFromDirectory(existing.id, dir);
        // Parked on a missing package or an absent license last boot? If the
        // blocker is gone — the background provisioner fetched the SDKs, or a
        // license was added — activate it now, before anything is loaded, so
        // it comes up wired like any other extension.
        if (service.promoteIfUnblocked(existing.id)) summary.promoted.push(preview.slug);
        if (refreshed) {
          summary.seeded.push(preview.slug);
          log.info(`Built-in extension refreshed from disk: ${preview.slug}`);
        } else {
          summary.skipped.push(preview.slug);
        }
        continue;
      }

      await service.installFromDirectory(dir, { type: "bundled" });
      summary.seeded.push(preview.slug);
      log.info(`Built-in extension seeded: ${preview.slug} (${preview.type})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push({ slug: name, error: msg });
      log.warn(`Built-in extension seed failed: ${name} — ${msg}`);
    }
  }

  return summary;
}

async function previewManifest(
  dir: string,
): Promise<{ id: string; slug: string; type: string } | null> {
  const { readManifest } = await import("./bundle.js");
  try {
    const m = await readManifest(dir);
    return { id: m.id, slug: m.slug, type: m.type };
  } catch {
    return null;
  }
}
