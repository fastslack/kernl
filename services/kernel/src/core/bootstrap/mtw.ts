/**
 * Stage: mtwRequest publisher + RPC handler + ARCH 3D beam wiring.
 *
 * Only runs when `config.bridge.enabled === true`.
 *
 *  - Opens a shared MtwConnection (used by both publisher and RPC).
 *  - Hands the connection to the WhatsApp provider so already-registered
 *    provider instances can subscribe to `whatsapp:*` channels.
 *  - Builds `publisherQueryChannel` — the function the publisher calls when
 *    a subscriber requests a snapshot. Handles extension channels via the
 *    `dashboardRegistry` AND core channels via the legacy `queryXxx` helpers.
 *  - Starts the `MtwPublisher`.
 *  - Builds the `MtwRpcHandler` and registers:
 *      * The hand-wired cross-cutting dashboard handlers
 *        (`dashboard.full`, `dashboard.kpis`, `dashboard.agenda`, etc.)
 *      * Each module's slice via `KernelModule.getDashboardRpcActions(deps)`
 *      * Each module's `getRpcActions()` (replaces the old hand-wired imports)
 *      * RSS registry RPC (extension owned)
 *      * Trading + PineScript RPC (extension owned)
 *      * Agents RPC
 *      * `llm.chat` — all LLM calls route through mtwRequest
 *  - Updates the architecture info snapshot so ARCH 3D shows live RPC stats.
 *  - Forwards a curated set of EventBus events as ARCH beams (`archEvent`)
 *    AND raw `agentFlow` events for the AgentWorld3D visor.
 */

import { log } from "../logger.js";
import type { KernelConfig } from "../config.js";
import type { SqliteDb } from "../db/sqlite.js";
import type { Neo4jClient } from "../db/neo4j.js";
import type { EventBus } from "../event-bus.js";
import type { Notifier } from "../notify/notifier.js";
import type { ModuleRegistry } from "../module-registry.js";
import type { DashboardRegistry } from "../dashboard-registry.js";
import type { DbDriverRegistry } from "../db-drivers/db-driver-registry.js";
import type { NotificationRegistry } from "../notify/registry.js";
import type { MtwConnAwareProvider } from "../extension-seams.js";
import type { LlmClient } from "../llm/client.js";
import type { RustBridge } from "../rust/bridge.js";
import type { createRustDelegates } from "../rust/delegates.js";
import { MtwPublisher } from "../mtw/publisher.js";
import type { KernelHttpServer } from "../http-server.js";
import type { MtwRequestArchInfo } from "../../modules/dashboard/architecture-routes.js";
import type { ExtensionHandles } from "./extensions.js";
import type { LifeService } from "../types/extensions/index.js";

export interface MtwResult {
  mtwPublisher: MtwPublisher | null;
  mtwConn: import("@matware/mtw-request-ts-client").MtwConnection | null;
}

export async function initMtw(args: {
  config: KernelConfig;
  sqlite: SqliteDb;
  neo4j: Neo4jClient;
  events: EventBus;
  notifier: Notifier;
  registry: ModuleRegistry;
  dashboardRegistry: DashboardRegistry;
  dbRegistry: DbDriverRegistry;
  notificationRegistry: NotificationRegistry;
  ext: ExtensionHandles;
  llmClient: LlmClient;
  llmRegistry: import("../llm/provider-registry.js").LlmProviderRegistry;
  rustDelegates: ReturnType<typeof createRustDelegates> | null;
  rustBridge: RustBridge | null;
  skillRegistry: import("../../skills/index.js").SkillRegistry;
  chatModule: { getService(): unknown };
  agentsModule: {
    getService(): unknown;
    getExecutor(): unknown;
  };
  httpServer: KernelHttpServer | null;
  mtwRequestArch: MtwRequestArchInfo | null;
  publisherRef: { current: { publishEvent: (ch: string, evt: string, data: Record<string, unknown>) => void } | null };
  lifeService: LifeService | null;
}): Promise<MtwResult> {
  const {
    config, sqlite, neo4j, events, notifier,
    registry, dashboardRegistry, dbRegistry,
    notificationRegistry,
    ext,
    llmClient, llmRegistry, rustDelegates,
    skillRegistry,
    chatModule, agentsModule,
    httpServer, mtwRequestArch, publisherRef,
    lifeService,
  } = args;

  // ── publisherQueryChannel ──────────────────────────
  // Built UNCONDITIONALLY (before the bridge gate) so the same per-channel
  // data the mtwRequest publisher pushes over WS is also reachable over
  // plain HTTP at GET /api/channel/:name. The zero-config / free stack runs
  // with BRIDGE_ENABLED=false (no mtwRequest broker), so without this the
  // dashboard's channel stores would never hydrate and every push-driven
  // page (home overview, life, finance…) would hang on "Loading…".
  const { queryFullDashboard, queryAnalytics, queryCrossModuleIntel, queryCalendar, querySystemTimeline } =
    await import("../../modules/dashboard/api.js");
  const { systemRegistry } = await import("../system-registry.js");

  // Core channels owned by the kernel framework itself (not extensions).
  // Extension-owned channels arrive via getQueryChannels() — registered
  // BEFORE this map so core entries below win as the final fallback.
  const coreQueryChannels: Record<string, () => Promise<unknown> | unknown> = {
    dashboard: () => queryFullDashboard(sqlite),
    analytics: () => queryAnalytics(sqlite, dbRegistry.getGraph()),
    agenda: () => {
      const d = new Date().toISOString().split("T")[0];
      return querySystemTimeline(sqlite, d, 150, systemRegistry);
    },
    crossIntel: () => {
      const r = queryCrossModuleIntel(sqlite);
      return r ? { available: true, ...r } : { available: false };
    },
    life: () => (lifeService ? lifeService.getLifeData() : { available: false }),
    calendar: () => {
      const d = new Date().toISOString().split("T")[0];
      return queryCalendar(sqlite, d, 150, systemRegistry);
    },
    systemAgenda: () => ({ processes: systemRegistry.list(), stats: systemRegistry.getStats() }),
  };
  // Pick up extension-contributed channels at boot time. Modules opt in
  // by implementing `getQueryChannels()` — see KernelModule type.
  const moduleQueryChannels = registry.collectQueryChannels();

  const publisherQueryChannel = async (channel: string): Promise<unknown> => {
    // Check dashboardRegistry for extension channels
    if (dashboardRegistry.hasChannel(channel)) {
      try {
        const d = await dashboardRegistry.queryChannel(channel, sqlite, neo4j);
        return d ? { available: true, ...(d as Record<string, unknown>) } : { available: false };
      } catch { return { available: false }; }
    }
    const moduleHandler = moduleQueryChannels.get(channel);
    if (moduleHandler) return moduleHandler();
    const coreHandler = coreQueryChannels[channel];
    if (coreHandler) return coreHandler();
    return undefined;
  };

  // HTTP fallback for the channel stores. The browser polls this when the
  // WS gateway is absent (free stack) or disconnected. Returns the same
  // shape the publisher would broadcast, or 404 for an unknown channel.
  if (httpServer) {
    httpServer.get("/api/channel/:name", async (req, res) => {
      const name = (req as unknown as { params?: { name?: string } }).params?.name
        ?? new URL(req.url ?? "/", "http://localhost").pathname.split("/").pop() ?? "";
      const data = await publisherQueryChannel(name);
      if (data === undefined) { httpServer.json(res, 404, { error: `unknown channel: ${name}` }); return; }
      httpServer.json(res, 200, data as Record<string, unknown>);
    });
  }

  // ── mtwRequest RPC Handler — built BEFORE the bridge gate ────────
  // Actions are collected and a POST /api/rpc/<action> HTTP route is wired
  // UNCONDITIONALLY, so the dashboard can call RPC over plain HTTP even when the
  // Rust bridge is off (zero-config public stack, BRIDGE_ENABLED=false). The WS
  // transport (attachConnection + start) is enabled below only when the bridge
  // is on. Mirrors the GET /api/channel/:name fallback wired above.
  const { MtwRpcHandler } = await import("../mtw/rpc-handler.js");
  const mtwRpc = new MtwRpcHandler({ events });

  // Dashboard RPC — cross-cutting, manually wired
  const { dashboardRpcActions } = await import("../../modules/dashboard/rpc-actions.js");
  // ConfigService is the settings store `config.ai.save` persists through
  // (app_settings + .env + process.env mirror), resolved from the registry —
  // same lookup pattern used for the HTTP `/api/config/ai` route (see http.ts).
  const configService =
    (registry.getModule("config") as { getService(): Parameters<typeof dashboardRpcActions>[0]["configService"] } | undefined)
      ?.getService?.() ?? undefined;
  mtwRpc.registerAll(dashboardRpcActions({
    db: sqlite,
    neo4j,
    getGraph: () => dbRegistry.getGraph(),
    systemRegistry,
    notifier,
    moduleRegistry: registry,
    dashboardRegistry,
    events,
    skillRegistry,
    config,
    chatService: chatModule.getService() as Parameters<typeof dashboardRpcActions>[0]["chatService"],
    agentExecutor: agentsModule.getExecutor() as Parameters<typeof dashboardRpcActions>[0]["agentExecutor"],
    llmRegistry,
    configService,
  }));

  // Each extension's slice of dashboard RPC actions.
  const dashboardSliceDeps = {
    taskService: ext.tasksModule?.getService() ?? null,
    reminderService: ext.remindersModule?.getService() ?? null,
    crmService: ext.crmModule?.getService() ?? null,
    shoppingService: ext.shoppingModule?.getService() ?? null,
  };
  const collectedDashboardRpc = registry.getAllDashboardRpcActions(dashboardSliceDeps);
  if (collectedDashboardRpc.length > 0) {
    mtwRpc.registerAll(collectedDashboardRpc);
    log.info(`Dashboard RPC: ${collectedDashboardRpc.length} actions collected from KernelModule.getDashboardRpcActions()`);
  }

  // Collect RPC actions from every module that opts in via getRpcActions().
  const collectedRpc = await registry.getAllRpcActions();
  if (collectedRpc.length > 0) {
    mtwRpc.registerAll(collectedRpc);
    log.info(`RPC: ${collectedRpc.length} actions collected from KernelModule.getRpcActions()`);
  }

  // RSS Registry RPC actions — owned by the extension itself.
  if (ext.rssRegistryModule && typeof ext.rssRegistryModule.getRpcActions === "function") {
    try {
      mtwRpc.registerAll(ext.rssRegistryModule.getRpcActions());
    } catch (err) {
      log.warn(`rss-registry: getRpcActions failed (skipped): ${String(err)}`);
    }
  } else if (ext.rssRegistryModule) {
    log.warn("rss-registry: extension loaded but does not expose getRpcActions — skipping RPC registration");
  }

  // Trading + PineScript RPC actions are now contributed by the trading
  // extension itself via `getRpcActions()` (collected above through
  // `registry.getAllRpcActions()`). No bootstrap-side dynamic import.

  // Agents RPC actions
  try {
    const { agentsRpcActions } = await import("../../modules/agents/rpc-actions.js");
    mtwRpc.registerAll(agentsRpcActions({
      service: agentsModule.getService() as Parameters<typeof agentsRpcActions>[0]["service"],
      executor: agentsModule.getExecutor() as Parameters<typeof agentsRpcActions>[0]["executor"],
      events,
    }));
  } catch { /* agents module may not be initialized */ }

  // LLM RPC action — all LLM calls go through mtwRequest
  mtwRpc.register({
    name: "llm.chat",
    handler: async (args: Record<string, unknown>) => {
      const system = typeof args.system === "string" ? args.system : "";
      const user = typeof args.user === "string" ? args.user : "";
      const model = typeof args.model === "string" ? args.model : undefined;
      const maxTokens = typeof args.max_tokens === "number" ? args.max_tokens : undefined;
      if (!user) throw new Error("user message required");
      const result = await llmClient.chat({ system, user, model, maxTokens });
      return { text: result.text, model: result.model, provider: result.provider };
    },
  });

  // Serve every registered RPC action over plain HTTP too, so the dashboard
  // (and any client) can call them when the Rust bridge / WS transport is off —
  // e.g. the zero-config public stack (BRIDGE_ENABLED=false). Same dispatch as
  // the WS path. POST /api/rpc/<action> with the args as the JSON body.
  if (httpServer) {
    httpServer.post("/api/rpc/:action", async (req, res) => {
      const action = (req as unknown as { params?: { action?: string } }).params?.action
        ?? new URL(req.url ?? "/", "http://localhost").pathname.split("/").pop() ?? "";
      try {
        const body = (await httpServer.parseBody(req)) as Record<string, unknown>;
        const data = await mtwRpc.callAction(action, body ?? {});
        httpServer.json(res, 200, (data ?? {}) as Record<string, unknown>);
      } catch (err) {
        httpServer.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  // ── Bridge gate ──────────────────────────────────────────────────
  // Everything below needs the mtwRequest WS broker. With the bridge off
  // (public stack) we're done: RPC actions are already reachable over HTTP.
  if (!config.bridge.enabled) {
    return { mtwPublisher: null, mtwConn: null };
  }

  const mtwUrl = process.env.KERNEL_URL ?? "ws://localhost:7741/ws";
  const { MtwConnection: MtwConn } = await import("@matware/mtw-request-ts-client");

  const mtwConn = new MtwConn({
    url: mtwUrl,
    reconnect: true,
    reconnectDelay: 2000,
    maxReconnectDelay: 30000,
  });

  log.info(`mtwRequest: connecting to ${mtwUrl}...`);
  try {
    await mtwConn.connect();
  } catch (err) {
    log.warn(`mtwRequest: initial connect failed, SDK will retry — ${err}`);
  }

  // WhatsApp provider talks to the whatsapp-bridge sidecar THROUGH mtwRequest.
  // Register a pre-start hook so the provider instance gets the live
  // connection the moment `notificationRegistry.startAll()` runs (stage 11).
  // Any other extension that implements `MtwConnAwareProvider` can opt in by
  // exposing the same instance method — no core change needed.
  notificationRegistry.registerPreStartHook("whatsapp", (provider) => {
    const aware = provider as unknown as Partial<MtwConnAwareProvider>;
    aware.setMtwConnection?.(mtwConn);
  });

  // publisherQueryChannel + the core/module channel maps are built above,
  // before the bridge gate, so the HTTP fallback endpoint works even when
  // BRIDGE_ENABLED=false. The publisher below reuses the same resolver.

  const mtwPublisher = new MtwPublisher({
    conn: mtwConn,
    events,
    queryChannel: publisherQueryChannel,
    // stdio-only kernels (one per Claude session) have no dashboard viewers —
    // the 15s ALL_CHANNELS refresh full-scans kernel.db and pegs a core.
    // http/both kernels (Docker dashboard) keep the periodic refresh.
    periodicRefresh: config.mcp.transport !== "stdio",
  });
  log.debug(`Publisher: pre-start (mtwConn.connected=${(mtwConn as { connected?: boolean }).connected ?? "?"})`);
  await mtwPublisher.start();
  log.info("Publisher: started");
  // Expose to the http stage's publisherRef so dashboard provider's pre-start
  // hook can publish notifications via this publisher instance.
  publisherRef.current = mtwPublisher;

  // Enable the WS transport now that the bridge connection exists — the RPC
  // handler and its actions were built above (before the gate).
  mtwRpc.attachConnection(mtwConn);
  await mtwRpc.start();

  // Update architecture info for ARCH 3D visualization. The rpcModules
  // list is derived from the module registry — every initialized module
  // that contributes RPC actions appears here, no hardcoded list.
  if (httpServer && mtwRequestArch) {
    mtwRequestArch.connected = mtwConn?.connected ?? false;
    mtwRequestArch.rpcActionCount = mtwRpc.actionCount;
    mtwRequestArch.rpcModules = registry.rpcModuleNames();
  }

  // ── ARCH beams: forward EventBus events as archEvents to mtwRequest ──
  const pub = mtwPublisher;
  const archEmit = (event: string, data: Record<string, unknown>) => {
    pub.publishEvent("agents.flow", "archEvent", { event, data, ts: new Date().toISOString() });
  };

  // Agent flow events — dual emission:
  //   1. archEvent → consumed by Architecture 3D visor (semantic beams)
  //   2. agentFlow → consumed by AgentWorld3D visor (raw event for walkers/bubbles)
  for (const evtName of [
    "agent:flow:run_started",
    "agent:flow:step",
    "agent:flow:chain_triggered",
    "agent:flow:run_completed",
    "agent:flow:auto_eval_started",
    "agent:flow:auto_eval",
    "agent:flow:auto_eval_skipped",
    "agent:flow:learning_created",
    "agent:flow:learning_deactivated",
    "agent:flow:meeting_requested",
    "agent:flow:meeting_started",
    "agent:flow:meeting_turn",
    "agent:flow:meeting_ended",
    "agent:flow:agent_edited",
    "agent:flow:escalation",
    "agent:flow:question_asked",
    "agent:flow:question_answered",
  ] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events.on(evtName as any, (payload: any) => {
      // (1) archEvent — semantic beams for Architecture visor
      if (evtName === "agent:flow:chain_triggered") {
        archEmit("agent_chain", {
          source: "agents",
          target: "agents",
          sourceAgent: payload.source_agent_name,
          targetAgent: payload.target_agent_name,
        });
      } else if (evtName === "agent:flow:step" && payload.type === "tool_call" && payload.tool_name) {
        archEmit("agent_tool", {
          source: "agents",
          target: String(payload.tool_name).replace(/^kernel_/, "").split("_")[0],
          agent: payload.agent_name,
          tool: payload.tool_name,
        });
      } else if (evtName === "agent:flow:run_started") {
        archEmit("agent_start", { source: "agents", target: "agents", agent: payload.agent_name });
      } else if (evtName === "agent:flow:run_completed") {
        archEmit("agent_done", {
          source: "agents",
          target: "agents",
          agent: payload.agent_name,
          status: payload.status,
        });
      }

      // (2) agentFlow — raw event passthrough for AgentWorld3D walkers/bubbles
      pub.publishEvent("agents.flow", "agentFlow", {
        event: evtName,
        data: payload,
        ts: new Date().toISOString(),
      });
    });
  }

  // Inbound mail received — forwarded as agentFlow so AgentWorld3D fires the
  // delivery truck + reception animation on the Communications office.
  // This stays in bootstrap because it targets the agentFlow channel, not
  // arch.cross_module. The cross-module beam side is emitted by the comms
  // extension itself.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events.on("comms:mail:received" as any, (p: any) => {
    pub.publishEvent("agents.flow", "agentFlow", {
      event: "comms:mail:received",
      data: p,
      ts: new Date().toISOString(),
    });
  });

  // Office infrastructure toggled (container up/stop/pause/resume/restart) —
  // forwarded as agentFlow so AgentWorld3D walks the office's manager to the
  // Repos Office and animates the power being switched on/off.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events.on("office:infra:changed" as any, (p: any) => {
    pub.publishEvent("agents.flow", "agentFlow", {
      event: "office:infra:changed",
      data: p,
      ts: new Date().toISOString(),
    });
  });

  // RPC calls → ARCH 3D beams (mtwrequest → module). Stays in bootstrap
  // because rpc.call is emitted by the MtwRpcHandler — itself a kernel
  // framework component, not an extension.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events.on("rpc.call" as any, (p: any) => {
    const mod = p.module ?? "unknown";
    archEmit("rpc_call", { source: "mtwrequest", target: mod, label: p.action ?? "", module: mod });
  });

  // Rust delegate calls → ARCH 3D beams (module → mtwrequest). Same
  // reasoning as rpc.call: the rust bridge is kernel framework.
  if (rustDelegates) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events.on("rust.delegate" as any, (p: any) => {
      archEmit("rust_delegate", { source: p.module ?? "trading", target: "mtwrequest", label: p.operation ?? "" });
    });
  }

  // ── Generic cross_module beam forwarder ──
  // Every extension that wants to surface a cross-module beam in the
  // ARCH 3D visor emits `arch.cross_module` on the event bus. Bootstrap
  // forwards each one to the publisher without knowing which extension
  // emitted it — keeps the kernel decoupled from any one module's
  // vocabulary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events.on("arch.cross_module" as any, (p: any) => {
    if (!p || typeof p !== "object") return;
    const { source, target, label, ...extras } = p as Record<string, unknown>;
    archEmit("cross_module", { source, target, label, ...extras });
  });

  void args.rustBridge; // referenced by callers via signature
  return { mtwPublisher, mtwConn };
}
