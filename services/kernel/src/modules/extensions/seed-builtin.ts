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
import { join, resolve } from "node:path";
import { log } from "../../core/logger.js";
import type { ExtensionService } from "./service.js";

/** Directory under the repo root that holds shipped (in-tree) extension stubs. */
const BUILTIN_DIR = resolve(process.cwd(), "assets/extensions");

export interface BuiltinSeedSummary {
  seeded: string[];
  skipped: string[];
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
  const summary: BuiltinSeedSummary = { seeded: [], skipped: [], errors: [] };

  if (!existsSync(BUILTIN_DIR)) return summary;

  const extensionDirs = await collectExtensionDirs(BUILTIN_DIR);

  for (const dir of extensionDirs) {
    // Slug for error reporting in case we can't even read the manifest.
    const name = dir.slice(BUILTIN_DIR.length + 1);
    try {
      const preview = await previewManifest(dir);
      if (!preview) continue;

      const existing = service.get(preview.id) ?? service.getBySlug(preview.slug);
      if (existing) {
        // Row exists — refresh manifest_json + install_path from disk so edits
        // to the on-disk manifest (e.g. flipping built_in → backend.entry)
        // take effect without a DB wipe. Status is preserved.
        const refreshed = await service.refreshFromDirectory(existing.id, dir);
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
