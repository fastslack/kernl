#!/usr/bin/env bun
/**
 * Seed the Jobs Hunter office — script-agent scrapers + LLM curator.
 *
 *   bun run scripts/seed-jobs-office.ts                 # seed against data/kernel.db
 *   KERNEL_DB_PATH=/path/to/kernel.db bun run scripts/seed-jobs-office.ts
 *
 * Idempotent. Re-running refreshes editable fields (cron, description,
 * system_prompt for the curator) but never overwrites the operator-tuned
 * `variables` JSON on already-seeded scraper rows, and never reactivates
 * agents the operator paused by hand.
 *
 * After this runs, restart the kernel so the scheduler picks up the new
 * `agent_schedules` rows and starts firing them on their cron expressions.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { seedJobsOffice } from "./seeds/jobs-office.js";
import { WorkspaceService } from "../assets/extensions/agents/agent-advanced/_module/workspace-service.js";

const DB_PATH = process.env.KERNEL_DB_PATH ?? resolve(process.cwd(), "data/kernel.db");

async function main(): Promise<void> {
  console.log(`🔎 seed-jobs-office — db=${DB_PATH}`);

  const db = new Database(DB_PATH);
  try {
    // Migrations are idempotent — safe even when the kernel already ran them.
    runMigrations(db, "agents", agentsMigrations);

    const events = new EventBus();
    const service = new AgentService(db, events);
    const workspaces = new WorkspaceService(db);

    seedJobsOffice(db, service, workspaces);

    // Sanity report — show what landed.
    const flow = db
      .prepare("SELECT id FROM agent_flows WHERE name = 'Jobs Hunter' AND active = 1")
      .get() as { id: string } | undefined;
    if (!flow) {
      throw new Error("Jobs Hunter flow missing after seed — abort.");
    }
    const agents = db
      .prepare(
        "SELECT id, name, builtin_handler, active FROM agents WHERE flow_id = ? ORDER BY builtin_handler DESC, name",
      )
      .all(flow.id) as Array<{ id: string; name: string; builtin_handler: string; active: number }>;

    console.log(`\n✓ Jobs Hunter office: ${agents.length} agent(s)`);
    for (const a of agents) {
      const role = a.builtin_handler ? `[${a.builtin_handler}]` : "[LLM curator]";
      const status = a.active ? "active" : "paused";
      console.log(`   ${role.padEnd(34)} ${a.name}  (${status})`);
    }

    const schedules = db
      .prepare(
        `SELECT a.name, s.cron_expression FROM agent_schedules s
         JOIN agents a ON a.id = s.agent_id
         WHERE a.flow_id = ? AND s.active = 1
         ORDER BY s.cron_expression`,
      )
      .all(flow.id) as Array<{ name: string; cron_expression: string }>;

    if (schedules.length > 0) {
      console.log(`\n⏱  ${schedules.length} schedule(s) wired:`);
      for (const s of schedules) {
        console.log(`   ${s.cron_expression.padEnd(20)} ${s.name}`);
      }
    }

    console.log(`\nNext step: restart the kernel to pick up the new schedules.`);
    console.log(`Then tune each scraper's keywords in the dashboard (agent variables JSON).`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`❌ seed-jobs-office failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
