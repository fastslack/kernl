/**
 * Bootstrap orchestrator.
 *
 * Runs every stage in dependency order. Each stage receives only the slice of
 * state it needs (the previous stages' outputs) and returns its own outputs;
 * this file is the canonical view of how all those slices fit together.
 *
 * Stage order:
 *   loadConfig + log level
 *   initDatabases    → sqlite, neo4j, events (+ security gates)
 *   initRegistries   → registries + ctx
 *   initCoreModules  → in-tree modules registered + initialized
 *   initDrivers      → sandbox/llm/db drivers seeded+started, identity, cost
 *                      router, skill registry, marketplace module
 *   loadExtensions   → seedBuiltin/legacy + loadActiveExtensions + handles
 *   wireMesh         → mesh-dashboard binding + EventBus bridge
 *   wireServices     → channels seed, event listeners, kernel-wide tool
 *                      catalog injection into chat+agents, seeders,
 *                      embeddings, cinema, builtin handlers, sandbox-agents
 *   initBridgesAndStdio → global LLM client, bridges, MCP stdio
 *   initHttpAndMcp   → HTTP server + every dashboard/admin route
 *   initMtw          → mtwRequest publisher + RPC + ARCH beams
 *   wireServicesLate → voice, rate limiter, orchestrator, channel startAll
 *   installShutdownHandlers → SIGINT/SIGTERM cleanup
 *
 * Anything that needs to see a value mutated by a later stage uses a
 * ref-object (e.g. `metaCatalogSlot.value`, `publisherRef.current`) instead
 * of capturing it by value.
 */

import { loadConfig } from "../config.js";
import { setLogLevel, log } from "../logger.js";
import { initDatabases } from "./databases.js";
import { initRegistries } from "./registries.js";
import { initCoreModules } from "./core-modules.js";
import { initDrivers } from "./drivers.js";
import { loadExtensions } from "./extensions.js";
import { wireMesh } from "./mesh-wiring.js";
import { wireServices } from "./services.js";
import { initBridgesAndStdio } from "./bridges.js";
import { initHttpAndMcp } from "./http.js";
import { initMtw } from "./mtw.js";
import { wireServicesLate } from "./services-late.js";
import { installShutdownHandlers } from "./shutdown.js";
import type { MeshModule } from "../types/extensions/index.js";

export async function bootstrap(): Promise<void> {
  // ── Config + log level ─────────────────────────────
  const config = loadConfig();
  setLogLevel(config.logLevel as "debug" | "info" | "warn" | "error");

  const transport = config.mcp.transport;
  const useStdio = transport === "stdio" || transport === "both";
  const useHttp = transport === "http" || transport === "both";

  // ── 1. Databases + security gates ─────────────────
  const { sqlite, neo4j, events } = await initDatabases(config);

  // ── 2. Registries + ctx ───────────────────────────
  const registries = initRegistries({ config, sqlite, neo4j, events });
  const {
    notificationRegistry, notifier,
    sandboxRegistry, llmRegistry, dbRegistry,
    registry, dashboardRegistry, ctx, license,
  } = registries;

  // ── 3. Core in-tree modules ───────────────────────
  // mesh is loaded as an extension later; the MCP plans dispatcher closure
  // resolves it via this late-bound accessor, so the slot is mutated when
  // the extensions stage finishes.
  const meshSlot: { value: MeshModule | null } = { value: null };
  const core = await initCoreModules({
    registry,
    ctx,
    getMesh: () => meshSlot.value,
  });

  // ── 4. Drivers + skill registry + identity + cost router + marketplace ──
  const drivers = await initDrivers({
    sqlite,
    events,
    ctx,
    registry,
    sandboxRegistry, llmRegistry, dbRegistry,
    agentsModule: core.agentsModule as Parameters<typeof initDrivers>[0]["agentsModule"],
    skillTools: null,
    metaIdentitySlot: core.metaIdentitySlot,
    metaCostRouterSlot: core.metaCostRouterSlot,
  });

  // ── 5. Extensions (legacy import, seed builtin, load active) ──
  const ext = await loadExtensions({
    sqlite, ctx, registry,
    extensionsModule: core.extensionsModule,
    sandboxRegistry,
    llmRegistry,
    skillRegistry: drivers.skillRegistry,
    marketplaceModule: drivers.marketplaceModule,
    identity: drivers.attestIdentity,
  });
  // Late-bind mesh module so the MCP plans dispatcher closure sees it.
  meshSlot.value = ext.meshModule;

  // ── 6. Mesh-dashboard wiring (after identity is loaded) ──
  wireMesh({
    registry, events,
    meshModule: ext.meshModule,
    attestIdentity: drivers.attestIdentity,
  });

  // ── 7. Post-extension service wiring (the big one) ──
  const services = await wireServices({
    config, sqlite, events, notifier,
    registry, dbRegistry, llmRegistry,
    ext,
    extensionsModule: core.extensionsModule,
    license,
    chatModule: core.chatModule as Parameters<typeof wireServices>[0]["chatModule"],
    agentsModule: core.agentsModule as Parameters<typeof wireServices>[0]["agentsModule"],
    skillTools: drivers.skillRegistry.getTools(),
    metaCatalogSlot: core.metaCatalogSlot,
    embeddingsResolver: core.embeddingsResolver,
    registryAllTools: () => registry.getAllTools(),
  });

  // ── 8. Global LLM client + bridges + MCP stdio ─────
  const bridges = await initBridgesAndStdio({
    config, events, registry,
    chatModule: core.chatModule,
    torrentsModule: ext.torrentsModule,
    finalTools: services.finalTools,
    useStdio,
    attestIdentity: drivers.attestIdentity,
    costRouter: drivers.costRouter,
    toolMemoryModule: core.toolMemoryModule,
    meshModule: ext.meshModule,
    skillRegistry: drivers.skillRegistry,
  });

  log.info(`Kernel ready — ${services.finalTools.length} tools registered (transport: ${transport})`);

  // ── 9. HTTP server + every route ───────────────────
  const http = await initHttpAndMcp({
    config, sqlite, neo4j, events, notifier,
    registry, dashboardRegistry,
    notificationRegistry, sandboxRegistry, llmRegistry, dbRegistry,
    extensionsModule: core.extensionsModule,
    ext,
    useHttp,
    attestIdentity: drivers.attestIdentity,
    costRouter: drivers.costRouter,
    toolMemoryModule: core.toolMemoryModule,
    skillRegistry: drivers.skillRegistry,
    chatModule: core.chatModule,
    agentsModule: core.agentsModule as Parameters<typeof initHttpAndMcp>[0]["agentsModule"],
    rustBridge: bridges.rustBridge,
    rustDelegates: bridges.rustDelegates,
    license,
  });

  // ── 10. mtwRequest publisher + RPC + ARCH beams ────
  const mtw = await initMtw({
    config, sqlite, neo4j, events, notifier,
    registry, dashboardRegistry, dbRegistry,
    notificationRegistry,
    ext,
    llmClient: bridges.llmClient,
    llmRegistry,
    rustDelegates: bridges.rustDelegates,
    rustBridge: bridges.rustBridge,
    skillRegistry: drivers.skillRegistry,
    chatModule: core.chatModule,
    agentsModule: core.agentsModule,
    httpServer: http.httpServer,
    mtwRequestArch: http.mtwRequestArch,
    publisherRef: http.publisherRef,
    lifeService: http.lifeService,
  });

  // ── 11. Late services (voice, rate limit, orchestrator, channels) ──
  await wireServicesLate({
    config, sqlite, neo4j, events, notifier,
    registry, notificationRegistry, dbRegistry,
    pairingManager: http.pairingManager,
    rustDelegates: bridges.rustDelegates,
    chatService: core.chatModule.getService(),
    agentService: core.agentsModule.getService(),
    agentExecutor: core.agentsModule.getExecutor(),
  });

  // ── 12. Graceful shutdown ──────────────────────────
  installShutdownHandlers({
    sqlite, neo4j,
    registry,
    notificationRegistry, sandboxRegistry, llmRegistry, dbRegistry,
    skillRegistry: drivers.skillRegistry,
    bridgeServer: bridges.bridgeServer,
    rustBridge: bridges.rustBridge,
    mtwPublisher: mtw.mtwPublisher,
    mtwConn: mtw.mtwConn,
    cameraStreamHub: http.cameraStreamHub,
    mcpRouter: http.mcpRouter,
    mcpUnixSocket: http.mcpUnixSocket,
    httpServer: http.httpServer,
  });
}
