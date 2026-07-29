import { join } from "node:path";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ModuleContext, KernelModule } from "../../../../../src/core/types.js";
import type { ModuleRegistry } from "../../../../../src/core/module-registry.js";
import { log } from "../../../../../src/core/logger.js";
import type { InstalledPlugin, PluginManifest, PluginModuleExport } from "./types.js";

/**
 * Dynamically loads backend modules from installed plugins.
 * Called during bootstrap after the plugin manager module initializes.
 *
 * Each plugin's backend.entry must export a `createModule()` factory
 * that returns a KernelModule-compatible object.
 */
export async function loadInstalledPlugins(
  plugins: InstalledPlugin[],
  registry: ModuleRegistry,
  ctx: ModuleContext,
): Promise<{ loaded: string[]; errors: Array<{ name: string; error: string }> }> {
  const loaded: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const plugin of plugins) {
    if (plugin.status !== "active") continue;

    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(plugin.manifest_json);
    } catch {
      errors.push({ name: plugin.name, error: "Invalid manifest JSON" });
      continue;
    }

    if (!manifest.backend?.entry) {
      // Plugin has no backend (frontend-only or agents-only) — that's fine
      loaded.push(plugin.name);
      continue;
    }

    try {
      await loadPluginBackend(plugin, manifest, registry, ctx);
      loaded.push(plugin.name);
      log.info(`Plugin loaded: ${plugin.name} v${plugin.version}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ name: plugin.name, error: msg });
      log.warn(`Failed to load plugin ${plugin.name}: ${msg}`);
    }
  }

  return { loaded, errors };
}

async function loadPluginBackend(
  plugin: InstalledPlugin,
  manifest: PluginManifest,
  registry: ModuleRegistry,
  ctx: ModuleContext,
): Promise<void> {
  const entryPath = join(plugin.install_path, manifest.backend!.entry);

  // Verify entry file exists
  try {
    await access(entryPath);
  } catch {
    throw new Error(`Backend entry not found: ${entryPath}`);
  }

  // Dynamic import — the entry must export createModule()
  const entryUrl = pathToFileURL(entryPath).href;
  const mod = await import(entryUrl) as PluginModuleExport;

  if (typeof mod.createModule !== "function") {
    throw new Error(`Plugin ${plugin.name}: backend entry must export createModule()`);
  }

  const pluginModule = mod.createModule();

  // Wrap as KernelModule
  const kernelModule: KernelModule = {
    name: `plugin:${plugin.name}`,
    async initialize(moduleCtx: ModuleContext) {
      await pluginModule.initialize(moduleCtx);
    },
    getTools() {
      return pluginModule.getTools();
    },
    async shutdown() {
      await pluginModule.shutdown();
    },
  };

  // Register and initialize
  registry.register(kernelModule);
  await kernelModule.initialize(ctx);
}
