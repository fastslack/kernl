/**
 * Type-specific install / uninstall dispatchers.
 *
 * The generic ExtensionService does NOT know how to make a theme look
 * good or how to register a notification channel — those are handled by
 * the respective subsystems. This file is where we route a manifest's
 * type to the right subsystem.
 *
 * For `module` extensions, install/uninstall is just metadata + migrations;
 * the dynamic loading happens at bootstrap via loader.ts.
 */

import { join, resolve, sep } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { log } from "../../core/logger.js";
import { runMigrations, type Migration } from "../../core/db/migrations.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { ExtensionManifest } from "./schema.js";

/**
 * Hooks provided by the host kernel. Each handler picks what it needs;
 * any field can be `null` if the corresponding subsystem isn't available
 * (tests, minimal deployments).
 */
export interface InstallerDeps {
  db: SqliteDb;
  /** Resolver for the Skills subsystem — used by `skill` and `module`(skills). */
  skillRegistry: SkillRegistryLike | null;
  /** Resolver for the Agents subsystem — used by `agent-bundle` and `flow`. */
  agentsFacade: AgentsFacadeLike | null;
  /** Resolver for the Notifications subsystem — used by `channel`. */
  notificationRegistry: NotificationRegistryLike | null;
  /** Resolver for the Theme subsystem — used by `theme`. */
  themeSubsystem: ThemeSubsystemLike | null;
  /** Resolver for the Sandbox Driver subsystem — used by `sandbox-driver`. */
  sandboxDriverRegistry: SandboxDriverRegistryLike | null;
  /** Resolver for the LLM Provider subsystem — used by `llm-provider`. */
  llmProviderRegistry: LlmProviderRegistryLike | null;
  /** Resolver for live module lifecycle — used to unload `module` extensions on uninstall. */
  moduleRegistry?: ModuleRegistryLike | null;
}

export interface ModuleRegistryLike {
  /** Return true if a live module with `ext:<slug>` name was found and shut down. */
  unregisterModule(name: string): Promise<boolean>;
}

export interface SkillRegistryLike {
  install(source: { type: string; id: string }): Promise<string | null>;
  enableSkill(id: string): Promise<boolean>;
  uninstall?(id: string): Promise<boolean>;
}

export interface AgentsFacadeLike {
  installAgentFromPayload(payload: unknown): Promise<string>;
  installFlowFromPayload(payload: unknown): Promise<string>;
  installOfficeFromPayload?(payload: unknown): Promise<string>;
  installChainFromPayload?(payload: unknown): Promise<string>;
  uninstallBySource(extensionId: string): Promise<void>;
}

export interface NotificationRegistryLike {
  registerChannelFromPackage(payload: unknown): Promise<void>;
  unregisterChannel(implementation: string): Promise<void>;
}

export interface ThemeSubsystemLike {
  applyTheme(payload: unknown): Promise<void>;
  removeTheme(extensionId: string): Promise<void>;
}

export interface SandboxDriverRegistryLike {
  /** Called on install — the caller dynamically imports the module and hands the factory in. */
  registerDriverFromExtension(slug: string, factory: () => unknown): void;
  /** Start a freshly-installed driver. */
  startDriver(slug: string): Promise<boolean>;
  /** Remove — used on uninstall. */
  unregister(slug: string): Promise<void>;
}

export interface LlmProviderRegistryLike {
  /** Called on install — caller dynamically imports the module and hands the factory in. */
  registerDriverFromExtension(slug: string, factory: () => unknown): void;
  /** Start a freshly-installed provider. */
  startProvider(slug: string): Promise<boolean>;
  /** Remove — used on uninstall. */
  unregister(slug: string): Promise<void>;
}

// ── Public API ────────────────────────────────────────────────────────

export async function dispatchInstall(
  manifest: ExtensionManifest,
  installDir: string,
  deps: InstallerDeps,
): Promise<void> {
  // Backend migrations run first regardless of type, because any type MAY
  // ship migrations (unlikely for theme/template, but not forbidden).
  await runExtensionMigrations(manifest, installDir, deps.db);

  switch (manifest.type) {
    case "module":
      // Nothing else at install time — loader.ts picks it up at bootstrap.
      break;
    case "skill":
      await installSkills(manifest, installDir, deps);
      break;
    case "agent-bundle":
      await installAgentBundle(manifest, installDir, deps);
      break;
    case "office":
      await installOffice(manifest, installDir, deps);
      break;
    case "flow":
      await installFlow(manifest, installDir, deps);
      break;
    case "theme":
      await installTheme(manifest, deps);
      break;
    case "template":
      // Templates are pure data. Consumers read the manifest to find them.
      break;
    case "channel":
      await installChannel(manifest, deps);
      break;
    case "sandbox-driver":
      await installSandboxDriver(manifest, installDir, deps);
      break;
    case "llm-provider":
      await installLlmProvider(manifest, installDir, deps);
      break;
    case "suite":
      // Suites are pure UI composition — no install-time work. The dashboard
      // reads manifest.frontend.navGroups/navItems directly.
      break;
  }

  await installComposableExtras(manifest, installDir, deps);

  log.info(`Extension installed: ${manifest.slug} (${manifest.type})`);
}

/**
 * Composable extras: an extension of ANY type may ALSO ship an office and/or
 * agents/flows — e.g. a `module` (like the DevOps extension) that seeds its
 * pre-configured agent team. Processed here unless the type switch already did,
 * so a `.kernl` needn't be an "office" type just to carry one.
 *
 * Runs on BOTH install and enable(): a builtin-seeded PAID extension is
 * registered but locked, and only materializes its office once the operator
 * enables it (which is where the license is checked). Idempotent — every
 * underlying facade upsert keys on slug, so re-running never duplicates; it
 * just adopts/updates the existing office + agents.
 */
export async function installComposableExtras(
  manifest: ExtensionManifest,
  installDir: string,
  deps: InstallerDeps,
): Promise<void> {
  if (manifest.office && manifest.type !== "office") {
    await installOffice(manifest, installDir, deps);
  }
  if ((manifest.flows?.length || manifest.agents?.length) && manifest.type !== "agent-bundle" && manifest.type !== "flow") {
    await installAgentBundle(manifest, installDir, deps);
  }
}

export async function dispatchUninstall(
  manifest: ExtensionManifest,
  _installDir: string,
  deps: InstallerDeps,
): Promise<void> {
  switch (manifest.type) {
    case "skill":
      if (deps.skillRegistry?.uninstall) {
        await deps.skillRegistry.uninstall(manifest.slug).catch(() => {});
      }
      break;
    case "agent-bundle":
    case "office":
    case "flow":
      await deps.agentsFacade?.uninstallBySource(manifest.id).catch(() => {});
      break;
    case "channel":
      for (const ch of manifest.channels ?? []) {
        await deps.notificationRegistry?.unregisterChannel(ch.implementation).catch(() => {});
      }
      break;
    case "theme":
      await deps.themeSubsystem?.removeTheme(manifest.id).catch(() => {});
      break;
    case "sandbox-driver":
      await deps.sandboxDriverRegistry?.unregister(manifest.slug).catch(() => {});
      break;
    case "llm-provider":
      await deps.llmProviderRegistry?.unregister(manifest.slug).catch(() => {});
      break;
    case "module":
      // Live-unregister the module so its tools stop being advertised and its
      // shutdown hook runs. Tool-set caches in ChatService / AgentExecutor
      // keep stale references until next reload — documented limitation.
      await deps.moduleRegistry?.unregisterModule(`ext:${manifest.slug}`).catch((err) => {
        log.warn(`Failed to unregister module ext:${manifest.slug}: ${err instanceof Error ? err.message : err}`);
      });
      break;
    case "template":
      break;
    case "suite":
      // Nothing to tear down — suites only touch manifest metadata.
      break;
  }
}

// ── Handlers ──────────────────────────────────────────────────────────

async function runExtensionMigrations(
  manifest: ExtensionManifest,
  installDir: string,
  db: SqliteDb,
): Promise<void> {
  const migDir = manifest.backend?.migrations;
  if (!migDir) return;
  const absDir = join(installDir, migDir);

  let files: string[];
  try {
    files = (await readdir(absDir)).filter((f) => /\.(sql|ts|js)$/.test(f)).sort();
  } catch {
    return;
  }
  if (!files.length) return;

  const migrations: Migration[] = [];
  for (let i = 0; i < files.length; i++) {
    const sql = await readFile(join(absDir, files[i]), "utf-8");
    migrations.push({ version: i + 1, sql });
  }
  runMigrations(db, `ext:${manifest.slug}`, migrations);
}

async function installSkills(
  manifest: ExtensionManifest,
  _installDir: string,
  deps: InstallerDeps,
): Promise<void> {
  if (!deps.skillRegistry) {
    log.warn(`Skill extension ${manifest.slug}: SkillRegistry unavailable`);
    return;
  }
  const skillId = await deps.skillRegistry.install({ type: "bundled", id: manifest.slug });
  if (skillId) await deps.skillRegistry.enableSkill(skillId);
}

async function installAgentBundle(
  manifest: ExtensionManifest,
  installDir: string,
  deps: InstallerDeps,
): Promise<void> {
  if (!deps.agentsFacade) {
    log.warn(`agent-bundle ${manifest.slug}: agents subsystem unavailable`);
    return;
  }
  // Flows first — agent payloads reference them via `flow_slug`.
  for (const rel of manifest.flows ?? []) {
    const payload = JSON.parse(await readFile(join(installDir, rel), "utf-8"));
    payload.__extension_id = manifest.id;
    await deps.agentsFacade.installFlowFromPayload(payload);
  }
  for (const rel of manifest.agents ?? []) {
    const payload = JSON.parse(await readFile(join(installDir, rel), "utf-8"));
    payload.__extension_id = manifest.id;
    await deps.agentsFacade.installAgentFromPayload(payload);
  }
}

async function installFlow(
  manifest: ExtensionManifest,
  installDir: string,
  deps: InstallerDeps,
): Promise<void> {
  if (!deps.agentsFacade) {
    log.warn(`flow ${manifest.slug}: agents subsystem unavailable`);
    return;
  }
  for (const rel of manifest.flows ?? []) {
    const payload = JSON.parse(await readFile(join(installDir, rel), "utf-8"));
    payload.__extension_id = manifest.id;
    await deps.agentsFacade.installFlowFromPayload(payload);
  }
}

async function installOffice(
  manifest: ExtensionManifest,
  installDir: string,
  deps: InstallerDeps,
): Promise<void> {
  if (!deps.agentsFacade) {
    log.warn(`office ${manifest.slug}: agents subsystem unavailable`);
    return;
  }
  // 1) Office spec → upserts the flow row (+ extended metadata).
  if (manifest.office) {
    const payload = JSON.parse(await readFile(join(installDir, manifest.office), "utf-8"));
    payload.__extension_id = manifest.id;
    if (deps.agentsFacade.installOfficeFromPayload) {
      await deps.agentsFacade.installOfficeFromPayload(payload);
    } else {
      // Back-compat fallback: degrade to flow upsert.
      await deps.agentsFacade.installFlowFromPayload(payload);
    }
  }
  // 2) Agents (in declaration order, so inter-agent refs resolve by the time
  //    chains run).
  for (const rel of manifest.agents ?? []) {
    const payload = JSON.parse(await readFile(join(installDir, rel), "utf-8"));
    payload.__extension_id = manifest.id;
    await deps.agentsFacade.installAgentFromPayload(payload);
  }
  // 3) Internal chains (source_slug → target_slug).
  if (deps.agentsFacade.installChainFromPayload) {
    for (const rel of manifest.chains ?? []) {
      const payload = JSON.parse(await readFile(join(installDir, rel), "utf-8"));
      payload.__extension_id = manifest.id;
      await deps.agentsFacade.installChainFromPayload(payload);
    }
  }
}

async function installTheme(
  manifest: ExtensionManifest,
  deps: InstallerDeps,
): Promise<void> {
  if (!deps.themeSubsystem) return;
  await deps.themeSubsystem.applyTheme({
    extensionId: manifest.id,
    ...(manifest.theme ?? {}),
  });
}

async function installChannel(
  manifest: ExtensionManifest,
  deps: InstallerDeps,
): Promise<void> {
  if (!deps.notificationRegistry) return;
  for (const ch of manifest.channels ?? []) {
    await deps.notificationRegistry.registerChannelFromPackage({
      extensionId: manifest.id,
      ...ch,
    });
  }
}

async function installSandboxDriver(
  manifest: ExtensionManifest,
  installDir: string,
  deps: InstallerDeps,
): Promise<void> {
  if (!deps.sandboxDriverRegistry) {
    log.warn(`sandbox-driver ${manifest.slug}: sandboxDriverRegistry unavailable`);
    return;
  }
  if (!manifest.backend?.entry) {
    throw new Error(`sandbox-driver ${manifest.slug}: backend.entry is required`);
  }
  const base = resolve(installDir);
  const entryPath = resolve(base, manifest.backend.entry);
  // Containment: manifest backend.entry must not escape the install dir.
  if (entryPath !== base && !entryPath.startsWith(base + sep)) {
    throw new Error(`sandbox-driver ${manifest.slug}: entry path escapes install dir`);
  }
  // Dynamic ESM import. The entry MUST export `createDriver()`.
  const mod = (await import(entryPath)) as { createDriver?: () => unknown };
  if (typeof mod.createDriver !== "function") {
    throw new Error(`sandbox-driver ${manifest.slug}: entry does not export createDriver()`);
  }
  deps.sandboxDriverRegistry.registerDriverFromExtension(manifest.slug, mod.createDriver);
  await deps.sandboxDriverRegistry.startDriver(manifest.slug).catch((err) => {
    log.warn(`sandbox-driver ${manifest.slug}: initial start failed: ${String(err)}`);
  });
}

async function installLlmProvider(
  manifest: ExtensionManifest,
  installDir: string,
  deps: InstallerDeps,
): Promise<void> {
  // Built-in providers are registered statically at bootstrap — nothing to do.
  if (manifest.built_in) return;
  if (!deps.llmProviderRegistry) {
    log.warn(`llm-provider ${manifest.slug}: llmProviderRegistry unavailable`);
    return;
  }
  if (!manifest.backend?.entry) {
    throw new Error(`llm-provider ${manifest.slug}: backend.entry is required`);
  }
  const base = resolve(installDir);
  const entryPath = resolve(base, manifest.backend.entry);
  // Containment: manifest backend.entry must not escape the install dir.
  if (entryPath !== base && !entryPath.startsWith(base + sep)) {
    throw new Error(`llm-provider ${manifest.slug}: entry path escapes install dir`);
  }
  // Dynamic ESM import. The entry MUST export `createProvider()`.
  const mod = (await import(entryPath)) as { createProvider?: () => unknown };
  if (typeof mod.createProvider !== "function") {
    throw new Error(`llm-provider ${manifest.slug}: entry does not export createProvider()`);
  }
  deps.llmProviderRegistry.registerDriverFromExtension(manifest.slug, mod.createProvider);
  await deps.llmProviderRegistry.startProvider(manifest.slug).catch((err) => {
    log.warn(`llm-provider ${manifest.slug}: initial start failed: ${String(err)}`);
  });
}
