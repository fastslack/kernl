#!/usr/bin/env bun
/**
 * CLI Script Runner — execute any script handler from terminal.
 *
 * Usage:
 *   bun scripts/cli/run.ts <script-name>
 *   bun scripts/cli/run.ts --list
 *
 * Examples:
 *   bun scripts/cli/run.ts db-health
 *   bun scripts/cli/run.ts today
 *   bun scripts/cli/run.ts contacts-dedup
 *   bun scripts/cli/run.ts cleanup
 *   bun scripts/cli/run.ts maintenance-due
 *   bun scripts/cli/run.ts export-summary
 */

import { Database } from "bun:sqlite";
import { SCRIPT_AGENT_DEFS, createScriptHandlers } from "../../src/modules/agents/script-handlers.js";
import type { BuiltinHandlerContext } from "../../src/modules/agents/builtin-handlers.js";

// Minimal config loader (avoid importing full config which pulls many deps)
const dbPath = process.env.SQLITE_PATH || "./data/kernel.db";

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log("Usage: bun scripts/cli/run.ts <script-name>");
  console.log("       bun scripts/cli/run.ts --list\n");
  console.log("Available scripts:");
  for (const s of SCRIPT_AGENT_DEFS) {
    const name = s.handler.replace("script:", "");
    console.log(`  ${name.padEnd(20)} ${s.description}`);
  }
  process.exit(0);
}

if (args[0] === "--list") {
  console.log("Available scripts:\n");
  for (const s of SCRIPT_AGENT_DEFS) {
    const name = s.handler.replace("script:", "");
    console.log(`  ${name.padEnd(20)} ${s.description}`);
    console.log(`  ${"".padEnd(20)} cron: ${s.cron}\n`);
  }
  process.exit(0);
}

const scriptName = args[0];
const handlerKey = `script:${scriptName}`;

// bun:sqlite is compatible with better-sqlite3 API
const bunDb = new Database(dbPath);

// Create a thin wrapper that matches the SqliteDb interface
const db = {
  prepare: (sql: string) => {
    const stmt = bunDb.prepare(sql);
    return {
      all: (...params: unknown[]) => stmt.all(...params),
      get: (...params: unknown[]) => stmt.get(...params),
      run: (...params: unknown[]) => stmt.run(...params),
    };
  },
} as any;

// Minimal notifier (CLI scripts don't send notifications when run standalone)
const notifier = {
  send: async () => true,
  sendReminder: async () => {},
  telegramConfigured: false,
} as any;

const config = {} as any;
const ctx: BuiltinHandlerContext = { db, notifier, config };
const handlers = createScriptHandlers(ctx);

const handler = handlers.get(handlerKey);
if (!handler) {
  console.error(`Unknown script: "${scriptName}"`);
  console.error(`Run with --list to see available scripts.`);
  bunDb.close();
  process.exit(1);
}

const start = Date.now();
try {
  const result = await handler();
  console.log(result);
  console.log(`\n--- ${Date.now() - start}ms ---`);
} catch (err) {
  console.error("Script failed:", err);
  process.exit(1);
} finally {
  bunDb.close();
}
