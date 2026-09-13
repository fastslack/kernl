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
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatUptime } from "./format.js";
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
import type { SkillPermission } from "../../skills/types.js";
import type { ConfigService } from "../config/service.js";
import { getGlobalPiiFilter } from "../../core/pii-filter.js";
import { createChatProviders } from "../../core/llm/chat-adapters.js";
import { writeEnvFile } from "../config/ai-routes.js";
import { log } from "../../core/logger.js";
import {
  queryKpis,
  queryFullDashboard,
  queryAgenda,
  queryCrossModuleIntel,
  querySystemTimeline,
} from "./api.js";
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
}

const startedAt = Date.now();

/** Mask a key: show first 8 chars + *** */
function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return key.slice(0, 2) + "***";
  return key.slice(0, 8) + "***" + key.slice(-4);
}

export function dashboardRpcActions(deps: DashboardRpcDeps): RpcAction[] {
  const { db, neo4j, systemRegistry, dashboardRegistry, llmRegistry } = deps;

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

  const actions: RpcAction[] = [
    ...autoActions,
    // ── Cross-module aggregators (no extension owns these) ──
    {
      name: "dashboard.full",
      handler: async () =>
        queryFullDashboard(db, async (name) => dashboardRegistry?.queryChannel(name, db, neo4j)),
    },
    {
      name: "dashboard.kpis",
      handler: async () => queryKpis(db),
    },
    {
      name: "dashboard.agenda",
      handler: async () => queryAgenda(db),
    },
    {
      name: "dashboard.crossIntel",
      handler: async () => queryCrossModuleIntel(db) ?? { available: false },
    },
    // Agents lives in core, not in an extension — keep here.
    {
      name: "dashboard.agents",
      handler: async () => queryAgents(db),
    },
    {
      name: "dashboard.agentsList",
      handler: async () => queryAgentsList(db),
    },
    {
      name: "dashboard.systemTimeline",
      handler: async (args) => {
        const date = typeof args.date === "string" ? args.date : new Date().toISOString().split("T")[0];
        const limit = typeof args.limit === "number" ? args.limit : 150;
        return querySystemTimeline(db, date, limit, systemRegistry);
      },
    },
    {
      name: "dashboard.systemAgenda",
      handler: async () => ({
        processes: systemRegistry.list(),
        stats: systemRegistry.getStats(),
      }),
    },
  ];

  // ── PII Filter ──
  actions.push({
    name: "pii.status",
    handler: async () => {
      const filter = getGlobalPiiFilter();
      const cfg = filter.getConfig();
      return {
        enabled: filter.isEnabled(),
        redactEmails: cfg.redactEmails,
        redactPhones: cfg.redactPhones,
        redactCreditCards: cfg.redactCreditCards,
        redactIbans: cfg.redactIbans,
        redactIps: cfg.redactIps,
        redactNames: cfg.redactNames,
        redactAddresses: cfg.redactAddresses,
        knownNames: cfg.knownNames.size,
        customPatterns: cfg.customPatterns.length,
      };
    },
  });

  // ── Architecture ──
  if (deps.moduleRegistry && deps.events) {
    const modRegistry = deps.moduleRegistry;
    const evts = deps.events;
    actions.push(
      {
        name: "architecture.get",
        handler: async () => {
          const modules = modRegistry.getInitializedModules();
          const allTools = modRegistry.getAllTools();
          const eventNames = evts.eventNames();
          const processes = systemRegistry.list();
          const stats = systemRegistry.getStats();
          return { modules, toolCount: allTools.length, eventCount: eventNames.length, processes, stats };
        },
      },
      {
        name: "architecture.metrics",
        handler: async () => {
          const modules = modRegistry.getInitializedModules();
          const processes = systemRegistry.list();
          const stats = systemRegistry.getStats();
          return { modules, processes, stats };
        },
      },
    );
  }

  // ── Notifications ──
  if (deps.notifier) {
    const notifier = deps.notifier;
    const channelRegistry = notifier.getRegistry();
    actions.push(
      {
        name: "notifications.list",
        handler: async (args) => {
          const unreadOnly = args.unreadOnly === true;
          const limit = typeof args.limit === "number" ? args.limit : 50;
          const notifications = notifier.getNotifications({ unreadOnly, limit });
          const unread = notifier.getUnreadCount();
          return { notifications, unread };
        },
      },
      {
        name: "notifications.markRead",
        handler: async (args) => {
          if (!args.id || typeof args.id !== "string") return { error: "id required" };
          notifier.markRead(args.id);
          deps.events?.emit("data.changed", { module: "notifications", action: "read" });
          return { success: true, unread: notifier.getUnreadCount() };
        },
      },
      {
        name: "notifications.markAllRead",
        handler: async () => {
          notifier.markAllRead();
          deps.events?.emit("data.changed", { module: "notifications", action: "read" });
          return { success: true, unread: notifier.getUnreadCount() };
        },
      },
      {
        name: "notifications.delete",
        handler: async (args) => {
          if (!args.id || typeof args.id !== "string") return { error: "id required" };
          notifier.deleteNotification(args.id);
          deps.events?.emit("data.changed", { module: "notifications", action: "delete" });
          return { success: true, unread: notifier.getUnreadCount() };
        },
      },
      {
        name: "notifications.deleteOld",
        handler: async (args) => {
          const daysOld = typeof args.daysOld === "number" ? args.daysOld : 30;
          notifier.purgeOld(daysOld);
          deps.events?.emit("data.changed", { module: "notifications", action: "delete" });
          return { success: true, unread: notifier.getUnreadCount() };
        },
      },
    );

    // ── Channels ──
    if (channelRegistry) {
      actions.push(
        {
          name: "channels.list",
          handler: async () => ({ channels: channelRegistry.getStatuses() }),
        },
        {
          name: "channels.schema",
          handler: async (args) => {
            const id = typeof args.id === "string" ? args.id : "";
            if (!id) return { error: "Missing id parameter" };
            const schema = channelRegistry.getConfigSchema(id);
            if (!schema) return { error: `No provider "${id}"` };
            const cfg = channelRegistry.loadConfig(id) ?? {};
            return { id, schema, config: cfg };
          },
        },
        {
          name: "channels.config.save",
          handler: async (args) => {
            const id = typeof args.id === "string" ? args.id : "";
            const cfg = args.config as Record<string, unknown> | undefined;
            if (!id || !cfg) return { error: "Missing id or config" };
            const saved = channelRegistry.saveConfig(id, cfg);
            if (!saved) return { error: `Channel "${id}" not found in marketplace` };
            return { success: true };
          },
        },
        {
          name: "channels.test",
          handler: async (args) => {
            const id = typeof args.id === "string" ? args.id : "";
            if (!id) return { error: "Missing id" };
            const provider = channelRegistry.getProvider(id);
            if (!provider?.isReady()) return { error: `Provider "${id}" not running` };
            let ok: boolean;
            if (provider.sendTest) {
              ok = await provider.sendTest();
            } else {
              ok = await provider.sendNotification({ title: `Kernl test — ${provider.name}`, body: "Channel working!" });
            }
            return { success: ok };
          },
        },
        {
          name: "channels.start",
          handler: async (args) => {
            const id = typeof args.id === "string" ? args.id : "";
            if (!id) return { error: "Missing id" };
            db.prepare("UPDATE marketplace_items SET status = 'active', updated_at = ? WHERE slug = ? AND type = 'channel'")
              .run(new Date().toISOString(), id);
            const ok = await channelRegistry.startProvider(id);
            if (!ok) {
              return {
                error: `Failed to start "${id}"`,
                detail: channelRegistry.lastStartError || "Unknown error — check server logs",
              };
            }
            return { success: true, status: channelRegistry.getProvider(id)?.getStatus() };
          },
        },
        {
          name: "channels.stop",
          handler: async (args) => {
            const id = typeof args.id === "string" ? args.id : "";
            if (!id) return { error: "Missing id" };
            db.prepare("UPDATE marketplace_items SET status = 'installed', updated_at = ? WHERE slug = ? AND type = 'channel'")
              .run(new Date().toISOString(), id);
            const ok = await channelRegistry.stopProvider(id);
            return { success: true, stopped: ok };
          },
        },
        {
          name: "channels.qr",
          handler: async () => {
            const provider = channelRegistry.getProvider("whatsapp") as any;
            if (!provider) return { error: "WhatsApp provider not registered" };
            const qr = provider.getQr?.() ?? null;
            const status = provider.getStatus?.() ?? {};
            return {
              qr,
              connected: status.connected ?? false,
              phoneNumber: status.info?.phoneNumber ?? null,
              error: status.error ?? null,
            };
          },
        },
        {
          name: "channels.whatsapp.send",
          handler: async (args) => {
            const phone = typeof args.phone === "string" ? args.phone : "";
            const message = typeof args.message === "string" ? args.message : "";
            if (!phone || !message) return { error: "Missing phone or message" };
            const provider = channelRegistry.getProvider("whatsapp") as any;
            if (!provider?.isReady()) return { error: "WhatsApp not connected" };
            const cleaned = phone.replace(/[\s\-\+\(\)]/g, "");
            const jid = cleaned.includes("@") ? cleaned : `${cleaned}@s.whatsapp.net`;
            const ok = await provider.sendTo(jid, { title: "", body: message });
            return { success: ok, jid };
          },
        },
      );
    }
  }

  // ── AI Config ──
  if (deps.config) {
    const aiCfg = deps.config;
    const envPath = resolve(process.cwd(), ".env");

    actions.push(
      {
        name: "config.ai.get",
        handler: async () => {
          const anthropicKey = aiCfg.webIntel.anthropicApiKey;
          const openaiKey = aiCfg.webIntel.openaiApiKey;
          const grokKey = aiCfg.webIntel.grokApiKey;
          const nvidiaKey = aiCfg.webIntel.nvidiaApiKey;
          const elevenLabsKey = aiCfg.voice.elevenLabsApiKey;
          return {
            providers: {
              anthropic: { configured: anthropicKey.length > 0, keyMasked: maskKey(anthropicKey) },
              openai: { configured: openaiKey.length > 0, keyMasked: maskKey(openaiKey) },
              grok: { configured: grokKey.length > 0, keyMasked: maskKey(grokKey), defaultModel: aiCfg.webIntel.grokDefaultModel },
              nvidia: { configured: nvidiaKey.length > 0, keyMasked: maskKey(nvidiaKey), defaultModel: aiCfg.webIntel.nvidiaDefaultModel },
              lmstudio: { configured: aiCfg.webIntel.lmstudioBaseUrl.length > 0, baseUrl: aiCfg.webIntel.lmstudioBaseUrl },
              minimax: (() => {
                const mm = (llmRegistry?.loadConfig("minimax") ?? {}) as Record<string, unknown>;
                const key = (typeof mm.apiKey === "string" && mm.apiKey) ? mm.apiKey : (process.env.MINIMAX_API_KEY ?? "");
                const model = (typeof mm.defaultModel === "string" && mm.defaultModel) ? mm.defaultModel : (process.env.MINIMAX_DEFAULT_MODEL ?? "");
                return { configured: key.length > 0, keyMasked: maskKey(key), defaultModel: model };
              })(),
              elevenlabs: { configured: elevenLabsKey.length > 0, keyMasked: maskKey(elevenLabsKey) },
            },
            defaults: {
              chatProvider: aiCfg.chat.defaultProvider,
              chatModel: aiCfg.chat.defaultModel,
              agentsProvider: aiCfg.agents.defaultProvider,
              agentsModel: aiCfg.agents.defaultModel,
              webIntelLlm: aiCfg.webIntel.defaultLlm,
            },
            envFileExists: existsSync(envPath),
          };
        },
      },
      {
        name: "config.ai.save",
        handler: async (args) => {
          // Per-request tracking of persisted keys. `persist()` routes through
          // ConfigService (settings store: app_settings + .env + process.env
          // mirror + config:changed) when available — same flow the HTTP
          // `/api/config/ai` route uses — and ALWAYS mirrors process.env so
          // the in-process provider re-init below sees the new value
          // regardless. When ConfigService isn't wired (defensive), the
          // fallback block below does the legacy batch .env write + manual
          // event emit (via the shared `writeEnvFile` from ai-routes.js).
          const configService = deps.configService;
          const envUpdates: Record<string, string> = {};
          const persist = (key: string, value: string): void => {
            envUpdates[key] = value;
            process.env[key] = value; // env mirror — provider re-init reads process.env
            if (configService) {
              try { configService.set(key, value, "user"); } catch { /* keep going; env mirror already applied */ }
            }
          };

          const body = args as Record<string, string | undefined>;

          if (body.anthropicApiKey && body.anthropicApiKey !== "") {
            persist("ANTHROPIC_API_KEY", body.anthropicApiKey);
            aiCfg.webIntel.anthropicApiKey = body.anthropicApiKey;
          }
          if (body.openaiApiKey && body.openaiApiKey !== "") {
            persist("OPENAI_API_KEY", body.openaiApiKey);
            aiCfg.webIntel.openaiApiKey = body.openaiApiKey;
            aiCfg.voice.openaiApiKey = body.openaiApiKey;
          }
          if (body.grokApiKey && body.grokApiKey !== "") {
            persist("GROK_API_KEY", body.grokApiKey);
            aiCfg.webIntel.grokApiKey = body.grokApiKey;
          }
          if (body.grokDefaultModel !== undefined) {
            persist("GROK_DEFAULT_MODEL", body.grokDefaultModel ?? "");
            aiCfg.webIntel.grokDefaultModel = body.grokDefaultModel ?? "";
          }
          if (body.nvidiaApiKey && body.nvidiaApiKey !== "") {
            persist("NVIDIA_API_KEY", body.nvidiaApiKey);
            aiCfg.webIntel.nvidiaApiKey = body.nvidiaApiKey;
          }
          if (body.nvidiaDefaultModel !== undefined) {
            persist("NVIDIA_DEFAULT_MODEL", body.nvidiaDefaultModel ?? "");
            aiCfg.webIntel.nvidiaDefaultModel = body.nvidiaDefaultModel ?? "";
          }
          if (body.googleClientId && body.googleClientId !== "") {
            persist("GOOGLE_CLIENT_ID", body.googleClientId);
            aiCfg.google.clientId = body.googleClientId;
          }
          if (body.googleClientSecret && body.googleClientSecret !== "") {
            persist("GOOGLE_CLIENT_SECRET", body.googleClientSecret);
            aiCfg.google.clientSecret = body.googleClientSecret;
          }
          if (body.lmstudioBaseUrl !== undefined) {
            persist("LMSTUDIO_BASE_URL", body.lmstudioBaseUrl ?? "");
            aiCfg.webIntel.lmstudioBaseUrl = body.lmstudioBaseUrl ?? "";
          }
          // MiniMax — registry-native: persist to settings_json + mirror to env.
          {
            const mm = (llmRegistry?.loadConfig("minimax") ?? {}) as Record<string, unknown>;
            let mmChanged = false;
            if (body.minimaxApiKey && body.minimaxApiKey !== "") {
              mm.apiKey = body.minimaxApiKey; mmChanged = true;
              persist("MINIMAX_API_KEY", body.minimaxApiKey);
            }
            if (body.minimaxBaseUrl !== undefined) {
              mm.baseUrl = body.minimaxBaseUrl ?? ""; mmChanged = true;
              persist("MINIMAX_BASE_URL", body.minimaxBaseUrl ?? "");
            }
            if (body.minimaxDefaultModel !== undefined) {
              mm.defaultModel = body.minimaxDefaultModel ?? ""; mmChanged = true;
              persist("MINIMAX_DEFAULT_MODEL", body.minimaxDefaultModel ?? "");
            }
            if (mmChanged && llmRegistry) {
              llmRegistry.saveConfig("minimax", mm);
              await llmRegistry.startProvider("minimax").catch(() => {});
            }
          }
          if (body.elevenLabsApiKey && body.elevenLabsApiKey !== "") {
            persist("ELEVENLABS_API_KEY", body.elevenLabsApiKey);
            aiCfg.voice.elevenLabsApiKey = body.elevenLabsApiKey;
          }
          if (body.chatProvider !== undefined) {
            persist("CHAT_DEFAULT_PROVIDER", body.chatProvider ?? "");
            aiCfg.chat.defaultProvider = body.chatProvider ?? "";
          }
          if (body.chatModel !== undefined) {
            persist("CHAT_DEFAULT_MODEL", body.chatModel ?? "");
            aiCfg.chat.defaultModel = body.chatModel ?? "";
          }
          if (body.agentsProvider !== undefined) {
            persist("AGENTS_DEFAULT_PROVIDER", body.agentsProvider ?? "");
            aiCfg.agents.defaultProvider = body.agentsProvider ?? "";
          }
          if (body.agentsModel !== undefined) {
            persist("AGENTS_DEFAULT_MODEL", body.agentsModel ?? "");
            aiCfg.agents.defaultModel = body.agentsModel ?? "";
          }
          if (body.webIntelLlm !== undefined) {
            persist("WEBINTEL_DEFAULT_LLM", body.webIntelLlm ?? "");
            aiCfg.webIntel.defaultLlm = body.webIntelLlm ?? "";
          }

          if (Object.keys(envUpdates).length > 0) {
            if (configService) {
              // ConfigService already persisted each key (app_settings + .env +
              // process.env) and emitted config:changed. Nothing more to write.
              log.info(`AI config updated via RPC: ${Object.keys(envUpdates).join(", ")}`);
            } else {
              // Fallback (ConfigService not wired): legacy batch .env write + emit.
              try {
                writeEnvFile(envPath, envUpdates);
                log.info(`AI config updated via RPC: ${Object.keys(envUpdates).join(", ")}`);
              } catch (writeErr) {
                log.warn("Could not write .env file — in-memory only", writeErr);
              }
              if (deps.events) {
                for (const [key, value] of Object.entries(envUpdates)) {
                  deps.events.emit("config:changed", { key, value, updatedBy: "rpc" });
                }
              }
            }
            const providerKeysChanged = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LMSTUDIO_BASE_URL", "GROK_API_KEY", "XAI_API_KEY", "GROK_DEFAULT_MODEL", "NVIDIA_API_KEY", "NVIDIA_DEFAULT_MODEL", "MINIMAX_API_KEY", "MINIMAX_BASE_URL", "MINIMAX_DEFAULT_MODEL"].some(
              (k) => k in envUpdates,
            );
            if (providerKeysChanged) {
              if (deps.chatService) deps.chatService.reloadProviders();
              if (deps.agentExecutor) {
                const newProviders = createChatProviders({
                  anthropicApiKey: aiCfg.webIntel.anthropicApiKey,
                  openaiApiKey: aiCfg.webIntel.openaiApiKey,
                  lmstudioBaseUrl: aiCfg.webIntel.lmstudioBaseUrl,
                  grokApiKey: aiCfg.webIntel.grokApiKey,
                  grokDefaultModel: aiCfg.webIntel.grokDefaultModel,
                  nvidiaApiKey: aiCfg.webIntel.nvidiaApiKey,
                  nvidiaDefaultModel: aiCfg.webIntel.nvidiaDefaultModel,
                  minimaxApiKey: process.env.MINIMAX_API_KEY,
                  minimaxBaseUrl: process.env.MINIMAX_BASE_URL,
                  minimaxDefaultModel: process.env.MINIMAX_DEFAULT_MODEL,
                  claudeCode: aiCfg.claudeCode,
                });
                deps.agentExecutor.setProviders(newProviders, aiCfg.agents.defaultProvider || aiCfg.chat.defaultProvider);
              }
              const { reloadLlmClient } = await import("../../core/llm/client.js");
              reloadLlmClient(aiCfg);
              log.info("LLM providers hot-reloaded via RPC");
            }
          }

          return {
            success: true,
            updated: Object.keys(envUpdates),
            envPersisted: existsSync(envPath),
            note: Object.keys(envUpdates).length === 0
              ? "No changes detected"
              : "Providers reloaded — no restart needed.",
          };
        },
      },
      {
        name: "config.ai.test",
        handler: async () => {
          // Delegate to the central helper — same code path as the HTTP
          // /api/config/ai/test endpoint. Uses each provider's listModels()
          // via the registry instead of duplicating per-provider fetch.
          if (!llmRegistry) {
            return { error: "llmRegistry not wired into dashboardRpcActions" };
          }
          const { testAllProviders } = await import("../../core/llm/test-providers.js");
          return testAllProviders(llmRegistry);
        },
      },
      {
        name: "config.ai.agents",
        handler: async () => {
          try {
            const agents = db.prepare(
              "SELECT id, name, description, provider, model, active, builtin_handler FROM agents WHERE active = 1 ORDER BY name"
            ).all();
            return { agents };
          } catch {
            return { agents: [] };
          }
        },
      },
      {
        name: "config.ai.agents.update",
        handler: async (args) => {
          const agentId = typeof args.agent_id === "string" ? args.agent_id : "";
          const provider = typeof args.provider === "string" ? args.provider : "";
          const model = typeof args.model === "string" ? args.model : "";
          if (!agentId) return { error: "agent_id required" };
          db.prepare("UPDATE agents SET provider = ?, model = ?, updated_at = datetime('now') WHERE id = ?")
            .run(provider, model, agentId);
          return { success: true };
        },
      },
    );
  }

  // ── Server ──
  actions.push(
    {
      name: "server.health",
      handler: async () => ({
        status: "ok",
        uptimeMs: Date.now() - startedAt,
        uptimeFormatted: formatUptime(Date.now() - startedAt),
        timezone: deps.config?.timezone ?? "UTC",
        services: {
          sqlite: true,
          graph: !!deps.getGraph?.()?.capabilities.cypher,
          dashboard: true,
        },
      }),
    },
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
    const skillReg = deps.skillRegistry;
    actions.push(
      {
        name: "skills.list",
        handler: async () => {
          const skills = skillReg.getAllSkills();
          const result = Array.from(skills.entries()).map(([id, state]) => ({
            id,
            name: state.manifest.name,
            description: state.manifest.description,
            version: state.manifest.version,
            author: state.manifest.author,
            homepage: state.manifest.homepage ?? null,
            icon: state.manifest.icon ?? null,
            category: state.manifest.category ?? "custom",
            status: state.status,
            permissions: state.manifest.permissions,
            grantedPermissions: state.config.grantedPermissions,
            tags: state.manifest.tags ?? [],
            toolCount: state.skill ? state.skill.tools.length : 0,
            loadedAt: state.loadedAt ?? null,
            error: state.error ?? null,
          }));
          return { skills: result, total: result.length };
        },
      },
      {
        name: "skills.enable",
        handler: async (args) => {
          const id = typeof args.id === "string" ? args.id : "";
          if (!id) return { error: "id required" };
          const autoGrant = args.grantPermissions !== false;
          if (autoGrant) {
            const state = skillReg.getSkill(id);
            if (state?.manifest.permissions) {
              skillReg.grantPermissions(id, state.manifest.permissions as SkillPermission[]);
            }
          }
          const ok = await skillReg.enableSkill(id);
          if (!ok) {
            const state = skillReg.getSkill(id);
            return { error: state?.error ?? "Failed to enable skill" };
          }
          return { success: true };
        },
      },
      {
        name: "skills.disable",
        handler: async (args) => {
          const id = typeof args.id === "string" ? args.id : "";
          if (!id) return { error: "id required" };
          await skillReg.disableSkill(id);
          return { success: true };
        },
      },
      {
        name: "skills.install",
        handler: async (args) => {
          try {
            const type = typeof args.type === "string" ? args.type : "";
            if (!type) return { error: "type required (local|npm|git|bundled)" };

            if (type === "bundled" && typeof args.id === "string") {
              const existing = skillReg.getSkill(args.id);
              if (existing) {
                if (args.autoEnable !== false && existing.status !== "enabled") {
                  const needed = existing.manifest.permissions as SkillPermission[];
                  if (needed.length > 0) skillReg.grantPermissions(args.id, needed);
                  await skillReg.enableSkill(args.id);
                }
                const state = skillReg.getSkill(args.id);
                return { success: true, skillId: args.id, status: state?.status ?? "installed" };
              }
            }

            let source: Parameters<typeof skillReg.install>[0];
            switch (type) {
              case "local":
                if (!args.path) return { error: "path required for local install" };
                source = { type: "local", path: String(args.path) };
                break;
              case "npm":
                if (!args.package) return { error: "package required for npm install" };
                source = { type: "npm", package: String(args.package), version: typeof args.version === "string" ? args.version : undefined };
                break;
              case "git":
                if (!args.url) return { error: "url required for git install" };
                source = { type: "git", url: String(args.url), ref: typeof args.ref === "string" ? args.ref : undefined };
                break;
              case "bundled":
                if (!args.id) return { error: "id required for bundled install" };
                source = { type: "bundled", id: String(args.id) };
                break;
              default:
                return { error: `Unknown install type: ${type}` };
            }

            const skillId = await skillReg.install(source);
            if (!skillId) return { error: "Installation failed — check server logs" };

            if (args.autoEnable !== false) {
              const freshState = skillReg.getSkill(skillId);
              if (freshState) {
                const needed = freshState.manifest.permissions as SkillPermission[];
                if (needed.length > 0) skillReg.grantPermissions(skillId, needed);
              }
              await skillReg.enableSkill(skillId);
            }

            const state = skillReg.getSkill(skillId);
            return { success: true, skillId, status: state?.status ?? "installed" };
          } catch (err) {
            return { error: String(err) };
          }
        },
      },
      {
        name: "skills.uninstall",
        handler: async (args) => {
          const id = typeof args.id === "string" ? args.id : "";
          if (!id) return { error: "id required" };
          const ok = await skillReg.uninstall(id);
          if (!ok) return { error: "Skill not found or failed to remove" };
          return { success: true };
        },
      },
    );
  }

  return actions;
}
