#!/usr/bin/env bun
/**
 * Seed the Repos Office — a flow + workspace + four agents (Coordinator,
 * Reader, Editor, Runner) that operate on registered local repositories via
 * the `kernel_repos_*` tools (productivity/repos extension).
 *
 *   bun run scripts/seed-repos-office.ts                 # seed against data/kernel.db
 *   KERNEL_DB_PATH=/path/to/kernel.db bun run scripts/seed-repos-office.ts
 *
 * Idempotent. Re-running refreshes editable fields (description, prompts,
 * allowed_tools, model_chain) but never overwrites operator-tuned
 * `variables` JSON and never reactivates a paused agent.
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
import { seedReposOffice } from "./seeds/repos-office.js";
import { WorkspaceService } from "../assets/extensions/agents/agent-advanced/_module/workspace-service.js";
import { reposMigrations } from "../assets/extensions/productivity/repos/_module/migrations/001_repos.js";

const DB_PATH = process.env.KERNEL_DB_PATH ?? resolve(process.cwd(), "data/kernel.db");

async function main(): Promise<void> {
  console.log(`📦 seed-repos-office — db=${DB_PATH}`);

  const db = new Database(DB_PATH);
  try {
    runMigrations(db, "agents", agentsMigrations);
    // The repos extension normally runs its own migration at kernel boot. Seed
    // it here too so this script works on a fresh DB before the kernel has
    // started.
    runMigrations(db, "repos", reposMigrations);

    const events = new EventBus();
    const service = new AgentService(db, events);
    const workspaces = new WorkspaceService(db);

    seedReposOffice(db, service, workspaces);

    // Sanity report — show what landed.
    const flow = db
      .prepare("SELECT id FROM agent_flows WHERE name = 'Repos Office' AND active = 1")
      .get() as { id: string } | undefined;
    if (!flow) throw new Error("Repos Office flow missing after seed — abort.");

    const agents = db
      .prepare(
        "SELECT id, name, slug, role, active FROM agents WHERE flow_id = ? ORDER BY role DESC, name",
      )
      .all(flow.id) as Array<{ id: string; name: string; slug: string; role: string; active: number }>;

    console.log(`\n✓ Repos Office: ${agents.length} agent(s)`);
    for (const a of agents) {
      const status = a.active ? "active" : "paused";
      const role = `[${a.role}]`.padEnd(10);
      console.log(`   ${role} ${a.slug.padEnd(22)} ${a.name}  (${status})`);
    }

    const workspaceRow = db
      .prepare("SELECT id, name, shared FROM workspaces WHERE owner_flow_id = ? ORDER BY created_at LIMIT 1")
      .get(flow.id) as { id: string; name: string; shared: number } | undefined;
    if (workspaceRow) {
      console.log(`\n📁 Workspace: ${workspaceRow.name} (${workspaceRow.id})${workspaceRow.shared ? " — shared" : ""}`);
    }

    const repoCount = db.prepare("SELECT COUNT(*) AS n FROM repos WHERE deleted_at IS NULL").get() as { n: number };
    console.log(`📚 Repos registered: ${repoCount.n}`);

    console.log(`\nNext steps:`);
    console.log(`  1. Restart kernel: ./scripts/dev.sh reload kernel`);
    console.log(`  2. From the dashboard, find "Repo Coordinator" and click Run.`);
    console.log(`     Goal examples:`);
    console.log(`        register ~/projects/Kernl as kernl`);
    console.log(`        list repos`);
    console.log(`        status kernl`);
    console.log(`        search kernl "kernel_repos_register"`);
    console.log(`        read kernl:src/index.ts`);
    console.log(`        build kernl`);
    console.log(`  3. Any agent in any office can use kernel_repos_* — add the tools to its allowed_tools to share access.`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`❌ seed-repos-office failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
