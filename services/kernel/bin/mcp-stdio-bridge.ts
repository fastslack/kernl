#!/usr/bin/env node
/**
 * kernl MCP stdio→Unix-socket bridge.
 *
 * Spawned by the Claude Agent SDK as a `type: "stdio"` MCP server. We open
 * the kernel's MCP Unix socket (default $KERNEL_MCP_SOCKET or
 * $HOME/.kernl/mcp.sock) and pipe stdin↔socket↔stdout. The SDK's
 * bwrap sandbox blocks all outbound TCP (--unshare-net), but
 * `allowAllUnixSockets: true` lets the connect(2) through, so this is the
 * way agent runs reach the kernel MCP from inside the sandbox.
 *
 * Handshake: before forwarding stdin, we emit one JSON line carrying the
 * caller's agent/run/depth (read from env vars). The kernel's Unix-socket
 * MCP transport (src/core/mcp-unix-socket.ts) parses it and binds the
 * caller-context AsyncLocalStorage for the connection.
 */

import { createConnection } from "node:net";
import * as path from "node:path";

function resolveSocketPath(): string {
  const cliArg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (cliArg) return cliArg;
  if (process.env.KERNEL_MCP_SOCKET) return process.env.KERNEL_MCP_SOCKET;
  if (process.env.XDG_RUNTIME_DIR) return path.join(process.env.XDG_RUNTIME_DIR, "kernl", "mcp.sock");
  if (process.env.HOME) return path.join(process.env.HOME, ".kernl", "mcp.sock");
  return "/tmp/kernl-mcp.sock";
}

const socketPath = resolveSocketPath();

const debug = process.env.KERNEL_MCP_BRIDGE_DEBUG === "1";
const log = (msg: string) => { if (debug) process.stderr.write(`[bridge] ${msg}\n`); };

log(`socket=${socketPath} pid=${process.pid}`);

const socket = createConnection({ path: socketPath });

// IMPORTANT: start consuming stdin immediately so data the SDK pushes before
// the socket's `connect` callback fires isn't lost. Until the socket is
// ready we buffer chunks (and a possible early EOF) so the handshake +
// initial MCP frames survive even when stdin closes before connect.
const stdinChunks: Buffer[] = [];
let socketReady = false;
let stdinEnded = false;
process.stdin.on("data", (chunk) => {
  log(`stdin chunk ${chunk.length} bytes (ready=${socketReady})`);
  if (socketReady) socket.write(chunk);
  else stdinChunks.push(chunk);
});
process.stdin.on("end", () => {
  log("stdin end");
  stdinEnded = true;
});
process.stdin.resume();

socket.on("error", (err) => {
  process.stderr.write(`mcp-stdio-bridge: cannot connect to ${socketPath}: ${err.message}\n`);
  process.exit(1);
});

socket.on("connect", () => {
  log("socket connect");
  // Handshake — kernel parses this single line and tags the connection's
  // request context. Skipped if the bridge is run without caller env (top-
  // level CLI use, etc.) — the kernel will fall back to anonymous context.
  const caller = {
    agentId: process.env.KERNEL_CALLER_AGENT_ID ?? "",
    runId: process.env.KERNEL_CALLER_RUN_ID ?? "",
    depth: Number.parseInt(process.env.KERNEL_CALLER_DEPTH ?? "0", 10) || 0,
  };
  if (caller.agentId || caller.runId) {
    socket.write(JSON.stringify({ caller }) + "\n");
  }

  // Flush any stdin received before the socket finished connecting.
  for (const chunk of stdinChunks) socket.write(chunk);
  stdinChunks.length = 0;
  socketReady = true;

  socket.pipe(process.stdout);
  // Don't half-close the socket on stdin EOF — the kernel-side MCP transport
  // treats stream end as a disconnect signal and tears down the session
  // before flushing pending replies. We rely on the parent SDK closing the
  // pipe pair entirely to terminate us (handled by socket.on("close")).
});

socket.on("close", () => process.exit(0));
process.on("SIGTERM", () => { socket.end(); process.exit(0); });
process.on("SIGINT", () => { socket.end(); process.exit(0); });
