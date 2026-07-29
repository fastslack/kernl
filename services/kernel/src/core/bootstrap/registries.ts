/**
 * Stage: build all top-level registries and the live `ModuleContext`.
 *
 * Notification provider factories (Mattermost/Telegram/Discord/Slack/WebChat/
 * WhatsApp/Dashboard-notifications) are NO LONGER registered here — each is
 * a `type=module` extension that registers its own factory during the
 * extension's `initialize()`. The real provider instances are created
 * on-demand inside `NotificationRegistry.startAll()` which scans
 * `marketplace_items WHERE type='channel' AND status='active'`.
 *
 * Built-in sandbox drivers (Docker + CubeSandbox) and built-in LLM providers
 * (claude / openai / grok / lmstudio) are still registered here. DB drivers
 * register through `registerBuiltinGraphDrivers`.
 *
 * The exported `ctx` is the `ModuleContext` passed to every module's
 * `initialize()`. `ctx.graph` is a LIVE getter so flipping the active driver
 * in /extensions takes effect on the next call without a kernel restart.
 */

import type { KernelConfig } from "../config.js";
import type { SqliteDb } from "../db/sqlite.js";
import type { Neo4jClient } from "../db/neo4j.js";
import { log } from "../logger.js";
import { systemRegistry } from "../system-registry.js";
import type { EventBus } from "../event-bus.js";
import type { ModuleContext } from "../types.js";
import { ModuleRegistry } from "../module-registry.js";
import { DashboardRegistry } from "../dashboard-registry.js";
import { Notifier } from "../notify/notifier.js";
import { NotificationRegistry } from "../notify/registry.js";
import { SandboxDriverRegistry } from "../sandbox/registry.js";
import { createDockerDriver, createCubeDriver } from "../sandbox/drivers/index.js";
import { LlmProviderRegistry } from "../llm/provider-registry.js";
import { registerBuiltinLlmProviders } from "../llm/providers/index.js";
import { DbDriverRegistry } from "../db-drivers/db-driver-registry.js";
import { registerBuiltinGraphDrivers } from "../db-drivers/builtins/index.js";
import { createLicenseService } from "../license/index.js";
import type { LicenseService } from "../license/index.js";

export interface RegistriesInit {
  notificationRegistry: NotificationRegistry;
  notifier: Notifier;
  sandboxRegistry: SandboxDriverRegistry;
  llmRegistry: LlmProviderRegistry;
  dbRegistry: DbDriverRegistry;
  registry: ModuleRegistry;
  dashboardRegistry: DashboardRegistry;
  license: LicenseService;
  ctx: ModuleContext;
}

export function initRegistries(args: {
  config: KernelConfig;
  sqlite: SqliteDb;
  neo4j: Neo4jClient;
  events: EventBus;
}): RegistriesInit {
  const { config, sqlite, neo4j, events } = args;

  // ── Notification Registry ──
  // Provider factories are now registered by each channel's extension
  // (mattermost/telegram/dashboard-notifications/whatsapp/slack/discord/webchat),
  // which all live under `assets/extensions/<slug>/` and call
  // `ctx.notifier.getRegistry().registerFactory(...)` during their
  // `initialize()`. The instances are still created lazily inside
  // `notificationRegistry.startAll()`.
  const notificationRegistry = new NotificationRegistry();
  notificationRegistry.setDb(sqlite);
  if (config.encryption.key) {
    notificationRegistry.setEncryptionKey(config.encryption.key);
  }
  const notifier = new Notifier(notificationRegistry);

  // ── Sandbox Driver Registry ──
  const sandboxRegistry = new SandboxDriverRegistry();
  sandboxRegistry.setDb(sqlite);
  if (config.encryption.key) {
    sandboxRegistry.setEncryptionKey(config.encryption.key);
  }
  sandboxRegistry.registerFactory("docker", createDockerDriver);
  sandboxRegistry.registerFactory("cubesandbox", createCubeDriver);

  // ── LLM Provider Registry ──
  const llmRegistry = new LlmProviderRegistry();
  llmRegistry.setDb(sqlite);
  if (config.encryption.key) {
    llmRegistry.setEncryptionKey(config.encryption.key);
  }
  registerBuiltinLlmProviders(llmRegistry);

  // ── DB Driver Registry (graph today; vector/kv/… coming) ──
  const dbRegistry = new DbDriverRegistry();
  dbRegistry.setDb(sqlite);
  if (config.encryption.key) {
    dbRegistry.setEncryptionKey(config.encryption.key);
  }
  registerBuiltinGraphDrivers(dbRegistry.getGraphRegistry());

  // ── Module + Dashboard Registry ──
  const dashboardRegistry = new DashboardRegistry();
  const registry = new ModuleRegistry();
  registry.setDashboardRegistry(dashboardRegistry);
  const disabledModules = (process.env.DISABLED_MODULES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (disabledModules.length > 0) {
    registry.setDisabledModules(disabledModules);
    log.info(`Disabled modules: ${disabledModules.join(", ")}`);
  }
  // Load overrides BEFORE any register(). Bundled modules whose slug
  // has an installed `type=module status=active` extension are skipped.
  registry.loadExtensionOverrides(sqlite);

  // ── License service. Single instance shared by every Pro module.
  //    The constructor kicks off an async load; cached status is "none" until
  //    that resolves (sub-second). Modules that initialize before the load
  //    completes will see status=none on first read; that's fine because the
  //    boot order is: registries → core modules → extensions, and extensions
  //    (where Pro modules live) start well after the license cache is warm.
  const license = createLicenseService();

  // ── Build live `ModuleContext`. `ctx.graph` is a LIVE getter so consumers
  //    that re-read it per call automatically reflect /extensions toggles.
  const ctxBase = {
    sqlite,
    neo4j,
    events,
    config,
    systemRegistry,
    notifier,
    license,
    getModule: (name: string) => registry.getModule(name) ?? null,
  };
  const ctx = Object.defineProperty(ctxBase, "graph", {
    get: () => dbRegistry.getGraph(),
    enumerable: true,
    configurable: false,
  }) as unknown as ModuleContext;

  return {
    notificationRegistry,
    notifier,
    sandboxRegistry,
    llmRegistry,
    dbRegistry,
    registry,
    dashboardRegistry,
    license,
    ctx,
  };
}
