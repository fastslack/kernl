/**
 * Stage: load extensions and resolve their handles.
 *
 * Sequence:
 *  1. `importLegacyExtensions` — one-shot import of legacy rows
 *     (marketplace_items / installed_plugins / skills-config.json).
 *     Idempotent — safe to run every boot.
 *  2. `seedBuiltinExtensions` — registers in-tree extension stubs (the
 *     `assets/extensions/*` bundles) into the unified extensions registry
 *     so the UI sees them. Runs BEFORE the loader so the loader skips
 *     anything already statically registered.
 *  3. `extensionsModule.service.setInstallerDeps(...)` — wires the late-bound
 *     dependencies the installer pipeline needs (skill registry, agents
 *     facade, sandbox driver registry, module registry callbacks).
 *  4. `loadActiveExtensions` — dynamically loads every `type=module` (and
 *     `type=agent-bundle`) extension marked active.
 *
 * After load we resolve all the extension handles via `getExt(slug)`. These
 * are the handles other stages (services, http, mtw) read to know what's
 * available — `null` means the extension isn't installed or isn't active.
 *
 * Email/triage tools are special: they depend on cross-extension handles
 * (tasks/crm/reminders/shopping). We assemble them right here so later
 * stages can fold them into the global tool catalog.
 */

import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "../logger.js";
import type { SqliteDb } from "../db/sqlite.js";
import type { ModuleContext, ToolDefinition } from "../types.js";
import type { ModuleRegistry } from "../module-registry.js";
import type { SandboxDriverRegistry } from "../sandbox/registry.js";
import type { ExtensionsModuleHandle } from "../../modules/extensions/index.js";
import type {
  CamerasModule,
  MeshModule,
  GraphIntelModule,
  AnalyticsService,
  RemindersModule,
  CommsModule,
  TasksModule,
  CrmModule,
  ShoppingModule,
  LightsModule,
  ApiRegistryModule,
  TradingModule,
  FederationModule,
  SocialModule,
  TorrentsModule,
  CinemaModule,
  BooksModule,
  TwitterModule,
  GoogleSyncModule,
} from "../types/extensions/index.js";
import { importLegacyExtensions } from "../../modules/extensions/legacy-import.js";
import { seedBuiltinExtensions } from "../../modules/extensions/seed-builtin.js";
import { loadActiveExtensions } from "../../modules/extensions/index.js";
import { AgentsFacade } from "../../modules/agents/extension-facade.js";
import { createDockerDriver } from "../sandbox/drivers/index.js";
import type { MarketplaceModule } from "../../modules/marketplace/index.js";
import type { RssExtensionHandle } from "./types.js";

export interface ExtensionHandles {
  googleSyncModule: (GoogleSyncModule & { getService(): unknown }) | null;
  rssRegistryModule: RssExtensionHandle | null;
  camerasModule: CamerasModule | null;
  lightsModule: LightsModule | null;
  federationModule: FederationModule | null;
  socialModule: SocialModule | null;
  torrentsModule: TorrentsModule | null;
  cinemaModule: CinemaModule | null;
  booksModule: BooksModule | null;
  twitterModule: TwitterModule | null;
  tradingModule: TradingModule | null;
  apiRegistryModule: ApiRegistryModule | null;
  graphIntelModule: GraphIntelModule | null;
  analyticsService: AnalyticsService | null;
  commsModule: CommsModule | null;
  tasksModule: TasksModule | null;
  crmModule: CrmModule | null;
  remindersModule: RemindersModule | null;
  shoppingModule: ShoppingModule | null;
  meshModule: MeshModule | null;
  emailTools: ToolDefinition[];
  triageTools: ToolDefinition[];
}

export async function loadExtensions(args: {
  sqlite: SqliteDb;
  ctx: ModuleContext;
  registry: ModuleRegistry;
  extensionsModule: ExtensionsModuleHandle;
  sandboxRegistry: SandboxDriverRegistry;
  llmRegistry: import("../llm/provider-registry.js").LlmProviderRegistry;
  skillRegistry: {
    install: (src: { type: "bundled"; id: string }) => Promise<string | null>;
    enableSkill: (id: string) => Promise<boolean>;
  };
  marketplaceModule: MarketplaceModule;
  identity?: import("../attestation.js").Identity | null;
}): Promise<ExtensionHandles> {
  const { sqlite, ctx, registry, extensionsModule, sandboxRegistry, llmRegistry, skillRegistry, marketplaceModule, identity } = args;

  // 0. Wire the unified catalog registry into the marketplace module — the
  //    extensions service is fully online here, so the bundled provider can
  //    overlay install status from the very first browse. The identity is
  //    threaded through so receipts (local) and watermarks (remote downloads)
  //    can be Ed25519-signed.
  marketplaceModule.attachCatalog(extensionsModule.service, { identity: identity ?? null });
  extensionsModule.service.setIdentity(identity ?? null);

  // 1. legacy import (idempotent)
  await importLegacyExtensions(sqlite);
  // 2. seed in-tree extension stubs
  await seedBuiltinExtensions(extensionsModule.service);
  // 3. wire installer deps
  extensionsModule.service.setInstallerDeps({
    db: sqlite,
    skillRegistry: {
      install: (src) => skillRegistry.install({ type: "bundled", id: src.id }),
      enableSkill: (id) => skillRegistry.enableSkill(id),
    },
    agentsFacade: new AgentsFacade(sqlite),
    notificationRegistry: null, // pending facade refactor
    themeSubsystem: null,
    sandboxDriverRegistry: {
      registerDriverFromExtension: (slug, factory) => {
        sandboxRegistry.registerDriverFromExtension(
          slug,
          factory as () => ReturnType<typeof createDockerDriver>,
        );
      },
      startDriver: (slug) => sandboxRegistry.startDriver(slug),
      unregister: (slug) => sandboxRegistry.unregister(slug),
    },
    llmProviderRegistry: {
      registerDriverFromExtension: (slug, factory) =>
        llmRegistry.registerDriverFromExtension(slug, factory as () => never),
      startProvider: (slug) => llmRegistry.startProvider(slug),
      unregister: (slug) => llmRegistry.unregister(slug),
    },
    moduleRegistry: {
      unregisterModule: (name) => registry.unregisterModule(name),
    },
  });

  // 3b. Re-register dynamically-installed llm-provider extensions (built-ins are
  //     registered statically in initRegistries). Mirrors the install-time path
  //     so third-party providers survive a restart.
  try {
    const provRows = extensionsModule.service.list({ status: "active", type: "llm-provider" });
    for (const row of provRows) {
      let m: { built_in?: boolean; backend?: { entry?: string } } = {};
      try { m = JSON.parse(row.manifest_json) as typeof m; } catch { m = {}; }
      if (m.built_in || !m.backend?.entry || llmRegistry.hasFactory(row.slug)) continue;
      try {
        const base = resolve(row.install_path);
        const entryPath = resolve(base, m.backend.entry);
        // Containment: manifest backend.entry must stay under install_path.
        if (entryPath !== base && !entryPath.startsWith(base + sep)) {
          throw new Error(`llm-provider ${row.slug}: entry path escapes install dir`);
        }
        const mod = (await import(pathToFileURL(entryPath).href)) as { createProvider?: () => never };
        if (typeof mod.createProvider === "function") {
          llmRegistry.registerDriverFromExtension(row.slug, mod.createProvider);
          await llmRegistry.startProvider(row.slug).catch(() => {});
          log.info(`llm-provider ${row.slug}: re-registered from extension at boot`);
        }
      } catch (err) {
        log.warn(`llm-provider ${row.slug}: boot re-register failed: ${String(err)}`);
      }
    }
  } catch (err) {
    log.warn(`llm-provider boot re-registration skipped: ${String(err)}`);
  }

  // 4. dynamic load
  const extLoad = await loadActiveExtensions(extensionsModule.service, registry, ctx);
  if (extLoad.failed.length > 0) {
    log.warn(
      `Extension loader: ${extLoad.failed.length} failed — ` +
        extLoad.failed.map((f) => `${f.slug} (${f.error})`).join("; "),
    );
  }

  // ── Late-bind extension handles ────────────────────
  const getExt = <T,>(slug: string): T | null =>
    (registry.getModule(`ext:${slug}`) ?? null) as T | null;

  const googleSyncModule = getExt<GoogleSyncModule & { getService(): unknown }>("google-sync");
  const rssRegistryModule = getExt<RssExtensionHandle>("rss-registry");
  const camerasModule = getExt<CamerasModule>("cameras");
  const lightsModule = getExt<LightsModule>("lights");
  const federationModule = getExt<FederationModule>("federation");
  const socialModule = getExt<SocialModule>("social");
  const torrentsModule = getExt<TorrentsModule>("torrents");
  const cinemaModule = getExt<CinemaModule>("cinema");
  const booksModule = getExt<BooksModule>("books");
  const twitterModule = getExt<TwitterModule>("twitter");
  const tradingModule = getExt<TradingModule>("trading");
  const apiRegistryModule = getExt<ApiRegistryModule>("api-registry");
  const graphIntelModule = getExt<GraphIntelModule>("graph-intel");
  const analyticsService = graphIntelModule?.getAnalyticsService() ?? null;
  const commsModule = getExt<CommsModule>("comms");
  const tasksModule = getExt<TasksModule>("tasks");
  const crmModule = getExt<CrmModule>("crm");
  const remindersModule = getExt<RemindersModule>("reminders");
  const shoppingModule = getExt<ShoppingModule>("shopping");
  const meshModule = getExt<MeshModule>("mesh");

  // ── Email Analysis + Triage (cross-extension tool factories) ──
  // The pipeline tools depend on services from tasks / crm / reminders /
  // shopping / comms — all of which load as extensions. We delegate to the
  // comms module so the actual tool factories live next to the services
  // they consume; bootstrap only supplies the cross-extension handles.
  let emailTools: ToolDefinition[] = [];
  let triageTools: ToolDefinition[] = [];
  {
    const taskSvc = tasksModule?.getService() ?? null;
    const crmSvc = crmModule?.getService() ?? null;
    const reminderSvc = remindersModule?.getService() ?? null;
    const shoppingSvc = shoppingModule?.getService() ?? null;
    if (commsModule && taskSvc && crmSvc && reminderSvc && shoppingSvc) {
      emailTools = commsModule.getEmailAnalysisTools({
        taskService: taskSvc,
        reminderService: reminderSvc,
        crmService: crmSvc,
        shoppingService: shoppingSvc,
      });
    }
    if (emailTools.length > 0) {
      log.info(`Email analysis: ${emailTools.length} tools ready`);
    }
    if (commsModule) {
      triageTools = commsModule.getCommsTriageTools();
    }
    if (triageTools.length > 0) {
      log.info(`Email triage: ${triageTools.length} tools ready`);
    }
  }

  return {
    googleSyncModule,
    rssRegistryModule,
    camerasModule,
    lightsModule,
    federationModule,
    socialModule,
    torrentsModule,
    cinemaModule,
    booksModule,
    twitterModule,
    tradingModule,
    apiRegistryModule,
    graphIntelModule,
    analyticsService,
    commsModule,
    tasksModule,
    crmModule,
    remindersModule,
    shoppingModule,
    meshModule,
    emailTools,
    triageTools,
  };
}
