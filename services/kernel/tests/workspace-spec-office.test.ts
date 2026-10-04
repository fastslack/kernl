/**
 * An office's declarative workspace end to end: the spec is stored on the
 * office home, the tool applies it to the real folder, and a claude_code run
 * refuses to start in a home that could not be prepared.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { workspaceSpecTools } from "../src/modules/agents/workspace-spec-tools.js";
import { ClaudeCodeExecutor, prepareOfficeWorkspace } from "../assets/extensions/agents/agent-advanced/_module/claude-code-executor.js";
import type { ToolDefinition } from "../src/core/types.js";

let root: string;
let origin: string;
let db: InstanceType<typeof Database>;
let service: AgentService;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function tool(name: string): ToolDefinition {
  const t = workspaceSpecTools(service).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

async function call(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const res = (await tool(name).handler(args as never)) as { content: Array<{ text: string }>; isError?: boolean };
  return { text: res.content.map((c) => c.text).join(""), isError: !!res.isError };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kernl-office-ws-"));
  origin = join(root, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  git(origin, "config", "user.email", "t@t");
  git(origin, "config", "user.name", "t");
  writeFileSync(join(origin, "README.md"), "hello\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "init");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "agents", agentsMigrations);
  service = new AgentService(db, new EventBus());
});

afterEach(() => db.close());

/** An office whose home is a host folder under the test root. */
function office(name: string) {
  const flow = service.createFlow({ name });
  const home = join(root, `home-${name}`);
  mkdirSync(home, { recursive: true });
  service.setFlowRepo(flow.id, home);
  return { flow, home };
}

describe("kernel_agents_workspace_apply", () => {
  it("stores the spec and prepares the office home right away", async () => {
    const { flow, home } = office("apply");
    const out = await call("kernel_agents_workspace_apply", {
      flow_id: flow.id,
      spec: {
        git: [{ repo: `file://${origin}`, path: "app" }],
        files: [{ path: "AGENTS.md", content: "# Office rules\n" }],
        skills: ["tdd"],
      },
    });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("**Ready**");
    expect(readFileSync(join(home, "app", "README.md"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("# Office rules\n");

    const ws = service.getFlowWorkspace(flow.id)!;
    expect(ws.setup_status).toBe("ready");
    expect(ws.spec.skills).toEqual(["tdd"]);

    const shown = await call("kernel_agents_workspace_get", { flow_id: flow.id });
    expect(shown.text).toContain(`git file://${origin} → app`);
    expect(shown.text).toContain("last preparation: ready");
  });

  it("rejects an invalid spec without storing it", async () => {
    const { flow } = office("invalid");
    const out = await call("kernel_agents_workspace_apply", {
      flow_id: flow.id,
      spec: { files: [{ path: "../escape.md", content: "x" }] },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/inside the workspace/);
    expect(service.getFlowWorkspace(flow.id)!.spec.files).toEqual([]);
  });

  it("records a failed preparation so it can be seen and retried", async () => {
    const { flow } = office("failing");
    const out = await call("kernel_agents_workspace_apply", {
      flow_id: flow.id,
      spec: { git: [{ repo: `file://${join(root, "missing")}`, path: "app" }] },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Not ready");
    const ws = service.getFlowWorkspace(flow.id)!;
    expect(ws.setup_status).toBe("failed");
    expect(ws.setup_error).toMatch(/app: clone of/);
  });
});

describe("claude_code runs wait for the office home", () => {
  it("fails the run with the reason when the home can't be prepared", async () => {
    const { flow, home } = office("gate");
    service.setFlowWorkspaceSpec(flow.id, { git: [{ repo: `file://${join(root, "gone")}`, path: "app" }] });
    const agent = service.createAgent({ name: "Coder", flow_id: flow.id, executor_type: "claude_code" } as never);
    const run = service.createRun({ agent_id: agent.id, goal: "fix the bug" });
    service.updateRun(run.id, { status: "running" });

    const executor = new ClaudeCodeExecutor();
    const result = await executor.execute({ agent: service.getAgent(agent.id)!, goal: "fix the bug", run, service });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/Workspace not ready: app: clone of/);
    expect(service.getRunConditions(run.id)).toMatchObject([
      { type: "WorkspaceReady", status: "False", reason: "SetupFailed" },
    ]);
    expect(existsSync(join(home, "app"))).toBe(false);
  }, 30_000);

  it("prepares the home and hands the spec's MCP servers and skills to the agent, its own winning", async () => {
    const { flow, home } = office("merge");
    service.setFlowWorkspaceSpec(flow.id, {
      git: [{ repo: `file://${origin}`, path: "app" }],
      mcp_servers: { docs: { type: "http", url: "http://localhost:9000/mcp" }, shared: { type: "http", url: "http://localhost:1/mcp" } },
      skills: ["tdd", "review"],
    });
    const agent = service.createAgent({ name: "Merger", flow_id: flow.id } as never);
    const run = service.createRun({ agent_id: agent.id, goal: "x" });
    const vars = {
      __mcp_servers__: { shared: { type: "http", url: "http://localhost:2/mcp" } },
      __skills__: ["review", "own"],
    } as Parameters<typeof prepareOfficeWorkspace>[3];

    await prepareOfficeWorkspace(service, run.id, flow.id, vars);

    expect(existsSync(join(home, "app", "README.md"))).toBe(true);
    expect(Object.keys(vars.__mcp_servers__!).sort()).toEqual(["docs", "shared"]);
    expect((vars.__mcp_servers__!.shared as { url: string }).url).toBe("http://localhost:2/mcp");
    expect(vars.__skills__).toEqual(["review", "own", "tdd"]);
    expect(service.getRunConditions(run.id)).toMatchObject([
      { type: "WorkspaceReady", status: "True", reason: "Prepared", message: "cloned app" },
    ]);

    await prepareOfficeWorkspace(service, run.id, flow.id, vars);
    expect(service.getRunConditions(run.id)[0].reason).toBe("AlreadyPrepared");
  });

  it("leaves an office without a spec alone", async () => {
    const { flow } = office("nospec");
    const agent = service.createAgent({ name: "Plain", flow_id: flow.id } as never);
    const run = service.createRun({ agent_id: agent.id, goal: "x" });
    const vars = {} as Parameters<typeof prepareOfficeWorkspace>[3];
    await prepareOfficeWorkspace(service, run.id, flow.id, vars);
    expect(vars).toEqual({});
    expect(service.getRunConditions(run.id)).toEqual([]);
  });
});
