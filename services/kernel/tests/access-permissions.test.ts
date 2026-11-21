import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { runMigrations } from "../src/core/db/migrations.js";
import { accessMigrations } from "../src/modules/access/migrations.js";
import { AccessService, BUILTIN_ROLES } from "../src/modules/access/service.js";
import { registerAccessRoutes } from "../src/modules/access/api-routes.js";
import {
  defaultRequestAuthorizer, setPermissionResolver, setUserTokenResolver, type Principal,
} from "../src/core/principal.js";
import {
  grants, isGrantablePermission, requirementForRoute, requirementForRpcAction, requirementForTool,
} from "../src/core/permissions.js";
import { guardPermission, toolPermissionDenial } from "../src/core/tool-permission-guard.js";
import { runWithContext } from "../src/core/request-context.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import type { ToolDefinition } from "../src/core/types.js";

const MASTER = "m".repeat(40);

function store() {
  const db = new Database(":memory:");
  runMigrations(db as never, "access", accessMigrations);
  return { db, svc: new AccessService(db as never) };
}

function wire(svc: AccessService) {
  setUserTokenResolver((t) => svc.resolve(t));
  setPermissionResolver((p) => (p.kind === "user" ? svc.permissionsForUser(p.id) : []));
}

afterEach(() => {
  setUserTokenResolver(null);
  setPermissionResolver(null);
});

describe("what a call needs", () => {
  it("routes: the module is the first segment, GET reads", () => {
    expect(requirementForRoute("/api/tasks/123", "GET")).toEqual({ module: "tasks", level: "read" });
    expect(requirementForRoute("/api/tasks", "POST")).toEqual({ module: "tasks", level: "write" });
    expect(requirementForRoute("/api/offices/create", "POST")).toEqual({ module: "agents", level: "write" });
    expect(requirementForRoute("/api/agents/flows", "HEAD")).toEqual({ module: "agents", level: "read" });
    expect(requirementForRoute("/api/channel/agents.flow", "GET")).toEqual({ module: "agents", level: "read" });
    expect(requirementForRoute("/api/channel/dashboard", "GET")).toEqual({ module: "dashboard", level: "read" });
  });

  it("/api/rpc reads the action, not the route", () => {
    expect(requirementForRoute("/api/rpc/agents.flows.list", "POST")).toEqual({ module: "agents", level: "read" });
    expect(requirementForRoute("/api/rpc/offices.create", "POST")).toEqual({ module: "agents", level: "write" });
    expect(requirementForRoute("/api/rpc/", "POST")).toBeNull();
  });

  it("rpc actions: unknown verbs count as writes", () => {
    expect(requirementForRpcAction("tasks.list")).toEqual({ module: "tasks", level: "read" });
    expect(requirementForRpcAction("tasks.frobnicate")).toEqual({ module: "tasks", level: "write" });
    expect(requirementForRpcAction("agents.runs.detail")).toEqual({ module: "agents", level: "read" });
  });

  it("tools: kernel_<module>_<verb>, side effects and explicit permission win", () => {
    expect(requirementForTool("kernel_tasks_list")).toEqual({ module: "tasks", level: "read" });
    expect(requirementForTool("kernel_tasks_create")).toEqual({ module: "tasks", level: "write" });
    expect(requirementForTool("kernel_agents_run")).toEqual({ module: "agents", level: "write" });
    expect(requirementForTool("kernel_office_create")).toEqual({ module: "agents", level: "write" });
    expect(requirementForTool("kernel_brain_ask")).toEqual({ module: "brain", level: "write" });
    expect(requirementForTool("kernel_mail_list", { sideEffects: ["mail.read:1"] })).toEqual({ module: "mail", level: "write" });
    expect(requirementForTool("kernel_odd_name", { permission: "crm:read" })).toEqual({ module: "crm", level: "read" });
    expect(requirementForTool("kernel_code_run")).toEqual({ module: "code", level: "write" });
    expect(requirementForTool("peer:abc:kernel_tasks_list")).toEqual({ module: "mesh", level: "write" });
  });
});

describe("what a grant covers", () => {
  it("write includes read; read does not include write", () => {
    expect(grants(["tasks:write"], { module: "tasks", level: "read" })).toBe(true);
    expect(grants(["tasks:read"], { module: "tasks", level: "write" })).toBe(false);
    expect(grants(["tasks:*"], { module: "tasks", level: "write" })).toBe(true);
  });

  it("aliases meet: offices are agents", () => {
    expect(grants(["offices:read"], { module: "agents", level: "read" })).toBe(true);
  });

  it("`*` covers feature modules and never system ones", () => {
    expect(grants(["*:*"], { module: "cinema", level: "write" })).toBe(true);
    expect(grants(["*:*"], { module: "fs", level: "read" })).toBe(false);
    expect(grants(["*:*"], { module: "llm-providers", level: "read" })).toBe(false);
    expect(grants(["system:read"], { module: "fs", level: "read" })).toBe(true);
    expect(grants(["system:read"], { module: "tasks", level: "read" })).toBe(false);
    expect(grants(["fs:read"], { module: "fs", level: "read" })).toBe(true);
  });

  it("reserved modules are granted by nothing", () => {
    for (const perms of [["*:*", "system:*"], ["access:*"], ["code:write"]]) {
      expect(grants(perms, { module: "access", level: "read" })).toBe(false);
      expect(grants(perms, { module: "code", level: "write" })).toBe(false);
    }
    expect(isGrantablePermission("access:read")).toBe(false);
    expect(isGrantablePermission("code:*")).toBe(false);
    expect(isGrantablePermission("tasks:read")).toBe(true);
    expect(isGrantablePermission("tasks")).toBe(false);
    expect(isGrantablePermission("tasks:delete")).toBe(false);
  });
});

describe("roles", () => {
  it("seeds the built-in roles and keeps them out of reach", () => {
    const { svc } = store();
    const roles = svc.listRoles();
    expect(roles.filter((r) => r.builtin).map((r) => r.id).sort()).toEqual(BUILTIN_ROLES.map((r) => r.id).sort());
    expect(() => svc.updateRole("role-viewer", { permissions: ["*:*"] })).toThrow();
    expect(() => svc.deleteRole("role-admin")).toThrow();
  });

  it("seeding twice changes nothing (every start re-seeds)", () => {
    const { db, svc } = store();
    new AccessService(db as never);
    expect(svc.listRoles().filter((r) => r.builtin)).toHaveLength(BUILTIN_ROLES.length);
  });

  it("refuses a permission a role cannot hold", () => {
    const { svc } = store();
    expect(() => svc.createRole({ name: "x", permissions: ["access:read"] })).toThrow();
    expect(() => svc.createRole({ name: "x", permissions: ["tasks"] })).toThrow();
    expect(svc.createRole({ name: "x", permissions: ["Tasks:read", "tasks:read", "offices:write"] }).permissions)
      .toEqual(["agents:write", "tasks:read"]);
  });

  it("a user gets the union of their roles, and loses it the moment a role changes", () => {
    const { svc } = store();
    const u = svc.createUser({ name: "Ana" });
    const crm = svc.createRole({ name: "CRM", permissions: ["crm:write"] });
    svc.setUserRoles(u.id, ["role-viewer", crm.id]);
    expect(svc.permissionsForUser(u.id)).toEqual(["*:read", "crm:write"]);
    svc.updateRole(crm.id, { permissions: ["crm:read"] });
    expect(svc.permissionsForUser(u.id)).toEqual(["*:read", "crm:read"]);
    svc.deleteRole(crm.id);
    expect(svc.permissionsForUser(u.id)).toEqual(["*:read"]);
    svc.setUserRoles(u.id, []);
    expect(svc.permissionsForUser(u.id)).toEqual([]);
  });

  it("an unknown role id is refused, not silently dropped", () => {
    const { svc } = store();
    const u = svc.createUser({ name: "Ana" });
    expect(() => svc.setUserRoles(u.id, ["nope"])).toThrow();
  });
});

describe("authorizer with roles", () => {
  const ana: Principal = { kind: "user", id: "u1", name: "Ana", tokenId: "t1" };

  it("lets through what the grants cover and names what is missing", () => {
    setPermissionResolver(() => ["tasks:read"]);
    expect(defaultRequestAuthorizer(ana, "/api/tasks", "GET")).toBeNull();
    expect(defaultRequestAuthorizer(ana, "/api/tasks", "POST")).toEqual({
      status: 403, body: { error: "Forbidden", reason: "no_permission", required: "tasks:write" },
    });
  });

  it("/mcp needs at least one grant", () => {
    setPermissionResolver(() => []);
    expect(defaultRequestAuthorizer(ana, "/mcp", "POST")?.status).toBe(403);
    setPermissionResolver(() => ["tasks:read"]);
    expect(defaultRequestAuthorizer(ana, "/mcp", "POST")).toBeNull();
  });
});

describe("tools check the caller", () => {
  const tool = (name: string): ToolDefinition => ({
    name,
    description: "",
    inputSchema: z.object({}),
    handler: async () => ({ content: [{ type: "text", text: "ran" }] }),
  });
  const ana: Principal = { kind: "user", id: "u1", name: "Ana", tokenId: "t1" };
  const as = <T>(principal: Principal | undefined, fn: () => T) =>
    runWithContext({ callerAgentId: "", callerRunId: "", callerDepth: 0, principal }, fn);

  beforeEach(() => setPermissionResolver(() => ["tasks:read"]));

  it("a user runs what their role grants and is refused the rest", async () => {
    const list = guardPermission(tool("kernel_tasks_list"));
    const create = guardPermission(tool("kernel_tasks_create"));
    expect((await as(ana, () => list.handler({}))).isError).toBeUndefined();
    const refused = await as(ana, () => create.handler({}));
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("tasks:write");
  });

  it("work with no principal (agent runs, the kernel itself) is not a user's to restrict", async () => {
    const create = guardPermission(tool("kernel_tasks_create"));
    expect((await as(undefined, () => create.handler({}))).isError).toBeUndefined();
  });

  it("code execution is refused to every user, admin role included", () => {
    setPermissionResolver(() => ["*:*", "system:*"]);
    expect(as(ana, () => toolPermissionDenial({ name: "kernel_code_run" }))).toContain("code:write");
  });

  it("wrapping is stable (one wrapper per tool)", () => {
    const t = tool("kernel_tasks_list");
    expect(guardPermission(t)).toBe(guardPermission(t));
  });
});

describe("HTTP: roles at the gate", () => {
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
    server.route("GET", "/api/tasks/probe", () => ({ ok: true }));
    server.route("POST", "/api/tasks/probe", () => ({ ok: true }));
    server.route("GET", "/api/fs/probe", () => ({ ok: true }));
    server.route("POST", "/api/rpc/:action", ({ params }) => ({ action: params.action }));
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await server.stop();
    db.close();
  });

  const send = (method: string, path: string, token: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  function userWith(roleIds: string[]): string {
    const u = svc.createUser({ name: "Ana" });
    svc.setUserRoles(u.id, roleIds);
    return svc.createToken(u.id).token;
  }

  it("a viewer reads features, writes nothing, and never reaches system modules", async () => {
    const token = userWith(["role-viewer"]);
    expect((await send("GET", "/api/tasks/probe", token)).status).toBe(200);
    const post = await send("POST", "/api/tasks/probe", token, {});
    expect(post.status).toBe(403);
    expect((await post.json()).required).toBe("tasks:write");
    expect((await send("GET", "/api/fs/probe", token)).status).toBe(403);
    expect((await send("POST", "/api/rpc/tasks.list", token, {})).status).toBe(200);
    expect((await send("POST", "/api/rpc/tasks.create", token, {})).status).toBe(403);
  });

  it("even the admin role cannot manage users", async () => {
    const token = userWith(["role-admin"]);
    expect((await send("GET", "/api/fs/probe", token)).status).toBe(200);
    expect((await send("GET", "/api/access/users", token)).status).toBe(403);
    expect((await send("POST", "/api/access/roles", token, { name: "x", permissions: [] })).status).toBe(403);
  });

  it("/api/auth/me tells a user what they may do", async () => {
    const token = userWith(["role-office-operator"]);
    const me = await (await send("GET", "/api/auth/me", token)).json();
    expect(me.roles).toEqual(["role-office-operator"]);
    expect(me.permissions).toEqual(["agents:*", "projects:read"]);
    expect(me.grammar.aliases.offices).toBe("agents");
    expect(me.grammar.system_modules).toContain("settings");
  });

  it("the super admin edits roles and the change applies to the next request", async () => {
    const { role } = await (await send("POST", "/api/access/roles", MASTER, { name: "Tasks", permissions: ["tasks:read"] })).json();
    const token = userWith([role.id]);
    expect((await send("POST", "/api/tasks/probe", token, {})).status).toBe(403);
    expect((await send("PUT", `/api/access/roles/${role.id}`, MASTER, { permissions: ["tasks:write"] })).status).toBe(200);
    expect((await send("POST", "/api/tasks/probe", token, {})).status).toBe(200);
    expect((await send("PUT", "/api/access/roles/role-admin", MASTER, { name: "x" })).status).toBe(409);
    expect((await send("POST", "/api/access/roles", MASTER, { name: "bad", permissions: ["access:read"] })).status).toBe(400);
  });
});
