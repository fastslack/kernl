/**
 * CatalogRegistry — fan-out across providers + status overlay.
 *
 * Marketplace browse goes through here. The registry:
 *   1. Asks every registered provider for items (in parallel).
 *   2. Cross-references against installed_extensions to set status.
 *   3. Returns the merged list. Installed-but-missing-from-catalog items
 *      surface as "orphan" entries with origin.provider="installed".
 *
 * Install/uninstall delegates to ExtensionService — this registry doesn't
 * touch the DB itself, so providers stay free of side effects.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../../core/logger.js";
import type { ExtensionService } from "../../extensions/service.js";
import type { ExtensionManifest } from "../../extensions/schema.js";
import type { InstalledExtension } from "../../extensions/types.js";
import { RemoteProvider } from "./remote-provider.js";
import type {
  CatalogFilter,
  CatalogItem,
  CatalogItemStatus,
  CatalogProvider,
} from "./types.js";

export interface CatalogRegistryOptions {
  extensionService: ExtensionService;
}

export class CatalogRegistry {
  private providers: CatalogProvider[] = [];

  constructor(private readonly opts: CatalogRegistryOptions) {}

  registerProvider(provider: CatalogProvider): void {
    if (this.providers.some((p) => p.name === provider.name)) {
      log.warn(`CatalogRegistry: provider ${provider.name} already registered, ignoring`);
      return;
    }
    this.providers.push(provider);
    log.info(`CatalogRegistry: provider registered: ${provider.name} (${provider.label})`);
  }

  /** Remove a provider by name. Returns true if it was found and removed. */
  unregisterProvider(name: string): boolean {
    const before = this.providers.length;
    this.providers = this.providers.filter((p) => p.name !== name);
    const removed = this.providers.length < before;
    if (removed) log.info(`CatalogRegistry: provider unregistered: ${name}`);
    return removed;
  }

  /** Look up a provider instance by name (typed as the base interface). */
  getProvider(name: string): CatalogProvider | null {
    return this.providers.find((p) => p.name === name) ?? null;
  }

  listProviders(): Array<{ name: string; label: string }> {
    return this.providers.map((p) => ({ name: p.name, label: p.label }));
  }

  /**
   * Return the merged catalog: union of every provider's items + installed
   * extensions, with status overlaid. Items present in providers but also
   * installed get `status` from the DB row (not "available").
   */
  async browse(filter?: CatalogFilter): Promise<CatalogItem[]> {
    const installedIndex = this.indexInstalled();
    const seen = new Set<string>();
    const merged: CatalogItem[] = [];

    // 1. From providers
    const lists = await Promise.all(
      this.providers.map(async (p) => {
        try {
          return await p.list(filter);
        } catch (err) {
          log.warn(`CatalogRegistry: provider ${p.name} list() failed: ${err}`);
          return [] as CatalogItem[];
        }
      }),
    );
    for (const items of lists) {
      for (const item of items) {
        const key = item.id;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(applyInstalledOverlay(item, installedIndex));
      }
    }

    // 2. Installed-but-not-in-any-provider — orphans (e.g. user-uploaded bundles)
    for (const row of installedIndex.values()) {
      if (seen.has(row.id)) continue;
      const orphan = installedRowToCatalogItem(row);
      if (matchesFilter(orphan, filter)) merged.push(orphan);
    }

    return sortCatalog(merged);
  }

  async getItem(idOrSlug: string): Promise<CatalogItem | null> {
    const installedIndex = this.indexInstalled();
    for (const p of this.providers) {
      const item = await p.get(idOrSlug);
      if (item) return applyInstalledOverlay(item, installedIndex);
    }
    // Fallback: maybe it's installed but not in a provider.
    const installed = this.opts.extensionService.get(idOrSlug)
      ?? this.opts.extensionService.getBySlug(idOrSlug);
    if (installed) return installedRowToCatalogItem(installed);
    return null;
  }

  /**
   * Install a catalog item by id/slug. Resolves the provider, then routes
   * through ExtensionService — directory-backed items use installFromDirectory,
   * everything else throws (until remote providers are wired up).
   */
  async install(idOrSlug: string): Promise<InstalledExtension> {
    const item = await this.getItem(idOrSlug);
    if (!item) throw new Error(`Catalog item not found: ${idOrSlug}`);
    if (item.status !== "available") {
      // Already installed — just flip to active.
      const row = item.installed_id
        ? this.opts.extensionService.get(item.installed_id)
        : this.opts.extensionService.get(item.id) ?? this.opts.extensionService.getBySlug(item.slug);
      if (!row) throw new Error(`Item ${idOrSlug} is marked installed but missing from registry`);
      if (row.status !== "active") await this.opts.extensionService.enable(row.id);
      return this.opts.extensionService.get(row.id)!;
    }

    // Remote providers: download the watermarked bundle, install it, fold the
    // watermark into the install receipt, then clean up the temp .kernlext.
    const remoteProvider = this.providers.find(
      (p): p is RemoteProvider => p.name === item.origin.provider && p instanceof RemoteProvider,
    );
    if (remoteProvider) {
      const dl = await remoteProvider.downloadBundle(item.slug);
      try {
        return await this.opts.extensionService.installFromBundle(
          dl.bundlePath,
          item.origin.source,
          { remoteWatermark: dl.watermark },
        );
      } finally {
        await RemoteProvider.cleanupBundle(dl.bundlePath);
      }
    }

    if (item.origin.directory) {
      // Canonical bundle layout (has extension.json) → install in place.
      // Normalized layouts (skills/plugins) lack extension.json — for those we
      // fall through to installFromManifest, which writes a fresh manifest
      // into the kernel's extensions data dir. The original asset directory
      // stays untouched (skills are still loaded by SkillRegistry from
      // assets/skills/<id>/, so the install_path mismatch is harmless).
      if (existsSync(join(item.origin.directory, "extension.json"))) {
        return this.opts.extensionService.installFromDirectory(
          item.origin.directory,
          item.origin.source,
        );
      }
    }

    // Manifest-only install (no on-disk source, OR normalized source like a
    // skill/plugin). Lets remote providers ship just a manifest until they
    // bring the bundle on demand. When the provider DID give us a source
    // directory (e.g. git clone with SKILL.md and no extension.json), we
    // pass it as `copyFromDir` so the SKILL body lands in install_path —
    // SkillBodyResolver and friends read from there, not from the (possibly
    // ephemeral) origin directory.
    return this.opts.extensionService.installFromManifest(item.manifest, item.origin.source, {
      copyFromDir: item.origin.directory ?? null,
    });
  }

  /**
   * Uninstall an installed extension by id or slug. Provider-agnostic — the
   * row in installed_extensions is the source of truth.
   */
  async uninstall(idOrSlug: string, opts?: { force?: boolean }): Promise<void> {
    const row = this.opts.extensionService.get(idOrSlug)
      ?? this.opts.extensionService.getBySlug(idOrSlug);
    if (!row) throw new Error(`Not installed: ${idOrSlug}`);
    await this.opts.extensionService.uninstall(row.id, opts);
  }

  // ── Internals ───────────────────────────────────────────────────────

  private indexInstalled(): Map<string, InstalledExtension> {
    const out = new Map<string, InstalledExtension>();
    for (const row of this.opts.extensionService.list()) {
      out.set(row.id, row);
      out.set(row.slug, row);
    }
    return out;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function applyInstalledOverlay(
  item: CatalogItem,
  index: Map<string, InstalledExtension>,
): CatalogItem {
  const installed = index.get(item.id) ?? index.get(item.slug);
  if (!installed) return item;
  return {
    ...item,
    status: rowStatusToCatalog(installed.status),
    installed_id: installed.id,
  };
}

function installedRowToCatalogItem(row: InstalledExtension): CatalogItem {
  let manifest: ExtensionManifest;
  try {
    manifest = JSON.parse(row.manifest_json) as ExtensionManifest;
  } catch {
    // Synthesize a minimal manifest from row columns so the UI doesn't crash.
    manifest = {
      $schema: "kernl://extension/v1",
      id: row.id,
      slug: row.slug,
      name: row.name,
      version: row.version,
      type: row.type,
      description: "(corrupted manifest)",
      author: "unknown",
      license: "Unknown",
      category: "utility",
    };
  }
  return {
    id: row.id,
    slug: row.slug,
    origin: { provider: "installed", source: { type: "bundled" } },
    manifest,
    status: rowStatusToCatalog(row.status),
    installed_id: row.id,
    price_cents: 0,
    currency: "EUR",
    install_count: 0,
    avg_rating: 0,
    review_count: 0,
    featured: false,
    verified: true,
  };
}

function rowStatusToCatalog(s: InstalledExtension["status"]): CatalogItemStatus {
  switch (s) {
    case "active": return "active";
    case "installed": return "installed";
    case "disabled": return "disabled";
    case "error": return "error";
    default: return "installed";
  }
}

function matchesFilter(item: CatalogItem, filter?: CatalogFilter): boolean {
  if (!filter) return true;
  if (filter.type && item.manifest.type !== filter.type) return false;
  if (filter.category && item.manifest.category !== filter.category) return false;
  if (filter.query) {
    const q = filter.query.toLowerCase();
    const hay = [
      item.slug,
      item.manifest.name,
      item.manifest.description,
      ...(item.manifest.tags ?? []),
    ].join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function sortCatalog(items: CatalogItem[]): CatalogItem[] {
  return [...items].sort((a, b) => {
    // featured first, then verified, then name
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    return a.manifest.name.localeCompare(b.manifest.name);
  });
}
