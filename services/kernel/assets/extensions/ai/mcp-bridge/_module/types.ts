/**
 * MCP Bridge — type definitions
 *
 * Defines the configuration for external MCP servers that the kernel
 * connects to as a client, bridging their tools into the tool pipeline.
 */

export type McpTransportType = "stdio" | "http";

export interface McpStdioConfig {
  type: "stdio";
  /** Command to spawn (e.g. "npx", "python", "/usr/local/bin/my-mcp") */
  command: string;
  /** Arguments passed to the command */
  args?: string[];
  /** Additional environment variables */
  env?: Record<string, string>;
}

export interface McpHttpConfig {
  type: "http";
  /** Full URL to the MCP Streamable HTTP endpoint */
  url: string;
  /** Optional Bearer token for authentication */
  token?: string;
  /** Optional extra headers */
  headers?: Record<string, string>;
}

export type McpServerConfig = (McpStdioConfig | McpHttpConfig) & {
  /** Unique name for this server (used as tool prefix) */
  name: string;
  /** Human-readable description shown in tool descriptions */
  description?: string;
  /**
   * Optional tool name allowlist. If set, only these tool names
   * (from the remote server) are bridged into the kernel.
   */
  allowTools?: string[];
  /**
   * Optional tool name denylist. Tools in this list are excluded.
   */
  denyTools?: string[];
};

/**
 * Parsed from MCP_BRIDGE_SERVERS env var (JSON array).
 * Example .env entry:
 *
 * MCP_BRIDGE_SERVERS='[
 *   {"name":"filesystem","type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]},
 *   {"name":"myapi","type":"http","url":"http://localhost:9000/mcp","token":"secret"}
 * ]'
 */
export function parseMcpBridgeServers(raw: string): McpServerConfig[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as McpServerConfig[];
  } catch {
    return [];
  }
}
