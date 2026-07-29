import type {
  ExtensibleModule,
  DashboardDescriptor,
  ModuleContext,
  ResourceProvider,
  ToolDefinition,
} from "../../core/types.js";
import { runMigrations } from "../../core/db/migrations.js";
import { agentsMigrations } from "./migrations.js";
import { AgentService } from "./service.js";
import { AgentExecutor } from "./executor.js";
import type { SandboxDriverRegistry } from "../../core/sandbox/registry.js";
import { ReactiveEngine } from "./reactive-engine.js";
import { AgentScheduler } from "./scheduler.js";
import { agentsTools } from "./tools.js";
import { auditTools } from "./audit-tools.js";
import { createAnalysisResourceProvider, createSkillResourceProvider } from "./resources.js";
import { log } from "../../core/logger.js";
import { createChatProviders, initProviderStatus } from "../../core/llm/chat-adapters.js";
import { queryAgents, queryAgentsList } from "./dashboard-queries.js";
import type {
  AltExecutorLike,
  EvalServiceLike,
  MeetingExecutorLike,
  WorkspaceServiceLike,
  ReflectionOptimizerLike,
  WorkspaceEvolverLike,
} from "./advanced-types.js";
import type { EmbeddingsClient } from "../../core/embeddings/client.js";

/**
 * Public surface of the agents module.
 *
 * The "advanced" capabilities (claude-code executor, auto-eval, meetings,
 * workspaces, prompt/workspace evolvers, debate/inbox/conversation engines)
 * live in the `ext:agent-advanced` extension. They wire themselves in via
 * the `register*()` methods below; the core knows them only structurally
 * through `./advanced-types.ts`.
 */
export interface AgentsModule extends ExtensibleModule {
  getService(): AgentService | null;
  getExecutor(): AgentExecutor | null;
  getReactiveEngine(): ReactiveEngine | null;
  getScheduler(): AgentScheduler | null;

  // ── Extension registration seam ──────────────────────────
  registerAltExecutor(type: string, executor: AltExecutorLike): void;
  registerEvalService(svc: EvalServiceLike): void;
  registerMeetingExecutor(svc: MeetingExecutorLike): void;
  registerWorkspaceService(svc: WorkspaceServiceLike): void;
  registerReflectionOptimizer(svc: ReflectionOptimizerLike): void;
  registerWorkspaceEvolver(svc: WorkspaceEvolverLike): void;

  // ── Live accessors used by other stages (http routes, services) ──
  getWorkspaceService(): WorkspaceServiceLike | null;
  getReflectionOptimizer(): ReflectionOptimizerLike | null;
  getWorkspaceEvolver(): WorkspaceEvolverLike | null;
  getMeetingExecutor(): MeetingExecutorLike | null;
  getAltExecutor(type: string): AltExecutorLike | null;

  /** Inject a sandbox registry. Stashed and forwarded to any alt executor
   *  registered later (the bootstrap drivers stage calls this BEFORE the
   *  agent-advanced extension loads). */
  setSandboxRegistry(registry: SandboxDriverRegistry): void;

  /**
   * Inject the kernel-wide EmbeddingsClient. The agents module initialises
   * BEFORE createEmbeddingsClient resolves, so bootstrap calls this after.
   * Null is acceptable — write-time embedding silently no-ops and the
   * reader degrades to lexical. Safe to call multiple times (last wins).
   */
  setEmbeddingsClient(client: EmbeddingsClient | null): void;
}

export function createAgentsModule(): AgentsModule {
  let tools: ToolDefinition[] = [];
  let agentService: AgentService | null = null;
  let agentExecutor: AgentExecutor | null = null;
  let reactiveEngine: ReactiveEngine | null = null;
  let agentScheduler: AgentScheduler | null = null;

  // Advanced-capability slots — populated when `ext:agent-advanced` registers.
  const altExecutors = new Map<string, AltExecutorLike>();
  let evalService: EvalServiceLike | null = null;
  let meetingExecutor: MeetingExecutorLike | null = null;
  let workspaceService: WorkspaceServiceLike | null = null;
  let reflectionOptimizer: ReflectionOptimizerLike | null = null;
  let workspaceEvolver: WorkspaceEvolverLike | null = null;

  // Stashed sandbox registry — wired by bootstrap BEFORE the advanced
  // extension loads, so we keep it and forward to alt executors as they
  // register.
  let stashedSandboxRegistry: SandboxDriverRegistry | null = null;

  return {
    name: "agents",

    async initialize(ctx: ModuleContext) {
      // Migration 18 introduces an 'agent_messages' table for the conversation
      // system. The external-agents module historically owned that name with a
      // different schema. Rename the legacy table out of the way before running
      // migrations — idempotent, only acts when the legacy schema is detected.
      renameLegacyAgentMessages(ctx.sqlite);

      runMigrations(ctx.sqlite, "agents", agentsMigrations);

      agentService = new AgentService(ctx.sqlite, ctx.events, ctx.config);
      agentService.cleanupStaleRuns();
      agentExecutor = new AgentExecutor();
      agentExecutor.setConfig(ctx.config);

      // Initialize provider quota tracking (persists across requests)
      initProviderStatus(ctx.sqlite);

      // Set up LLM providers (reusing chat's provider infrastructure)
      const providers = createChatProviders({
        anthropicApiKey: ctx.config.webIntel.anthropicApiKey,
        openaiApiKey: ctx.config.webIntel.openaiApiKey,
        lmstudioBaseUrl: ctx.config.webIntel.lmstudioBaseUrl,
        grokApiKey: ctx.config.webIntel.grokApiKey,
        grokDefaultModel: ctx.config.webIntel.grokDefaultModel,
        nvidiaApiKey: ctx.config.webIntel.nvidiaApiKey,
        nvidiaDefaultModel: ctx.config.webIntel.nvidiaDefaultModel,
        claudeCode: ctx.config.claudeCode,
      });
      const defaultProvider = ctx.config.agents?.defaultProvider || ctx.config.chat.defaultProvider || "claude";
      agentExecutor.setProviders(providers, defaultProvider);

      // Reactive engine and scheduler
      reactiveEngine = new ReactiveEngine(
        agentService,
        agentExecutor,
        ctx.events,
        ctx.systemRegistry,
      );

      const pollMs = ctx.config.agents?.pollIntervalMs ?? 30_000;
      agentScheduler = new AgentScheduler(
        agentService,
        agentExecutor,
        ctx.events,
        pollMs,
        ctx.config.timezone,
        ctx.systemRegistry,
        ctx.config.agents?.learningCleanupIntervalMs ?? 3_600_000,
        ctx.config.agents?.learningMinConfidence ?? 0.15,
      );

      tools = [
        ...agentsTools(agentService, agentExecutor, ctx.events, () => meetingExecutor),
        ...auditTools(agentService),
      ];

      // Upgrade pass: any agent that already produces output worth sharing
      // (has workspace or notes tools) gets the new analysis/search tools
      // auto-granted. Idempotent — only patches when missing.
      upgradeWorkspaceAccess(ctx.sqlite);
    },

    getTools() {
      return tools;
    },

    getResources(): ResourceProvider[] {
      // Workspace analyses + Claude skills exposed as MCP `resources/*`.
      // The skills provider is unconditional — it scans the host's ~/.claude
      // and returns an empty list when nothing exists. The analyses provider
      // needs the WorkspaceService, so it's only included once the advanced
      // extension has registered one.
      const out: ResourceProvider[] = [createSkillResourceProvider()];
      if (workspaceService) out.push(createAnalysisResourceProvider(workspaceService));
      return out;
    },

    getService() {
      return agentService;
    },

    getExecutor() {
      return agentExecutor;
    },

    getReactiveEngine() {
      return reactiveEngine;
    },

    getScheduler() {
      return agentScheduler;
    },

    // ── Registration seam ──────────────────────────────────────
    registerAltExecutor(type: string, executor: AltExecutorLike) {
      altExecutors.set(type, executor);
      // Forward stashed sandbox registry now that we have an executor that
      // might want it (only certain executors expose setSandboxRegistry).
      if (stashedSandboxRegistry) {
        const sb = (executor as unknown as { setSandboxRegistry?: (r: SandboxDriverRegistry) => void }).setSandboxRegistry;
        if (typeof sb === "function") sb.call(executor, stashedSandboxRegistry);
      }
      // Today only "claude_code" is consumed by AgentExecutor's routing.
      if (type === "claude_code") {
        agentExecutor?.setClaudeCodeExecutor(executor);
      }
    },

    registerEvalService(svc: EvalServiceLike) {
      evalService = svc;
      agentExecutor?.setEvalService(svc);
    },

    registerMeetingExecutor(svc: MeetingExecutorLike) {
      meetingExecutor = svc;
    },

    registerWorkspaceService(svc: WorkspaceServiceLike) {
      workspaceService = svc;
    },

    registerReflectionOptimizer(svc: ReflectionOptimizerLike) {
      reflectionOptimizer = svc;
    },

    registerWorkspaceEvolver(svc: WorkspaceEvolverLike) {
      workspaceEvolver = svc;
    },

    getWorkspaceService() {
      return workspaceService;
    },

    getReflectionOptimizer() {
      return reflectionOptimizer;
    },

    getWorkspaceEvolver() {
      return workspaceEvolver;
    },

    getMeetingExecutor() {
      return meetingExecutor;
    },

    getAltExecutor(type: string) {
      return altExecutors.get(type) ?? null;
    },

    setSandboxRegistry(registry: SandboxDriverRegistry) {
      stashedSandboxRegistry = registry;
      // Forward to any already-registered alt executor that wants it.
      for (const exec of altExecutors.values()) {
        const sb = (exec as unknown as { setSandboxRegistry?: (r: SandboxDriverRegistry) => void }).setSandboxRegistry;
        if (typeof sb === "function") sb.call(exec, registry);
      }
    },

    setEmbeddingsClient(client: EmbeddingsClient | null) {
      agentService?.setEmbeddingsClient(client);
    },

    getDashboardDescriptor(): DashboardDescriptor {
      return {
        nav: [
          { id: "agents", label: "Agents", icon: "🤖", group: "ai", order: 20 },
          { id: "autogenesis", label: "Autogenesis", icon: "🧬", group: "ai", order: 21 },
        ],
        channels: [
          {
            name: "agents",
            query: (db) => {
              const d = queryAgents(db);
              const l = queryAgentsList(db);
              return (d || l) ? { ...(d ?? {}), ...(l ?? {}) } : null;
            },
          },
          {
            name: "flowWidgets",
            query: () => {
              if (!agentService) return null;
              return { widgets: agentService.getFlowWidgets() };
            },
          },
        ],
        channelMappings: [
          { moduleKey: "agents", channels: ["agents", "flowWidgets"] },
        ],
        stores: ["agents", "flowWidgets"],
        fetchEndpoints: [
          { url: "/api/dashboard/agents", store: "agents" },
          { url: "/api/dashboard/flowWidgets", store: "flowWidgets" },
        ],
      };
    },

    async shutdown() {
      agentScheduler?.stop();
      reactiveEngine?.stop();
      // Workspace compose / debate / inbox-waker / subscription teardown is
      // owned by the `ext:agent-advanced` extension's own shutdown().
    },
  };
}

/**
 * Pre-migration safety: rename the legacy external-agents 'agent_messages'
 * table to 'external_agent_messages' so migration 18 can create its own
 * (conversation-system) table under that name. Only acts when the legacy
 * schema is detected (presence of the 'direction' column). Idempotent.
 */
function renameLegacyAgentMessages(
  db: {
    prepare: (sql: string) => {
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown[];
    };
    exec: (sql: string) => void;
  },
): void {
  try {
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_messages'")
      .get() as { name?: string } | undefined;
    if (!exists) return;

    const cols = db.prepare("PRAGMA table_info(agent_messages)").all() as Array<{ name: string }>;
    const isLegacy = cols.some((c) => c.name === "direction");
    if (!isLegacy) return; // already the new conversation schema, leave it alone

    const targetExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='external_agent_messages'")
      .get() as { name?: string } | undefined;

    if (targetExists) {
      db.exec(`
        INSERT OR IGNORE INTO external_agent_messages
          (id, agent_id, direction, message_type, content, metadata, created_at)
        SELECT id, agent_id, direction, message_type, content, metadata, created_at
        FROM agent_messages;
        DROP TABLE agent_messages;
      `);
    } else {
      db.exec("ALTER TABLE agent_messages RENAME TO external_agent_messages");
    }
    log.info("Agents: renamed legacy external-agents 'agent_messages' → 'external_agent_messages'");
  } catch (err) {
    log.warn(`renameLegacyAgentMessages failed (non-fatal): ${String(err)}`);
  }
}

/**
 * Auto-grant the shared analysis tools to any agent already trusted with
 * workspace or notes output. Runs once at startup, idempotent.
 */
function upgradeWorkspaceAccess(db: { prepare: (sql: string) => { all: () => unknown[]; run: (...args: unknown[]) => unknown } }): void {
  const NEW_TOOLS = [
    "kernel_workspace_analysis_save",
    "kernel_workspace_analysis_list",
    "kernel_workspace_search",
    "kernel_workspace_create",
    "kernel_workspace_list_workspaces",
  ];
  try {
    const rows = db.prepare("SELECT id, name, allowed_tools FROM agents").all() as Array<{ id: string; name: string; allowed_tools: string }>;
    let patched = 0;
    for (const r of rows) {
      let current: unknown;
      try { current = JSON.parse(r.allowed_tools || "[]"); } catch { continue; }
      if (!Array.isArray(current)) continue;
      if (current.length === 0) continue; // empty = all tools allowed, nothing to patch
      const strs = current.filter((t): t is string => typeof t === "string");
      const qualifies =
        strs.some(t => t.startsWith("kernel_workspace_")) ||
        strs.includes("kernel_notes_create");
      if (!qualifies) continue;
      const missing = NEW_TOOLS.filter(t => !strs.includes(t));
      if (missing.length === 0) continue;
      const merged = [...strs, ...missing];
      db.prepare("UPDATE agents SET allowed_tools = ?, updated_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(merged), r.id);
      patched++;
    }
    if (patched > 0) log.info(`Agents: auto-granted workspace analysis tools to ${patched} existing agent(s)`);
  } catch (err) {
    log.warn(`upgradeWorkspaceAccess failed: ${String(err)}`);
  }
}
