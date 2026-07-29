/**
 * MCP Bridge Client
 *
 * Connects to an external MCP server (stdio or HTTP) and translates its
 * tool list into kernel ToolDefinition[] so they flow through the normal
 * chat/agent pipeline without any changes to ChatService or AgentExecutor.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { log } from "../../../../../src/core/logger.js";
import type { ToolDefinition, ToolResult } from "../../../../../src/core/types.js";
import type { McpServerConfig } from "./types.js";

/** Wraps a remote JSON Schema as a passthrough Zod schema */
function schemaFromJsonSchema(jsonSchema: Record<string, unknown>): z.ZodType<unknown> {
  // We can't convert arbitrary JSON Schema to Zod at runtime without a full
  // library. Instead we use a ZodAny that carries the raw JSON Schema in its
  // description so zodToJsonSchema() in chat-tools.ts gets the real schema.
  return z.any().describe(JSON.stringify(jsonSchema));
}

export interface McpBridgeConnection {
  serverName: string;
  tools: ToolDefinition[];
  disconnect(): Promise<void>;
}

/**
 * Connect to one external MCP server and return its tools as ToolDefinitions.
 */
export async function connectMcpServer(
  config: McpServerConfig,
): Promise<McpBridgeConnection> {
  const client = new Client(
    { name: "Kernl-bridge", version: "1.0.0" },
    { capabilities: {} },
  );

  // ── Transport ────────────────────────────────────────────
  let transport: StdioClientTransport | StreamableHTTPClientTransport;

  if (config.type === "stdio") {
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
    });
  } else {
    const headers: Record<string, string> = { ...(config.headers ?? {}) };
    if (config.token) {
      headers["Authorization"] = `Bearer ${config.token}`;
    }
    transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers },
    });
  }

  await client.connect(transport);
  log.info(`MCP Bridge: connected to "${config.name}" (${config.type})`);

  // ── Discover remote tools ────────────────────────────────
  const { tools: remoteTools } = await client.listTools();

  const allowed = config.allowTools ? new Set(config.allowTools) : null;
  const denied = config.denyTools ? new Set(config.denyTools) : new Set<string>();

  const tools: ToolDefinition[] = [];

  for (const remote of remoteTools) {
    if (denied.has(remote.name)) continue;
    if (allowed && !allowed.has(remote.name)) continue;

    // Prefix tool name with server name to avoid collisions
    const kernelName = `mcp_${config.name}_${remote.name}`;
    const jsonSchema = (remote.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>;

    tools.push({
      name: kernelName,
      description: `[${config.name}] ${remote.description ?? remote.name}`,
      inputSchema: schemaFromJsonSchema(jsonSchema),

      handler: async (args: unknown): Promise<ToolResult> => {
        try {
          const result = await client.callTool({
            name: remote.name,
            arguments: (args ?? {}) as Record<string, unknown>,
          }) as { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };

          // MCP CallToolResult → ToolResult
          const text = result.content
            .map((c) => {
              if (c.type === "text") return c.text ?? "";
              if (c.type === "image") return `[image: base64/${(c as { mimeType?: string }).mimeType ?? "unknown"}]`;
              return JSON.stringify(c);
            })
            .join("\n");

          return {
            content: [{ type: "text", text: text || "(empty response)" }],
            isError: result.isError === true,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`MCP Bridge [${config.name}] tool "${remote.name}" error:`, err);
          return {
            content: [{ type: "text", text: `Error calling ${remote.name}: ${msg}` }],
            isError: true,
          };
        }
      },
    });
  }

  log.info(
    `MCP Bridge: "${config.name}" exposed ${tools.length} tools → [${tools.map((t) => t.name).join(", ")}]`,
  );

  return {
    serverName: config.name,
    tools,
    async disconnect() {
      try {
        await client.close();
        log.info(`MCP Bridge: disconnected from "${config.name}"`);
      } catch {
        // ignore disconnect errors on shutdown
      }
    },
  };
}
