/**
 * Workspace evolver — runCycle() integration demo.
 *
 * Same calc.sh miniature as demo-workspace-evolver.ts, but driven via
 * `evolver.runCycle()` + AgentExecutor instead of calling the primitives
 * directly. Two agents with `builtin_handler` short-circuit the LLM path,
 * so the demo runs without needing API keys configured.
 *
 * What this exercises that the primitives demo doesn't:
 *   - runCycle() orchestrates snapshot → executor.execute → evaluate → accept|reject
 *   - agent_runs rows are populated (the run that mutated the workspace)
 *   - evolution_runs.trigger_run_ids links back to the agent run
 *   - reject path actually reverts when the agent's mutation breaks the eval
 */

import { Database } from "bun:sqlite";
import { writeFile, readFile, rm, mkdir, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { WorkspaceService } from "../assets/extensions/agents/agent-advanced/_module/workspace-service.js";
import { WORKSPACE_ROOT } from "../src/modules/agents/workspace-constants.js";
import { WorkspaceEvolverService } from "../assets/extensions/agents/agent-advanced/_module/workspace-evolver/service.js";
import { EventBus } from "../src/core/event-bus.js";

const WORKSPACE_ID = "evolver-demo-runcycle";

function header(title: string): void {
  console.log("\n" + "─".repeat(70));
  console.log(`  ${title}`);
  console.log("─".repeat(70));
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
  // Demo runs both cycles back-to-back; in production keep the default
  // cooldown to throttle runaway loops.
  const evolver = new WorkspaceEvolverService(agents, workspaces, { cooldownSeconds: 0 });

  // The whole point of this demo: drive the cycle through the real executor.
  const executor = new AgentExecutor();

  // Two builtin handlers stand in for an LLM-driven agent. The first writes
  // a correct calc.sh; the second writes a broken one. The executor's
  // builtin-handler short-circuit fires them without touching the LLM path.
  const writeCorrect = async (): Promise<string> => {
    const p = resolve(workspaceDir, "calc.sh");
    await writeFile(p, "#!/bin/sh\necho $(( $1 + $2 ))\n", "utf8");
    await chmod(p, 0o755);
    return "wrote correct adder";
  };
  const writeBuggy = async (): Promise<string> => {
    const p = resolve(workspaceDir, "calc.sh");
    await writeFile(p, "#!/bin/sh\necho $(( $1 - $2 ))\n", "utf8");
    await chmod(p, 0o755);
    return "wrote subtraction (intentionally broken)";
  };
  const handlers = new Map<string, () => Promise<string>>();
  handlers.set("demo:write-correct-calc", writeCorrect);
  handlers.set("demo:break-calc", writeBuggy);
  executor.setBuiltinHandlers(handlers);

  workspaces.create({ id: WORKSPACE_ID, owner_flow_id: "demo-flow", name: "calc-demo" });
  const goodAgent = agents.createAgent({
    name: "calc-implementer",
    builtin_handler: "demo:write-correct-calc",
  });
  const badAgent = agents.createAgent({
    name: "calc-saboteur",
    builtin_handler: "demo:break-calc",
  });
  console.log(`  workspace_id   : ${WORKSPACE_ID}`);
  console.log(`  good agent     : ${goodAgent.id} (handler=${goodAgent.builtin_handler})`);
  console.log(`  bad agent      : ${badAgent.id} (handler=${badAgent.builtin_handler})`);

  // ── policy + checks ────────────────────────────────
  header("Init evolver + policy + checks");
  await evolver.init(WORKSPACE_ID);
  await writeFile(
    resolve(workspaceDir, ".evolve/policy.json"),
    JSON.stringify({
      version: 1,
      mutable_globs: ["calc.sh"],
      protected_globs: [],
      evaluation: { command: "./.evolve/checks/run-all.sh", timeout_s: 10 },
    }, null, 2),
    "utf8",
  );
  const checksPath = resolve(workspaceDir, ".evolve/checks/run-all.sh");
  await writeFile(
    checksPath,
    [
      "#!/bin/sh",
      "set -e",
      'r=$(./calc.sh 2 3); test "$r" = "5" || (echo "expected 5, got $r" >&2; exit 1)',
      'r=$(./calc.sh 10 20); test "$r" = "30" || (echo "expected 30, got $r" >&2; exit 1)',
      "echo all good",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(checksPath, 0o755);
  console.log("  policy + checks ready");

  // ── CYCLE 1 — good agent ───────────────────────────
  header("CYCLE 1 — runCycle with the good agent");
  const out1 = await evolver.runCycle({
    workspace_id: WORKSPACE_ID,
    agent_id: goodAgent.id,
    goal: "implement a sumator at calc.sh",
    executor,
    events,
  });
  console.log(`  status         : ${out1.summary.status}`);
  console.log(`  agent_run_id   : ${out1.agent_run_id}`);
  console.log(`  baseline       : ${out1.summary.baseline_ref.slice(0, 12)}`);
  console.log(`  candidate      : ${out1.summary.candidate_ref.slice(0, 12) || "(none)"}`);
  console.log(`  eval passed    : ${out1.summary.evaluation?.passed}`);
  console.log(`  eval stdout    : ${out1.summary.evaluation?.stdout.trim()}`);

  const run1Row = agents.getRun(out1.agent_run_id);
  console.log(`  agent_run row  : status=${run1Row?.status} result="${(run1Row?.result ?? "").slice(0, 60)}"`);

  // ── CYCLE 2 — bad agent ────────────────────────────
  header("CYCLE 2 — runCycle with the bad agent (expect reject + revert)");
  const out2 = await evolver.runCycle({
    workspace_id: WORKSPACE_ID,
    agent_id: badAgent.id,
    goal: "modify calc.sh somehow",
    executor,
    events,
  });
  console.log(`  status         : ${out2.summary.status}`);
  console.log(`  agent_run_id   : ${out2.agent_run_id}`);
  console.log(`  candidate      : ${out2.summary.candidate_ref.slice(0, 12) || "(none — rejected)"}`);
  console.log(`  eval passed    : ${out2.summary.evaluation?.passed}`);
  console.log(`  eval stderr    : ${out2.summary.evaluation?.stderr.trim()}`);

  const run2Row = agents.getRun(out2.agent_run_id);
  console.log(`  agent_run row  : status=${run2Row?.status} result="${(run2Row?.result ?? "").slice(0, 60)}"`);

  // ── verify revert ──────────────────────────────────
  header("Verify revert: calc.sh should still be the working sumator");
  const calcAfter = await readFile(resolve(workspaceDir, "calc.sh"), "utf8");
  console.log(calcAfter.split("\n").map(l => "    " + l).join("\n"));

  // ── final state ────────────────────────────────────
  header("Persisted state");
  const allRuns = agents.listRuns({ limit: 10 });
  console.log(`  agent_runs (${allRuns.length}):`);
  for (const r of allRuns) {
    const payload = JSON.parse(r.trigger_payload || "{}");
    console.log(`  • ${r.id.slice(0, 8)}  agent=${r.agent_id.slice(0, 8)}  status=${r.status}  evolution=${payload.evolution ? "yes" : "no"}`);
  }

  const allEvos = agents.listEvolutionRunsByWorkspace(WORKSPACE_ID);
  console.log(`\n  agent_evolution_runs (${allEvos.length}):`);
  for (const e of allEvos) {
    const triggers = JSON.parse(e.trigger_run_ids || "[]") as string[];
    console.log(`  • ${e.id.slice(0, 8)}  status=${e.status.padEnd(8)} target=${e.target}  trigger_runs=[${triggers.map(t => t.slice(0,8)).join(",")}]  artifact=${e.artifact_ref.slice(0, 12) || "(none)"}`);
  }

  console.log(`\n  git log:`);
  const proc = Bun.spawnSync(["git", "-C", workspaceDir, "log", "--oneline"]);
  console.log(proc.stdout.toString().split("\n").map(l => "    " + l).join("\n"));

  // ── cleanup ────────────────────────────────────────
  db.close();
  await rm(workspaceDir, { recursive: true, force: true });
  console.log("  ✓ runCycle demo complete\n");
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
