/**
 * Wiring for the Kernl fixer: the agent it runs (kept in kernl_bug_settings by
 * id), how a run starts, and the run-completed listener that hands the result
 * to KernlFixService. See kernl-bugs-fix.ts for the safety layers.
 */
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EventBus } from "../../core/event-bus.js";
import { log } from "../../core/logger.js";
import type { AgentService } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import type { KernlBugService } from "./kernl-bugs-service.js";
import { agentOperations } from "./operations.js";
import { KernlFixService, type FixerAgents } from "./kernl-bugs-fix.js";

/** File tools and Bash, nothing else: the kernel's own tools are denied (`mcp__kernel`). */
const FIXER_TOOLS = ["Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "Bash", "TodoWrite"];
const FIXER_DENIED = ["mcp__kernel", "WebFetch"];

export function createKernlFixer(deps: {
  db: SqliteDb;
  service: AgentService;
  executor: AgentExecutor;
  events: EventBus;
  bugs: KernlBugService;
  sandboxReady: () => boolean;
  env?: NodeJS.ProcessEnv;
}): KernlFixService {
  const { db, service, executor, events, bugs } = deps;
  const env = deps.env ?? process.env;
  const settingKey = "fixer_agent_id";
  const readId = () =>
    (db.prepare("SELECT value FROM kernl_bug_settings WHERE key = ?").get(settingKey) as { value: string } | undefined)?.value ?? "";

  const agents: FixerAgents = {
    ensureFixer(cwd) {
      const variables = { __sandbox_driver__: "docker", __cwd_path__: cwd };
      let agent = readId() ? service.getAgent(readId()) : undefined;
      if (!agent) {
        agent = service.createAgent({
          name: "Kernl Fixer",
          description: "Fixes a Kernl bug report in its own worktree, isolated in the Docker sandbox. Started from the Kernl tab of the chief's office.",
          allowed_tools: FIXER_TOOLS,
          denied_tools: FIXER_DENIED,
          variables,
          timeout_ms: 45 * 60_000,
          show_on_dashboard: false,
        });
        db.prepare("INSERT OR REPLACE INTO kernl_bug_settings (key, value) VALUES (?, ?)").run(settingKey, agent.id);
      }
      // Re-asserted every run: an edit in the agent panel must not widen what the fixer can reach.
      service.updateAgent(agent.id, { allowed_tools: FIXER_TOOLS, denied_tools: FIXER_DENIED, variables, active: true });
      service.setExecutorType(agent.id, "claude_code");
      return agent.id;
    },
    async run(agentId, goal) {
      const res = await agentOperations({ service, executor, events })["agents.run"]({ agent_id: agentId, goal }) as { run_id?: string };
      if (!res?.run_id) throw new Error("The fixer run did not start.");
      return res.run_id;
    },
    runStatus(runId) {
      const run = service.getRun(runId);
      return run ? { status: run.status, result: run.result ?? "", error: run.error ?? "" } : null;
    },
    sandboxReady: deps.sandboxReady,
  };

  const fixes = new KernlFixService(db, agents, {
    repo: env.KERNL_REPO_PATH ?? "",
    root: env.KERNL_FIX_ROOT ?? "",
  });
  const titleOf = (bugId: string) => bugs.get(bugId)?.title ?? "Kernl fix";

  events.on("agent:flow:run_completed", (payload) => {
    const runId = (payload as { run_id?: unknown })?.run_id;
    if (typeof runId !== "string" || !runId) return;
    const row = db.prepare("SELECT bug_id FROM kernl_bug_fixes WHERE run_id = ? AND status = 'running'").get(runId) as { bug_id: string } | undefined;
    if (!row) return;
    const run = agents.runStatus(runId);
    const ok = (payload as { status?: unknown }).status === "completed";
    void fixes.finish(row.bug_id, { ok, result: run?.result ?? "", error: run?.error ?? String((payload as { error?: unknown }).error ?? "") }, titleOf(row.bug_id))
      .then((f) => { if (f) events.emit("data.changed", { module: "agents", action: "kernl_fix_finished", bug_id: f.bug_id, status: f.status }); })
      .catch((e) => log.warn(`Kernl fixer: finishing run ${runId} failed: ${(e as Error).message}`));
  });
  void fixes.sweep(titleOf).catch((e) => log.warn(`Kernl fixer: startup sweep failed: ${(e as Error).message}`));
  return fixes;
}
