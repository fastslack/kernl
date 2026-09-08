/**
 * Stage: post-extension service wiring.
 *
 * This is the most cross-cutting stage:
 *  - Seeds bundled channel rows + migrates legacy env config into the
 *    channel_config table.
 *  - Wires the kernel/skill/email/triage/bridge tool list into chat + agents,
 *    and points the meta module's late-bound catalog slot at it.
 *  - Runs the agent seeders that survive the extension migration (office
 *    reorg, ranks, debate rule, optional demo office).
 *  - Builds the embeddings client (and resolves the tool-memory promise).
 *  - Wires cinema's search infra + Nostr identity (derived from the paid
 *    social module's ed25519 seed when installed so cinema/social share one
 *    npub; core-owned persisted seed otherwise).
 *  - First-run cinema ingest kick.
 *  - Assembles the builtin agent handlers (+ optional demo handlers) and
 *    hands them to the agents scheduler/executor.
 *  - Starts the Twitter publisher.
 *  - Initialises sandbox-agents AFTER allTools is assembled (its agents
 *    contribute additional tools that fold back into the catalog).
 *
 * Output `finalTools` is the canonical tool surface the rest of the kernel
 * sees (bridge server, MCP stdio + HTTP, agents, chat).
 */

import { log } from "../logger.js";
import type { KernelConfig } from "../config.js";
import type { SqliteDb } from "../db/sqlite.js";
import type { EventBus } from "../event-bus.js";
import type { ToolDefinition } from "../types.js";
import type { ModuleRegistry } from "../module-registry.js";
import type { DbDriverRegistry } from "../db-drivers/db-driver-registry.js";
import type { Notifier } from "../notify/notifier.js";
import type { EmbeddingsClient } from "../embeddings/index.js";
import type { NostrRelayPool } from "../nostr/nostr-relay-pool.js";

// NOTE: setupEventListeners() moved out of core — now lives in the
// `events-reminders-integration` extension which self-installs via the loader.
import { seedBundledChannels, migrateEnvToChannelConfig } from "../../modules/marketplace/seeders.js";
import { createBuiltinHandlers, KERNEL_AGENT_DEFS, type BuiltinHandler } from "../../modules/agents/builtin-handlers.js";
import { RETIRED_CHECK_HANDLERS } from "../../modules/agents/builtin-checks.js";
import { seedAgentRanks } from "../../modules/agents/ranks-seeder.js";
import { seedTopAgent } from "../../modules/agents/top-agent-seeder.js";
import { seedSkillSuggester } from "../../modules/agents/seed-skill-suggester.js";
import { seedAgentFactory } from "../../modules/agents/seed-agent-factory.js";
import { seedDriverAgents, splitRetiredDrivers } from "../../modules/agents/seed-driver-agents.js";
import { seedModelDiscoveryAgent } from "../../modules/agents/seed-model-discovery-agent.js";

import type { ExtensionHandles } from "./extensions.js";
import type { SandboxAgentsModule } from "../types/extensions/index.js";
import type { ExtensionsModuleHandle } from "../../modules/extensions/index.js";
import type { LicenseService } from "../license/index.js";

export interface ServicesInitResult {
  emailAnalysisService: ReturnType<NonNullable<ExtensionHandles["commsModule"]>["getEmailAnalysisService"]> | null;
  embeddingsClient: EmbeddingsClient | null;
  allTools: ToolDefinition[];
  finalTools: ToolDefinition[];
  agentContribTools: ToolDefinition[];
}

export async function wireServices(args: {
  config: KernelConfig;
  sqlite: SqliteDb;
  events: EventBus;
  notifier: Notifier;
  registry: ModuleRegistry;
  dbRegistry: DbDriverRegistry;
  llmRegistry: import("../llm/provider-registry.js").LlmProviderRegistry;
  ext: ExtensionHandles;
  extensionsModule: ExtensionsModuleHandle;
  license: LicenseService;
  chatModule: { getService(): { setKernelTools: (t: ToolDefinition[]) => void } | null };
  agentsModule: {
    getService(): unknown;
    getExecutor(): { setKernelTools: (t: ToolDefinition[]) => void; setBuiltinHandlers: (h: Map<string, unknown>) => void; setSkillResolver?: (r: unknown) => void } | null;
    getScheduler(): { start(): void; setBuiltinHandlers: (h: Map<string, unknown>) => void } | null;
    getReactiveEngine(): { start(): void; reload(): void } | null;
    getReflectionOptimizer(): unknown;
    getWorkspaceEvolver(): unknown;
    getWorkspaceService(): unknown;
    getMeetingExecutor(): unknown;
    setEmbeddingsClient(client: EmbeddingsClient | null): void;
  };
  skillTools: ToolDefinition[];
  metaCatalogSlot: { value: () => ToolDefinition[] };
  embeddingsResolver: ((c: EmbeddingsClient) => void) | null;
  registryAllTools: () => ToolDefinition[];
}): Promise<ServicesInitResult> {
  const {
    config, sqlite, events, notifier,
    registry, dbRegistry, llmRegistry,
    ext, extensionsModule, license, chatModule, agentsModule,
    skillTools, metaCatalogSlot,
    embeddingsResolver, registryAllTools,
  } = args;

  // ── Seed bundled channels & migrate env config ──
  seedBundledChannels(sqlite);
  migrateEnvToChannelConfig(sqlite, config);

  // ── Cross-module event listeners ────────────────────
  // Provided by the `events-reminders-integration` extension (see
  // `assets/extensions/automation/events-reminders-integration/`). The loader installs
  // it during the standard extension boot pass.

  // ── Email analysis service handle (used by builtin handlers) ──
  const emailAnalysisService = ext.commsModule?.getEmailAnalysisService() ?? null;

  // ── Assemble the global tool surface ────────────────
  const chatService = chatModule.getService();
  const mcpBridge = registry.getModule("ext:mcp-bridge") as {
    getBridgedTools?: () => ToolDefinition[];
    setRepublish?: (fn: () => void) => void;
  } | null;

  // Read live rather than snapshotting. A captured array is what made a
  // freshly connected MCP server invisible until the kernel was restarted:
  // the tools existed, but every catalog had already been built without them.
  const composeTools = (): ToolDefinition[] => [
    ...registryAllTools(),
    ...skillTools,
    ...ext.emailTools,
    ...ext.triageTools,
    ...(mcpBridge?.getBridgedTools?.() ?? []),
  ];

  const allTools = composeTools();
  // Now that we know the full surface, point the meta module's catalog slot
  // at it so kernel_tool_search / kernel_code_run see every tool.
  metaCatalogSlot.value = composeTools;

  // Filled in below, once the sandbox-agents extension has contributed. Held
  // as a mutable reference so republishing picks up agent tools too — pushing
  // only the MCP half would silently drop them from chat.
  let agentContribToolsRef: ToolDefinition[] = [];
  if (chatService) {
    chatService.setKernelTools(allTools);
  }

  // ── Inject tools into AgentExecutor + start reactive engine + scheduler ──
  const agentExecutor = agentsModule.getExecutor();

  // The seam that makes connecting an MCP server usable without a restart.
  // setKernelTools converts eagerly (convertToolsForLlm + buildToolExecutor)
  // and keeps no reference, so mutating a shared array achieves nothing — the
  // catalogs have to be handed the new surface explicitly.
  const republishToolSurface = (): void => {
    const next = [...composeTools(), ...agentContribToolsRef];
    chatService?.setKernelTools(next);
    agentExecutor?.setKernelTools(next);
  };
  mcpBridge?.setRepublish?.(republishToolSurface);

  if (agentExecutor) {
    agentExecutor.setKernelTools(allTools);
    // Procedural skills resolver — turns agent.skills_json slugs into
    // SKILL.md bodies and the prompt-index block. Constructed here because
    // it needs the SQLite handle and the agent executor in one place.
    const { SkillBodyResolver } = await import("../../modules/agents/skill-resolver.js");
    (agentExecutor as { setSkillResolver?: (r: unknown) => void }).setSkillResolver?.(
      new SkillBodyResolver(sqlite),
    );
  }

  agentsModule.getReactiveEngine()?.start();

  // ── System agents (replaces AutomationRunner + ProactiveEngine) ──
  // Office structure seeders (reorg/debate-rule) ran historically here;
  // they now run inside `ext:agent-advanced.initialize()`, which sits at stage 5
  // of the bootstrap pipeline and so completes BEFORE this stage. Core only
  // owns the rank seeder (it doesn't depend on advanced) and the optional
  // demo-office trigger (which we delegate to the advanced extension so the
  // bootstrap doesn't import any concrete advanced symbol).
  const agentService = agentsModule.getService() as Parameters<typeof seedAgentRanks>[1] | null;
  const advancedExt = registry.getModule("ext:agent-advanced") as {
    getDemoHandlers?: () => Map<string, BuiltinHandler> | null;
    runDemoOfficeSeed?: (events: EventBus) => void;
  } | null;
  let embeddingsClient: EmbeddingsClient | null = null;
  if (agentService) {
    // Seed ranks AFTER agent-bundles install so auto-assignment covers everyone.
    seedAgentRanks(sqlite, agentService);
    // Top agent — holder of the highest rank. Runs AFTER ranks so the rank
    // lookup hits; idempotent so re-boots don't duplicate the agent/flow.
    seedTopAgent(sqlite, agentService);

    // Skill Suggester — sits in the commander's flow and feeds him daily
    // suggestions on which installed skills to attach to which agents. Must
    // run AFTER seedTopAgent so the commander flow already exists.
    seedSkillSuggester(sqlite, agentService);

    // Agent Factory — meta-agent that fabricates new expert agents on demand
    // (research → curate tools → synthesize prompt → create inactive draft).
    // Lives in the commander flow, so it must run AFTER seedTopAgent.
    seedAgentFactory(sqlite, agentService);

    // (Cinema catalog-loader agents are now seeded by the generic driver
    // seeder below — the cinema extension publishes them as AgentDrivers.)

    // LLM model-discovery cron — polls each provider's available models every
    // 6h, persists the catalog, and notifies on new models / configured refs
    // that point at a vanished model. Gated by MODELS_DISCOVERY_ENABLED so it
    // can be turned off wholesale (default on).
    if (process.env.MODELS_DISCOVERY_ENABLED !== "false") {
      seedModelDiscoveryAgent(sqlite, agentService);
    }

    // Demo office (DISABLED) — only seeded when DEMO_OFFICE=1. Gating happens
    // inside the extension so this stage stays oblivious to the env knob.
    advancedExt?.runDemoOfficeSeed?.(events);
    // Reload reactive triggers so the Error Auditor's event trigger is live
    // even when seeded in this boot (first-boot case).
    agentsModule.getReactiveEngine()?.reload();

    // Embeddings client — created once at boot; cinema:embed-pending handler
    // uses it on every tick. Probes LMStudio on init, falls back to local
    // MiniLM if unavailable.
    const { createEmbeddingsClient } = await import("../embeddings/index.js");
    embeddingsClient = await createEmbeddingsClient(config).catch((err) => {
      log.warn("embeddings: factory failed at boot — semantic features disabled", err);
      return null;
    });
    // Hand to tool-memory's lazy resolver. If embeddings failed, leave the
    // promise pending — tool-memory's getService() returns null and hooks degrade.
    if (embeddingsClient && embeddingsResolver) {
      const resolve = embeddingsResolver as (c: EmbeddingsClient) => void;
      resolve(embeddingsClient);
    }

    // Wire the agents module's AgentService with the embeddings client so it
    // can embed memory / learnings / run goals at write time. Same lifecycle
    // contract as the tool-memory resolver above — degrades gracefully when
    // the client is null (agents fall back to lexical ranking).
    agentsModule.setEmbeddingsClient(embeddingsClient);

    // TODO(drivers): the cross-extension wiring below (cinema setSearchInfra /
    // setNostrIdentity, rss-registry setEmbeddingsClient, social→cinema
    // identity share) still names concrete extensions from the bootstrap.
    // It is deliberately OUT of scope of the agent-driver refactor — a future
    // capability-registry pass should invert it the same way agent handlers
    // were inverted via getAgentDrivers().
    //
    // Wire cinema's semantic-search dependencies. Active graph driver is
    // captured at this snapshot — switching backends in /extensions requires
    // a kernel restart for cinema's bound driver to flip.
    ext.cinemaModule?.setSearchInfra(dbRegistry.getGraph(), embeddingsClient);
    // Wire rss-registry's embeddings client so kernel_rss_items can rank items
    // by relevance to a query (top-k) instead of dumping the raw inventory —
    // a hallucination vector for curator agents. Null degrades to lexical.
    ext.rssRegistryModule?.setEmbeddingsClient(embeddingsClient);
    // Wire cinema's Nostr publishing identity. With the paid social
    // extension installed, derive it from social's ed25519 seed (unified
    // npub across social posts + subtitle announcements) and share its
    // relay pool. Without social, fall back to a core-owned persisted seed
    // (src/core/nostr/identity-store.ts) — same tagged derivation, so a
    // kernel that previously ran social keeps the npub it broadcast under.
    try {
      if (ext.cinemaModule) {
        let cinemaIdentity = ext.socialModule?.deriveNostrIdentity() ?? null;
        let sharedPool: NostrRelayPool | null = null;
        if (cinemaIdentity) {
          sharedPool = ext.socialModule?.getNostrBridge()?.getRelayPool() ?? null;
        } else {
          const { loadOrCreateCoreNostrIdentity } = await import("../nostr/identity-store.js");
          cinemaIdentity = loadOrCreateCoreNostrIdentity(sqlite, config.encryption.key);
        }
        if (cinemaIdentity) {
          ext.cinemaModule.setNostrIdentity(cinemaIdentity, sharedPool);
        }
      }
    } catch (err) {
      log.warn("cinema: failed to wire Nostr identity — subs publish disabled", err);
    }

    // First-run cinema seed: cinema module owns the empty-catalog check
    // and ingest kickoff. Idempotent and safe to call on every boot.
    ext.cinemaModule?.maybeFirstRunIngest();

    // Collect agent-handler factories self-published by extensions via
    // `KernelModule.getAgentHandlers()`. Replaces the previous pattern of
    // builtin-handlers dynamic-importing extension paths.
    const agentHandlerRegistry = registry.collectAgentHandlers();
    log.info(
      `Agent handlers registered by extensions: ${agentHandlerRegistry.size} ` +
      `(${[...agentHandlerRegistry.keys()].sort().join(", ") || "none"})`,
    );

    // Kernel-generic handlers only — every extension-specific service handle
    // that used to live in this bag now ships inside its extension's own
    // AgentDrivers (each driver closes over its module's services).
    const builtinHandlers = createBuiltinHandlers({
      db: sqlite,
      notifier,
      config,
      agentHandlerRegistry,
      services: {
        events,
        // LLM provider registry — the `llm:model-discovery` builtin handler
        // polls its providers' listModels() to refresh the model catalog.
        llmRegistry,
        agentService: agentsModule.getService(),
        reflectionOptimizer: agentsModule.getReflectionOptimizer(),
        workspaceEvolver: agentsModule.getWorkspaceEvolver(),
        workspaceService: agentsModule.getWorkspaceService(),
        embeddingsClient,
        getGraph: () => dbRegistry.getGraph(),
        // Marketplace catalog repos service — used by the
        // `marketplace:sync-repos` builtin handler to refresh subscribed repos.
        marketplaceRepos: (() => {
          const mp = registry.getModule("marketplace") as { getReposService?: () => unknown } | null;
          return mp?.getReposService?.() ?? null;
        })(),
        // Extension service + license accessors — used by the
        // `store:auto-update` builtin handler to check/apply newer versions
        // of already-installed, licensed extensions from the Kernl store.
        getExtensionService: () => {
          try {
            return extensionsModule.service;
          } catch {
            return null;
          }
        },
        licenseHas: (feature: string) => license.has(feature),
        licenseJwt: () => license.jwt(),
      },
    });

    // ── Agent drivers (plugin-style) ────────────────────────────────
    // Each module/extension publishes complete drivers (handler id +
    // metadata + run closure) via getAgentDrivers(). Merge their run
    // closures into the builtin map (kernel-generic keys win on collision)
    // and seed an agents row + cron schedule for every def with a cron —
    // kernel generics included.
    const { handlers: driverHandlers, defs: driverDefs } = registry.collectAgentDrivers();
    for (const [key, run] of driverHandlers) {
      if (builtinHandlers.has(key)) {
        log.warn(`Agent driver "${key}" collides with a kernel builtin handler — module driver ignored`);
        continue;
      }
      builtinHandlers.set(key, run);
    }
    // A driver marked `retired` keeps its handler in the map above — so a row
    // an operator re-enables by hand still runs real code — but is excluded
    // from seeding and its id is handed to the retirement pass, which parks
    // any agent still carrying it. Declared by the module that owns the
    // driver, so the kernel never has to keep a list of other people's
    // handler ids.
    const { active: liveDrivers, retiredHandlers } = splitRetiredDrivers(driverDefs);
    seedDriverAgents(sqlite, agentService as Parameters<typeof seedDriverAgents>[1], [
      ...KERNEL_AGENT_DEFS,
      ...liveDrivers,
    ], config.agents.minScheduleSeconds, [...RETIRED_CHECK_HANDLERS, ...retiredHandlers]);

    // Demo handlers — register unconditionally; they only execute when an
    // agent has builtin_handler='demo:*' set (i.e. the demo seeder ran).
    // Built and exposed by the advanced extension so this stage doesn't
    // touch the `createDemoHandlers` factory directly.
    const demoHandlers = advancedExt?.getDemoHandlers?.() ?? null;
    if (demoHandlers) {
      for (const [k, v] of demoHandlers) (builtinHandlers as Map<string, unknown>).set(k, v);
    }
    agentsModule.getScheduler()?.setBuiltinHandlers(builtinHandlers as Map<string, unknown>);
    agentsModule.getExecutor()?.setBuiltinHandlers(builtinHandlers as Map<string, unknown>);
  }
  agentsModule.getScheduler()?.start();

  // ── Twitter Publisher (auto-posts approved tweets on schedule) ──
  (ext.twitterModule as unknown as { getPublisher?: () => { start: () => void } } | null)
    ?.getPublisher?.()?.start();

  // ── Sandbox Agents — initialize AFTER allTools is assembled ──
  const sandboxAgentsExt = registry.getModule("ext:sandbox-agents") as SandboxAgentsModule | null;
  await sandboxAgentsExt?.initializeSandboxes(allTools);
  const agentContribTools = sandboxAgentsExt?.getAgentTools() ?? [];
  // Keep the republish path aware of them from here on.
  agentContribToolsRef = agentContribTools;
  if (agentContribTools.length > 0) {
    // Inject agent-contributed tools into chat and agent executor
    const allToolsWithAgents = [...allTools, ...agentContribTools];
    if (chatService) chatService.setKernelTools(allToolsWithAgents);
    if (agentExecutor) agentExecutor.setKernelTools(allToolsWithAgents);
  }

  const finalTools = agentContribTools.length > 0
    ? [...allTools, ...agentContribTools]
    : allTools;

  return {
    emailAnalysisService,
    embeddingsClient,
    allTools,
    finalTools,
    agentContribTools,
  };
}
