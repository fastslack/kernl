#!/usr/bin/env bun
/**
 * Move LLM agents onto the Claude Code executor.
 *
 * Why you would: the native executor needs a provider that can run a tool loop,
 * which means an API key. The Claude Code executor drives the CLI's own SDK
 * loop over your logged-in subscription instead — no key, no per-call billing.
 * On a kernel with no LLM credentials configured, this is the difference
 * between agents that run and agents that cannot.
 *
 * Usage:
 *   bun run scripts/agents-use-claude-code.ts              # dry run, changes nothing
 *   bun run scripts/agents-use-claude-code.ts --apply      # write the changes
 *   bun run scripts/agents-use-claude-code.ts --min-turns 60 --apply
 *
 * Environment:
 *   KERNEL_URL          default http://localhost:3086
 *   KERNEL_AUTH_TOKEN   falls back to <data dir>/.kernel-auth-token
 *
 * It is idempotent: agents already migrated with a sufficient budget are left
 * alone, so re-running it is safe.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface MigratableAgent {
  id: string;
  name: string;
  executor_type?: string;
  builtin_handler?: string;
  max_iterations?: number;
}

export interface PlannedChange {
  id: string;
  name: string;
  /** Switch the engine to claude_code. */
  setExecutor: boolean;
  /** New max_iterations, or null when the current budget is already enough. */
  setMaxIterations: number | null;
  from: { executor: string; maxIterations: number };
}

export interface SkippedAgent {
  id: string;
  name: string;
  reason: string;
}

/**
 * Decide what to change, and what to leave alone.
 *
 * `minTurns` matters more than it looks. Under the native executor one
 * iteration is a full LLM round with every tool batched into it; under the SDK
 * a single tool call spends a turn. An agent sitting at the native-sensible 15
 * runs out mid-task against the SDK — observed as "Reached maximum number of
 * turns (15)" after 55 steps of real work. So agents below the floor get
 * raised to it, and agents already above it are never lowered.
 */
export function planAgentMigration(
  agents: MigratableAgent[],
  opts: { minTurns: number },
): { migrate: PlannedChange[]; skipped: SkippedAgent[] } {
  const migrate: PlannedChange[] = [];
  const skipped: SkippedAgent[] = [];

  for (const a of agents) {
    const executor = a.executor_type || "native";
    const iterations = a.max_iterations ?? 0;

    // Builtin handlers are plain code paths — gsync, catalogue syncs and the
    // like. They never call a model, so an SDK executor would only burn turns.
    if (a.builtin_handler) {
      skipped.push({ id: a.id, name: a.name, reason: `builtin handler (${a.builtin_handler}) — never calls an LLM` });
      continue;
    }

    const needsExecutor = executor !== "claude_code";
    const needsBudget = iterations < opts.minTurns;
    if (!needsExecutor && !needsBudget) {
      skipped.push({ id: a.id, name: a.name, reason: `already on claude_code with ${iterations} turns` });
      continue;
    }

    migrate.push({
      id: a.id,
      name: a.name,
      setExecutor: needsExecutor,
      setMaxIterations: needsBudget ? opts.minTurns : null,
      from: { executor, maxIterations: iterations },
    });
  }

  return { migrate, skipped };
}

// ── CLI ────────────────────────────────────────────────────────────

function resolveToken(): string {
  const fromEnv = process.env.KERNEL_AUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const candidates = [
    resolve(process.cwd(), "data/.kernel-auth-token"),
    resolve(import.meta.dir, "../data/.kernel-auth-token"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, "utf-8").trim();
  }
  throw new Error(
    "No API token. Set KERNEL_AUTH_TOKEN, or run from the kernel's data dir.\n" +
      "  Docker:  KERNEL_AUTH_TOKEN=$(docker compose exec -T kernel cat /app/data/.kernel-auth-token) bun run scripts/agents-use-claude-code.ts",
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const minTurnsArg = args.indexOf("--min-turns");
  const minTurns = minTurnsArg >= 0 ? Number(args[minTurnsArg + 1]) : 40;
  if (!Number.isFinite(minTurns) || minTurns < 1) {
    throw new Error(`--min-turns must be a positive number, got ${args[minTurnsArg + 1]}`);
  }

  const base = (process.env.KERNEL_URL || "http://localhost:3086").replace(/\/$/, "");
  const token = resolveToken();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const res = await fetch(`${base}/api/agents`, { headers: auth });
  if (!res.ok) throw new Error(`GET /api/agents failed: ${res.status} ${await res.text()}`);
  const { agents } = (await res.json()) as { agents: MigratableAgent[] };

  const { migrate, skipped } = planAgentMigration(agents, { minTurns });

  console.log(`\nKernl — move agents to the Claude Code executor  (floor: ${minTurns} turns)`);
  console.log(`${agents.length} agents · ${migrate.length} to change · ${skipped.length} left alone\n`);

  for (const s of skipped) console.log(`  ·  ${s.name.padEnd(28)} skip — ${s.reason}`);
  if (skipped.length > 0) console.log("");
  for (const m of migrate) {
    const bits: string[] = [];
    if (m.setExecutor) bits.push(`executor ${m.from.executor} → claude_code`);
    if (m.setMaxIterations !== null) bits.push(`turns ${m.from.maxIterations} → ${m.setMaxIterations}`);
    console.log(`  ${apply ? "→" : "·"}  ${m.name.padEnd(28)} ${bits.join(", ")}`);
  }

  if (!apply) {
    console.log(`\nDry run — nothing changed. Re-run with --apply to write.`);
    console.log(`Each migrated agent then runs on your Claude subscription; turns count against it.\n`);
    return;
  }

  let ok = 0;
  const failures: string[] = [];
  for (const m of migrate) {
    try {
      if (m.setExecutor) {
        const r = await fetch(`${base}/api/agents/${m.id}/executor-type`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ executor_type: "claude_code" }),
        });
        if (!r.ok) throw new Error(`executor-type: ${r.status} ${await r.text()}`);
      }
      if (m.setMaxIterations !== null) {
        const r = await fetch(`${base}/api/agents/${m.id}`, {
          method: "PUT",
          headers: auth,
          body: JSON.stringify({ max_iterations: m.setMaxIterations }),
        });
        if (!r.ok) throw new Error(`max_iterations: ${r.status} ${await r.text()}`);
      }
      ok++;
    } catch (err) {
      failures.push(`${m.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${ok}/${migrate.length} migrated.`);
  if (failures.length > 0) {
    console.error(`\nFailed:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`Run one and watch it before migrating expectations along with the agents.\n`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
