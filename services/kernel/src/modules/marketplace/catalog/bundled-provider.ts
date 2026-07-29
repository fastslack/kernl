/**
 * BundledProvider — surfaces installable artifacts that ship inside the repo.
 *
 * Scans:
 *   - assets/extensions/**     (canonical, has extension.json)
 *   - assets/bundles/**        (canonical, has extension.json — multi-agent offices, etc.)
 *   - assets/skills/*          (legacy SKILL.json, normalized to type='skill')
 *   - assets/plugins/*         (legacy plugin manifest.json, normalized to type='module')
 *
 * Each scan is cheap (filesystem readdir + a single JSON read per dir) so
 * we just rescan on every list() call. Remote providers will need caching.
 */

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { log } from "../../../core/logger.js";
import { readManifest } from "../../extensions/bundle.js";
import type { ExtensionManifest } from "../../extensions/schema.js";
import {
  readSkillAsExtensionManifest,
  readPluginAsExtensionManifest,
} from "./normalizers.js";
import type {
  CatalogFilter,
  CatalogItem,
  CatalogProvider,
} from "./types.js";

export interface BundledProviderOptions {
  /** Repo root — the four scanned directories live under `<root>/assets/...`. */
  rootDir: string;
}

export class BundledProvider implements CatalogProvider {
  readonly name = "bundled";
  readonly label = "Bundled with Kernl";

  constructor(private readonly opts: BundledProviderOptions) {}

  async list(filter?: CatalogFilter): Promise<CatalogItem[]> {
    const items: CatalogItem[] = [];
    items.push(...(await this.scanCanonical(join(this.opts.rootDir, "assets/extensions"))));
    items.push(...(await this.scanCanonical(join(this.opts.rootDir, "assets/bundles"))));
    items.push(...(await this.scanSkills(join(this.opts.rootDir, "assets/skills"))));
    items.push(...(await this.scanPlugins(join(this.opts.rootDir, "assets/plugins"))));

    return applyFilter(items, filter);
  }

  async get(id: string): Promise<CatalogItem | null> {
    const all = await this.list();
    return all.find((i) => i.id === id || i.slug === id) ?? null;
  }

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * Walk a directory looking for `extension.json` markers (depth ≤ 3 to
   * accommodate the `assets/extensions/<category>/[<sub>/]<slug>/` layout).
   */
  private async scanCanonical(root: string): Promise<CatalogItem[]> {
    if (!existsSync(root)) return [];
    const dirs = await collectExtensionDirs(root);
    const out: CatalogItem[] = [];
    for (const dir of dirs) {
      try {
        const manifest = await readManifest(dir);
        out.push(this.toCatalogItem(manifest, dir));
      } catch (err) {
        log.warn(`BundledProvider: invalid extension at ${dir}: ${err}`);
      }
    }
    return out;
  }

  private async scanSkills(root: string): Promise<CatalogItem[]> {
    if (!existsSync(root)) return [];
    const out: CatalogItem[] = [];
    let entries: string[] = [];
    try { entries = await readdir(root); } catch { return out; }
    for (const name of entries) {
      const dir = join(root, name);
      if (!existsSync(join(dir, "SKILL.json"))) continue;
      try {
        const manifest = await readSkillAsExtensionManifest(dir);
        out.push(this.toCatalogItem(manifest, dir));
      } catch (err) {
        log.warn(`BundledProvider: invalid skill at ${dir}: ${err}`);
      }
    }
    return out;
  }

  private async scanPlugins(root: string): Promise<CatalogItem[]> {
    if (!existsSync(root)) return [];
    const out: CatalogItem[] = [];
    let entries: string[] = [];
    try { entries = await readdir(root); } catch { return out; }
    for (const name of entries) {
      const dir = join(root, name);
      if (!existsSync(join(dir, "manifest.json"))) continue;
      try {
        const manifest = await readPluginAsExtensionManifest(dir);
        out.push(this.toCatalogItem(manifest, dir));
      } catch (err) {
        log.warn(`BundledProvider: invalid plugin at ${dir}: ${err}`);
      }
    }
    return out;
  }

  private toCatalogItem(manifest: ExtensionManifest, dir: string): CatalogItem {
    const absDir = resolve(dir);
    return {
      id: manifest.id,
      slug: manifest.slug,
      origin: {
        provider: this.name,
        source: { type: "bundled" },
        directory: absDir,
      },
      manifest,
      status: "available",
      price_cents: manifest.pricing?.amount_cents ?? 0,
      currency: manifest.pricing?.currency ?? "EUR",
      install_count: 0,
      avg_rating: 0,
      review_count: 0,
      featured: false,
      verified: true,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

async function collectExtensionDirs(root: string, depth = 3): Promise<string[]> {
  const out: string[] = [];
  if (depth <= 0) return out;
  let entries: string[] = [];
  try { entries = await readdir(root); } catch { return out; }
  for (const name of entries) {
    const dir = join(root, name);
    if (existsSync(join(dir, "extension.json"))) {
      out.push(dir);
      continue;
    }
    out.push(...(await collectExtensionDirs(dir, depth - 1)));
  }
  return out;
}

function applyFilter(items: CatalogItem[], filter?: CatalogFilter): CatalogItem[] {
  let out = items;
  if (filter?.type) {
    out = out.filter((i) => i.manifest.type === filter.type);
  }
  if (filter?.category) {
    out = out.filter((i) => i.manifest.category === filter.category);
  }
  if (filter?.query) {
    const q = filter.query.toLowerCase();
    out = out.filter((i) => {
      const haystack = [
        i.slug,
        i.manifest.name,
        i.manifest.description,
        ...(i.manifest.tags ?? []),
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }
  if (filter?.limit) out = out.slice(0, filter.limit);
  return out;
}
