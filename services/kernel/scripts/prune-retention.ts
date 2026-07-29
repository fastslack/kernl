#!/usr/bin/env bun
/**
 * Retention pruning for kernel.db (design Fase 0).
 *
 * The DB grows to multi-GB not from "intelligence" but from un-pruned
 * operational history: agent run logs, market snapshots, RSS items,
 * evolution runs. This trims them to a retention window.
 *
 * SAFE BY DEFAULT: runs as a DRY RUN and only reports what it WOULD delete.
 * Pass `--apply` to actually delete + VACUUM. Pass `--db <path>` to target a
 * non-default database. Tune windows with the flags below.
 *
 * Usage:
 *   bun scripts/prune-retention.ts                  # dry run, default windows
 *   bun scripts/prune-retention.ts --apply          # actually prune + VACUUM
 *   bun scripts/prune-retention.ts --runs-days 14 --snapshots-days 7 --apply
 *
 * Idempotent: re-running after an apply finds little/nothing left to trim.
 */

import { Database } from "bun:sqlite";

interface Args {
  db: string;
  apply: boolean;
  runsDays: number;
  snapshotsDays: number;
  rssDays: number;
  evolutionKeep: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    db: "./data/kernel.db",
    apply: false,
    runsDays: 30,
    snapshotsDays: 30,
    rssDays: 60,
    evolutionKeep: 2000,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--apply") a.apply = true;
    else if (v === "--db") a.db = argv[++i];
    else if (v === "--runs-days") a.runsDays = parseInt(argv[++i], 10);
    else if (v === "--snapshots-days") a.snapshotsDays = parseInt(argv[++i], 10);
    else if (v === "--rss-days") a.rssDays = parseInt(argv[++i], 10);
    else if (v === "--evolution-keep") a.evolutionKeep = parseInt(argv[++i], 10);
  }
  return a;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function tableExists(db: Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columns(db: Database, table: string): Set<string> {
  const rows = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

interface Policy {
  label: string;
  table: string;
  /** Returns the count + DELETE sql + params for rows to prune. */
  plan: (db: Database) => { count: number; sql: string; params: unknown[] } | null;
}

function buildPolicies(a: Args): Policy[] {
  // Pick the first timestamp column that actually exists (schemas vary:
  // rss_items has fetched_at/published_at, not created_at).
  const olderThan = (table: string, tsCandidates: string[], iso: string): Policy["plan"] => (db) => {
    if (!tableExists(db, table)) return null;
    const cols = columns(db, table);
    const tsCol = tsCandidates.find((c) => cols.has(c));
    if (!tsCol) return null;
    const where = `${tsCol} < ?`;
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(iso) as { n: number }).n;
    return { count, sql: `DELETE FROM ${table} WHERE ${where}`, params: [iso] };
  };

  return [
    { label: `agent_runs older than ${a.runsDays}d`, table: "agent_runs", plan: olderThan("agent_runs", ["created_at", "started_at"], isoDaysAgo(a.runsDays)) },
    {
      label: "agent_run_steps orphaned (run pruned)",
      table: "agent_run_steps",
      plan: (db) => {
        if (!tableExists(db, "agent_run_steps") || !tableExists(db, "agent_runs")) return null;
        if (!columns(db, "agent_run_steps").has("run_id")) return null;
        const where = "run_id NOT IN (SELECT id FROM agent_runs)";
        const count = (db.prepare(`SELECT COUNT(*) AS n FROM agent_run_steps WHERE ${where}`).get() as { n: number }).n;
        return { count, sql: `DELETE FROM agent_run_steps WHERE ${where}`, params: [] };
      },
    },
    { label: `market_snapshots older than ${a.snapshotsDays}d`, table: "market_snapshots", plan: olderThan("market_snapshots", ["created_at", "timestamp", "ts"], isoDaysAgo(a.snapshotsDays)) },
    { label: `rss_items older than ${a.rssDays}d`, table: "rss_items", plan: olderThan("rss_items", ["fetched_at", "published_at", "created_at"], isoDaysAgo(a.rssDays)) },
    {
      label: `agent_evolution_runs keep newest ${a.evolutionKeep}`,
      table: "agent_evolution_runs",
      plan: (db) => {
        if (!tableExists(db, "agent_evolution_runs") || !columns(db, "agent_evolution_runs").has("created_at")) return null;
        const where = `id NOT IN (SELECT id FROM agent_evolution_runs ORDER BY created_at DESC LIMIT ${a.evolutionKeep})`;
        const count = (db.prepare(`SELECT COUNT(*) AS n FROM agent_evolution_runs WHERE ${where}`).get() as { n: number }).n;
        return { count, sql: `DELETE FROM agent_evolution_runs WHERE ${where}`, params: [] };
      },
    },
  ];
}

function fileSizeMB(path: string): string {
  try {
    const st = require("node:fs").statSync(path);
    return (st.size / 1_048_576).toFixed(1) + " MB";
  } catch {
    return "?";
  }
}

function main() {
  const a = parseArgs(Bun.argv.slice(2));
  console.log(`\n🧹 Retention prune — ${a.db}`);
  console.log(`   mode: ${a.apply ? "APPLY (will delete + VACUUM)" : "DRY RUN (no changes)"}`);
  console.log(`   size before: ${fileSizeMB(a.db)}\n`);

  const db = new Database(a.db);
  db.run("PRAGMA busy_timeout = 10000");
  const policies = buildPolicies(a);

  let totalToDelete = 0;
  const plans: Array<{ label: string; sql: string; params: unknown[]; count: number }> = [];
  for (const p of policies) {
    const planned = p.plan(db);
    if (!planned) {
      console.log(`   • ${p.label}: (table/column absent — skipped)`);
      continue;
    }
    plans.push({ label: p.label, ...planned });
    totalToDelete += planned.count;
    console.log(`   • ${p.label}: ${planned.count.toLocaleString()} rows`);
  }

  console.log(`\n   total rows to prune: ${totalToDelete.toLocaleString()}`);

  if (!a.apply) {
    console.log(`\n   DRY RUN — nothing deleted. Re-run with --apply to prune.\n`);
    db.close();
    return;
  }

  if (totalToDelete === 0) {
    console.log(`\n   Nothing to prune. ✅\n`);
    db.close();
    return;
  }

  console.log(`\n   Applying…`);
  const tx = db.transaction(() => {
    for (const pl of plans) {
      if (pl.count === 0) continue;
      const info = db.prepare(pl.sql).run(...(pl.params as never[]));
      console.log(`     ✓ ${pl.label}: deleted ${info.changes}`);
    }
  });
  tx();

  console.log(`   VACUUM…`);
  db.run("VACUUM");
  db.close();
  console.log(`\n   size after: ${fileSizeMB(a.db)} ✅\n`);
}

main();
