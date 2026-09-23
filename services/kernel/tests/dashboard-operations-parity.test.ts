/**
 * The dashboard reaches the cross-cutting dashboard actions (aggregators,
 * health, PII status, notifications, channels, AI config, architecture,
 * skills) through rpcOrCall: WS RPC when the bridge is up, the HTTP route
 * otherwise. The two used to be separate implementations and answered
 * differently for the same request. They are one function now; these tests
 * pin the places they had drifted apart, driven through both roads.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { EventBus } from "../src/core/event-bus.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import type { Notifier } from "../src/core/notify/notifier.js";
import type { SystemRegistry } from "../src/core/system-registry.js";
import type { ModuleRegistry } from "../src/core/module-registry.js";
import type { SkillRegistry } from "../src/skills/registry.js";
import type { ConfigService } from "../src/modules/config/service.js";
import type { Neo4jClient } from "../src/core/db/neo4j.js";
import { dashboardRpcActions } from "../src/modules/dashboard/rpc-actions.js";
import { registerDashboardRoutes } from "../src/modules/dashboard/api-routes.js";
import { registerArchitectureRoutes } from "../src/modules/dashboard/architecture-routes.js";
import { registerAiConfigRoutes } from "../src/modules/config/ai-routes.js";
import { registerSkillRoutes } from "../src/modules/skills/api-routes.js";
import { dateRange } from "../src/modules/dashboard/operations.js";
import { maskKey } from "../src/modules/config/ai-operations.js";

describe("dashboard operations answer alike over RPC and HTTP", () => {
  let db: InstanceType<typeof Database>;
  let server: KernelHttpServer;
  let base = "";
  let rpc: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  let purged: number[];
  let markedAll: number;
  let channelStore: Record<string, Record<string, unknown>>;
  let config: KernelConfig;
  const savedChainEnv = process.env.AGENTS_DEFAULT_MODEL_CHAIN;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.run("CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, description TEXT, provider TEXT, model TEXT, active INTEGER, builtin_handler TEXT, updated_at TEXT)");
    db.run("INSERT INTO agents VALUES ('a1', 'A', '', 'claude', 'm', 1, NULL, '')");
    db.run("CREATE TABLE marketplace_items (slug TEXT, type TEXT, status TEXT, updated_at TEXT)");
    const events = new EventBus();
    purged = [];
    markedAll = 0;

    // "tg" is the one configured channel: a secret botToken and a plain chatId.
    channelStore = { tg: { botToken: "123:SECRET-TOKEN", chatId: "42" } };
    const channelRegistry = {
      getStatuses: () => [],
      getConfigSchema: (id: string) => id === "tg"
        ? [{ key: "botToken", type: "password" }, { key: "chatId", type: "text" }]
        : null,
      loadConfig: (id: string) => channelStore[id] ?? {},
      saveConfig: (id: string, cfg: Record<string, unknown>) => {
        if (id !== "tg") return false;
        channelStore[id] = cfg;
        return true;
      },
      getProvider: () => undefined,
      startProvider: async () => false,
      stopProvider: async () => true,
      lastStartError: "boom",
    };
    const notifier = {
      getNotifications: () => [],
      getUnreadCount: () => 0,
      markRead: () => {},
      markAllRead: () => { markedAll++; },
      deleteNotification: () => {},
      purgeOld: (days: number) => { purged.push(days); },
      getRegistry: () => channelRegistry,
    } as unknown as Notifier;
    const systemRegistry = { list: () => [], getStats: () => ({}) } as unknown as SystemRegistry;
    const moduleRegistry = {
      getInitializedModules: () => ["dashboard"],
      getAllTools: () => [{ name: "kernel_dashboard_x" }],
    } as unknown as ModuleRegistry;
    const skillRegistry = {
      getAllSkills: () => new Map(),
      getSkill: () => undefined,
      grantPermissions: () => {},
      enableSkill: async () => false,
      disableSkill: async () => {},
      uninstall: async () => false,
    } as unknown as SkillRegistry;
    // A settings store stub keeps save from writing the real .env.
    const configService = { set: () => ({}) } as unknown as ConfigService;
    config = {
      timezone: "UTC",
      voice: { elevenLabsApiKey: "" },
      chat: { defaultProvider: "", defaultModel: "" },
      agents: { defaultProvider: "", defaultModel: "", defaultModelChain: [{ provider: "claude", model: "x" }] },
      webIntel: { defaultLlm: "" },
      google: { clientId: "", clientSecret: "" },
      claudeCode: {},
    } as unknown as KernelConfig;
    const getGraph = () => null;

    const actions = dashboardRpcActions({
      db, neo4j: {} as Neo4jClient, getGraph, systemRegistry, notifier, skillRegistry,
      config, events, moduleRegistry, configService,
    });
    rpc = (name, args = {}) => {
      const action = actions.find((a) => a.name === name);
      if (!action) throw new Error(`no RPC action ${name}`);
      return action.handler(args);
    };

    server = new KernelHttpServer({
      config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
    });
    registerDashboardRoutes(server, db, async () => null, getGraph, null, systemRegistry, config, notifier, events);
    registerArchitectureRoutes(server, { registry: moduleRegistry, events, getGraph, sqlite: db, systemRegistry });
    registerAiConfigRoutes(server, config, undefined, undefined, events, db, undefined, configService);
    registerSkillRoutes(server, skillRegistry);
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(async () => {
    await server.stop();
    db.close();
    if (savedChainEnv === undefined) delete process.env.AGENTS_DEFAULT_MODEL_CHAIN;
    else process.env.AGENTS_DEFAULT_MODEL_CHAIN = savedChainEnv;
  });

  const http = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const keys = (o: unknown) => Object.keys(o as object).sort();
  const sameShape = async (name: string, path: string) => {
    const viaRpc = await rpc(name);
    const viaHttp = await (await http("GET", path)).json();
    expect(keys(viaRpc)).toEqual(keys(viaHttp));
    return { viaRpc, viaHttp };
  };

  it("config.ai.get returns agentsDefaultModelChain over RPC too, keys masked on both", async () => {
    const { viaRpc, viaHttp } = await sameShape("config.ai.get", "/api/config/ai");
    const d = (x: unknown) => (x as { defaults: Record<string, unknown> }).defaults;
    expect(d(viaRpc).agentsDefaultModelChain).toEqual([{ provider: "claude", model: "x" }]);
    expect(keys(d(viaRpc))).toEqual(keys(d(viaHttp)));
    expect(maskKey("sk-1234567890abcdef")).toBe("sk-12345***cdef");
  });

  it("config.ai.save writes agentsDefaultModelChain over RPC (it used to drop it)", async () => {
    const out = await rpc("config.ai.save", { agentsDefaultModelChain: [{ provider: "openai", model: "y" }, { bogus: 1 }] }) as { updated: string[] };
    expect(out.updated).toEqual(["AGENTS_DEFAULT_MODEL_CHAIN"]);
    expect(config.agents.defaultModelChain).toEqual([{ provider: "openai", model: "y" }]);
  });

  it("config.ai.agents.update needs agent_id on HTTP too (was an undefined bind, a 500)", async () => {
    const res = await http("POST", "/api/config/ai/agents/update", { provider: "p", model: "m" });
    expect(res.status).toBe(400);
    await expect(rpc("config.ai.agents.update", { provider: "p" })).rejects.toThrow("agent_id required");
    expect((await http("GET", "/api/config/ai/agents")).status).toBe(200);
    await sameShape("config.ai.agents", "/api/config/ai/agents");
  });

  it("pii.status, systemAgenda, health and cross-intel answer the same fields on both roads", async () => {
    await sameShape("pii.status", "/api/pii/status");
    await sameShape("dashboard.systemAgenda", "/api/dashboard/system-agenda");
    await sameShape("server.health", "/api/health");
    const { viaRpc } = await sameShape("dashboard.crossIntel", "/api/dashboard/cross-intel");
    expect(viaRpc).toEqual({ available: false });
  });

  it("the timeline window takes start/days on both roads, date/limit kept as aliases", () => {
    expect(dateRange({ start: "2026-01-01", days: "500" })).toEqual(["2026-01-01", 365]);
    expect(dateRange({ date: "2026-02-02", limit: 10 })).toEqual(["2026-02-02", 10]);
    expect(dateRange({})[1]).toBe(150);
  });

  it("architecture answers the topology and the metrics over RPC, not a thinner shape", async () => {
    const { viaRpc } = await sameShape("architecture.get", "/api/architecture");
    expect(keys(viaRpc)).toEqual(["links", "meta", "nodes"]);
    const m = await sameShape("architecture.metrics", "/api/architecture/metrics");
    expect(keys(m.viaRpc)).toEqual(["health", "modules", "timeline"]);
  });

  it("the HTTP purge honours daysOld (it always purged 30)", async () => {
    expect((await http("DELETE", "/api/notifications?daysOld=7")).status).toBe(200);
    await rpc("notifications.deleteOld", { daysOld: 7 });
    expect((await http("DELETE", "/api/notifications")).status).toBe(200);
    expect(purged).toEqual([7, 7, 30]);
  });

  it("an id that is there but empty is a 400, never 'mark all' or 'purge'", async () => {
    expect((await http("POST", "/api/notifications/read", { id: "" })).status).toBe(400);
    expect((await http("DELETE", "/api/notifications?id=")).status).toBe(400);
    expect(markedAll).toBe(0);
    expect(purged).toEqual([]);
    await expect(rpc("notifications.markRead", {})).rejects.toThrow("id required");
    // requireBody: an empty body is still refused; `{}` still means all.
    expect((await http("POST", "/api/notifications/read")).status).toBe(400);
    expect((await http("POST", "/api/notifications/read", {})).status).toBe(200);
    expect(markedAll).toBe(1);
  });

  it("channels.schema answers `config` with secrets masked on both roads", async () => {
    const viaRpc = await rpc("channels.schema", { id: "tg" }) as { config: Record<string, unknown> };
    const viaHttp = await (await http("GET", "/api/channels/schema?id=tg")).json() as typeof viaRpc;
    for (const out of [viaRpc, viaHttp]) {
      expect(out.config).toEqual({ botToken: "••••••••", chatId: "42" });
      expect(JSON.stringify(out)).not.toContain("SECRET");
    }
  });

  it("channels.config.save keeps a secret sent blank or masked and replaces it when a new one is typed", async () => {
    await rpc("channels.config.save", { id: "tg", config: { botToken: "", chatId: "7" } });
    expect(channelStore.tg).toEqual({ botToken: "123:SECRET-TOKEN", chatId: "7" });
    await http("POST", "/api/channels/config", { id: "tg", config: { botToken: "••••••••", chatId: "8" } });
    expect(channelStore.tg).toEqual({ botToken: "123:SECRET-TOKEN", chatId: "8" });
    await rpc("channels.config.save", { id: "tg", config: { botToken: "456:NEW", chatId: "8" } });
    expect(channelStore.tg.botToken).toBe("456:NEW");
  });

  it("failures reject over RPC (they used to resolve as { error }) and keep the HTTP status and body", async () => {
    const res = await http("POST", "/api/channels/start", { id: "x" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Failed to start "x"', detail: "boom" });
    await expect(rpc("channels.start", { id: "x" })).rejects.toThrow('Failed to start "x"');

    expect((await http("GET", "/api/channels/schema?id=nope")).status).toBe(404);
    await expect(rpc("channels.schema", { id: "nope" })).rejects.toThrow('No provider "nope"');

    expect((await http("DELETE", "/api/skills/uninstall?id=s")).status).toBe(404);
    await expect(rpc("skills.uninstall", { id: "s" })).rejects.toThrow("Skill not found or failed to remove");
    await expect(rpc("skills.enable", { id: "s" })).rejects.toThrow("Failed to enable skill");
    await expect(rpc("skills.install", { type: "local", path: 42 })).rejects.toThrow("path required for local install");
  });
});
