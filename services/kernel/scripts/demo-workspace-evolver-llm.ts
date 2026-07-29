/**
 * Workspace evolver — LLM-driven runCycle demo.
 *
 * This is the runCycle demo with a real LLM in the loop. The agent gets a
 * goal, picks a tool, modifies calc.sh, the evaluator runs, runCycle decides
 * accept|reject. End-to-end with no shortcuts.
 *
 * Provider: points at Ollama's OpenAI-compatible endpoint via the
 * lmstudio adapter (Ollama and LM Studio expose the same OpenAI shape).
 *
 * Cost guards:
 *   - Local model (Ollama llama3.2:3b) → zero $$ and no upstream rate limit.
 *   - max_iterations=4 caps the LLM round-trips.
 *   - max_tokens=2000 caps each completion.
 *   - timeout_ms=60_000 caps wall time.
 *
 * If Ollama isn't running on :11434 the demo stops with a clear message.
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
import { workspaceTools } from "../assets/extensions/agents/agent-advanced/_module/workspace-tools.js";
import { WorkspaceEvolverService } from "../assets/extensions/agents/agent-advanced/_module/workspace-evolver/service.js";
import { createChatProviders } from "../src/modules/chat/llm-adapter.js";
import { EventBus } from "../src/core/event-bus.js";

const WORKSPACE_ID = "evolver-demo-llm";
const OLLAMA_URL = "http://localhost:11434/v1";
const MODEL = process.env.MODEL ?? "llama3.2:3b";

function header(title: string): void {
  console.log("\n" + "─".repeat(70));
  console.log(`  ${title}`);
  console.log("─".repeat(70));
}

async function preflight(): Promise<void> {
  try {
    const r = await fetch(`${OLLAMA_URL}/models`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json() as { data?: Array<{ id: string }> };
    const has = json.data?.some((m) => m.id.includes(MODEL.split(":")[0]));
    if (!has) {
      console.log(`  ! warning: ${MODEL} not in Ollama's catalog at ${OLLAMA_URL}`);
      console.log(`    available: ${json.data?.map((m) => m.id).join(", ") ?? "none"}`);
    }
  } catch (err) {
    console.error(`Cannot reach Ollama at ${OLLAMA_URL}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`Start it with: ollama serve  (and pull the model: ollama pull ${MODEL})`);
    process.exit(2);
  }
}

async function main(): Promise<void> {
  header("Pre-flight");
  await preflight();
  console.log(`  Ollama reachable, model=${MODEL}`);

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
  const evolver = new WorkspaceEvolverService(agents, workspaces, { cooldownSeconds: 0 });

  // Provider: Ollama via the OpenAI-compat adapter. lmstudioBaseUrl is the
  // shape we plug in; both Ollama and LM Studio expose the same endpoint.
  const providers = createChatProviders({
    anthropicApiKey: "",
    openaiApiKey: "",
    lmstudioBaseUrl: OLLAMA_URL,
  });

  // The flow + agent are scoped to the same office; the workspace is owned
  // by that flow so the agent has write access.
  const flowId = "demo-flow-llm";
  workspaces.create({ id: WORKSPACE_ID, owner_flow_id: flowId, name: "main" });

  const agent = agents.createAgent({
    name: "calc-implementer-llm",
    description: "Writes a tiny shell calculator on demand.",
    system_prompt:
      "You are an agent that writes small shell scripts on request.\n" +
      "Use kernel_workspace_write to create files. Paths are relative to the workspace root.\n" +
      "Be terse: pick one tool call that solves the task and stop. Do not explain.",
    flow_id: flowId,
    provider: "lmstudio",
    model: MODEL,
    allowed_tools: ["kernel_workspace_write"],
    max_iterations: 4,
    max_tokens: 2000,
    timeout_ms: 60_000,
    max_errors: 2,
  });

  // Wire the executor: providers + tools.
  const executor = new AgentExecutor();
  executor.setProviders(providers, "lmstudio");
  executor.setKernelTools([...workspaceTools(agents, workspaces)]);

  console.log(`  workspace_id : ${WORKSPACE_ID}`);
  console.log(`  agent_id     : ${agent.id}`);
  console.log(`  flow_id      : ${flowId}`);
  console.log(`  model        : ${MODEL} via lmstudio adapter @ ${OLLAMA_URL}`);

  // ── policy + checks ───────────────────────────────
  header("Init evolver + policy");
  await evolver.init(WORKSPACE_ID);
  await writeFile(
    resolve(workspaceDir, ".evolve/policy.json"),
    JSON.stringify({
      version: 1,
      mutable_globs: ["calc.sh"],
      protected_globs: [],
      // Eval uses `sh calc.sh` (no chmod required) so the agent doesn't
      // need executable-bit support from kernel_workspace_write.
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
      'test -f calc.sh || (echo "calc.sh not present" >&2; exit 1)',
      'r=$(sh calc.sh 2 3); test "$r" = "5" || (echo "expected 5, got $r" >&2; exit 1)',
      'r=$(sh calc.sh 10 7); test "$r" = "17" || (echo "expected 17, got $r" >&2; exit 1)',
      "echo all good",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(checksPath, 0o755);

  // ── runCycle with a real LLM ──────────────────────
  header("runCycle — agent picks a tool, writes calc.sh, eval gates the result");
  const goal =
    "Create a shell script at path 'calc.sh' (in the workspace root) that takes two integer arguments and prints their sum. " +
    "Use kernel_workspace_write. The file content must be exactly:\n" +
    "#!/bin/sh\\necho $(($1 + $2))\\n";
  console.log(`  goal: ${goal.slice(0, 100)}...`);

  const start = Date.now();
  const out = await evolver.runCycle({
    workspace_id: WORKSPACE_ID,
    agent_id: agent.id,
    goal,
    executor,
    events,
  });
  const elapsedMs = Date.now() - start;

  header("Cycle outcome");
  console.log(`  status         : ${out.summary.status}`);
  console.log(`  agent_run_id   : ${out.agent_run_id}`);
  console.log(`  baseline       : ${out.summary.baseline_ref.slice(0, 12)}`);
  console.log(`  candidate      : ${out.summary.candidate_ref.slice(0, 12) || "(none)"}`);
  console.log(`  eval passed    : ${out.summary.evaluation?.passed}`);
  console.log(`  eval stdout    : ${(out.summary.evaluation?.stdout ?? "").trim()}`);
  console.log(`  eval stderr    : ${(out.summary.evaluation?.stderr ?? "").trim()}`);
  console.log(`  total wall time: ${elapsedMs}ms`);

  const runRow = agents.getRun(out.agent_run_id);
  console.log(`  agent run      : status=${runRow?.status} steps=${runRow?.steps_count} tokens=${runRow?.tokens_used}`);

  header("calc.sh contents (post-cycle)");
  const calcContents = await readFile(resolve(workspaceDir, "calc.sh"), "utf8").catch(() => "(file absent — agent didn't create it)");
  console.log(calcContents.split("\n").map(l => "    " + l).join("\n"));

  header("agent_run_steps trace");
  const steps = agents.getSteps(out.agent_run_id);
  for (const s of steps.slice(0, 20)) {
    const summary = s.tool_name
      ? `${s.tool_name}(${s.tool_input.slice(0, 80)})`
      : s.content.slice(0, 100);
    console.log(`  • ${s.step_number.toString().padStart(2)} ${s.type.padEnd(12)} ${summary}`);
  }
  if (steps.length > 20) console.log(`  … (${steps.length - 20} more steps)`);

  // ── cleanup ───────────────────────────────────────
  db.close();
  await rm(workspaceDir, { recursive: true, force: true });
  console.log("\n  ✓ LLM-driven demo complete\n");
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
