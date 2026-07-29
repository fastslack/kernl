/**
 * Bridge Server — Unix socket server for mtwRequest integration.
 *
 * Receives MessagePack-framed requests from mtwRequest (Rust) and
 * executes kernel tools, returning results over the same socket.
 *
 * Protocol (same as mtw-bridge crate):
 *   [4 bytes: payload length (BE u32)] [N bytes: MessagePack payload]
 *
 * Request:  { id: string, tool: string, args: object }
 * Response: { id: string, result?: object, error?: string }
 *
 * Kernl keeps working exactly as before — this is additive.
 */

import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { log } from "../logger.js";
import { stripInternalArgs } from "../helpers.js";
import type { ToolDefinition } from "../types.js";
import type { EventBus } from "../event-bus.js";

// Use native MessagePack via Bun's msgpack or fallback to JSON
let encode: (obj: unknown) => Uint8Array;
let decode: (buf: Uint8Array) => unknown;

try {
  // Try @msgpack/msgpack first
  const msgpack = await import("@msgpack/msgpack");
  encode = msgpack.encode;
  decode = msgpack.decode;
  log.debug("Bridge: using @msgpack/msgpack");
} catch {
  // Fallback to JSON-based encoding (works without extra deps)
  encode = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
  decode = (buf: Uint8Array) => JSON.parse(new TextDecoder().decode(buf));
  log.debug("Bridge: using JSON fallback (install @msgpack/msgpack for better performance)");
}

interface BridgeRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

interface BridgeResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export interface BridgeServerOptions {
  socketPath: string;
  tools: ToolDefinition[];
  events?: EventBus;
}

export class BridgeServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private toolMap: Map<string, ToolDefinition>;
  private socketPath: string;
  private events?: EventBus;

  constructor(opts: BridgeServerOptions) {
    this.socketPath = opts.socketPath;
    this.events = opts.events;
    this.toolMap = new Map(opts.tools.map((t) => [t.name, t]));
    log.debug(`Bridge: ${this.toolMap.size} tools registered`);
  }

  /** Update tool list (e.g., after sandbox agents initialize) */
  updateTools(tools: ToolDefinition[]): void {
    this.toolMap = new Map(tools.map((t) => [t.name, t]));
    log.debug(`Bridge: tools updated (${this.toolMap.size} total)`);
  }

  async start(): Promise<void> {
    // Clean stale socket file
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));

      this.server.on("error", (err) => {
        log.error("Bridge server error:", err);
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        log.info(`Bridge: listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  shutdown(): void {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Clean up socket file
    try {
      if (existsSync(this.socketPath)) {
        unlinkSync(this.socketPath);
      }
    } catch {
      // Ignore cleanup errors
    }

    log.info("Bridge: shut down");
  }

  private handleConnection(socket: Socket): void {
    this.clients.add(socket);
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Process all complete frames in the buffer
      while (buffer.length >= 4) {
        const payloadLen = buffer.readUInt32BE(0);

        // Guard against absurd frame sizes (max 10 MB)
        if (payloadLen > 10 * 1024 * 1024) {
          log.error(`Bridge: frame too large (${payloadLen} bytes), closing connection`);
          socket.destroy();
          return;
        }

        if (buffer.length < 4 + payloadLen) {
          break; // Wait for more data
        }

        const payload = buffer.subarray(4, 4 + payloadLen);
        buffer = buffer.subarray(4 + payloadLen);

        this.handleFrame(payload, socket).catch((err) => {
          log.error("Bridge: frame handler error", err);
        });
      }
    });

    socket.on("close", () => {
      this.clients.delete(socket);
    });

    socket.on("error", (err) => {
      log.warn("Bridge: client error", err);
      this.clients.delete(socket);
    });
  }

  private async handleFrame(payload: Uint8Array, socket: Socket): Promise<void> {
    let req: BridgeRequest;

    try {
      req = decode(payload) as BridgeRequest;
    } catch (err) {
      log.error("Bridge: failed to decode request", err);
      return;
    }

    // Health check — special tool name
    if (req.tool === "_health") {
      this.sendResponse(socket, {
        id: req.id,
        result: { status: "ok", tools: this.toolMap.size },
      });
      return;
    }

    // Find and execute the tool
    const tool = this.toolMap.get(req.tool);
    if (!tool) {
      this.sendResponse(socket, {
        id: req.id,
        error: `tool not found: ${req.tool}`,
      });
      return;
    }

    try {
      // Requests arrive from external mtwRequest clients over the Unix
      // socket — strip kernel-internal `__`-prefixed keys (e.g.
      // `__caller_agent_id`) before invoking the handler, mirroring
      // server.ts's dispatch. Otherwise an external caller could forge
      // those fields and impersonate an agent to caller-aware tools.
      const result = await tool.handler(stripInternalArgs(req.args));

      // Emit data.changed so MtwPublisher refreshes mtwRequest channels
      if (this.events) {
        this.events.emit("data.changed", {
          module: req.tool.split("_")[1] ?? "unknown",
          tool: req.tool,
        });
      }

      // Extract text content from ToolResult format
      const content = result?.content;
      let value: unknown;

      if (Array.isArray(content) && content.length > 0 && content[0]?.text) {
        // Standard MCP ToolResult: { content: [{ type: "text", text: "..." }] }
        const text = content[0].text;
        try {
          value = JSON.parse(text);
        } catch {
          value = text;
        }
      } else {
        value = result;
      }

      this.sendResponse(socket, {
        id: req.id,
        result: value,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendResponse(socket, {
        id: req.id,
        error: message,
      });
    }
  }

  private sendResponse(socket: Socket, resp: BridgeResponse): void {
    try {
      const payload = encode(resp);
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(payload.length, 0);
      socket.write(lenBuf);
      socket.write(payload);
    } catch (err) {
      log.error("Bridge: failed to send response", err);
    }
  }
}
