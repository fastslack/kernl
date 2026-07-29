import type { KernelHttpServer } from "../../core/http-server.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import type { ModuleRegistry } from "../../core/module-registry.js";
import type { EventBus } from "../../core/event-bus.js";
import type { SystemRegistry } from "../../core/system-registry.js";

export interface MtwRequestArchInfo {
  connected: boolean;
  rpcActionCount: number;
  rustDelegates: string[];
  bridgeEnabled: boolean;
  rustBridgeEnabled: boolean;
  /** Modules that have RPC actions registered */
  rpcModules: string[];
}

export function registerArchitectureRoutes(
  httpServer: KernelHttpServer,
  opts: {
    registry: ModuleRegistry;
    events: EventBus;
    getGraph: () => GraphDriver | null;
    sqlite: SqliteDb;
    systemRegistry: SystemRegistry;
    mtwRequest?: MtwRequestArchInfo;
  },
): void {
  const { registry, events, getGraph, sqlite, systemRegistry } = opts;
  const mtw = opts.mtwRequest;

  // Architecture 3D map endpoint — full system topology
  httpServer.get("/api/architecture", (_req, res) => {
    const modules = registry.getInitializedModules();
    const allTools = registry.getAllTools();
    const eventNames = events.eventNames();
    const processes = systemRegistry.list();
    const stats = systemRegistry.getStats();

    // Build module nodes with tool counts
    const moduleToolCounts: Record<string, number> = {};
    for (const t of allTools) {
      const mod = t.name.replace(/^kernel_/, "").split("_")[0];
      moduleToolCounts[mod] = (moduleToolCounts[mod] ?? 0) + 1;
    }

    // Build nodes
    const nodes: Array<Record<string, unknown>> = [];
    const links: Array<Record<string, unknown>> = [];

    // Core services
    nodes.push({ id: "core:eventbus", label: "EventBus", type: "core", group: 0, val: 20, events: eventNames.length });
    nodes.push({ id: "core:sqlite", label: "SQLite", type: "database", group: 1, val: 18 });
    nodes.push({ id: "core:neo4j", label: "Graph", type: "database", group: 1, val: 16, available: !!getGraph()?.capabilities.cypher });
    nodes.push({ id: "core:mcp", label: "MCP Server", type: "core", group: 0, val: 22, tools: allTools.length });
    nodes.push({ id: "core:ws", label: "WebSocket Hub", type: "core", group: 0, val: 14 });
    nodes.push({ id: "core:http", label: "HTTP Server", type: "core", group: 0, val: 14 });
    nodes.push({ id: "core:notifier", label: "Notifier", type: "core", group: 0, val: 12 });

    // mtwRequest (Rust real-time server)
    if (mtw) {
      nodes.push({
        id: "core:mtwrequest",
        label: "mtwRequest",
        type: "core",
        group: 0,
        val: 20,
        connected: mtw.connected,
        rpcActions: mtw.rpcActionCount,
        rustDelegates: mtw.rustDelegates.length,
        bridgeEnabled: mtw.bridgeEnabled,
        rustBridgeEnabled: mtw.rustBridgeEnabled,
      });
      // mtwRequest ↔ core links
      links.push({ source: "core:mtwrequest", target: "core:eventbus", type: "event", label: "data.changed" });
      links.push({ source: "core:mtwrequest", target: "core:http", type: "ws", label: "WebSocket" });

      // RPC modules → mtwRequest
      for (const rpcMod of mtw.rpcModules) {
        if (modules.includes(rpcMod)) {
          links.push({ source: `mod:${rpcMod}`, target: "core:mtwrequest", type: "ws", label: "rpc" });
        }
      }

      // Rust delegates → mtwRequest
      const rustModules = new Set(mtw.rustDelegates.map(d => d.split(".")[0]));
      for (const rustMod of rustModules) {
        const modName = modules.find(m => m === rustMod || m.replace(/-/g, "_") === rustMod);
        if (modName) {
          links.push({ source: `mod:${modName}`, target: "core:mtwrequest", type: "data", label: "rust delegate" });
        }
      }
    }

    // Module nodes
    for (const mod of modules) {
      const shortKey = mod.replace(/-/g, "_");
      nodes.push({
        id: `mod:${mod}`,
        label: mod,
        type: "module",
        group: 2,
        val: 6 + (moduleToolCounts[shortKey] ?? 0) * 0.8,
        toolCount: moduleToolCounts[shortKey] ?? 0,
      });
      // Every module connects to SQLite, EventBus, MCP
      links.push({ source: `mod:${mod}`, target: "core:sqlite", type: "data", label: "query" });
      links.push({ source: `mod:${mod}`, target: "core:eventbus", type: "event", label: "emit/listen" });
      links.push({ source: `mod:${mod}`, target: "core:mcp", type: "tool", label: "tools" });
    }

    // Neo4j-connected modules
    for (const mod of ["crm", "graph-intel", "google-sync", "notes", "goals", "chat"]) {
      if (modules.includes(mod)) {
        links.push({ source: `mod:${mod}`, target: "core:neo4j", type: "data", label: "graph" });
      }
    }

    // Notification channels
    for (const mod of ["reminders", "events", "dashboard"]) {
      if (modules.includes(mod)) {
        links.push({ source: `mod:${mod}`, target: "core:notifier", type: "notify", label: "notify" });
      }
    }

    // Dashboard → WS
    if (modules.includes("dashboard")) {
      links.push({ source: "mod:dashboard", target: "core:ws", type: "ws", label: "broadcast" });
      links.push({ source: "core:ws", target: "core:http", type: "ws", label: "upgrade" });
    }

    // Schedulers as nodes
    const schedulerProcs = processes.filter(p => p.type === "interval");
    for (const proc of schedulerProcs) {
      const sid = `sched:${proc.id}`;
      nodes.push({
        id: sid,
        label: proc.name,
        type: "scheduler",
        group: 3,
        val: 8,
        status: proc.status,
        intervalMs: proc.intervalMs,
        runCount: proc.runCount,
        module: proc.module,
      });
      // Connect scheduler to its module
      const modNode = modules.find(m => m === proc.module || m.includes(proc.module));
      if (modNode) {
        links.push({ source: sid, target: `mod:${modNode}`, type: "schedule", label: "tick" });
      }
    }

    // Event listeners as subtle links
    const listenerProcs = processes.filter(p => p.type === "event-listener");
    for (const proc of listenerProcs) {
      const lid = `listener:${proc.id}`;
      nodes.push({
        id: lid,
        label: proc.name.replace(/^on\("/, "").replace(/"\)$/, ""),
        type: "listener",
        group: 4,
        val: 4,
        event: proc.event,
        module: proc.module,
        runCount: proc.runCount,
      });
      links.push({ source: "core:eventbus", target: lid, type: "event", label: proc.event ?? "" });
    }

    httpServer.json(res, 200, {
      nodes,
      links,
      meta: {
        modules: modules.length,
        tools: allTools.length,
        events: eventNames.length,
        processes: processes.length,
        stats,
        uptimeMs: Date.now() - Date.parse(processes[0]?.startedAt ?? new Date().toISOString()),
        mtwRequest: mtw ? {
          connected: mtw.connected,
          rpcActions: mtw.rpcActionCount,
          rustDelegates: mtw.rustDelegates.length,
          rpcModules: mtw.rpcModules.length,
        } : null,
      },
    });
  });

  // Architecture metrics endpoint — heatmap, health, timeline
  httpServer.get("/api/architecture/metrics", (_req, res) => {
    const now = Date.now();
    const oneHourAgo = new Date(now - 3_600_000).toISOString();
    const thirtyMinAgo = new Date(now - 1_800_000).toISOString();
    const initModules = registry.getInitializedModules();

    // ── Module metrics from agent_run_steps (safeQuery) ──
    const moduleMetrics: Record<string, {
      toolCalls: number;
      recentCalls: number;
      errors: number;
      lastActivity: string;
      avgLatencyMs: number;
      status: "healthy" | "degraded" | "error" | "inactive";
    }> = {};

    // Initialize all modules as inactive
    for (const mod of initModules) {
      moduleMetrics[mod] = {
        toolCalls: 0,
        recentCalls: 0,
        errors: 0,
        lastActivity: "",
        avgLatencyMs: 0,
        status: "inactive",
      };
    }

    try {
      // Total tool calls per module (all time)
      const totalRows = sqlite.prepare(`
        SELECT
          REPLACE(SUBSTR(s.tool_name, 8), '_' || SUBSTR(SUBSTR(s.tool_name, 8), INSTR(SUBSTR(s.tool_name, 8), '_') + 1), '') AS mod,
          COUNT(*) AS cnt,
          MAX(s.created_at) AS last_at
        FROM agent_run_steps s
        WHERE s.type = 'tool_call' AND s.tool_name LIKE 'kernel_%'
        GROUP BY mod
      `).all() as Array<{ mod: string; cnt: number; last_at: string }>;

      for (const row of totalRows) {
        const modName = row.mod.replace(/_/g, "-");
        if (moduleMetrics[modName]) {
          moduleMetrics[modName].toolCalls = row.cnt;
          moduleMetrics[modName].lastActivity = row.last_at;
        }
      }

      // Recent calls (last hour) per module
      const recentRows = sqlite.prepare(`
        SELECT
          REPLACE(SUBSTR(s.tool_name, 8), '_' || SUBSTR(SUBSTR(s.tool_name, 8), INSTR(SUBSTR(s.tool_name, 8), '_') + 1), '') AS mod,
          COUNT(*) AS cnt
        FROM agent_run_steps s
        WHERE s.type = 'tool_call' AND s.tool_name LIKE 'kernel_%' AND s.created_at >= ?
        GROUP BY mod
      `).all(oneHourAgo) as Array<{ mod: string; cnt: number }>;

      for (const row of recentRows) {
        const modName = row.mod.replace(/_/g, "-");
        if (moduleMetrics[modName]) {
          moduleMetrics[modName].recentCalls = row.cnt;
        }
      }

      // Errors in last hour per module
      const errorRows = sqlite.prepare(`
        SELECT
          REPLACE(SUBSTR(s.tool_name, 8), '_' || SUBSTR(SUBSTR(s.tool_name, 8), INSTR(SUBSTR(s.tool_name, 8), '_') + 1), '') AS mod,
          COUNT(*) AS cnt
        FROM agent_run_steps s
        WHERE s.type = 'error' AND s.tool_name LIKE 'kernel_%' AND s.created_at >= ?
        GROUP BY mod
      `).all(oneHourAgo) as Array<{ mod: string; cnt: number }>;

      for (const row of errorRows) {
        const modName = row.mod.replace(/_/g, "-");
        if (moduleMetrics[modName]) {
          moduleMetrics[modName].errors = row.cnt;
        }
      }

      // Avg latency: time between tool_call and next tool_result for same run
      const latencyRows = sqlite.prepare(`
        SELECT
          REPLACE(SUBSTR(c.tool_name, 8), '_' || SUBSTR(SUBSTR(c.tool_name, 8), INSTR(SUBSTR(c.tool_name, 8), '_') + 1), '') AS mod,
          AVG(
            (julianday(r.created_at) - julianday(c.created_at)) * 86400000
          ) AS avg_ms
        FROM agent_run_steps c
        JOIN agent_run_steps r ON r.run_id = c.run_id AND r.step_number = c.step_number + 1 AND r.type = 'tool_result'
        WHERE c.type = 'tool_call' AND c.tool_name LIKE 'kernel_%'
        GROUP BY mod
      `).all() as Array<{ mod: string; avg_ms: number }>;

      for (const row of latencyRows) {
        const modName = row.mod.replace(/_/g, "-");
        if (moduleMetrics[modName]) {
          moduleMetrics[modName].avgLatencyMs = Math.round(row.avg_ms ?? 0);
        }
      }
    } catch {
      // agent_run_steps table may not exist — leave defaults
    }

    // Compute status for each module
    for (const mod of initModules) {
      const m = moduleMetrics[mod];
      if (m.errors > 5) {
        m.status = "error";
      } else if (m.errors > 0) {
        m.status = "degraded";
      } else if (m.recentCalls > 0 || m.toolCalls > 0) {
        m.status = "healthy";
      } else {
        m.status = "inactive";
      }
    }

    // ── System health ──
    const mem = process.memoryUsage();
    const health = {
      sqlite: true,
      graph: !!getGraph()?.capabilities.cypher,
      uptime: process.uptime(),
      memoryMb: Math.round(mem.rss / 1_048_576),
    };

    // ── Timeline (arch events migrated to mtwRequest) ──
    const timeline: unknown[] = [];

    httpServer.json(res, 200, {
      modules: moduleMetrics,
      health,
      timeline,
    });
  });
}
