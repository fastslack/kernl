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

/**
 * OAuth 2 client-credentials settings for an HTTP MCP server.
 *
 * Servers behind OAuth 2.1 (Upwork's, for one) issue short-lived bearer
 * tokens, so a static `token` goes stale: the transport keeps sending a dead
 * header and every tool call fails until someone edits MCP_BRIDGE_SERVERS by
 * hand and restarts the kernel. Give `oauth` instead and the bridge mints its
 * own tokens and refreshes them before they expire.
 */
export interface McpOAuthConfig {
  /** Token endpoint, e.g. https://www.upwork.com/api/v3/oauth2/token */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Optional space-separated scopes, passed through untouched. */
  scope?: string;
  /**
   * Renew this many seconds before the server-stated expiry, so a token never
   * dies mid-request. Default 60.
   */
  refreshSkewSeconds?: number;
}

export interface McpHttpConfig {
  type: "http";
  /** Full URL to the MCP Streamable HTTP endpoint */
  url: string;
  /**
   * Static Bearer token. Ignored when `oauth` is set — that path mints and
   * rotates its own.
   */
  token?: string;
  /** OAuth 2 client-credentials config; takes precedence over `token`. */
  oauth?: McpOAuthConfig;
  /**
   * A ready-made token source, built by the caller. Wins over both `oauth` and
   * `token`. This is how the connection registry supplies an
   * authorization_code provider that reads and rotates tokens through the
   * store — that provider needs database access, which a JSON config in an
   * environment variable cannot express.
   */
  tokenProvider?: { getToken(force?: boolean): Promise<string> };
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
