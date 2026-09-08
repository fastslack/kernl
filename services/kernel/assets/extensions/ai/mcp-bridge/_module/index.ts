/**
 * MCP Bridge Module
 *
 * Connects to external MCP servers and injects their tools into the kernel's
 * pipeline, so chat and agents can call them like any other tool.
 *
 * Servers used to live only in the MCP_BRIDGE_SERVERS environment variable.
 * They now live in the database, which is what lets them be added,
 * authenticated, reconnected and removed from the dashboard instead of by
 * editing `.env` and restarting. The variable is still read once, to import
 * whatever it holds on first boot, so no existing configuration is lost.
 */

import type { KernelModule, ModuleContext, ToolDefinition, DashboardDescriptor } from "../../../../../src/core/types.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import { log } from "../../../../../src/core/logger.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { parseMcpBridgeServers } from "./types.js";
import { mcpMigrations } from "./migrations/001_mcp.js";
import { McpStore } from "./store.js";
import { McpRegistry } from "./registry.js";
import { mcpRpcActions } from "./rpc-actions.js";
import { registerMcpOAuthRoutes } from "./oauth-routes.js";

export type McpBridgeModule = KernelModule & {
  /** Every tool from every connected server. Read live by the tool surface. */
  getBridgedTools(): ToolDefinition[];
  /** Injected by bootstrap so a connection change can refresh chat + agents. */
  setRepublish(fn: () => void): void;
  getStore(): McpStore | null;
  getRegistry(): McpRegistry | null;
};

export function createMcpBridgeModule(): McpBridgeModule {
  let store: McpStore | null = null;
  let registry: McpRegistry | null = null;
  let sqlite: ModuleContext["sqlite"] | null = null;
  let republish: () => void = () => {};

  return {
    name: "mcp-bridge",

    async initialize(ctx: ModuleContext) {
      sqlite = ctx.sqlite;
      runMigrations(ctx.sqlite, "mcp-bridge", mcpMigrations);
      store = new McpStore(ctx.sqlite);

      // One-time import; a no-op once the table has rows.
      const imported = store.importFromEnv(parseMcpBridgeServers(process.env.MCP_BRIDGE_SERVERS ?? ""));
      if (imported.length > 0) {
        log.info(`MCP Bridge: imported ${imported.length} server(s) from MCP_BRIDGE_SERVERS → ${imported.join(", ")}`);
      }

      store.sweepOAuthState();

      registry = new McpRegistry({
        store,
        // Indirect so bootstrap can install the real one after this runs.
        republish: () => republish(),
      });

      await registry.connectAll();
    },

    getTools(): ToolDefinition[] {
      // Also returned here so bridged tools appear in the kernel's own MCP
      // ListTools response, not only in chat and agents.
      return registry?.getTools() ?? [];
    },

    getBridgedTools(): ToolDefinition[] {
      return registry?.getTools() ?? [];
    },

    setRepublish(fn: () => void) {
      republish = fn;
    },

    getRpcActions(): RpcAction[] {
      if (!sqlite || !store || !registry) return [];
      return mcpRpcActions(sqlite, { store, registry });
    },

    getDashboardDescriptor(): DashboardDescriptor | null {
      if (!store || !registry) return null;
      const s = store;
      const r = registry;
      return {
        registerRoutes: (server) => {
          registerMcpOAuthRoutes(server, {
            store: s,
            registry: r,
            // Only used to parse the callback's own URL; the redirect the
            // provider was given came from the browser at login time.
            publicOrigin: () => "http://127.0.0.1",
          });
        },
      };
    },

    getStore() {
      return store;
    },

    getRegistry() {
      return registry;
    },

    async shutdown() {
      await registry?.shutdown();
      registry = null;
      store = null;
    },
  };
}
