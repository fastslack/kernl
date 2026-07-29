import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { WorkspaceService, WORKSPACE_ROOT } from "../assets/extensions/agents/agent-advanced/_module/workspace-service.js";
import { WorkspaceEvolverService } from "../assets/extensions/agents/agent-advanced/_module/workspace-evolver/service.js";
import { newId } from "../src/core/helpers.js";
import { EventBus } from "../src/core/event-bus.js";

describe("WorkspaceEvolverService", () => {
  let db: InstanceType<typeof Database>;
  let agents: AgentService;
  let workspaces: WorkspaceService;
  let evolver: WorkspaceEvolverService;
  let workspaceId: string;
  let workspaceDir: string;
  let agentId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    const events = new EventBus();
    agents = new AgentService(db, events);
    workspaces = new WorkspaceService(db);
    evolver = new WorkspaceEvolverService(agents, workspaces);

    const agent = agents.createAgent({ name: "evolver-test-agent" });
    agentId = agent.id;

    const ws = workspaces.create({
      owner_flow_id: "flow-test",
      name: `evolver-test-${newId()}`,
    });
    workspaceId = ws.id;
    workspaceDir = resolve(WORKSPACE_ROOT, workspaceId);
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  // ── init ────────────────────────────────────────────

  it("init scaffolds policy.json, EVOLUTION.md, checks/run-all.sh on first call", async () => {
    const r = await evolver.init(workspaceId);
    expect(r.policyCreated).toBe(true);
    expect(r.objectivesCreated).toBe(true);
    expect(r.checksCreated).toBe(true);
    expect(r.head_ref).toMatch(/^[0-9a-f]{40}$/);

    const policyRaw = await readFile(resolve(workspaceDir, ".evolve/policy.json"), "utf8");
    expect(JSON.parse(policyRaw).version).toBe(1);
  });

  it("init creates checks/run-all.sh as executable", async () => {
    await evolver.init(workspaceId);
    const checksPath = resolve(workspaceDir, ".evolve/checks/run-all.sh");
    const s = await stat(checksPath);
    // owner-execute bit must be set, otherwise the eval command can't run it.
    expect(s.mode & 0o100).toBeGreaterThan(0);
  });

  it("init is idempotent — second call leaves files untouched", async () => {
    await evolver.init(workspaceId);
    await writeFile(resolve(workspaceDir, "EVOLUTION.md"), "# my custom mission\n", "utf8");

    const r = await evolver.init(workspaceId);
    expect(r.policyCreated).toBe(false);
    expect(r.objectivesCreated).toBe(false);

    const md = await readFile(resolve(workspaceDir, "EVOLUTION.md"), "utf8");
    expect(md).toContain("my custom mission");
  });

  // ── describe ────────────────────────────────────────

  it("describe reports uninitialised state before init", async () => {
    const d = await evolver.describe(workspaceId);
    expect(d.initialised).toBe(false);
    expect(d.policy).toBeNull();
    expect(d.objectives).toBeNull();
  });

  it("describe reports initialised state after init", async () => {
    await evolver.init(workspaceId);
    const d = await evolver.describe(workspaceId);
    expect(d.initialised).toBe(true);
    expect(d.policy).not.toBeNull();
    expect(d.objectives).toContain("EVOLUTION");
    expect(d.head_ref).toMatch(/^[0-9a-f]{40}$/);
  });

  // ── snapshot + evaluate + accept happy path ────────

  it("end-to-end: snapshot → modify → evaluate (pass) → accept", async () => {
    await evolver.init(workspaceId);
    await writeFile(
      resolve(workspaceDir, ".evolve/policy.json"),
      JSON.stringify({
        version: 1,
        mutable_globs: [],
        protected_globs: [],
        evaluation: { command: "true", timeout_s: 5 },
      }, null, 2),
      "utf8",
    );

    const baseline = await evolver.snapshotBaseline({ workspace_id: workspaceId });
    expect(baseline.ref).toMatch(/^[0-9a-f]{40}$/);

    // Simulate the agent modifying the workspace.
    await writeFile(resolve(workspaceDir, "src.txt"), "new code", "utf8");

    const evalResult = await evolver.evaluate({ workspace_id: workspaceId });
    expect(evalResult).not.toBeNull();
    expect(evalResult?.passed).toBe(true);

    const summary = await evolver.acceptCandidate({
      workspace_id: workspaceId,
      agent_id: agentId,
      baseline_ref: baseline.ref,
      evaluation: evalResult!,
      hypothesis: "test hypothesis",
    });
    expect(summary.status).toBe("accepted");
    expect(summary.candidate_ref).not.toEqual(baseline.ref);

    const history = agents.listEvolutionRunsByWorkspace(workspaceId);
    expect(history).toHaveLength(1);
    expect(history[0].target).toBe("workspace");
    expect(history[0].status).toBe("accepted");
    expect(history[0].artifact_ref).toEqual(summary.candidate_ref);
  });

  // ── reject + revert ─────────────────────────────────

  it("rejectCandidate with revert=true restores baseline", async () => {
    await evolver.init(workspaceId);
    await writeFile(
      resolve(workspaceDir, ".evolve/policy.json"),
      JSON.stringify({
        version: 1,
        mutable_globs: [],
        protected_globs: [],
        evaluation: { command: "false", timeout_s: 5 },
      }, null, 2),
      "utf8",
    );

    const baseline = await evolver.snapshotBaseline({ workspace_id: workspaceId });

    await writeFile(resolve(workspaceDir, "broken.txt"), "this breaks things", "utf8");
    const evalResult = await evolver.evaluate({ workspace_id: workspaceId });
    expect(evalResult?.passed).toBe(false);

    const summary = await evolver.rejectCandidate({
      workspace_id: workspaceId,
      agent_id: agentId,
      baseline_ref: baseline.ref,
      evaluation: evalResult!,
      revert: true,
    });
    expect(summary.status).toBe("rejected");

    let exists = true;
    try { await readFile(resolve(workspaceDir, "broken.txt"), "utf8"); }
    catch { exists = false; }
    expect(exists).toBe(false);
  });

  it("rejectCandidate with revert=false keeps dirty files for triage", async () => {
    await evolver.init(workspaceId);
    await writeFile(
      resolve(workspaceDir, ".evolve/policy.json"),
      JSON.stringify({
        version: 1,
        mutable_globs: [],
        protected_globs: [],
        evaluation: { command: "false", timeout_s: 5 },
      }, null, 2),
      "utf8",
    );

    const baseline = await evolver.snapshotBaseline({ workspace_id: workspaceId });
    await writeFile(resolve(workspaceDir, "leftover.txt"), "keep me", "utf8");
    const evalResult = await evolver.evaluate({ workspace_id: workspaceId });

    await evolver.rejectCandidate({
      workspace_id: workspaceId,
      agent_id: agentId,
      baseline_ref: baseline.ref,
      evaluation: evalResult!,
      revert: false,
    });

    const content = await readFile(resolve(workspaceDir, "leftover.txt"), "utf8");
    expect(content).toBe("keep me");
  });

  // ── guards (anti rate-limit) ───────────────────────

  it("runCycle rejects a second call inside cooldown window", async () => {
    // Use a guarded evolver for this test — the suite-wide one has default cooldown.
    const guarded = new WorkspaceEvolverService(agents, workspaces, { cooldownSeconds: 60 });
    await guarded.init(workspaceId);
    await writeFile(
      resolve(workspaceDir, ".evolve/policy.json"),
      JSON.stringify({
        version: 1,
        mutable_globs: [],
        protected_globs: [],
        evaluation: { command: "true", timeout_s: 5 },
      }, null, 2),
      "utf8",
    );

    // Stub executor — short-circuits immediately, no LLM.
    const executor = new (await import("../src/modules/agents/executor.js")).AgentExecutor();
    const handlers = new Map<string, () => Promise<string>>();
    handlers.set("test:noop", async () => "ok");
    executor.setBuiltinHandlers(handlers);
    agents.updateAgent(agentId, { builtin_handler: "test:noop" });

    await guarded.runCycle({
      workspace_id: workspaceId, agent_id: agentId, goal: "noop", executor,
    });

    await expect(guarded.runCycle({
      workspace_id: workspaceId, agent_id: agentId, goal: "noop again", executor,
    })).rejects.toThrow(/cooldown active/);
  });

  it("runCycle respects the global concurrency cap", async () => {
    const guarded = new WorkspaceEvolverService(agents, workspaces, {
      cooldownSeconds: 0,
      maxConcurrent: 1,
    });
    await guarded.init(workspaceId);
    await writeFile(
      resolve(workspaceDir, ".evolve/policy.json"),
      JSON.stringify({
        version: 1,
        mutable_globs: [],
        protected_globs: [],
        evaluation: { command: "true", timeout_s: 5 },
      }, null, 2),
      "utf8",
    );

    const executor = new (await import("../src/modules/agents/executor.js")).AgentExecutor();
    const handlers = new Map<string, () => Promise<string>>();
    // Slow handler so the first cycle is still inflight when we fire the second.
    handlers.set("test:slow", () => new Promise<string>((r) => setTimeout(() => r("done"), 80)));
    executor.setBuiltinHandlers(handlers);
    agents.updateAgent(agentId, { builtin_handler: "test:slow" });

    // Need a second workspace to exercise the global cap (the same-workspace
    // guard would also reject, but we want to prove the global one fires).
    const ws2 = workspaces.create({ owner_flow_id: "flow-test", name: `evolver-test-${newId()}` });
    const ws2Dir = resolve(WORKSPACE_ROOT, ws2.id);
    await mkdir(ws2Dir, { recursive: true });
    await guarded.init(ws2.id);
    await writeFile(
      resolve(ws2Dir, ".evolve/policy.json"),
      JSON.stringify({
        version: 1,
        mutable_globs: [],
        protected_globs: [],
        evaluation: { command: "true", timeout_s: 5 },
      }, null, 2),
      "utf8",
    );

    try {
      const first = guarded.runCycle({
        workspace_id: workspaceId, agent_id: agentId, goal: "slow", executor,
      });
      // Second call lands while first is mid-flight → should reject.
      await expect(guarded.runCycle({
        workspace_id: ws2.id, agent_id: agentId, goal: "also slow", executor,
      })).rejects.toThrow(/concurrency cap reached/);
      await first;
    } finally {
      await rm(ws2Dir, { recursive: true, force: true });
    }
  });

  // ── evaluate without policy ────────────────────────

  it("evaluate returns null when no policy is configured", async () => {
    // Workspace dir exists but no .evolve/policy.json
    const result = await evolver.evaluate({ workspace_id: workspaceId });
    expect(result).toBeNull();
  });
});
