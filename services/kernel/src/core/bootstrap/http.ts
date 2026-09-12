/**
 * Stage: build the kernel HTTP server and register every route surface.
 *
 *  - Runs notification-table migrations (`notificationMigrations`).
 *  - Resolves the late-bound life + news extension handles.
 *  - Builds a `PairingManager` BEFORE the HTTP server so admin endpoints
 *    AND `wireMessageRouting` (in services-late.ts) share the same instance.
 *  - Constructs `KernelHttpServer` when `config.dashboard.enabled || useHttp`.
 *  - Registers the dashboard / notification-admin / sandbox-driver /
 *    llm-provider / db-driver / pairing-admin / skills / agents / AI-config
 *    routes. Most extension routes register themselves via the
 *    DashboardDescriptor returned from each module.
 *  - Builds the `MtwRequestArchInfo` snapshot that ARCH 3D reads, then
 *    registers the architecture routes.
 *  - Starts the server. After bind, starts mDNS (gated by KERNEL_MDNS=1),
 *    attaches the camera stream WebSocket hub, registers pre-start hooks
 *    that need the live `nodeServer` (dashboard + webchat providers).
 *  - Starts the McpHttpRouter (`/mcp`) when useHttp is true.
 */

import { log } from "../logger.js";
import type { KernelConfig } from "../config.js";
import type { SqliteDb } from "../db/sqlite.js";
import type { Neo4jClient } from "../db/neo4j.js";
import type { EventBus } from "../event-bus.js";
import type { Notifier } from "../notify/notifier.js";
import type { ModuleRegistry } from "../module-registry.js";
import type { DashboardRegistry } from "../dashboard-registry.js";
import type { NotificationRegistry } from "../notify/registry.js";
import type { SandboxDriverRegistry } from "../sandbox/registry.js";
import type { LlmProviderRegistry } from "../llm/provider-registry.js";
import type { DbDriverRegistry } from "../db-drivers/db-driver-registry.js";
import type { Identity } from "../attestation.js";
import type { CostRouter } from "../llm/cost-router.js";
import type { ToolMemoryModule } from "../../modules/tool-memory/index.js";
import type { RustBridge } from "../rust/bridge.js";
import type { createRustDelegates } from "../rust/delegates.js";
import type { ExtensionsModuleHandle } from "../../modules/extensions/index.js";
import type { ExtensionHandles } from "./extensions.js";
import type { CameraStreamHub } from "./types.js";

import { KernelHttpServer } from "../http-server.js";
import { McpHttpRouter } from "../../server.js";
import {
  startMcpUnixSocketServer,
  resolveDefaultSocketPath,
  type McpUnixSocketHandle,
} from "../mcp-unix-socket.js";
import { registerDashboardRoutes } from "../../modules/dashboard/api-routes.js";
import {
  registerArchitectureRoutes,
  type MtwRequestArchInfo,
} from "../../modules/dashboard/architecture-routes.js";
import { registerSkillRoutes } from "../../modules/skills/api-routes.js";
import { registerAgentRoutes } from "../../modules/agents/api-routes.js";
import { registerSandboxDriverRoutes } from "../sandbox/routes.js";
import { registerLlmProviderRoutes, registerClaudeCodeAuthRoutes } from "../llm/provider-routes.js";
import { registerDbDriverRoutes } from "../db-drivers/api-routes.js";
import { registerAiConfigRoutes } from "../../modules/config/ai-routes.js";
import { registerSettingsRoutes } from "../../modules/config/settings-routes.js";
import { runMigrations } from "../db/migrations.js";
import { notificationMigrations } from "../../modules/dashboard/notification-migrations.js";
import { PairingManager } from "../../security/index.js";
import { RustFormulaRegistry } from "../rust/formula-adapter.js";
import type { DashboardProviderLike, WebChatProviderLike, IrcProviderLike } from "../extension-seams.js";
import type { LifeModule, NewsModule, LifeService, NewsService } from "../types/extensions/index.js";
import type { LicenseService } from "../license/index.js";
import { registerLicenseRoutes } from "../license/routes.js";
import { checkForUpdate } from "../update/check.js";
import { applyUpdate, updateProgress } from "../update/apply.js";

export interface HttpResult {
  httpServer: KernelHttpServer | null;
  mcpRouter: McpHttpRouter | null;
  mcpUnixSocket: McpUnixSocketHandle | null;
  cameraStreamHub: CameraStreamHub;
  mtwRequestArch: MtwRequestArchInfo | null;
  pairingManager: PairingManager;
  lifeService: LifeService | null;
  newsService: NewsService | null;
  // Captured so the publisher in mtw.ts can call `mtwPublisher.publishEvent`
  // from inside provider hooks. The publisher is created later, so we close
  // over a ref-object that `mtw.ts` mutates.
  publisherRef: { current: { publishEvent: (ch: string, evt: string, data: Record<string, unknown>) => void } | null };
}

export async function initHttpAndMcp(args: {
  config: KernelConfig;
  sqlite: SqliteDb;
  neo4j: Neo4jClient;
  events: EventBus;
  notifier: Notifier;
  registry: ModuleRegistry;
  dashboardRegistry: DashboardRegistry;
  notificationRegistry: NotificationRegistry;
  sandboxRegistry: SandboxDriverRegistry;
  llmRegistry: LlmProviderRegistry;
  dbRegistry: DbDriverRegistry;
  extensionsModule: ExtensionsModuleHandle;
  ext: ExtensionHandles;
  useHttp: boolean;
  attestIdentity: Identity | undefined;
  costRouter: CostRouter;
  toolMemoryModule: ToolMemoryModule;
  skillRegistry: Parameters<typeof registerSkillRoutes>[1];
  chatModule: { getService(): unknown };
  agentsModule: {
    getExecutor(): Parameters<typeof registerAgentRoutes>[2] | null;
    getService(): Parameters<typeof registerAgentRoutes>[1] | null;
    getWorkspaceService(): unknown;
    getReflectionOptimizer(): unknown;
    getWorkspaceEvolver(): unknown;
  };
  rustBridge: RustBridge | null;
  rustDelegates: ReturnType<typeof createRustDelegates> | null;
  license: LicenseService;
}): Promise<HttpResult> {
  const {
    config, sqlite, neo4j, events, notifier,
    registry, dashboardRegistry, notificationRegistry,
    sandboxRegistry, llmRegistry, dbRegistry,
    extensionsModule, ext,
    useHttp,
    attestIdentity, costRouter, toolMemoryModule, skillRegistry,
    chatModule, agentsModule,
    rustBridge, rustDelegates,
    license,
  } = args;

  // ── Dashboard Notifications migrations ──────────────
  runMigrations(sqlite, "notifications", notificationMigrations);

  // ── Life + News (resolved post-extensions) ──────────
  const lifeModule = (registry.getModule("ext:life") ?? null) as LifeModule | null;
  const newsModule = (registry.getModule("ext:news") ?? null) as NewsModule | null;
  const lifeService = lifeModule?.getService() ?? null;
  const newsService = newsModule?.getService() ?? null;

  // ── HTTP Server (dashboard + MCP Streamable HTTP) ──
  let httpServer: KernelHttpServer | null = null;
  let mcpRouter: McpHttpRouter | null = null;
  let mcpUnixSocket: McpUnixSocketHandle | null = null;
  let cameraStreamHub: CameraStreamHub = null;
  let mtwRequestArch: MtwRequestArchInfo | null = null;

  const publisherRef: HttpResult["publisherRef"] = { current: null };

  // Pairing manager — created here (before HTTP routes) so admin endpoints
  // AND `wireMessageRouting` share the same instance.
  const pairingManager = new PairingManager({
    pairingCodeExpiration: 5,
    trustedUsers: new Map([
      ["telegram", config.telegram.allowedUserIds.map(String)],
    ]),
  });

  if (config.dashboard.enabled || useHttp) {
    httpServer = new KernelHttpServer({ config });

    // API routes — always registered when HTTP server is running.
    {
      registerDashboardRoutes(
        httpServer,
        sqlite,
        (name) => dashboardRegistry.queryChannel(name, sqlite, neo4j),
        () => dbRegistry.getGraph(),
        lifeService,
        (await import("../system-registry.js")).systemRegistry,
        config,
        notifier,
        events,
      );

      // Provider-specific admin endpoints (QR pairing, logout, status).
      const { registerNotificationAdminRoutes } = await import("../notify/admin-routes.js");
      registerNotificationAdminRoutes(httpServer, notificationRegistry);

      // Sandbox driver admin endpoints (status/config/start/stop).
      registerSandboxDriverRoutes(httpServer, sandboxRegistry);

      // LLM provider admin endpoints + per-(slug,model) blocklist that
      // the chain probe auto-populates when a specific model is broken
      // (timeout / 404) so the dropdown at /models stops offering it.
      const { ModelBlocklist } = await import("../llm/model-blocklist.js");
      const modelBlocklist = new ModelBlocklist(sqlite);
      // After a provider's settings_json is saved via PUT /api/llm-providers/:slug/config,
      // mirror it into config.webIntel.* + .env and hot-reload the chat adapter /
      // llm() singleton so chat/agents/web-intel pick up the change without a restart.
      const { syncProvidersToKernelConfig, providerEnvUpdates } = await import("../llm/sync-config.js");
      const { writeEnvFile } = await import("../../modules/config/ai-routes.js");
      const { reloadLlmClient } = await import("../llm/client.js");
      const { resolve: resolvePath } = await import("node:path");
      // ── Rehydrate stored settings into process.env ────────────────
      //
      // ConfigService.set() writes app_settings + process.env + .env, but
      // NOTHING read app_settings back at boot. When the .env write fails —
      // which it does in a container whose working dir isn't writable, and the
      // API answers `envPersisted: false` — a setting worked until the next
      // restart and then silently reverted to the default.
      //
      // That is how a configured LLM chain (AGENTS_DEFAULT_MODEL_CHAIN) kept
      // vanishing: saved, live, gone after a restart, so every LLM call fell
      // back to the legacy single provider. Real environment variables still
      // win — we only fill in what the environment didn't already define.
      try {
        const stored = sqlite
          .prepare("SELECT key, value FROM app_settings WHERE value <> ''")
          .all() as Array<{ key: string; value: string }>;
        let restored = 0;
        for (const { key, value } of stored) {
          if (process.env[key] === undefined || process.env[key] === "") {
            process.env[key] = value;
            restored++;
          }
        }
        if (restored > 0) log.info(`Config: restored ${restored} stored setting(s) into the environment`);
      } catch (err) {
        log.warn("Config: could not rehydrate stored settings", err);
      }

      // Same trap, second setting: the language. `parseLanguage` ran against
      // an environment that did not yet contain KERNEL_DEFAULT_LANGUAGE, so a
      // language chosen through POST /api/config/language was live until the
      // process died and then came back English — stored in app_settings the
      // whole time, just never read back into `config`. Every agent prompt,
      // notification and meeting turn follows `config.language`, so the whole
      // fleet quietly answered in English on an instance set to Spanish.
      const restoredLanguage = process.env.KERNEL_DEFAULT_LANGUAGE;
      if (
        (restoredLanguage === "es" || restoredLanguage === "en") &&
        config.language !== restoredLanguage
      ) {
        config.language = restoredLanguage;
        log.info(`Language restored from settings: ${restoredLanguage}`);
      }

      // The config object was built from the environment BEFORE the block
      // above ran, so re-derive the chain and rebuild the singleton.
      try {
        const raw = process.env.AGENTS_DEFAULT_MODEL_CHAIN;
        if (raw && config.agents && (config.agents.defaultModelChain?.length ?? 0) === 0) {
          const parsed = JSON.parse(raw) as Array<{ provider?: string; model?: string }>;
          if (Array.isArray(parsed)) {
            config.agents.defaultModelChain = parsed
              .filter((e) => e && typeof e === "object")
              .map((e) => ({ provider: String(e.provider ?? ""), model: String(e.model ?? "") }))
              .filter((e) => e.provider || e.model);
            if (config.agents.defaultModelChain.length > 0) {
              reloadLlmClient(config);
              log.info(
                `LLM chain restored from settings: ${config.agents.defaultModelChain
                  .map((e) => `${e.provider}/${e.model}`)
                  .join(" → ")}`,
              );
            }
          }
        }
      } catch (err) {
        log.warn("Config: could not restore the LLM chain from settings", err);
      }

      const llmEnvPath = resolvePath(process.cwd(), ".env");
      registerClaudeCodeAuthRoutes(httpServer, llmRegistry);
      registerLlmProviderRoutes(httpServer, llmRegistry, modelBlocklist, (slug) => {
        syncProvidersToKernelConfig(config, llmRegistry);
        const envUpdates = providerEnvUpdates(slug, llmRegistry.loadConfig(slug));
        if (Object.keys(envUpdates).length > 0) {
          try { writeEnvFile(llmEnvPath, envUpdates); } catch (err) { log.warn("env persist failed", err); }
          if (events) for (const [k, v] of Object.entries(envUpdates)) events.emit("config:changed", { key: k, value: v, updatedBy: "http" });
        }
        try { (chatModule.getService() as { reloadProviders?: () => void } | null)?.reloadProviders?.(); } catch { /* */ }
        reloadLlmClient(config);
        markLlmReadinessStale(`provider "${slug}" was reconfigured`);
      });

      // Mirror the stored provider settings into KernelConfig once at boot.
      // This only ran from the save callback, so anything living solely in the
      // registry — the Claude Code token, and the model picked for it — was
      // absent on every fresh start until someone happened to press Save.
      try {
        syncProvidersToKernelConfig(config, llmRegistry);
        // The chat service and the llm() singleton read this config in their
        // constructors, which already ran — so mirroring alone changes nothing
        // until they are rebuilt. Same two calls the save path makes.
        try { (chatModule.getService() as { reloadProviders?: () => void } | null)?.reloadProviders?.(); } catch { /* chat may be disabled */ }
        reloadLlmClient(config);
      } catch (err) {
        log.warn("Provider settings could not be mirrored into config at boot", err);
      }

      // ── Can an agent actually run? ────────────────────────────────
      //
      // `isReady()` on a provider only means "installed": the claude-code CLI
      // ships inside the Agent SDK, so it reports ready on a machine with no
      // account, and it cannot carry a tool loop at all. The gate below refuses
      // the API until some provider proves it can take a tool call, and the
      // probe rebuilds its providers from `config` on every run so a key saved
      // a second ago is the one being tested.
      const { initLlmReadiness, ensureLlmReadiness, markLlmReadinessStale } =
        await import("../llm/readiness.js");
      const { createLlmReadinessGate } = await import("../llm/readiness-gate.js");
      const { createChatProviders } = await import("../llm/chat-adapters.js");
      initLlmReadiness(() =>
        createChatProviders({
          anthropicApiKey: config.webIntel.anthropicApiKey,
          openaiApiKey: config.webIntel.openaiApiKey,
          lmstudioBaseUrl: config.webIntel.lmstudioBaseUrl,
          grokApiKey: config.webIntel.grokApiKey,
          grokDefaultModel: config.webIntel.grokDefaultModel,
          nvidiaApiKey: config.webIntel.nvidiaApiKey,
          nvidiaDefaultModel: config.webIntel.nvidiaDefaultModel,
          claudeCode: config.claudeCode,
        }),
      );
      httpServer.addPrecondition(createLlmReadinessGate());
      // Fill the cache in the background: boot must not wait on a provider,
      // and the gate refuses by default until the answer arrives.
      void ensureLlmReadiness().then((r) => {
        if (r.ok) log.info(`LLM readiness: ${r.provider} can run agent tools`);
        else log.warn(`LLM readiness: blocked (${r.reason}) — ${r.detail ?? ""}`);
      });
      // Persist health tracker to sqlite so a kernel restart doesn't
      // re-discover quota/auth/timeout failures from scratch — the next
      // call picks up where we left off (e.g. grok still blocked from
      // last night's exhausted credit).
      const { attachDb: attachLlmHealthDb } = await import("../llm/provider-health.js");
      attachLlmHealthDb(sqlite);
      // Audit log of EVERY chatOnce — slug, model, latency, tokens,
      // error class, caller. Bounded by row count + emits kernel log.
      const { attachDb: attachLlmCallLogDb } = await import("../llm/call-log.js");
      attachLlmCallLogDb(sqlite);

      // DB driver admin endpoints — the /activate endpoint is what users hit
      // from /extensions to switch graph backends.
      registerDbDriverRoutes(httpServer, dbRegistry);

      // License management (Pro tier) — GET status / POST set / POST clear.
      registerLicenseRoutes(httpServer, license);

      // User-to-bot pairing approval (whatsapp/telegram/slack first-contact).
      const { registerPairingAdminRoutes } = await import("../pairing-admin-routes.js");
      registerPairingAdminRoutes(httpServer, pairingManager);

      // Peering: this instance's signed identity, its friends, and the
      // transports that reach them. The layer is kernel-wide; cinema's
      // friends-only directories are simply its first consumer.
      try {
        const { PeeringService } = await import("../peering/service.js");
        const { registerPeeringRoutes } = await import("../peering/routes.js");
        const { NostrRelayPool } = await import("../nostr/nostr-relay-pool.js");
        const peering = PeeringService.create({
          sqlite,
          encryptionKey: config.encryption.key,
          version: process.env.KERNEL_VERSION ?? "0",
          port: config.dashboard.port,
          // Presence goes to public relays: a few hundred bytes every few
          // hours, which is what lets a friend find us after we move.
          pool: process.env.KERNEL_PEERING_ANNOUNCE === "0" ? undefined : new NostrRelayPool(),
        });
        if (peering) {
          void peering.start();
          registerPeeringRoutes(httpServer, {
            friends: peering.friends,
            resolver: peering.resolver,
            client: peering.client,
            currentDescriptor: () => peering.currentDescriptor(),
            selfNpub: () => peering.selfNpub(),
          });
        }
      } catch (err) {
        log.warn("peering: failed to initialise — instance sharing disabled", err);
      }

      // Auto-register routes from self-registering modules.
      dashboardRegistry.registerAllRoutes(httpServer, sqlite, neo4j);
      // Manifest endpoint for frontend dynamic configuration. Passes the
      // extensions service so nav items/groups declared in manifests of
      // active extensions get merged in on every request.
      httpServer.get("/api/manifest", (_req, res) => {
        httpServer!.json(res, 200, dashboardRegistry.getManifest(extensionsModule.service));
      });

      // Is a newer Kernl published? Read-only: it never downloads or applies
      // anything, because migrations run at boot and only go forward, so an
      // update has to be a moment the user chose. `?fresh=1` skips the 6h
      // cache for an explicit "check now".
      // The button. Downloads, stages, and hands off to a helper that swaps
      // the bundle once this process is gone — so a 202 here means "we are
      // about to exit", not "done". Only ever reached because someone clicked.
      httpServer.post("/api/update/apply", async (_req, res) => {
        const outcome = await applyUpdate();
        if (!outcome.ok) {
          httpServer!.json(res, 400, outcome);
          return;
        }
        httpServer!.json(res, 202, outcome);
        // Give the response time to reach the browser before the helper's
        // wait-for-exit loop gets what it is waiting for.
        setTimeout(() => process.exit(0), 750);
      });

      // Polled while the POST above is still in flight. Separate on purpose:
      // applying ends with this process exiting, so the request that started
      // it cannot also report how it went — and a multi-megabyte download with
      // no progress reads as a hung button.
      httpServer.get("/api/update/progress", (_req, res) => {
        httpServer!.json(res, 200, updateProgress());
      });

      httpServer.get("/api/update/status", async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        httpServer!.json(res, 200, await checkForUpdate({
          fresh: url.searchParams.get("fresh") === "1",
        }));
      });

      // Architecture endpoints (topology + metrics)
      // mtwRequestArch is populated later when the RPC handler initializes.
      mtwRequestArch = {
        connected: false,
        rpcActionCount: 0,
        rustDelegates: rustDelegates
          ? ["trading.compute_formulas", "trading.monitor.add_position", "trading.monitor.check", "trading.monitor.check_all", "trading.monitor.remove", "trading.calculate_pnl", "security.rate_limit.consume", "security.rate_limit.check"]
          : [],
        bridgeEnabled: config.bridge.enabled,
        rustBridgeEnabled: config.rustBridge.enabled,
        rpcModules: [],
      };
      registerArchitectureRoutes(httpServer, {
        registry, events,
        getGraph: () => dbRegistry.getGraph(),
        sqlite,
        systemRegistry: (await import("../system-registry.js")).systemRegistry,
        mtwRequest: mtwRequestArch,
      });
    }

    // Skills API
    registerSkillRoutes(httpServer, skillRegistry);

    // Agents API (composer)
    const agentService = agentsModule.getService();
    const agentExecutor = agentsModule.getExecutor();
    if (agentService && agentExecutor) {
      registerAgentRoutes(
        httpServer,
        agentService,
        agentExecutor,
        events,
        agentsModule.getWorkspaceService() as Parameters<typeof registerAgentRoutes>[4],
        agentsModule.getReflectionOptimizer() as Parameters<typeof registerAgentRoutes>[5],
        agentsModule.getWorkspaceEvolver() as Parameters<typeof registerAgentRoutes>[6],
        config.language,
        // Skill candidates from subscribed catalogue repos, for the per-agent
        // suggestions route. The marketplace module exposes getService(), not
        // browseCatalog() directly, hence the double hop. Absent module → []
        // → the suggestions route degrades to installed skills only.
        async () => {
          const mp = registry.getModule("marketplace") as {
            getService?: () => {
              browseCatalog(f: { type?: string; limit?: number }): Promise<
                Array<{ slug: string; manifest?: { name?: string; description?: string; long_description?: string } }>
              >;
            } | null;
          } | null;
          const svc = mp?.getService?.() ?? null;
          if (!svc) return [];
          const items = await svc.browseCatalog({ type: "skill", limit: 500 });
          return items.map((i) => ({
            slug: i.slug,
            name: i.manifest?.name ?? i.slug,
            text: `${i.slug} ${i.manifest?.name ?? ""} ${i.manifest?.description ?? ""} ${i.manifest?.long_description ?? ""}`,
          }));
        },
      );
    }

    // Replace local formula computation with Rust if available.
    const tradingService = ext.tradingModule?.getService() ?? null;
    if (rustBridge && tradingService) {
      const rustFormulas = new RustFormulaRegistry(rustBridge);
      // Store Rust formula registry — feeder checks for this and uses async path.
      (tradingService as { _rustFormulas?: RustFormulaRegistry })._rustFormulas = rustFormulas;
      log.info("Trading formulas delegated to Rust");
    }

    // AI Providers config (pass live service references for hot-reload).
    // llmRegistry is forwarded so /api/config/ai/test can delegate to
    // testAllProviders() instead of duplicating per-provider fetch blocks.
    // ConfigService is the settings store the AI-config routes persist through
    // (app_settings + .env + process.env mirror), resolved from the registry.
    const configService =
      (registry.getModule("config") as { getService(): Parameters<typeof registerAiConfigRoutes>[7] | null } | undefined)
        ?.getService?.() ?? undefined;
    registerAiConfigRoutes(
      httpServer,
      config,
      (chatModule.getService() ?? undefined) as Parameters<typeof registerAiConfigRoutes>[2],
      (agentExecutor ?? undefined) as Parameters<typeof registerAiConfigRoutes>[3],
      events,
      sqlite,
      llmRegistry,
      configService ?? undefined,
    );

    // Generic settings catalog (core + extension-contributed) — the dashboard
    // Settings UI renders itself from GET /api/settings/catalog.
    registerSettingsRoutes(httpServer, {
      sqlite,
      config,
      events,
      extensionService: extensionsModule.service,
    });

    // Federation periodic sync (kernel-side concern, not a route).
    const fedSync = ext.federationModule?.getSyncEngine() ?? null;
    if (fedSync) {
      const fedInterval = setInterval(async () => {
        try {
          await fedSync.syncAll();
        } catch (err) {
          log.error("Federation: periodic sync error", err);
        }
      }, 5 * 60 * 1000);
      fedInterval.unref();
    }

    if (useHttp) {
      const mcpOpts = {
        skillRegistry,
        identity: attestIdentity,
        costRouter,
        toolMemory: toolMemoryModule.getService() ?? undefined,
        mesh: ext.meshModule?.getService() ?? undefined,
      };
      mcpRouter = new McpHttpRouter(registry, events, mcpOpts, config.auth.token);
      httpServer.all("/mcp", (req, res) => mcpRouter!.handleRequest(req, res));
      log.info(`MCP Streamable HTTP endpoint: http://localhost:${config.dashboard.port}/mcp`);

      // Mirror the MCP server on a Unix-domain socket so subprocess agents
      // (Claude Code SDK + bwrap --unshare-net) can talk to the kernel
      // through a path that survives the sandbox's network isolation.
      // Disabled via KERNEL_MCP_UNIX_SOCKET=0.
      if (process.env.KERNEL_MCP_UNIX_SOCKET !== "0") {
        try {
          const socketPath = resolveDefaultSocketPath();
          mcpUnixSocket = await startMcpUnixSocketServer(registry, events, mcpOpts, socketPath);
        } catch (err) {
          log.error(`Failed to start MCP Unix socket: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    const started = await httpServer.start();

    // Bring up mDNS auto-discovery once the HTTP port is bound and the
    // attestation identity is known. Gated by KERNEL_MDNS=1 internally.
    if (started && attestIdentity) {
      ext.meshModule?.startMdns({
        port: config.dashboard.port,
        identity: attestIdentity,
      });
    }

    if (started && httpServer.nodeServer) {
      // Camera stream WebSocket hub — cameras is a PAID module (provided
      // separately); when installed it attaches to the same HTTP server
      // via its own hook so the hub's lifecycle stays inside the module.
      // Without it this is a no-op (null handle).
      cameraStreamHub = ext.camerasModule?.attachStreamHub(httpServer.nodeServer) ?? null;

      // Pre-start hooks for providers that need dependency injection.
      // These run BEFORE provider.start() when startAll() instantiates from factories.
      notificationRegistry.registerPreStartHook("dashboard-notifications", (provider) => {
        (provider as unknown as DashboardProviderLike).setDashboard(sqlite, (n) => {
          if (publisherRef.current) {
            publisherRef.current.publishEvent("notifications", "notification", { data: n });
          }
        });
      });
      if (httpServer.nodeServer) {
        notificationRegistry.registerPreStartHook("webchat", (provider) => {
          (provider as unknown as WebChatProviderLike).setHttpServer(httpServer!.nodeServer!);
        });
        // IRC mounts its IRC-over-WebSocket gateway (/ws/irc) on the shared
        // HTTP server, in addition to its own TLS port.
        notificationRegistry.registerPreStartHook("irc", (provider) => {
          (provider as unknown as IrcProviderLike).setHttpServer(httpServer!.nodeServer!);
        });
      }
    }
  }

  return {
    httpServer,
    mcpRouter,
    mcpUnixSocket,
    cameraStreamHub,
    mtwRequestArch,
    pairingManager,
    lifeService,
    newsService,
    publisherRef,
  };
}
