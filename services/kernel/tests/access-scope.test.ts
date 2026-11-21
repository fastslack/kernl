import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { runMigrations } from "../src/core/db/migrations.js";
import { accessMigrations } from "../src/modules/access/migrations.js";
import { AccessService } from "../src/modules/access/service.js";
import { registerAccessRoutes } from "../src/modules/access/api-routes.js";
import {
  defaultRequestAuthorizer, setPermissionResolver, setUserTokenResolver, type Principal,
} from "../src/core/principal.js";
import { filterForScope, refAllowed, scopeDenial, setScopeProvider, type Scope } from "../src/core/scope.js";
import { guardPermission } from "../src/core/tool-permission-guard.js";
import { runWithContext } from "../src/core/request-context.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import { MtwRpcHandler } from "../src/core/mtw/rpc-handler.js";
import type { KernelConfig } from "../src/core/config.js";
import type { ToolDefinition } from "../src/core/types.js";

const MASTER = "m".repeat(40);

// Two offices: A (agents a1, a2) and B (agent b1, with run rb1).
const OFF_A = "office-aaaa";
const OFF_B = "office-bbbb";

function store() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agent_flows (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, flow_id TEXT);
    CREATE TABLE agent_runs (id TEXT PRIMARY KEY, agent_id TEXT);
    INSERT INTO agent_flows VALUES ('${OFF_A}', 'A'), ('${OFF_B}', 'B');
    INSERT INTO agents VALUES ('agent-a1', 'a1', '${OFF_A}'), ('agent-a2', 'a2', '${OFF_A}'), ('agent-b1', 'b1', '${OFF_B}'),
                              ('agent-lone', 'lone', '');
    INSERT INTO agent_runs VALUES ('run-a1', 'agent-a1'), ('run-b1', 'agent-b1');
  `);
  runMigrations(db as never, "access", accessMigrations);
  const svc = new AccessService(db as never);
  return { db, svc };
}

function wire(svc: AccessService) {
  setUserTokenResolver((t) => svc.resolve(t));
  setPermissionResolver((p) => (p.kind === "user" ? svc.permissionsForUser(p.id) : []));
  setScopeProvider({
    scopeOf: (p) => (p.kind === "user" ? svc.scopeForUser(p.id) : null),
    lookup: (id) => svc.refs.lookup(id),
  });
}

afterEach(() => {
  setUserTokenResolver(null);
  setPermissionResolver(null);
  setScopeProvider(null);
});

/** A restricted user holding office A, with every feature permission. */
function restrictedUser(svc: AccessService, scope: { offices?: string[]; agents?: string[] } = { offices: [OFF_A] }) {
  const u = svc.createUser({ name: "Ana" });
  svc.setUserRoles(u.id, ["role-admin"]);
  svc.setScope(u.id, { mode: "restricted", offices: scope.offices ?? [], agents: scope.agents ?? [] });
  return { user: u, token: svc.createToken(u.id).token, principal: { kind: "user", id: u.id, name: "Ana", tokenId: "t" } as Principal };
}

const as = <T>(principal: Principal | undefined, fn: () => T) =>
  runWithContext({ callerAgentId: "", callerRunId: "", callerDepth: 0, principal }, fn);

describe("scopes in the service", () => {
  it("defaults to every office", () => {
    const { svc } = store();
    const u = svc.createUser({ name: "Ana" });
    expect(svc.getScope(u.id)).toEqual({ mode: "all", offices: [], agents: [] });
    expect(svc.scopeForUser(u.id)).toBeNull();
  });

  it("refuses ids that are not offices or agents", () => {
    const { svc } = store();
    const u = svc.createUser({ name: "Ana" });
    expect(() => svc.setScope(u.id, { mode: "restricted", offices: ["agent-a1"] })).toThrow();
    expect(() => svc.setScope(u.id, { mode: "restricted", agents: [OFF_A] })).toThrow();
    expect(() => svc.setScope(u.id, { mode: "everything" })).toThrow();
  });

  it("restricting takes effect at once and widening too", () => {
    const { svc } = store();
    const u = svc.createUser({ name: "Ana" });
    svc.setScope(u.id, { mode: "restricted", offices: [OFF_A] });
    expect([...svc.scopeForUser(u.id)!.offices]).toEqual([OFF_A]);
    svc.setScope(u.id, { mode: "all" });
    expect(svc.scopeForUser(u.id)).toBeNull();
  });

  it("the index tells offices, agents and runs apart", () => {
    const { svc } = store();
    expect(svc.refs.lookup(OFF_A)).toEqual({ kind: "office" });
    expect(svc.refs.lookup("agent-b1")).toEqual({ kind: "agent", officeId: OFF_B });
    expect(svc.refs.lookup("run-b1")).toEqual({ kind: "run", agentId: "agent-b1", officeId: OFF_B });
    expect(svc.refs.lookup("task-123")).toBeNull();
  });
});

describe("what a scope reaches", () => {
  let svc: AccessService;
  beforeEach(() => { ({ svc } = store()); wire(svc); });

  const scope = (offices: string[], agents: string[] = []): Scope => ({ offices: new Set(offices), agents: new Set(agents) });

  it("a granted office brings its agents and their runs", () => {
    const s = scope([OFF_A]);
    expect(refAllowed(s, "agent-a2", "write")).toBe(true);
    expect(refAllowed(s, "run-a1", "read")).toBe(true);
    expect(refAllowed(s, "agent-b1", "read")).toBe(false);
    expect(refAllowed(s, "run-b1", "read")).toBe(false);
    expect(refAllowed(s, OFF_B, "read")).toBe(false);
  });

  it("a granted agent shows its office but cannot change it", () => {
    const s = scope([], ["agent-b1"]);
    expect(refAllowed(s, "agent-b1", "write")).toBe(true);
    expect(refAllowed(s, OFF_B, "read")).toBe(true);
    expect(refAllowed(s, OFF_B, "write")).toBe(false);
    expect(refAllowed(s, "agent-a1", "read")).toBe(false);
  });

  it("ids that are none of ours pass", () => {
    expect(refAllowed(scope([]), "task-123", "write")).toBe(true);
  });

  it("filters lists and id-keyed maps, at any depth", () => {
    const { principal } = restrictedUser(svc);
    const out: unknown = as(principal, () => filterForScope<unknown>({
      agents: [{ id: "agent-a1" }, { id: "agent-b1" }, { id: "agent-a2", flow_id: OFF_A }],
      flows: [{ id: OFF_A }, { id: OFF_B }],
      tasks: [{ id: "t1", agent_id: "agent-b1" }, { id: "t2", agent_id: "agent-a1" }, { id: "t3" }],
      stats: { "agent-a1": 3, "agent-b1": 9 },
      ids: ["agent-a1", "agent-b1"],
      nested: { runs: [{ id: "run-b1" }, { run_id: "run-a1" }] },
    }));
    expect(out).toEqual({
      agents: [{ id: "agent-a1" }, { id: "agent-a2", flow_id: OFF_A }],
      flows: [{ id: OFF_A }],
      tasks: [{ id: "t2", agent_id: "agent-a1" }, { id: "t3" }],
      stats: { "agent-a1": 3 },
      ids: ["agent-a1"],
      nested: { runs: [{ run_id: "run-a1" }] },
    });
  });

  it("the unrestricted get the very same object back", () => {
    const u = svc.createUser({ name: "Bob" });
    const data = { agents: [{ id: "agent-b1" }] };
    expect(as({ kind: "user", id: u.id, name: "Bob", tokenId: "t" }, () => filterForScope(data))).toBe(data);
  });

  it("refuses inputs naming anything outside, under any key", () => {
    const { principal } = restrictedUser(svc);
    expect(as(principal, () => scopeDenial({ whatever: { deep: ["run-b1"] } }, "read"))).toContain("run-b1");
    expect(as(principal, () => scopeDenial({ id: "agent-a1", note: "agent-b1 is mentioned in prose" }, "write"))).toBeNull();
  });
});

describe("HTTP with a restricted user", () => {
  let server: KernelHttpServer;
  let base: string;
  let svc: AccessService;
  let db: Database;

  beforeEach(async () => {
    ({ db, svc } = store());
    wire(svc);
    server = new KernelHttpServer({
      config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: MASTER }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
    });
    registerAccessRoutes(server, svc, { authEnabled: true });
    server.route("GET", "/api/agents/list", () => ({
      agents: [{ id: "agent-a1" }, { id: "agent-b1" }],
      flows: [{ id: OFF_A }, { id: OFF_B }],
    }));
    server.route("GET", "/api/agents/:id", ({ params }) => ({ id: params.id }));
    server.route("POST", "/api/agents/create", ({ body }) => ({ ok: true, flow_id: body.flow_id }));
    server.post("/api/agents/raw", async (req, res) => {
      try {
        const body = await server.parseBody<Record<string, unknown>>(req);
        server.json(res, 200, { got: body });
      } catch (err) {
        server.json(res, 400, { error: String(err) });
      }
    });
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await server.stop();
    db.close();
  });

  const send = (method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("lists come back without the other offices", async () => {
    const { token } = restrictedUser(svc);
    expect(await (await send("GET", "/api/agents/list", token)).json()).toEqual({
      agents: [{ id: "agent-a1" }], flows: [{ id: OFF_A }],
    });
    // The super admin sees all of it.
    expect((await (await send("GET", "/api/agents/list", MASTER)).json()).agents).toHaveLength(2);
  });

  it("path, query and body naming another office are refused", async () => {
    const { token } = restrictedUser(svc);
    expect((await send("GET", "/api/agents/agent-a1", token)).status).toBe(200);
    expect((await send("GET", "/api/agents/agent-b1", token)).status).toBe(403);
    expect((await send("GET", "/api/agents/list?agent_id=agent-b1", token)).status).toBe(403);
    expect((await send("POST", "/api/agents/create", token, { flow_id: OFF_A })).status).toBe(200);
    expect((await send("POST", "/api/agents/create", token, { flow_id: OFF_B })).status).toBe(403);
  });

  it("a raw handler reading the body is held to it too", async () => {
    const { token } = restrictedUser(svc);
    const ok = await send("POST", "/api/agents/raw", token, { flow_id: OFF_A });
    expect(ok.status).toBe(200);
    const refused = await send("POST", "/api/agents/raw", token, { agent_id: "agent-b1" });
    expect(refused.status).not.toBe(200);
  });

  it("an agent-only grant sees its office in lists, cannot change it", async () => {
    const { token } = restrictedUser(svc, { agents: ["agent-b1"] });
    expect(await (await send("GET", "/api/agents/list", token)).json()).toEqual({
      agents: [{ id: "agent-b1" }], flows: [{ id: OFF_B }],
    });
    expect((await send("POST", "/api/agents/create", token, { flow_id: OFF_B })).status).toBe(403);
  });

  it("the super admin sets scopes over HTTP", async () => {
    const u = svc.createUser({ name: "Ana" });
    const r = await send("PUT", `/api/access/users/${u.id}/scope`, MASTER, { mode: "restricted", offices: [OFF_A] });
    expect((await r.json()).scope).toEqual({ mode: "restricted", offices: [OFF_A], agents: [] });
    expect((await send("PUT", `/api/access/users/${u.id}/scope`, MASTER, { offices: ["nope"] })).status).toBe(400);
  });

  it("/api/auth/me tells a user their scope", async () => {
    const { token } = restrictedUser(svc);
    expect((await (await send("GET", "/api/auth/me", token)).json()).scope).toEqual({ mode: "restricted", offices: [OFF_A], agents: [] });
  });

  it("the broker opens for the kernel token only", async () => {
    const { token } = restrictedUser(svc);
    const broker = (uri: string) => fetch(base + "/api/auth/broker", { headers: { "x-original-uri": uri } });
    expect((await broker(`/mtw?token=${MASTER}`)).status).toBe(204);
    expect((await broker(`/mtw?token=${token}`)).status).toBe(403);
    expect((await broker("/mtw?token=nope")).status).toBe(401);
    expect((await broker("/mtw")).status).toBe(401);
  });
});

describe("RPC and tools with a restricted user", () => {
  let svc: AccessService;
  beforeEach(() => { ({ svc } = store()); wire(svc); });

  it("RPC actions are held to the scope and filtered", async () => {
    const { principal } = restrictedUser(svc);
    const rpc = new MtwRpcHandler({ events: { emit: async () => {} } as never });
    rpc.register({ name: "agents.list", handler: async () => ({ agents: [{ id: "agent-a1" }, { id: "agent-b1" }] }) });
    rpc.register({ name: "agents.update", handler: async (a) => ({ ok: a.id }) });
    expect(await as(principal, () => rpc.callAction("agents.list", {}))).toEqual({ agents: [{ id: "agent-a1" }] });
    expect(await as(principal, () => rpc.callAction("agents.update", { id: "agent-a1" }))).toEqual({ ok: "agent-a1" });
    await expect(as(principal, () => rpc.callAction("agents.update", { id: "agent-b1" }))).rejects.toThrow();
  });

  it("tools refuse out-of-scope arguments and filter structured results", async () => {
    const { principal } = restrictedUser(svc);
    const tool: ToolDefinition = guardPermission({
      name: "kernel_agents_list",
      description: "",
      inputSchema: z.object({}),
      handler: async () => ({
        content: [{ type: "text", text: "two agents" }],
        structuredContent: { agents: [{ id: "agent-a1" }, { id: "agent-b1" }] },
      }),
    });
    const ok = await as(principal, () => tool.handler({}));
    expect(ok.structuredContent).toEqual({ agents: [{ id: "agent-a1" }] });
    const refused = await as(principal, () => tool.handler({ agent_id: "agent-b1" }));
    expect(refused.isError).toBe(true);
  });

  it("a restricted user stays off /mcp; an unrestricted one with grants may enter", () => {
    const { principal } = restrictedUser(svc);
    expect(defaultRequestAuthorizer(principal, "/mcp", "POST")).toEqual({
      status: 403, body: { error: "Forbidden", reason: "scoped_user" },
    });
    const u = svc.createUser({ name: "Bob" });
    svc.setUserRoles(u.id, ["role-viewer"]);
    expect(defaultRequestAuthorizer({ kind: "user", id: u.id, name: "Bob", tokenId: "t" }, "/mcp", "POST")).toBeNull();
  });
});
