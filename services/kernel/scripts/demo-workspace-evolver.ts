/**
 * Workspace evolver — miniature end-to-end demo.
 *
 * Two cycles of the same workspace:
 *   1. Agent writes a CORRECT calc.sh → eval passes → accept (new commit).
 *   2. Agent writes a BROKEN calc.sh → eval fails → reject + revert.
 *
 * Doesn't require Claude SDK / HTTP — calls the service primitives directly.
 * Uses an in-memory SQLite DB + a workspace id under data/workspaces/.
 */

import { Database } from "bun:sqlite";
import { writeFile, readFile, rm, mkdir, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { WorkspaceService } from "../assets/extensions/agents/agent-advanced/_module/workspace-service.js";
import { WORKSPACE_ROOT } from "../src/modules/agents/workspace-constants.js";
import { WorkspaceEvolverService } from "../assets/extensions/agents/agent-advanced/_module/workspace-evolver/service.js";
import { EventBus } from "../src/core/event-bus.js";

const WORKSPACE_ID = "evolver-demo-mini";

function header(title: string): void {
  console.log("\n" + "─".repeat(70));
  console.log(`  ${title}`);
  console.log("─".repeat(70));
}

async function readMaybe(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch { return null; }
}

async function main(): Promise<void> {
  const workspaceDir = resolve(WORKSPACE_ROOT, WORKSPACE_ID);
  await rm(workspaceDir, { recursive: true, force: true });
  await mkdir(workspaceDir, { recursive: true });

  header("Setup");
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "agents", agentsMigrations);
  const events = new EventBus();
  const agents = new AgentService(db, events);
  const workspaces = new WorkspaceService(db);
  const evolver = new WorkspaceEvolverService(agents, workspaces);

  const agent = agents.createAgent({ name: "demo-worker" });
  workspaces.create({ id: WORKSPACE_ID, owner_flow_id: "demo-flow", name: "calc-demo" });
  console.log(`  agent_id    = ${agent.id}`);
  console.log(`  workspace_id= ${WORKSPACE_ID}`);
  console.log(`  workspace_dir= ${workspaceDir}`);

  // ── 1. init ────────────────────────────────────────
  header("1. evolver.init() — scaffold .evolve files + git repo");
  const initResult = await evolver.init(WORKSPACE_ID);
  console.log(`  policy.json    : ${initResult.policyCreated ? "created" : "kept"}`);
  console.log(`  EVOLUTION.md   : ${initResult.objectivesCreated ? "created" : "kept"}`);
  console.log(`  checks/run-all.sh: ${initResult.checksCreated ? "created" : "kept"}`);
  console.log(`  initial HEAD   : ${initResult.head_ref.slice(0, 12)}`);

  // ── 2. policy + checks for our toy project ─────────
  header("2. write a policy + a check script for calc.sh");
  await writeFile(
    resolve(workspaceDir, ".evolve/policy.json"),
    JSON.stringify({
      version: 1,
      mutable_globs: ["calc.sh", "README.md"],
      protected_globs: [],
      evaluation: {
        command: "./.evolve/checks/run-all.sh",
        timeout_s: 10,
      },
    }, null, 2),
    "utf8",
  );
  const checksPath = resolve(workspaceDir, ".evolve/checks/run-all.sh");
  await writeFile(
    checksPath,
    [
      "#!/bin/sh",
      "set -e",
      'test -x calc.sh || (echo "calc.sh not executable" >&2; exit 1)',
      'r=$(./calc.sh 2 3); test "$r" = "5" || (echo "expected 5, got $r" >&2; exit 1)',
      'r=$(./calc.sh 10 20); test "$r" = "30" || (echo "expected 30, got $r" >&2; exit 1)',
      'r=$(./calc.sh -1 1); test "$r" = "0" || (echo "expected 0, got $r" >&2; exit 1)',
      'echo "all checks passed"',
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(checksPath, 0o755);
  console.log("  policy.json: mutable_globs = ['calc.sh', 'README.md']");
  console.log("  checks: 2+3=5, 10+20=30, -1+1=0");

  // ── 3. cycle 1 — agent writes a CORRECT calc.sh ────
  header("3. CYCLE 1 — snapshotBaseline");
  const baseline1 = await evolver.snapshotBaseline({ workspace_id: WORKSPACE_ID, label: "pre-cycle-1" });
  console.log(`  baseline    : ${baseline1.ref.slice(0, 12)}`);

  header("3. CYCLE 1 — simulate agent writing calc.sh (CORRECT version)");
  const calcPath = resolve(workspaceDir, "calc.sh");
  await writeFile(
    calcPath,
    [
      "#!/bin/sh",
      "# A trivial adder — first cycle gets it right",
      "echo $(( $1 + $2 ))",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(calcPath, 0o755);
  console.log("  wrote: calc.sh (correct adder)");

  header("3. CYCLE 1 — evaluate");
  const eval1 = await evolver.evaluate({ workspace_id: WORKSPACE_ID });
  console.log(`  passed    : ${eval1?.passed}`);
  console.log(`  exit_code : ${eval1?.exit_code}`);
  console.log(`  stdout    : ${eval1?.stdout.trim()}`);
  console.log(`  duration  : ${eval1?.duration_ms}ms`);

  header(`3. CYCLE 1 — ${eval1?.passed ? "acceptCandidate" : "rejectCandidate (eval failed)"}`);
  if (eval1?.passed) {
    const acc1 = await evolver.acceptCandidate({
      workspace_id: WORKSPACE_ID,
      agent_id: agent.id,
      baseline_ref: baseline1.ref,
      evaluation: eval1,
      notes: "first calc.sh implementation",
      hypothesis: "implement a working adder",
    });
    console.log(`  status      : ${acc1.status}`);
    console.log(`  candidate   : ${acc1.candidate_ref.slice(0, 12)}`);
    console.log(`  evolution_id: ${acc1.evolution_run_id}`);
  } else {
    throw new Error(`cycle 1 unexpectedly failed eval — exit ${eval1?.exit_code}, stderr=${eval1?.stderr}`);
  }

  // ── 4. cycle 2 — agent breaks it ───────────────────
  header("4. CYCLE 2 — snapshotBaseline (now points to cycle 1's candidate)");
  const baseline2 = await evolver.snapshotBaseline({ workspace_id: WORKSPACE_ID, label: "pre-cycle-2" });
  console.log(`  baseline    : ${baseline2.ref.slice(0, 12)}  (= cycle 1 candidate)`);

  header("4. CYCLE 2 — simulate agent introducing a BUG (subtraction instead of sum)");
  await writeFile(
    calcPath,
    [
      "#!/bin/sh",
      "# Oops — subtraction instead of addition",
      "echo $(( $1 - $2 ))",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(calcPath, 0o755);
  console.log("  wrote: calc.sh (BUGGY: $1 - $2)");
  console.log("  current calc.sh contents:");
  console.log((await readFile(resolve(workspaceDir, "calc.sh"), "utf8")).split("\n").map(l => "    " + l).join("\n"));

  header("4. CYCLE 2 — evaluate");
  const eval2 = await evolver.evaluate({ workspace_id: WORKSPACE_ID });
  console.log(`  passed    : ${eval2?.passed}`);
  console.log(`  exit_code : ${eval2?.exit_code}`);
  console.log(`  stderr    : ${eval2?.stderr.trim()}`);

  header("4. CYCLE 2 — rejectCandidate (revert=true)");
  const rej2 = await evolver.rejectCandidate({
    workspace_id: WORKSPACE_ID,
    agent_id: agent.id,
    baseline_ref: baseline2.ref,
    evaluation: eval2!,
    notes: "agent broke addition",
    hypothesis: "tried to introduce subtraction by mistake",
    revert: true,
  });
  console.log(`  status      : ${rej2.status}`);
  console.log(`  evolution_id: ${rej2.evolution_run_id}`);

  header("4. CYCLE 2 — verify revert: calc.sh is back to the working version");
  const restored = await readFile(resolve(workspaceDir, "calc.sh"), "utf8");
  console.log("  restored calc.sh:");
  console.log(restored.split("\n").map(l => "    " + l).join("\n"));
  const reEval = await evolver.evaluate({ workspace_id: WORKSPACE_ID });
  console.log(`  re-eval after revert → passed: ${reEval?.passed}, exit: ${reEval?.exit_code}`);

  // ── 5. results ─────────────────────────────────────
  header("5. RESULTS");
  const history = agents.listEvolutionRunsByWorkspace(WORKSPACE_ID);
  console.log(`  agent_evolution_runs (${history.length} rows):`);
  for (const h of history) {
    console.log(`  • ${h.created_at}  status=${h.status.padEnd(8)} target=${h.target}  artifact=${h.artifact_ref.slice(0, 12) || "(none)"}`);
  }

  console.log(`\n  workspace files:`);
  const files = ["calc.sh", "README.md", ".evolve/policy.json", "EVOLUTION.md"];
  for (const f of files) {
    const c = await readMaybe(resolve(workspaceDir, f));
    console.log(`  • ${f}: ${c ? `${c.length} bytes` : "(missing)"}`);
  }

  console.log(`\n  git log (last 5):`);
  const proc = Bun.spawnSync(["git", "-C", workspaceDir, "log", "--oneline", "-5"]);
  console.log(proc.stdout.toString().split("\n").map(l => "    " + l).join("\n"));

  // ── 6. cleanup ─────────────────────────────────────
  header("6. cleanup");
  db.close();
  await rm(workspaceDir, { recursive: true, force: true });
  console.log(`  removed ${workspaceDir}`);
  console.log("\n  ✓ demo complete\n");
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
