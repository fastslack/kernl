/**
 * MCP Bridge Module
 *
 * Connects to external MCP servers at startup and injects their tools into
 * the kernel's tool pipeline. Configured via the MCP_BRIDGE_SERVERS env var.
 *
 * Example .env:
 *   MCP_BRIDGE_SERVERS='[
 *     {"name":"fs","type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]},
 *     {"name":"myapi","type":"http","url":"http://localhost:9000/mcp","token":"secret"}
 *   ]'
 */

import type { KernelModule, ModuleContext, ToolDefinition } from "../../../../../src/core/types.js";
import { log } from "../../../../../src/core/logger.js";
import { parseMcpBridgeServers } from "./types.js";
import { connectMcpServer, type McpBridgeConnection } from "./client.js";

export type McpBridgeModule = KernelModule & {
  /** Returns all tools bridged from external MCP servers */
  getBridgedTools(): ToolDefinition[];
};

export function createMcpBridgeModule(): McpBridgeModule {
  let bridgedTools: ToolDefinition[] = [];
  let connections: McpBridgeConnection[] = [];

  return {
    name: "mcp-bridge",

    async initialize(_ctx: ModuleContext) {
      const raw = process.env.MCP_BRIDGE_SERVERS ?? "";
      const servers = parseMcpBridgeServers(raw);

      if (servers.length === 0) {
        log.info("MCP Bridge: no servers configured (MCP_BRIDGE_SERVERS not set)");
        return;
      }

      log.info(`MCP Bridge: connecting to ${servers.length} server(s)…`);

      const results = await Promise.allSettled(
        servers.map((cfg) => connectMcpServer(cfg)),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled") {
          connections.push(result.value);
          bridgedTools.push(...result.value.tools);
        } else {
          log.error(
            `MCP Bridge: failed to connect to "${servers[i].name}":`,
            result.reason,
          );
        }
      }

      log.info(
        `MCP Bridge: ready — ${bridgedTools.length} external tools from ${connections.length} server(s)`,
      );
    },

    getTools(): ToolDefinition[] {
      // The bridge tools are injected into allTools in index.ts via getBridgedTools().
      // We return them here too so they appear in the MCP server's ListTools response.
      return bridgedTools;
    },

    getBridgedTools(): ToolDefinition[] {
      return bridgedTools;
    },

    async shutdown() {
      await Promise.allSettled(connections.map((c) => c.disconnect()));
      connections = [];
      bridgedTools = [];
    },
  };
}
