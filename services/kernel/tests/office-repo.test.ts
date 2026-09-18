/**
 * Changing an office's repo from the panel: the shared setOfficeRepo used by
 * the MCP tool, PUT /api/agents/flows/:id/repo and agents.flows.set_repo.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { EventBus } from "../src/core/event-bus.js";
import { registerAgentRoutes } from "../src/modules/agents/api-routes.js";
import { agentsRpcActions } from "../src/modules/agents/rpc-actions.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { OfficeRepoError, previousOfficeRepo, setOfficeRepo } from "../src/modules/agents/office-repo.js";

let db: InstanceType<typeof Database>;
let service: AgentService;
let dir: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "agents", agentsMigrations);
  service = new AgentService(db, new EventBus());
  dir = mkdtempSync(join(tmpdir(), "kernl-office-repo-"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function setVars(agentId: string, vars: Record<string, unknown>) {
  db.prepare("UPDATE agents SET variables = ? WHERE id = ?").run(JSON.stringify(vars), agentId);
}
const varsOf = (agentId: string) => JSON.parse(service.getAgent(agentId)!.variables || "{}") as Record<string, unknown>;

describe("previousOfficeRepo", () => {
  it("prefers home_repo_path", () => {
    expect(previousOfficeRepo("/home", [JSON.stringify({ __cwd_path__: "/other" })])).toBe("/home");
  });
  it("falls back to the one __cwd_path__ the agents share", () => {
    expect(previousOfficeRepo("", [JSON.stringify({ __cwd_path__: "/r" }), JSON.stringify({ __cwd_path__: "/r" }), "{}"])).toBe("/r");
  });
  it("is empty when agents disagree or have none", () => {
    expect(previousOfficeRepo("", [JSON.stringify({ __cwd_path__: "/a" }), JSON.stringify({ __cwd_path__: "/b" })])).toBe("");
    expect(previousOfficeRepo(undefined, ["{}", "not json"])).toBe("");
  });
});

describe("setOfficeRepo", () => {
  it("promotes an office: seeds the folder and stores home_repo_path", () => {
    const flow = service.createFlow({ name: "Builders" });
    const result = setOfficeRepo(service, { flow_id: flow.id, path: dir, git_init: false });
    expect(result.path).toBe(dir);
    expect(result.git).toBe("skipped");
    expect(service.getFlow(flow.id)!.home_repo_path).toBe(dir);
    expect(existsSync(join(dir, "CHARTER.md"))).toBe(true);
  });

  it("rejects a relative path with 400 and an unknown office with 404", () => {
    const flow = service.createFlow({ name: "Builders" });
    try {
      setOfficeRepo(service, { flow_id: flow.id, path: "relative/dir" });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OfficeRepoError);
      expect((err as OfficeRepoError).status).toBe(400);
      expect((err as Error).message).toMatch(/path must be absolute/);
    }
    try {
      setOfficeRepo(service, { flow_id: "nope", path: dir });
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as OfficeRepoError).status).toBe(404);
      expect((err as Error).message).toBe("Flow not found: nope");
    }
  });

  it("retargets agents that carry the previous repo in __cwd_path__ (Office Kit offices)", () => {
    const flow = service.createFlow({ name: "Kit office" });
    const builder = service.createAgent({ name: "Builder", flow_id: flow.id });
    const reviewer = service.createAgent({ name: "Reviewer", flow_id: flow.id });
    const other = service.createAgent({ name: "Elsewhere", flow_id: flow.id });
    setVars(builder.id, { __cwd_path__: "/old/repo", keep: "yes" });
    setVars(reviewer.id, { __cwd_path__: "/old/repo" });
    setVars(other.id, {});

    const result = setOfficeRepo(service, { flow_id: flow.id, path: dir, git_init: false, retarget_agents: true });
    expect(result.retargeted).toBe(2);
    expect(varsOf(builder.id)).toEqual({ __cwd_path__: dir, keep: "yes" });
    expect(varsOf(reviewer.id).__cwd_path__).toBe(dir);
    expect(varsOf(other.id).__cwd_path__).toBeUndefined();
  });

  it("leaves agents alone without retarget_agents (the MCP tool's behavior)", () => {
    const flow = service.createFlow({ name: "Kit office" });
    const builder = service.createAgent({ name: "Builder", flow_id: flow.id });
    setVars(builder.id, { __cwd_path__: "/old/repo" });
    const result = setOfficeRepo(service, { flow_id: flow.id, path: dir, git_init: false });
    expect(result.retargeted).toBe(0);
    expect(varsOf(builder.id).__cwd_path__).toBe("/old/repo");
  });

  it("removing the repo reverts the office and strips the repo posture from retargeted agents", () => {
    const flow = service.createFlow({ name: "Kit office" });
    const builder = service.createAgent({ name: "Builder", flow_id: flow.id });
    setVars(builder.id, { __cwd_path__: dir, __sandbox__: false, __permission_mode__: "bypassPermissions", keep: 1 });
    service.setFlowRepo(flow.id, dir);
    db.prepare("UPDATE agent_flows SET repo_isolation = 'host' WHERE id = ?").run(flow.id);

    const result = setOfficeRepo(service, { flow_id: flow.id, path: null, retarget_agents: true });
    expect(result.path).toBe("");
    expect(result.homePath).not.toBeNull();
    expect(result.flow.repo_isolation).toBe("");
    expect(service.getFlow(flow.id)!.home_repo_path).toBe("");
    expect(service.getFlow(flow.id)!.repo_isolation).toBe("");
    expect(varsOf(builder.id)).toEqual({ keep: 1 });
  });

  it("a repo set on an office without isolation picks sandbox and applies it to the agents", () => {
    const flow = service.createFlow({ name: "Kit office" });
    const builder = service.createAgent({ name: "Builder", flow_id: flow.id });
    setVars(builder.id, { __cwd_path__: "/old/repo", __sandbox__: false, __permission_mode__: "bypassPermissions" });
    expect(service.getFlow(flow.id)!.repo_isolation).toBe("");

    const result = setOfficeRepo(service, { flow_id: flow.id, path: dir, git_init: false, retarget_agents: true });
    expect(result.flow.repo_isolation).toBe("sandbox");
    expect(service.getFlow(flow.id)!.repo_isolation).toBe("sandbox");
    expect(varsOf(builder.id)).toEqual({ __cwd_path__: dir });
  });

  it("changing the repo keeps the isolation the office already has", () => {
    const flow = service.createFlow({ name: "Kit office" });
    const builder = service.createAgent({ name: "Builder", flow_id: flow.id });
    setVars(builder.id, { __cwd_path__: "/old/repo", __sandbox__: false, __permission_mode__: "bypassPermissions" });
    db.prepare("UPDATE agent_flows SET repo_isolation = 'host' WHERE id = ?").run(flow.id);

    setOfficeRepo(service, { flow_id: flow.id, path: dir, git_init: false, retarget_agents: true });
    expect(service.getFlow(flow.id)!.repo_isolation).toBe("host");
    expect(varsOf(builder.id)).toEqual({ __cwd_path__: dir, __sandbox__: false, __permission_mode__: "bypassPermissions" });
  });
});

describe("PUT /api/agents/flows/:id/repo", () => {
  let server: KernelHttpServer;
  let base: string;

  beforeEach(async () => {
    const cfg = {
      dashboard: { port: 0, bind: "127.0.0.1" },
      auth: { token: "" },
      cors: { allowedOrigins: [] },
    } as unknown as KernelConfig;
    server = new KernelHttpServer({ config: cfg });
    registerAgentRoutes(server, service, new AgentExecutor());
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  const put = (id: string, body: unknown) =>
    fetch(`${base}/api/agents/flows/${id}/repo`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("200 with the new path", async () => {
    const flow = service.createFlow({ name: "Builders" });
    const res = await put(flow.id, { path: dir, git_init: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; path: string; git: string; retargeted: number };
    expect(body).toMatchObject({ success: true, path: dir, git: "skipped", retargeted: 0 });
  });

  it("400 for a relative path or a missing path, 404 for an unknown office", async () => {
    const flow = service.createFlow({ name: "Builders" });
    expect((await put(flow.id, { path: "rel" })).status).toBe(400);
    expect((await put(flow.id, {})).status).toBe(400);
    expect((await put("nope", { path: dir })).status).toBe(404);
  });
});

describe("agents.flows.set_repo RPC", () => {
  const action = () => {
    const found = agentsRpcActions({ service }).find((a) => a.name === "agents.flows.set_repo");
    if (!found) throw new Error("no rpc action named agents.flows.set_repo");
    return found;
  };

  it("sets the repo and reports it", async () => {
    const flow = service.createFlow({ name: "Builders" });
    const res = (await action().handler({ flow_id: flow.id, path: dir, git_init: false })) as { path: string };
    expect(res.path).toBe(dir);
  });

  it("throws the validation message", async () => {
    const flow = service.createFlow({ name: "Builders" });
    await expect(action().handler({ flow_id: flow.id, path: "rel" })).rejects.toThrow(/path must be absolute/);
  });

  it("a missing path is a validation error, not a removal", async () => {
    const flow = service.createFlow({ name: "Builders" });
    service.setFlowRepo(flow.id, dir);
    await expect(action().handler({ flow_id: flow.id })).rejects.toThrow(/path must be a string or null/);
    expect(service.getFlow(flow.id)!.home_repo_path).toBe(dir);
  });
});
