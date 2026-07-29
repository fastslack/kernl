/**
 * Backfill office homes for flows that pre-date migration v36.
 *
 * New offices get a kernel-workspace home automatically via
 * AgentService.createFlow. Existing offices have `home_workspace_id = ''`
 * until this script links each one to an 'office-home' workspace row.
 *
 * DB-only + idempotent: it never touches disk (the folder convention is seeded
 * lazily by the executor on first run, or eagerly by kernel_agents_flows_set_repo
 * when promoting to a git repo). Re-running skips offices that already have a home.
 *
 * Usage:
 *   bun run scripts/backfill-office-homes.ts            # all active flows
 *   bun run scripts/backfill-office-homes.ts --dry-run  # report only
 *
 * Env:
 *   KERNEL_DB_PATH=data/kernel.db
 */
import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");
const DB_PATH = resolve(process.cwd(), process.env.KERNEL_DB_PATH ?? "data/kernel.db");

function uuid(): string {
  return crypto.randomUUID();
}

function main(): void {
  const db = new Database(DB_PATH);
  db.run("PRAGMA foreign_keys = ON");

  const flows = db
    .prepare("SELECT id, name, home_workspace_id FROM agent_flows WHERE active = 1")
    .all() as Array<{ id: string; name: string; home_workspace_id: string }>;

  let created = 0;
  let relinked = 0;
  let skipped = 0;

  for (const flow of flows) {
    // Already linked to a live workspace?
    if (flow.home_workspace_id) {
      const live = db
        .prepare("SELECT 1 FROM workspaces WHERE id = ? AND deleted_at IS NULL")
        .get(flow.home_workspace_id);
      if (live) {
        skipped++;
        continue;
      }
    }

    // Re-link to an existing office-home row if one is already there.
    const existing = db
      .prepare("SELECT id FROM workspaces WHERE owner_flow_id = ? AND name = 'office-home' AND deleted_at IS NULL")
      .get(flow.id) as { id: string } | undefined;

    let wsId = existing?.id;
    const action = wsId ? "relink" : "create";

    if (DRY_RUN) {
      console.log(`[dry-run] ${action} home for "${flow.name}" (${flow.id})`);
      if (action === "create") created++; else relinked++;
      continue;
    }

    if (!wsId) {
      wsId = uuid();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO workspaces (id, owner_flow_id, name, description, shared, created_at, updated_at)
         VALUES (?, ?, 'office-home', ?, 1, ?, ?)`,
      ).run(wsId, flow.id, `Home de la oficina ${flow.name}`, now, now);
      created++;
    } else {
      relinked++;
    }

    db.prepare("UPDATE agent_flows SET home_workspace_id = ?, updated_at = ? WHERE id = ?")
      .run(wsId, new Date().toISOString(), flow.id);
    console.log(`${action} home for "${flow.name}" → workspace ${wsId}`);
  }

  db.close();
  console.log(
    `\nDone. ${flows.length} active offices: ${created} created, ${relinked} relinked, ${skipped} already had a home.${DRY_RUN ? " (dry-run, nothing written)" : ""}`,
  );
}

main();
