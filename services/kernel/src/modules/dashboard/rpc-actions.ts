/**
 * Dashboard RPC Actions — cross-cutting handlers that don't belong to any
 * single extension. The per-extension slices (tasks, crm, news, comms, etc.)
 * live in their own `assets/extensions/<name>/_module/dashboard-rpc-actions.ts`
 * files and are collected by `ModuleRegistry.getAllDashboardRpcActions()`.
 *
 * What stays here:
 *   - Cross-module aggregators (agenda, crossIntel, systemTimeline, full).
 *   - Core panels that don't have a module: agents/agentsList.
 *   - Infrastructure RPCs: PII filter, architecture, notifications, channels,
 *     AI config, server health/manifest, skills.
 *
 * Every action with an HTTP twin is an operation shared with its route (see
 * operations.ts, architecture-routes.ts, config/ai-operations.ts and
 * skills/operations.ts), so the two roads of `rpcOrCall` answer alike.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { Neo4jClient } from "../../core/db/neo4j.js";
import type { SystemRegistry } from "../../core/system-registry.js";
import type { ModuleRegistry } from "../../core/module-registry.js";
import type { DashboardRegistry } from "../../core/dashboard-registry.js";
import type { RpcAction } from "../../core/mtw/rpc-handler.js";
import type { Notifier } from "../../core/notify/notifier.js";
import type { SkillRegistry } from "../../skills/registry.js";
import type { KernelConfig } from "../../core/config.js";
import type { EventBus } from "../../core/event-bus.js";
import type { ChatService } from "../chat/service.js";
import type { AgentExecutor } from "../agents/executor.js";
import type { ConfigService } from "../config/service.js";
import { rpcActionsFrom, type Operation } from "../../sdk/args.js";
import { dashboardOperations, startedAt } from "./operations.js";
import { architectureOperations, type MtwRequestArchInfo } from "./architecture-routes.js";
import { aiConfigOperations } from "../config/ai-operations.js";
import { skillOperations } from "../skills/operations.js";
// agents (core module — not an extension): imported directly from the owning
// module's dashboard-queries.js (one-way dashboard → agents aggregation dep).
import { queryAgents, queryAgentsList } from "../agents/dashboard-queries.js";

interface DashboardRpcDeps {
  db: SqliteDb;
  neo4j: Neo4jClient;
  /**
   * Live getter for the active graph driver — read per-call so /extensions
   * toggles take effect without a kernel restart.
   */
  getGraph?: () => import("../../core/db-drivers/graph-driver.js").GraphDriver | null;
  systemRegistry: SystemRegistry;
  notifier?: Notifier | null;
  skillRegistry?: SkillRegistry | null;
  config?: KernelConfig | null;
  events?: EventBus | null;
  chatService?: ChatService | null;
  agentExecutor?: AgentExecutor | null;
  moduleRegistry?: ModuleRegistry | null;
  /** Registry emitting one RpcAction per registered channel (self-registering modules). */
  dashboardRegistry?: DashboardRegistry | null;
  /** LLM provider registry — used by the unified `config.ai.test` RPC
   *  so it delegates to each provider's `listModels()` instead of
   *  duplicating per-provider fetch logic. */
  llmRegistry?: import("../../core/llm/provider-registry.js").LlmProviderRegistry | null;
  /** Settings store (app_settings + .env + process.env mirror + config:changed).
   *  Threaded in so `config.ai.save` persists through the same flow as the
   *  HTTP `/api/config/ai` route instead of writing .env directly. Optional —
   *  when absent, `config.ai.save` falls back to the legacy .env-only write. */
  configService?: ConfigService | null;
  /** mtwRequest info for the architecture map (live object, see bootstrap/http.ts). */
  mtwRequestArch?: MtwRequestArchInfo | null;
}

/** The named subset of a set of operations. */
function pick(ops: Record<string, Operation>, names: string[]): Record<string, Operation> {
  return Object.fromEntries(names.map((name) => [name, ops[name]]));
}

export function dashboardRpcActions(deps: DashboardRpcDeps): RpcAction[] {
  const { db, neo4j, systemRegistry, dashboardRegistry } = deps;

  // Auto-generate `dashboard.<channel>` RpcActions for every channel registered
  // in the DashboardRegistry. Replaces the per-module hardcoded cases this file
  // used to carry. New modules (including `.kernl` extensions) become
  // available over RPC without touching this file.
  const autoActions: RpcAction[] = [];
  if (dashboardRegistry) {
    for (const channelName of dashboardRegistry.getChannelNames()) {
      autoActions.push({
        name: `dashboard.${channelName}`,
        handler: async () => {
          const d = await dashboardRegistry.queryChannel(channelName, db, neo4j);
          return d ?? { available: false };
        },
      });
    }
  }

  const ops = dashboardOperations({
    db,
    readChannel: async (name) => dashboardRegistry?.queryChannel(name, db, neo4j),
    getGraph: () => deps.getGraph?.() ?? null,
    systemRegistry,
    config: deps.config,
    notifier: deps.notifier,
    events: deps.events,
  });

  const actions: RpcAction[] = [
    ...autoActions,
    // ── Cross-module aggregators (no extension owns these) ──
    ...rpcActionsFrom(pick(ops, [
      "dashboard.full",
      "dashboard.kpis",
      "dashboard.agenda",
      "dashboard.crossIntel",
      "dashboard.systemTimeline",
      "dashboard.systemAgenda",
    ])),
    // Agents lives in core, not in an extension — keep here. Served over HTTP
    // as the agents module's `agents` dashboard channel.
    { name: "dashboard.agents", handler: async () => queryAgents(db) },
    { name: "dashboard.agentsList", handler: async () => queryAgentsList(db) },
    // ── PII Filter ──
    ...rpcActionsFrom(pick(ops, ["pii.status"])),
  ];

  // ── Architecture ──
  if (deps.moduleRegistry && deps.events) {
    actions.push(...rpcActionsFrom(architectureOperations({
      registry: deps.moduleRegistry,
      events: deps.events,
      getGraph: () => deps.getGraph?.() ?? null,
      sqlite: db,
      systemRegistry,
      mtwRequest: deps.mtwRequestArch,
    })));
  }

  // ── Notifications ──
  if (deps.notifier) {
    actions.push(...rpcActionsFrom(pick(ops, [
      "notifications.list",
      "notifications.markRead",
      "notifications.markAllRead",
      "notifications.delete",
      "notifications.deleteOld",
    ])));

    // ── Channels ──
    if (deps.notifier.getRegistry()) {
      actions.push(...rpcActionsFrom(pick(ops, [
        "channels.list",
        "channels.schema",
        "channels.config.save",
        "channels.test",
        "channels.start",
        "channels.stop",
        "channels.qr",
        "channels.whatsapp.send",
      ])));
    }
  }

  // ── AI Config ──
  if (deps.config) {
    actions.push(...rpcActionsFrom(aiConfigOperations({
      config: deps.config,
      chatService: deps.chatService,
      agentExecutor: deps.agentExecutor,
      events: deps.events,
      db,
      llmRegistry: deps.llmRegistry,
      configService: deps.configService,
    })));
  }

  // ── Server ──
  actions.push(
    ...rpcActionsFrom(pick(ops, ["server.health"])),
    // RPC only: GET /api/manifest is the extension manifest (sidebar, pages),
    // a different payload the dashboard fetches over HTTP on purpose.
    {
      name: "server.manifest",
      handler: async () => ({
        name: "Kernl",
        version: process.env.npm_package_version ?? "unknown",
        modules: systemRegistry.list().map((p: any) => p.name ?? p.id ?? String(p)),
        uptime: Date.now() - startedAt,
      }),
    },
  );

  // ── Skills ──
  if (deps.skillRegistry) {
    actions.push(...rpcActionsFrom(skillOperations(deps.skillRegistry)));
  }

  return actions;
}
