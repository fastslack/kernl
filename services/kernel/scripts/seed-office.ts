#!/usr/bin/env bun
/**
 * Generic office seeder — materializes any `scripts/offices/<name>.office.ts`
 * manifest through the shared Office Kit engine.
 *
 *   bun run scripts/seed-office.ts prode
 *   KERNEL_DB_PATH=/path/to/kernel.db bun run scripts/seed-office.ts prode
 *
 * Idempotent (same guarantees as materializeOffice): re-running refreshes
 * editable fields, never reactivates a paused agent, never duplicates
 * chains/schedules, and preserves operator-edited variables.
 *
 * After seeding against the live DB, restart the kernel so the dashboard +
 * scheduler pick the office up: `npm run reload`.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { materializeOffice, type OfficeDefinition, type RepoServiceLike } from "../src/modules/agents/office-kit.js";
import { RepoService } from "../assets/extensions/productivity/repos/_module/service.js";
import { reposMigrations } from "../assets/extensions/productivity/repos/_module/migrations/001_repos.js";

const DB_PATH = process.env.KERNEL_DB_PATH ?? resolve(process.cwd(), "data/kernel.db");
const OFFICES_DIR = resolve(import.meta.dir, "offices");

function availableOffices(): string[] {
  if (!existsSync(OFFICES_DIR)) return [];
  return readdirSync(OFFICES_DIR)
    .filter((f) => f.endsWith(".office.ts"))
    .map((f) => f.replace(/\.office\.ts$/, ""))
    .sort();
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.error("Usage: bun run scripts/seed-office.ts <name>");
    const offices = availableOffices();
    if (offices.length) console.error(`Available: ${offices.join(", ")}`);
    process.exit(1);
  }

  const manifestPath = resolve(OFFICES_DIR, `${name}.office.ts`);
  if (!existsSync(manifestPath)) {
    console.error(`❌ No manifest at ${manifestPath}`);
    const offices = availableOffices();
    if (offices.length) console.error(`Available: ${offices.join(", ")}`);
    process.exit(1);
  }

  const mod = (await import(manifestPath)) as { default?: OfficeDefinition };
  if (!mod.default) throw new Error(`${manifestPath} must default-export a defineOffice({...}) manifest`);
  const def = mod.default;

  console.log(`🏢 seed-office "${def.name}" — db=${DB_PATH}`);

  const db = new Database(DB_PATH);
  try {
    runMigrations(db, "agents", agentsMigrations);
    // The repos extension normally migrates at kernel boot; run it here too so
    // this script works on a fresh DB before the kernel has started.
    runMigrations(db, "repos", reposMigrations);

    const service = new AgentService(db, new EventBus());
    const repoService = new RepoService(db) as unknown as RepoServiceLike;

    const report = materializeOffice(db, service, def, { repoService });

    console.log(`\n✓ Office "${report.flowName}" — flow ${report.flowId}`);
    if (report.created.length) console.log(`   created:  ${report.created.join(", ")}`);
    if (report.updated.length) console.log(`   updated:  ${report.updated.join(", ")}`);
    if (report.chained.length) console.log(`   chained:  ${report.chained.map(([s, t]) => `${s}→${t}`).join(", ")}`);
    if (report.scheduled) console.log(`   cron:     ${report.scheduled.agent} every ${report.scheduled.intervalMs / 60000} min`);
    if (report.repo) console.log(`   repo:     ${report.repo.path} (${report.repo.registered ? "registered" : "NOT registered"})`);
    for (const w of report.warnings) console.log(`   ⚠ ${w}`);

    console.log(`\nNext: restart the kernel so the dashboard + scheduler pick it up — npm run reload`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`❌ seed-office failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
