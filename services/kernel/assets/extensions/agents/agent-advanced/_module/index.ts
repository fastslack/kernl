/**
 * `agent-advanced` — heavy / optional capabilities for the agents subsystem.
 *
 * What lives here vs. in `src/modules/agents/` (core):
 *   core: AgentService, AgentExecutor (native LLM loop), AgentScheduler,
 *         ReactiveEngine, agent CRUD tools, audit tools, MCP resources for
 *         workspace analyses + skills.
 *   here: Claude Agent SDK executor (`claude_code`), auto-eval, multi-agent
 *         meetings + debate orchestration, prompt + workspace evolvers,
 *         conversation subscriptions, inbox waker, workspace tools/compose,
 *         opinionated office seeders (reorg / debate rule), demo
 *         office + handlers (DEMO_OFFICE=1).
 *
 * The core never imports anything from this extension. Wiring happens here:
 * on `initialize()` we resolve the live `agents` module via
 * `ctx.getModule("agents")` and call its `register*()` seam to plug in our
 * implementations. Tools owned by this extension (workspace + evolver) are
 * returned by our own `getTools()` so the kernel-wide tool catalog sees them.
 *
 * Two seeders need to run AFTER `seedAgentRanks` (a core seeder that fires
 * in the bootstrap `wireServices` stage). Those are exposed via the public
 * methods `getDemoHandlers()` and `runDemoOfficeSeed()` so the bootstrap
 * stage can pull from this extension via the registry without the core
 * importing any concrete advanced symbols.
 */
import type {
  KernelModule,
  ModuleContext,
  ToolDefinition,
} from "../../../../../src/core/types.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import { log } from "../../../../../src/core/logger.js";
import type { AgentsModule } from "../../../../../src/modules/agents/index.js";
import { createChatProviders } from "../../../../../src/modules/chat/llm-adapter.js";
import type { BuiltinHandler } from "../../../../../src/modules/agents/builtin-handlers.js";

import { AgentEvalService } from "./eval-service.js";
import { ClaudeCodeExecutor } from "./claude-code-executor.js";
import { MeetingExecutor } from "./meeting-executor.js";
import { DebateOrchestrator } from "./debate-orchestrator.js";
import { InboxWaker } from "./inbox-waker.js";
import { ConversationSubscriptionEngine } from "./conversation-subscription-engine.js";
import { ReflectionOptimizer } from "./reflection-optimizer.js";
import { WorkspaceService } from "./workspace-service.js";
import { workspaceTools } from "./workspace-tools.js";
import {
  WorkspaceEvolverService,
  workspaceEvolverTools,
} from "./workspace-evolver/index.js";
import {
  startIdleReaper as startWorkspaceComposeReaper,
  stopIdleReaper as stopWorkspaceComposeReaper,
  shutdownAllCompose,
} from "./workspace-compose.js";

// Seeders that bootstrap office structure (idempotent — safe to call every boot).
import { seedOfficeReorg } from "./seed-office-reorg.js";
import { seedDebateRule } from "./seed-debate-rule.js";
import { seedDemoOffice } from "./seed-demo-office.js";
import { createDemoHandlers } from "./demo-handlers.js";

export interface AgentAdvancedModule extends KernelModule {
  /**
   * Build the `demo:*` builtin handlers map. Called by the bootstrap
   * `wireServices` stage so it can fold these into the kernel-wide builtin
   * handler registry alongside core handlers from `createBuiltinHandlers()`.
   * Returns null when the extension didn't initialise (e.g. no agents core).
   */
  getDemoHandlers(): Map<string, BuiltinHandler> | null;

  /**
   * Run the optional DEMO_OFFICE seeder. Bootstrap calls this AFTER
   * `seedAgentRanks` so demo agents pick up the proper ranks instead of
   * being auto-assigned to the lowest rank. No-op when DEMO_OFFICE != "1".
   */
  runDemoOfficeSeed(events: EventBus): void;
}

export function createAgentAdvancedModule(): AgentAdvancedModule {
  let tools: ToolDefinition[] = [];
  let started = false;

  // Slots populated in initialize() and read by the public methods below.
  let ctxRef: ModuleContext | null = null;
  let agentsRef: AgentsModule | null = null;
  let meetingExecutorRef: MeetingExecutor | null = null;

  return {
    name: "ext:agent-advanced",

    async initialize(ctx: ModuleContext) {
      ctxRef = ctx;

      // Pro gate removed (2026-05-16): agent-advanced ships full-featured for
      // anyone who has the bundle installed. Same policy as trading — the
      // gate is the bundle's distribution channel, not a runtime license
      // check. Without this, any agent with executor_type='claude_code'
      // (the top agent, advanced classifiers, etc.) fails at runtime
      // because the executor never gets registered.

      const agentsModule = ctx.getModule?.("agents") as AgentsModule | null;
      if (!agentsModule) {
        log.warn("agent-advanced: core 'agents' module not found — extension is a no-op");
        return;
      }
      const agentService = agentsModule.getService();
      const agentExecutor = agentsModule.getExecutor();
      if (!agentService || !agentExecutor) {
        log.warn("agent-advanced: agents core not initialized yet — skipping wiring");
        return;
      }
      agentsRef = agentsModule;

      // Same provider matrix the agents core builds. Stateless adapters, so
      // having a second copy is harmless and keeps cross-module coupling at
      // the config level instead of leaking internal state.
      const providers = createChatProviders({
        anthropicApiKey: ctx.config.webIntel.anthropicApiKey,
        openaiApiKey: ctx.config.webIntel.openaiApiKey,
        lmstudioBaseUrl: ctx.config.webIntel.lmstudioBaseUrl,
        grokApiKey: ctx.config.webIntel.grokApiKey,
        grokDefaultModel: ctx.config.webIntel.grokDefaultModel,
        nvidiaApiKey: ctx.config.webIntel.nvidiaApiKey,
        nvidiaDefaultModel: ctx.config.webIntel.nvidiaDefaultModel,
      });
      const defaultProvider =
        ctx.config.agents?.defaultProvider ||
        ctx.config.chat.defaultProvider ||
        "claude";

      // ── Auto-evaluation (uses a usually cheaper provider/model) ──
      const evalService = new AgentEvalService();
      const evalProvider = ctx.config.agents?.evalProvider || defaultProvider;
      const evalModel = ctx.config.agents?.evalModel || "";
      evalService.setProviders(providers, evalProvider, evalModel);
      evalService.setConfig(ctx.config);
      agentsModule.registerEvalService(evalService);

      // ── Claude Agent SDK alt executor (executor_type='claude_code') ──
      const claudeCodeExecutor = new ClaudeCodeExecutor();
      claudeCodeExecutor.setConfig(ctx.config);
      claudeCodeExecutor.setEvalService(evalService);
      claudeCodeExecutor.setNativeExecutor(agentExecutor);
      // registerAltExecutor will forward the stashed SandboxDriverRegistry
      // (wired by the bootstrap drivers stage before extensions loaded).
      agentsModule.registerAltExecutor("claude_code", claudeCodeExecutor);

      // ── Workspaces ──
      const workspaceService = new WorkspaceService(ctx.sqlite);
      // Back-compat: any pre-existing per-flow directory becomes a 'main'
      // workspace owned by that flow. Idempotent.
      workspaceService.registerLegacyDirs();
      claudeCodeExecutor.setWorkspaceService(workspaceService);
      agentsModule.registerWorkspaceService(workspaceService);

      // Workspace evolver — gates whether a run's filesystem changes get
      // promoted to a new git baseline based on policy.evaluation.command.
      const workspaceEvolver = new WorkspaceEvolverService(
        agentService,
        workspaceService,
      );
      agentsModule.registerWorkspaceEvolver(workspaceEvolver);

      // ── Meeting executor + multi-agent loops ──
      const meetingExecutor = new MeetingExecutor();
      meetingExecutor.setProviders(providers, defaultProvider);
      meetingExecutor.setConfig(ctx.config);
      agentsModule.registerMeetingExecutor(meetingExecutor);
      meetingExecutorRef = meetingExecutor;

      // Debate orchestrator — subscribes to conversation messages and auto-opens
      // debates when agents disagree. Kill switch: AGENTS_AUTO_DEBATE=0.
      const debateOrchestrator = new DebateOrchestrator(
        agentService,
        meetingExecutor,
        ctx.events,
      );
      debateOrchestrator.start();

      // Inbox waker — flips post_to_colleague from "lazy mailbox" to a real
      // wake-up signal. Kill switch: AGENTS_INBOX_WAKE=0.
      const inboxWaker = new InboxWaker(
        agentService,
        agentExecutor,
        ctx.events,
        { quietMs: ctx.config.agents?.inboxWakeQuietMs ?? 300_000 },
      );
      inboxWaker.start();

      // Conversation subscriptions — agents that follow a conversation get a
      // run on every matching new turn. Kill switch:
      // AGENTS_CONVERSATION_SUBSCRIPTIONS=0.
      const subscriptionEngine = new ConversationSubscriptionEngine(
        agentService,
        agentExecutor,
        ctx.events,
        { cooldownMs: ctx.config.agents?.subscriptionCooldownMs ?? 60_000 },
        ctx.config,
      );
      subscriptionEngine.start();

      // Reflection optimizer — uses the eval provider/model for cheap meta-LLM calls.
      const reflectionOptimizer = new ReflectionOptimizer(agentService);
      reflectionOptimizer.setProviders(providers, evalProvider);
      reflectionOptimizer.setConfig(ctx.config);
      agentsModule.registerReflectionOptimizer(reflectionOptimizer);

      // ── Office structure seeders ──
      // These ran historically inside the bootstrap `wireServices` stage; we
      // own them now. Order matters: reorg first so later seeders see the
      // renamed/merged flows. All idempotent.
      seedOfficeReorg(ctx.sqlite, agentService);
      seedDebateRule(ctx.sqlite);

      // ── Tools contributed to the kernel-wide catalog ──
      tools = [
        ...workspaceTools(agentService, workspaceService),
        ...workspaceEvolverTools(agentService, agentExecutor, workspaceEvolver),
      ];

      // Reaper that tears down docker-compose workspaces after 30 min idle.
      startWorkspaceComposeReaper();
      started = true;
    },

    getTools(): ToolDefinition[] {
      return tools;
    },

    getDemoHandlers(): Map<string, BuiltinHandler> | null {
      if (!started || !agentsRef || !meetingExecutorRef) return null;
      const service = agentsRef.getService();
      if (!service) return null;
      const ctx = ctxRef;
      if (!ctx) return null;
      return createDemoHandlers({
        service,
        events: ctx.events,
        meetingExecutor: meetingExecutorRef,
        // Read at call time, not captured: the operator can flip the system
        // language at runtime via POST /api/config/language and the next run
        // has to pick it up.
        getLanguage: () => ctx.config.language,
      });
    },

    runDemoOfficeSeed(events: EventBus): void {
      if (process.env.DEMO_OFFICE !== "1") {
        log.info("Demo Office: skipped (set DEMO_OFFICE=1 to enable)");
        return;
      }
      if (!started || !agentsRef || !ctxRef) {
        log.warn("Demo Office: skipped — agent-advanced not initialised");
        return;
      }
      const service = agentsRef.getService();
      const executor = agentsRef.getExecutor();
      if (!service) {
        log.warn("Demo Office: skipped — no AgentService");
        return;
      }
      log.info("Demo Office: about to seed (kickoff included)…");
      try {
        if (executor) {
          seedDemoOffice(ctxRef.sqlite, service, executor, events);
        } else {
          seedDemoOffice(ctxRef.sqlite, service);
        }
      } catch (err) {
        log.error("Demo Office seeding FAILED", err);
      }
    },

    async shutdown() {
      if (!started) return;
      stopWorkspaceComposeReaper();
      // Drain any still-running compose stacks so we don't leak containers.
      await shutdownAllCompose();
    },
  };
}
