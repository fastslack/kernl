/**
 * Dynamic loader for active `module` extensions.
 *
 * Called once during bootstrap, after core modules have initialized. Reads
 * every `status='active'` row of type `module` and imports its backend
 * entry, wrapping the exported createModule() factory into a KernelModule
 * and registering it with the ModuleRegistry so it appears in getTools().
 *
 * This closes the long-standing gap where installed plugins lived in the
 * DB but never got loaded.
 */

import { resolve, sep } from "node:path";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { KernelModule, ModuleContext } from "../../core/types.js";
import type { ModuleRegistry } from "../../core/module-registry.js";
import { log } from "../../core/logger.js";
import type { ExtensionService } from "./service.js";
import type { InstalledExtension } from "./types.js";
import type { ExtensionManifest } from "./schema.js";

interface LoadResult {
  loaded: string[];
  skipped: string[];
  failed: Array<{ slug: string; error: string }>;
}

export async function loadActiveExtensions(
  service: ExtensionService,
  registry: ModuleRegistry,
  ctx: ModuleContext,
): Promise<LoadResult> {
  const result: LoadResult = { loaded: [], skipped: [], failed: [] };

  // Resolve dependency-safe order: extensions with no deps first.
  const rows = service.list({ status: "active", type: "module" });
  const ordered = topoSort(rows, service);

  // Dependency enforcement needs to consider non-module extensions too (e.g. a
  // module may depend on a `channel` that provides an auth/connection service).
  // Index by both id and slug so manifests can reference either form.
  const allInstalled = service.list({});
  const byIdAll = new Map<string, InstalledExtension>();
  const bySlugAll = new Map<string, InstalledExtension>();
  for (const r of allInstalled) {
    byIdAll.set(r.id, r);
    bySlugAll.set(r.slug, r);
  }

  for (const row of ordered) {
    const manifest = service.parseManifest(row);
    // Built-in modules are statically registered at bootstrap — skip.
    if (manifest.built_in) {
      result.skipped.push(row.slug);
      continue;
    }
    if (!manifest.backend?.entry) {
      result.skipped.push(row.slug);
      continue;
    }

    // Enforce required dependencies: every declared id/slug must resolve to
    // an installed extension whose status is 'active'. Anything else is a
    // hard stop — load nothing for this extension and surface a clear error.
    const missing: string[] = [];
    for (const depRef of manifest.dependencies ?? []) {
      const dep = byIdAll.get(depRef) ?? bySlugAll.get(depRef);
      if (!dep) {
        missing.push(`${depRef} (not installed)`);
      } else if (dep.status !== "active") {
        missing.push(`${depRef} (${dep.status})`);
      }
    }
    if (missing.length > 0) {
      const msg = `Dependencies not satisfied: ${missing.join(", ")}`;
      service.setStatus(row.id, "error", msg);
      result.failed.push({ slug: row.slug, error: msg });
      log.warn(`Skipping extension ${row.slug}: ${msg}`);
      continue;
    }

    try {
      await loadOne(row, manifest, registry, ctx);
      service.markLoaded(row.id);
      result.loaded.push(row.slug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      service.setStatus(row.id, "error", msg);
      result.failed.push({ slug: row.slug, error: msg });
      log.warn(`Failed to load extension ${row.slug}: ${msg}`);
    }
  }

  log.info(
    `Extensions loaded: ${result.loaded.length} ok, ` +
      `${result.skipped.length} skipped, ${result.failed.length} failed`,
  );
  return result;
}

async function loadOne(
  row: InstalledExtension,
  manifest: ExtensionManifest,
  registry: ModuleRegistry,
  ctx: ModuleContext,
): Promise<void> {
  const base = resolve(row.install_path);
  const entryPath = resolve(base, manifest.backend!.entry);
  // Containment: a malicious manifest backend.entry must not escape install_path.
  if (entryPath !== base && !entryPath.startsWith(base + sep)) {
    throw new Error(`Extension ${manifest.slug}: entry path escapes module dir`);
  }
  try {
    await access(entryPath);
  } catch {
    throw new Error(`Backend entry not found: ${entryPath}`);
  }

  const mod = (await import(pathToFileURL(entryPath).href)) as {
    createModule?: () => KernelModule;
    default?: () => KernelModule;
  };
  const factory = mod.createModule ?? mod.default;
  if (typeof factory !== "function") {
    throw new Error(
      `Extension ${manifest.slug}: backend must export createModule() or default factory`,
    );
  }

  const extModule = factory();
  // Delegating wrapper. Forwards EVERY custom method of the underlying module
  // mediante un Proxy: `getDashboardDescriptor`, `getService`, `getRpcActions`,
  // and any module-specific `getXxx` / `setXxx` (e.g. cinema's
  // setSearchInfra, social's getNostrBridge, trading's getMarketGraph). Esto
  // lets consumers in the bootstrap reach the handle via
  // `registry.getModule("ext:slug").customMethod()` sin que el wrapper esconda
  // la API.
  const baseModule: KernelModule = {
    name: `ext:${manifest.slug}`,
    async initialize(c: ModuleContext) {
      await extModule.initialize(c);
    },
    getTools() {
      return extModule.getTools();
    },
    async shutdown() {
      await extModule.shutdown();
    },
  };

  const kernelModule = new Proxy(baseModule, {
    get(target, prop, receiver) {
      // The base wrapper's own methods (name, initialize, getTools, shutdown)
      // win to ensure the registry sees the wrapped name `ext:<slug>`. For any
      // other property, fall through to the underlying module so consumers can
      // call custom methods (getService, setSearchInfra, getMarketGraph, ...).
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      const value = (extModule as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(extModule);
      }
      return value;
    },
    has(target, prop) {
      return prop in target || prop in (extModule as object);
    },
  }) as KernelModule;

  await kernelModule.initialize(ctx);
  registry.registerPostInit(kernelModule);
}

/**
 * Deterministic topological sort by `manifest.dependencies`. Extensions
 * with unresolved deps are placed at the end (they'll likely fail to load,
 * but we still try — a missing dep doesn't block unrelated extensions).
 */
function topoSort(
  rows: InstalledExtension[],
  service: ExtensionService,
): InstalledExtension[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const visited = new Set<string>();
  const out: InstalledExtension[] = [];

  function visit(row: InstalledExtension): void {
    if (visited.has(row.id)) return;
    visited.add(row.id);
    const manifest = service.parseManifest(row);
    for (const depId of manifest.dependencies ?? []) {
      const dep = byId.get(depId) ?? bySlug.get(depId);
      if (dep) visit(dep);
    }
    out.push(row);
  }

  for (const row of rows) visit(row);
  return out;
}
