/**
 * Usage:
 *   bun run scripts/seed-mail-office.ts                  # data/kernel.db
 *   KERNEL_DB_PATH=/app/data/kernel.db bun run scripts/seed-mail-office.ts
 */
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { seedMailOffice } from "./seeds/mail-office.js";

const DB_PATH = process.env.KERNEL_DB_PATH ?? resolve(process.cwd(), "data/kernel.db");
const db = new Database(DB_PATH);
try {
  runMigrations(db as any, "agents", agentsMigrations);
  const { updated, missing, unrestricted } = seedMailOffice(db as any, new AgentService(db as any, new EventBus()));
  console.log(`updated: ${updated.join(", ") || "none"}`);
  if (missing.length) console.log(`not found: ${missing.join(", ")}`);
  if (unrestricted.length) console.log(`left on all tools (already have inbox + ack): ${unrestricted.join(", ")}`);
} finally {
  db.close();
}
