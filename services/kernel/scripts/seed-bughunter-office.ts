#!/usr/bin/env bun
/**
 * Seed the Bug Hunter office — recreates github.com/elementalsouls/Claude-BugHunter
 * as a kernel flow (Scope → Recon → Hunt → Validate → Capture → Report).
 *
 *   bun run scripts/seed-bughunter-office.ts                 # seed against data/kernel.db
 *   KERNEL_DB_PATH=/path/to/kernel.db bun run scripts/seed-bughunter-office.ts
 *
 * Idempotent. Re-running refreshes editable fields (description,
 * system_prompt, model_chain, allowed_tools) but never overwrites the
 * operator-tuned `variables` JSON and never reactivates a paused agent.
 *
 * After this runs, restart the kernel so the dashboard picks up the new
 * agents and the coordinator's `kernel_agents_run` invocations succeed.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { seedBugHunterOffice } from "./seeds/bughunter-office.js";
import { WorkspaceService } from "../assets/extensions/agents/agent-advanced/_module/workspace-service.js";

const DB_PATH = process.env.KERNEL_DB_PATH ?? resolve(process.cwd(), "data/kernel.db");

async function main(): Promise<void> {
  console.log(`🐛 seed-bughunter-office — db=${DB_PATH}`);

  const db = new Database(DB_PATH);
  try {
    runMigrations(db, "agents", agentsMigrations);

    const events = new EventBus();
    const service = new AgentService(db, events);
    const workspaces = new WorkspaceService(db);

    seedBugHunterOffice(db, service, workspaces);

    // Sanity report — show what landed.
    const flow = db
      .prepare("SELECT id FROM agent_flows WHERE name = 'Bug Hunter' AND active = 1")
      .get() as { id: string } | undefined;
    if (!flow) {
      throw new Error("Bug Hunter flow missing after seed — abort.");
    }
    const agents = db
      .prepare(
        "SELECT id, name, slug, role, active FROM agents WHERE flow_id = ? ORDER BY role DESC, name",
      )
      .all(flow.id) as Array<{ id: string; name: string; slug: string; role: string; active: number }>;

    console.log(`\n✓ Bug Hunter office: ${agents.length} agent(s)`);
    for (const a of agents) {
      const status = a.active ? "active" : "paused";
      const role = `[${a.role}]`.padEnd(10);
      console.log(`   ${role} ${a.slug.padEnd(22)} ${a.name}  (${status})`);
    }

    const workspaceRow = db
      .prepare("SELECT id, name FROM workspaces WHERE owner_flow_id = ? ORDER BY created_at LIMIT 1")
      .get(flow.id) as { id: string; name: string } | undefined;
    if (workspaceRow) {
      console.log(`\n📁 Workspace: ${workspaceRow.name} (${workspaceRow.id})`);
    }

    console.log(`\nNext steps:`);
    console.log(`  1. Restart kernel: ./scripts/dev.sh reload kernel`);
    console.log(`  2. From the dashboard, find "Engagement Coordinator" and click Run.`);
    console.log(`     Goal examples:`);
    console.log(`        hunt example.com (program URL: https://hackerone.com/example)`);
    console.log(`        resume example.com`);
    console.log(`        report <note-id> on platform=bugcrowd`);
    console.log(`  3. (Optional) Install the Claude-BugHunter skill bundle into ~/.claude/skills/`);
    console.log(`     for the 574+ disclosed-report attack patterns. The office works without it.`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`❌ seed-bughunter-office failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
