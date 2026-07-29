/**
 * Stage: seed + start built-in driver registries, build the Skill registry,
 * load the attestation identity, build the cost router and register the
 * marketplace module.
 *
 * This stage runs AFTER `initCoreModules` (the extensions module's migrations
 * have created `installed_extensions`, which the seed-rows below stub into).
 * It runs BEFORE `loadExtensions` so the registries are warm by the time
 * extensions try to register additional drivers/providers.
 *
 * `metaIdentitySlot.value` is mutated here so meta tools (`kernel_attest_*`)
 * can see the identity immediately after this stage returns.
 */

import { log } from "../logger.js";
import type { SqliteDb } from "../db/sqlite.js";
import type { EventBus } from "../event-bus.js";
import type { ModuleContext, ToolDefinition } from "../types.js";
import type { Identity } from "../attestation.js";
import type { CostRouter } from "../llm/cost-router.js";
import type { ModuleRegistry } from "../module-registry.js";
import type { SandboxDriverRegistry } from "../sandbox/registry.js";
import type { LlmProviderRegistry } from "../llm/provider-registry.js";
import type { DbDriverRegistry } from "../db-drivers/db-driver-registry.js";
import { createSkillRegistry } from "../../skills/index.js";
import { createMarketplaceModule, type MarketplaceModule } from "../../modules/marketplace/index.js";

export interface DriversInitResult {
  attestIdentity: Identity | undefined;
  costRouter: CostRouter;
  skillRegistry: ReturnType<typeof createSkillRegistry>;
  marketplaceModule: MarketplaceModule;
}

export async function initDrivers(args: {
  sqlite: SqliteDb;
  events: EventBus;
  ctx: ModuleContext;
  registry: ModuleRegistry;
  sandboxRegistry: SandboxDriverRegistry;
  llmRegistry: LlmProviderRegistry;
  dbRegistry: DbDriverRegistry;
  agentsModule: { setSandboxRegistry: (r: SandboxDriverRegistry) => void; getService: () => unknown };
  skillTools: ToolDefinition[] | null;  // unused; placeholder for future hook
  metaIdentitySlot: { value: () => Identity | undefined };
  metaCostRouterSlot: { value: () => CostRouter | undefined };
}): Promise<DriversInitResult> {
  const {
    sqlite, events, ctx, registry,
    sandboxRegistry, llmRegistry, dbRegistry,
    agentsModule,
    metaIdentitySlot, metaCostRouterSlot,
  } = args;

  // ── Sandbox drivers — seed + start ─────────────────
  sandboxRegistry.seedBuiltinRows();
  // Inject the registry into the agents module so the claude_code executor
  // can pick a driver per-agent via `__sandbox_driver__`.
  agentsModule.setSandboxRegistry(sandboxRegistry);
  // Start active drivers (non-fatal — drivers whose daemon isn't reachable
  // go to ready=false and the executor throws a clear error at run time).
  await sandboxRegistry.startAll();

  // ── LLM providers — seed + start ────────────────────
  llmRegistry.seedBuiltinRows();
  await llmRegistry.startAll();
  // The registry's per-provider settings_json is the source of truth. Mirror it
  // into the legacy config.webIntel.* fields the chat adapter / web-intel /
  // llm() singleton still read, so saved provider config survives restarts even
  // when it was never written to .env.
  try {
    const { syncProvidersToKernelConfig } = await import("../llm/sync-config.js");
    syncProvidersToKernelConfig(ctx.config, llmRegistry);
  } catch (err) {
    log.warn(`syncProvidersToKernelConfig at bootstrap failed: ${String(err)}`);
  }

  // ── DB drivers — seed + start active ────────────────
  // Fresh installs boot with `noop` active so the kernel doesn't try to
  // reach a graph server until the user opts in from /extensions. The
  // legacy Neo4jClient stays the source of truth for ctx.neo4j until
  // consumers migrate to ctx.graph.
  dbRegistry.seedBuiltins();
  await dbRegistry.startAllActive();

  // ── Skill Registry ──
  const skillRegistry = createSkillRegistry(process.cwd(), events);
  await skillRegistry.initialize(ctx);
  const skillTools = skillRegistry.getTools();
  if (skillTools.length > 0) {
    log.info(`SkillRegistry: ${skillTools.length} tools from ${skillRegistry.getEnabledSkills().length} enabled skills`);
  }

  // ── Attestation Identity ──
  // Per-install Ed25519 keypair persisted in `kernel_identity` (singleton).
  // Receipts on every tool call are signed with this. Disable with
  // KERNEL_ATTEST=0.
  const { loadOrCreateIdentity } = await import("../attestation.js");
  const attestIdentity = process.env.KERNEL_ATTEST === "0"
    ? undefined
    : (() => {
        try {
          const id = loadOrCreateIdentity(sqlite);
          log.info(`Attestation enabled. server_id=${id.serverId()}`);
          return id;
        } catch (e) {
          log.warn(`Failed to load attestation identity: ${(e as Error).message} — running without receipts`);
          return undefined;
        }
      })();
  metaIdentitySlot.value = () => attestIdentity;

  // ── Cost Router ──
  // Per-install rolling p50 cost stats per tool. Drives:
  //   * pre-flight budget rejection on tools/call (-32004)
  //   * post-flight `_meta.cost.actual` for client telemetry
  //   * `kernel_meta_cost_report` for "what's eating my budget"
  const { CostRouter } = await import("../llm/cost-router.js");
  const costRouter = new CostRouter(sqlite);
  metaCostRouterSlot.value = () => costRouter;

  // ── Marketplace (needs skillRegistry + agentService) ──
  const marketplaceModule = createMarketplaceModule(
    skillRegistry,
    agentsModule.getService() as Parameters<typeof createMarketplaceModule>[1],
  ) as MarketplaceModule;
  await marketplaceModule.initialize(ctx);
  registry.registerPostInit(marketplaceModule);

  return {
    attestIdentity,
    costRouter,
    skillRegistry,
    marketplaceModule,
  };
}
