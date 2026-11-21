/**
 * A user held to projects (core/scope.ts): the offices that work on them,
 * only the items that belong to them, and only the modules that hold
 * project data. Users held to offices alone keep seeing every project.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { accessMigrations } from "../src/modules/access/migrations.js";
import { AccessService } from "../src/modules/access/service.js";
import {
  defaultRequestAuthorizer, setPermissionResolver, setUserIdResolver, setUserTokenResolver, type Principal,
} from "../src/core/principal.js";
import { runWithContext } from "../src/core/request-context.js";
import {
  assertMayCreateAgentIn, filterForScope, refAllowed, scopeDenial, setScopeProvider, type Scope,
} from "../src/core/scope.js";

// Projects P (home office A, linked to office C) and Q (home office B).
const OFF_A = "office-aaaa";
const OFF_B = "office-bbbb";
const OFF_C = "office-cccc";
const OFF_D = "office-dddd";
const P = "project-pppp";
const Q = "project-qqqq";

function schema(db: Database) {
  db.exec(`
    CREATE TABLE agent_flows (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, flow_id TEXT);
    CREATE TABLE agent_runs (id TEXT PRIMARY KEY, agent_id TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, home_flow_id TEXT);
    CREATE TABLE office_projects (flow_id TEXT, project_id TEXT, active INTEGER NOT NULL DEFAULT 1);
    INSERT INTO agent_flows VALUES ('${OFF_A}', 'A'), ('${OFF_B}', 'B'), ('${OFF_C}', 'C'), ('${OFF_D}', 'D');
    INSERT INTO agents VALUES ('agent-a1', 'a1', '${OFF_A}'), ('agent-b1', 'b1', '${OFF_B}'),
                              ('agent-c1', 'c1', '${OFF_C}'), ('agent-d1', 'd1', '${OFF_D}');
    INSERT INTO agent_runs VALUES ('run-c1', 'agent-c1'), ('run-b1', 'agent-b1');
    INSERT INTO projects VALUES ('${P}', 'P', '${OFF_A}'), ('${Q}', 'Q', '${OFF_B}');
    INSERT INTO office_projects VALUES ('${OFF_C}', '${P}', 1), ('${OFF_D}', '${P}', 0);
  `);
}

function store() {
  const db = new Database(":memory:");
  schema(db);
  runMigrations(db as never, "access", accessMigrations);
  return { db, svc: new AccessService(db as never) };
}

function wire(svc: AccessService) {
  setUserTokenResolver((t) => svc.resolve(t));
  setUserIdResolver((id) => svc.resolveUser(id));
  setPermissionResolver((p) => (p.kind === "user" ? svc.permissionsForUser(p.id) : []));
  setScopeProvider({
    scopeOf: (p) => (p.kind === "user" ? svc.scopeForUser(p.id) : null),
    lookup: (id) => svc.refs.lookup(id),
  });
}

afterEach(() => {
  setUserTokenResolver(null);
  setUserIdResolver(null);
  setPermissionResolver(null);
  setScopeProvider(null);
});

function user(svc: AccessService, scope: { offices?: string[]; projects?: string[] }, role = "role-admin") {
  const u = svc.createUser({ name: "Ana" });
  svc.setUserRoles(u.id, [role]);
  svc.setScope(u.id, { mode: "restricted", offices: scope.offices ?? [], projects: scope.projects ?? [] });
  return { kind: "user", id: u.id, name: "Ana", tokenId: "t" } as Principal;
}

const as = <T>(principal: Principal, fn: () => T) =>
  runWithContext({ callerAgentId: "", callerRunId: "", callerDepth: 0, principal }, fn);

describe("storing a project scope", () => {
  it("keeps the office and agent grants made before projects existed", () => {
    const db = new Database(":memory:");
    schema(db);
    runMigrations(db as never, "access", accessMigrations.slice(0, 3));
    db.exec(`
      INSERT INTO users (id, name, created_at, updated_at, office_scope) VALUES ('u1', 'Old', 'x', 'x', 'restricted');
      INSERT INTO user_scopes VALUES ('u1', 'office', '${OFF_A}', 'x'), ('u1', 'agent', 'agent-b1', 'x');
    `);
    runMigrations(db as never, "access", accessMigrations);
    const svc = new AccessService(db as never);
    expect(svc.getScope("u1")).toEqual({ mode: "restricted", offices: [OFF_A], agents: ["agent-b1"], projects: [] });
  });

  it("saves projects and refuses ids that are not projects", () => {
    const { svc } = store();
    const u = svc.createUser({ name: "Ana" });
    expect(svc.setScope(u.id, { mode: "restricted", projects: [P] }).projects).toEqual([P]);
    expect(() => svc.setScope(u.id, { projects: [OFF_A] })).toThrow("not a project");
    expect(svc.scopeForUser(u.id)?.projects.has(P)).toBe(true);
  });

  it("knows which projects an office works on: its home and its active links", () => {
    const { svc } = store();
    expect(svc.refs.lookup(OFF_A)).toEqual({ kind: "office", projects: [P] });
    expect(svc.refs.lookup(OFF_C)).toEqual({ kind: "office", projects: [P] });
    expect(svc.refs.lookup(OFF_D)).toEqual({ kind: "office", projects: [] });
    expect(svc.refs.lookup(P)).toEqual({ kind: "project" });
  });
});

describe("what a user held to a project reaches", () => {
  let svc: AccessService;
  beforeEach(() => { ({ svc } = store()); wire(svc); });

  const scope = (projects: string[], offices: string[] = []): Scope =>
    ({ offices: new Set(offices), agents: new Set(), projects: new Set(projects) });

  it("works in the project's offices, their agents and runs", () => {
    const s = scope([P]);
    for (const id of [OFF_A, OFF_C, "agent-a1", "agent-c1", "run-c1", P]) {
      expect(refAllowed(s, id, "write")).toBe(true);
    }
  });

  it("reaches nothing of other projects, nor offices only once linked", () => {
    const s = scope([P]);
    for (const id of [OFF_B, OFF_D, "agent-b1", "agent-d1", "run-b1", Q]) {
      expect(refAllowed(s, id, "read")).toBe(false);
    }
  });

  it("a user held to offices alone still sees every project", () => {
    expect(refAllowed(scope([], [OFF_A]), Q, "read")).toBe(true);
  });

  it("only items of their projects come back; items of none are hidden", () => {
    const principal = user(svc, { projects: [P] });
    const out = as(principal, () => filterForScope<unknown>({
      projects: [{ id: P, name: "P" }, { id: Q, name: "Q" }],
      tasks: [
        { id: "t1", project_id: P },
        { id: "t2", project_id: Q },
        { id: "t3", project_id: null },
        { id: "t4", projectId: "" },
        { id: "t5", projectId: P },
      ],
      flows: [{ id: OFF_A }, { id: OFF_B }, { id: OFF_C }, { id: OFF_D }],
      note: { text: "an item with no project key is not judged here" },
    }));
    expect(out).toEqual({
      projects: [{ id: P, name: "P" }],
      tasks: [{ id: "t1", project_id: P }, { id: "t5", projectId: P }],
      flows: [{ id: OFF_A }, { id: OFF_C }],
      note: { text: "an item with no project key is not judged here" },
    });
  });

  it("a user held to offices alone keeps items of any project", () => {
    const principal = user(svc, { offices: [OFF_A] });
    const tasks = [{ id: "t2", project_id: Q }, { id: "t3", project_id: null }];
    expect(as(principal, () => filterForScope(tasks))).toEqual(tasks);
  });

  it("may not name another project, and may add agents to a project's office", () => {
    const principal = user(svc, { projects: [P] });
    expect(as(principal, () => scopeDenial({ project_id: Q }, "write"))).toContain("projects");
    expect(as(principal, () => scopeDenial({ project_id: P }, "write"))).toBeNull();
    expect(() => as(principal, () => assertMayCreateAgentIn(OFF_C))).not.toThrow();
    expect(() => as(principal, () => assertMayCreateAgentIn(OFF_B))).toThrow();
  });

  it("is kept to the modules that hold project data, whatever the roles", () => {
    const principal = user(svc, { projects: [P] });
    expect(defaultRequestAuthorizer(principal, "/api/tasks", "GET")).toBeNull();
    expect(defaultRequestAuthorizer(principal, "/api/projects/x", "GET")).toBeNull();
    expect(defaultRequestAuthorizer(principal, "/api/offices", "GET")).toBeNull();
    const mail = defaultRequestAuthorizer(principal, "/api/emails", "GET");
    expect(mail?.status).toBe(403);
    expect((mail?.body as { reason: string }).reason).toBe("outside_projects");
    expect(defaultRequestAuthorizer(principal, "/api/rpc/emails.list", "POST")?.status).toBe(403);
    expect(as(principal, () => scopeDenial({}, "read", "notes"))).toContain("notes");
    expect(as(principal, () => scopeDenial({}, "read", "tasks"))).toBeNull();
  });

  it("roles still decide inside those modules", () => {
    const principal = user(svc, { projects: [P] }, "role-office-operator");
    expect(defaultRequestAuthorizer(principal, "/api/agents/flows", "GET")).toBeNull();
    expect(defaultRequestAuthorizer(principal, "/api/tasks", "GET")?.status).toBe(403);
  });

  it("users held to offices alone are not kept off other modules", () => {
    const principal = user(svc, { offices: [OFF_A] });
    expect(defaultRequestAuthorizer(principal, "/api/emails", "GET")).toBeNull();
  });
});
