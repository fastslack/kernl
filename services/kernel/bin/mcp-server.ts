#!/usr/bin/env node
/**
 * Kernl MCP Server Entry Point
 *
 * This script sets up global error handlers and bootstraps the kernel.
 */

import { bootstrap } from "../src/index.js";

// ── Global Error Handlers ─────────────────────────────────────
//
// These handlers catch errors that would otherwise crash the process
// silently, providing visibility into issues during development and
// production.

/**
 * Handle unhandled promise rejections.
 *
 * These occur when a promise is rejected but no .catch() handler exists.
 * We log the error but don't exit — the operation failed but the server
 * can continue running.
 */
process.on("unhandledRejection", (reason, promise) => {
  process.stderr.write(
    `[WARN] Unhandled Promise Rejection:\n` +
      `  Reason: ${reason instanceof Error ? reason.stack || reason.message : reason}\n` +
      `  Promise: ${promise}\n`
  );
});

/**
 * Handle uncaught exceptions.
 *
 * These are synchronous errors that bubble up to the event loop.
 * These are more serious — the process is in an undefined state,
 * so we log and exit.
 */
process.on("uncaughtException", (err, origin) => {
  process.stderr.write(
    `[FATAL] Uncaught Exception (${origin}):\n` +
      `  ${err.stack || err.message}\n`
  );
  process.exit(1);
});

/**
 * Handle SIGTERM (graceful shutdown request).
 *
 * Kubernetes, Docker, and systemd send SIGTERM before SIGKILL.
 * This gives us a chance to clean up.
 */
process.on("SIGTERM", () => {
  process.stderr.write("[INFO] Received SIGTERM, initiating graceful shutdown...\n");
  // The bootstrap function sets up its own shutdown handlers
  // This is just for visibility
});

/**
 * Handle SIGINT (Ctrl+C).
 */
process.on("SIGINT", () => {
  process.stderr.write("[INFO] Received SIGINT, initiating graceful shutdown...\n");
  // Let the bootstrap shutdown handlers take over
});

// ── Bootstrap ─────────────────────────────────────────────────

bootstrap().catch((err) => {
  process.stderr.write(
    `[FATAL] Bootstrap failed:\n` +
      `  ${err instanceof Error ? err.stack || err.message : err}\n`
  );
  process.exit(1);
});
