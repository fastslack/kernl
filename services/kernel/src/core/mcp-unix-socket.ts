/**
 * Unix-domain socket transport for the kernel MCP server.
 *
 * Reason: the Claude Agent SDK ships a bwrap sandbox that --unshare-net's the
 * subprocess, so `http://localhost:3087/mcp` is unreachable from inside.
 * `allowAllUnixSockets: true` is the only network escape hatch the SDK
 * exposes — so we listen on a unix socket and pair it with a stdio bridge
 * (bin/mcp-stdio-bridge.ts) that the SDK spawns as a `type: "stdio"` MCP
 * server.
 *
 * Wire protocol on the socket:
 *  1. First line (ASCII, newline-terminated): JSON handshake
 *       { "caller": { "agentId": "...", "runId": "...", "depth": 0 } }
 *     The handshake is optional — if the first byte parses as `{"jsonrpc":`
 *     we skip it and treat the connection as anonymous (top-level caller).
 *  2. Remaining stream: standard MCP stdio framing
 *     (newline-delimited JSON-RPC messages, same as StdioServerTransport).
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, type CreateMcpServerOptions } from "../server.js";
import type { ModuleRegistry } from "./module-registry.js";
import type { EventBus } from "./event-bus.js";
import { log } from "./logger.js";
import { runWithContext, type KernelRequestContext } from "./request-context.js";

export interface McpUnixSocketHandle {
  socketPath: string;
  close(): Promise<void>;
}

const EMPTY_CONTEXT: KernelRequestContext = {
  callerAgentId: "",
  callerRunId: "",
  callerDepth: 0,
};

/** Parse the optional first-line handshake. Returns the caller context plus
 *  the leftover bytes (the start of the MCP stream, if any).
 *
 *  CRITICAL: the first line may be EITHER our caller handshake
 *  (`{"caller":{...}}`) OR the client's first MCP message (`initialize`).
 *  We must only consume the line as a handshake when it genuinely is one —
 *  otherwise we'd eat the client's `initialize` and the MCP handshake
 *  deadlocks (no response is ever sent). The discriminator is the `caller`
 *  field, NOT key order: the Claude Code SDK serializes JSON-RPC with
 *  `jsonrpc`/`id` LAST (`{"method":…,"params":…,"jsonrpc":"2.0","id":0}`),
 *  so a naive `startsWith('{"jsonrpc"')` check misclassifies it as a
 *  handshake and silently drops the message. */
function parseHandshake(buf: Buffer): { ctx: KernelRequestContext; rest: Buffer } {
  const nl = buf.indexOf(0x0a);
  if (nl < 0) {
    return { ctx: EMPTY_CONTEXT, rest: buf };
  }
  const head = buf.subarray(0, nl).toString("utf8").trim();
  if (!head) {
    return { ctx: EMPTY_CONTEXT, rest: buf };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(head);
  } catch {
    // Not a complete JSON line (partial frame) — pass everything through.
    return { ctx: EMPTY_CONTEXT, rest: buf };
  }
  // Treat as a caller handshake ONLY if it's a JSON object that carries a
  // `caller` field and is NOT itself a JSON-RPC message. Anything else (any
  // MCP message, regardless of key order) is passed through untouched.
  const obj = parsed as Record<string, unknown>;
  const isHandshake =
    obj && typeof obj === "object" &&
    "caller" in obj && !("jsonrpc" in obj) && !("method" in obj);
  if (!isHandshake) {
    return { ctx: EMPTY_CONTEXT, rest: buf };
  }
  const c = (obj.caller ?? {}) as { agentId?: unknown; runId?: unknown; depth?: unknown };
  return {
    ctx: {
      callerAgentId: typeof c.agentId === "string" ? c.agentId : "",
      callerRunId: typeof c.runId === "string" ? c.runId : "",
      callerDepth: typeof c.depth === "number" && c.depth >= 0 ? c.depth : 0,
    },
    rest: buf.subarray(nl + 1),
  };
}

export async function startMcpUnixSocketServer(
  registry: ModuleRegistry,
  events: EventBus | undefined,
  opts: CreateMcpServerOptions,
  socketPath: string,
): Promise<McpUnixSocketHandle> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o755 });
  try { fs.unlinkSync(socketPath); } catch { /* didn't exist */ }

  const netServer = net.createServer((socket) => {
    const peerLabel = `mcp-unix#${socket.localPort ?? "?"}`;
    let ctx: KernelRequestContext = EMPTY_CONTEXT;

    // The StdioServerTransport expects a Readable for input — we forward
    // post-handshake bytes through a PassThrough so the transport never
    // sees the handshake line.
    const downstream = new PassThrough();
    let handshakeDone = false;

    const onData = (chunk: Buffer) => {
      if (handshakeDone) {
        downstream.write(chunk);
        return;
      }
      const { ctx: parsed, rest } = parseHandshake(chunk);
      ctx = parsed;
      handshakeDone = true;
      if (rest.length > 0) downstream.write(rest);
    };

    socket.on("data", onData);
    socket.on("end", () => downstream.end());
    socket.on("error", (err) => log.warn(`${peerLabel}: socket error: ${err.message}`));

    const mcp: Server = createMcpServer(registry, events, opts);
    const transport = new StdioServerTransport(downstream, socket);

    // Wrap the transport's onmessage so each MCP message runs inside the
    // AsyncLocalStorage context tagged with the handshake's caller info —
    // this is what kernel_agents_run / _invoke read to enforce no-self-
    // invocation and increment chain depth. We trap the property's setter
    // BEFORE Server.connect() assigns to it; storage holds the raw handler
    // so the trap doesn't recurse when we rewrite during the setter.
    let realHandler: ((msg: unknown, extra: unknown) => unknown) | undefined;
    Object.defineProperty(transport, "onmessage", {
      configurable: true,
      enumerable: true,
      get() { return realHandler; },
      set(fn) {
        realHandler = fn
          ? ((msg, extra) => runWithContext(ctx, () => fn(msg, extra)))
          : undefined;
      },
    });

    mcp.connect(transport).catch((err) => {
      log.error(`${peerLabel}: MCP connect failed: ${err instanceof Error ? err.message : err}`);
      socket.destroy();
    });

    socket.on("close", () => {
      mcp.close().catch(() => { /* already torn down */ });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => reject(err);
    netServer.once("error", onErr);
    netServer.listen(socketPath, () => {
      netServer.off("error", onErr);
      try { fs.chmodSync(socketPath, 0o660); } catch { /* best-effort */ }
      log.info(`MCP Unix socket endpoint: ${socketPath}`);
      resolve();
    });
  });

  return {
    socketPath,
    async close() {
      await new Promise<void>((resolve) => netServer.close(() => resolve()));
      try { fs.unlinkSync(socketPath); } catch { /* gone */ }
    },
  };
}

/** Default socket path.
 *
 *  Defaults to `/tmp/kernl-mcp.sock`: the SDK's bwrap sandbox
 *  (--unshare-net but with `allowAllUnixSockets: true`) reliably bind-mounts
 *  `/tmp` into the sandbox FS, so the socket is visible from inside agent
 *  subprocesses. `$XDG_RUNTIME_DIR`/`$HOME` paths often live under user-
 *  scoped dirs that bwrap doesn't expose by default, which would silently
 *  break the bridge.
 *
 *  Override priority: $KERNEL_MCP_SOCKET → /tmp default. */
export function resolveDefaultSocketPath(): string {
  const explicit = process.env.KERNEL_MCP_SOCKET;
  if (explicit) return explicit;
  return "/tmp/kernl-mcp.sock";
}
