/**
 * Stage: graceful shutdown handlers.
 *
 * Closes every long-lived resource in roughly LIFO order:
 *   publisher → mtwConn → bridge → rust → notification/sandbox/llm/db
 *   registries → camera hub → MCP HTTP router → HTTP server → skills →
 *   modules → neo4j → sqlite.
 *
 * Registers two `systemRegistry` watchers so the agenda visor lists the
 * signal handlers as live processes.
 */

import { log } from "../logger.js";
import { systemRegistry } from "../system-registry.js";
import { closeSqlite, type SqliteDb } from "../db/sqlite.js";
import type { Neo4jClient } from "../db/neo4j.js";
import type { KernelHttpServer } from "../http-server.js";
import type { McpHttpRouter } from "../../server.js";
import type { ModuleRegistry } from "../module-registry.js";
import type { NotificationRegistry } from "../notify/registry.js";
import type { SandboxDriverRegistry } from "../sandbox/registry.js";
import type { LlmProviderRegistry } from "../llm/provider-registry.js";
import type { DbDriverRegistry } from "../db-drivers/db-driver-registry.js";
import type { BridgeServer } from "../mtw/bridge-server.js";
import type { RustBridge } from "../rust/bridge.js";
import type { MtwPublisher } from "../mtw/publisher.js";
import type { CameraStreamHub } from "./types.js";
import type { SkillRegistry } from "../../skills/registry.js";

export function installShutdownHandlers(args: {
  sqlite: SqliteDb;
  neo4j: Neo4jClient;
  registry: ModuleRegistry;
  notificationRegistry: NotificationRegistry;
  sandboxRegistry: SandboxDriverRegistry;
  llmRegistry: LlmProviderRegistry;
  dbRegistry: DbDriverRegistry;
  skillRegistry: SkillRegistry;
  bridgeServer: BridgeServer | null;
  rustBridge: RustBridge | null;
  mtwPublisher: MtwPublisher | null;
  mtwConn: import("@matware/mtw-request-ts-client").MtwConnection | null;
  cameraStreamHub: CameraStreamHub;
  mcpRouter: McpHttpRouter | null;
  mcpUnixSocket: { close(): Promise<void> } | null;
  httpServer: KernelHttpServer | null;
}): void {
  const {
    sqlite, neo4j,
    registry,
    notificationRegistry, sandboxRegistry, llmRegistry, dbRegistry,
    skillRegistry,
    bridgeServer, rustBridge,
    mtwPublisher, mtwConn,
    cameraStreamHub, mcpRouter, mcpUnixSocket, httpServer,
  } = args;

  // Idempotent: on Windows closing the console can deliver SIGHUP and
  // SIGBREAK back to back, and a second pass would close sqlite twice.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutting down...");
    mtwPublisher?.shutdown();
    mtwConn?.close().catch(() => {});
    bridgeServer?.shutdown();
    await rustBridge?.disconnect();
    await notificationRegistry.stopAll();
    await sandboxRegistry.stopAll();
    await llmRegistry.stopAll();
    await dbRegistry.stopAll();
    cameraStreamHub?.shutdown();
    await mcpRouter?.shutdown();
    await mcpUnixSocket?.close().catch(() => {});
    await httpServer?.stop();
    await skillRegistry.shutdown();
    await registry.shutdownAll();
    await neo4j.close();
    closeSqlite(sqlite);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Windows never delivers SIGTERM. Closing the start.bat console arrives as
  // SIGHUP, Ctrl+Break as SIGBREAK; without these the kernel died with sqlite
  // still open and no module shut down.
  process.on("SIGHUP", shutdown);
  if (process.platform === "win32") process.on("SIGBREAK", shutdown);

  // Register signal watchers in system registry
  systemRegistry.register({
    name: "SIGINT Handler",
    type: "watcher",
    module: "core",
    description: "Graceful shutdown on SIGINT",
    status: "idle",
  });
  systemRegistry.register({
    name: "SIGTERM Handler",
    type: "watcher",
    module: "core",
    description: "Graceful shutdown on SIGTERM",
    status: "idle",
  });
}
