/**
 * Users and permissions as extensions see them: the SDK's access helpers,
 * a route that declares a permission, and the routes that hand out
 * credentials.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { accessMigrations } from "../src/modules/access/migrations.js";
import { AccessService } from "../src/modules/access/service.js";
import { setPermissionResolver, setUserTokenResolver, SUPER_ADMIN, type Principal } from "../src/core/principal.js";
import { requirementForRoute, requirementForRpcAction } from "../src/core/permissions.js";
import { runWithContext } from "../src/core/request-context.js";
import { assertMayCreateAgentIn, assertMayCreateOffice, setScopeProvider } from "../src/core/scope.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { can, currentPrincipal, inScope, requireInScope, requirePermission, isHttpError, defineTool } from "../src/sdk/index.js";
import { getHost, setHost, type KernlHost } from "../src/sdk/host.js";
import { requirementForTool } from "../src/core/permissions.js";
import { z } from "zod";
import { twitterOperations } from "../assets/extensions/crm/twitter/_module/operations.js";

const MASTER = "m".repeat(40);
const ana: Principal = { kind: "user", id: "u1", name: "Ana", tokenId: "t1" };

function as<T>(principal: Principal | undefined, fn: () => T): T {
  return runWithContext({ callerAgentId: "", callerRunId: "", callerDepth: 0, principal }, fn);
}

afterEach(() => {
  setPermissionResolver(null);
  setUserTokenResolver(null);
  setScopeProvider(null);
});

describe("SDK: can / requirePermission", () => {
  beforeEach(() => setPermissionResolver(() => ["cinema:read"]));

  it("answers for the caller of the request in flight", () => {
    as(ana, () => {
      expect(currentPrincipal()?.id).toBe("u1");
      expect(can("cinema:read")).toBe(true);
      expect(can("cinema:write")).toBe(false);
      expect(can("secrets:read")).toBe(false);
    });
  });

  it("the super admin and kernel-started work may do anything", () => {
    expect(as(SUPER_ADMIN, () => can("secrets:write"))).toBe(true);
    expect(as(undefined, () => can("secrets:write"))).toBe(true);
    expect(currentPrincipal()).toBeNull();
  });

  it("a malformed or wildcard permission never grants a user", () => {
    setPermissionResolver(() => ["*:*", "system:*"]);
    as(ana, () => {
      expect(can("cinema")).toBe(false);
      expect(can("*:read")).toBe(false);
      expect(can("cinema:read")).toBe(true);
    });
  });

  it("requirePermission throws a 403 the route turns into a response", () => {
    as(ana, () => {
      expect(() => requirePermission("cinema:read")).not.toThrow();
      try {
        requirePermission("cinema:write");
        throw new Error("did not throw");
      } catch (err) {
        expect(isHttpError(err)).toBe(true);
        expect((err as { status: number }).status).toBe(403);
        expect((err as { body: Record<string, unknown> }).body.required).toBe("cinema:write");
      }
    });
  });

  it("on a host that predates users, only the owner gets in", () => {
    const real = getHost();
    const { can: _c, inScope: _s, ...old } = real;
    setHost(Object.freeze(old) as KernlHost);
    try {
      expect(as(ana, () => can("cinema:read"))).toBe(false);
      expect(as(SUPER_ADMIN, () => can("cinema:read"))).toBe(true);
      expect(as(ana, () => inScope("anything"))).toBe(true);
    } finally {
      setHost(real);
    }
  });
});

describe("SDK: inScope", () => {
  beforeEach(() => {
    setScopeProvider({
      scopeOf: (p) => (p.kind === "user" ? { offices: new Set(["off-a"]), agents: new Set(), projects: new Set() } : null),
      lookup: (id) => (id === "agent-a" ? { kind: "agent", officeId: "off-a" }
        : id === "agent-b" ? { kind: "agent", officeId: "off-b" }
        : id.startsWith("off-") ? { kind: "office", projects: [] } : null),
    });
  });

  it("follows the caller's offices", () => {
    as(ana, () => {
      expect(inScope("agent-a")).toBe(true);
      expect(inScope("agent-b")).toBe(false);
      expect(inScope("not-ours")).toBe(true);
      expect(() => requireInScope("agent-b", "write")).toThrow();
    });
    expect(as(SUPER_ADMIN, () => inScope("agent-b"))).toBe(true);
  });

  it("a restricted user creates agents only inside a granted office, and no offices", () => {
    as(ana, () => {
      expect(() => assertMayCreateOffice()).toThrow();
      expect(() => assertMayCreateAgentIn("off-a")).not.toThrow();
      expect(() => assertMayCreateAgentIn("off-b")).toThrow();
      expect(() => assertMayCreateAgentIn("")).toThrow();
    });
    // The owner, and an agent's own tools (no principal), are not held back.
    as(SUPER_ADMIN, () => { assertMayCreateOffice(); assertMayCreateAgentIn(undefined); });
    as(undefined, () => { assertMayCreateOffice(); assertMayCreateAgentIn(undefined); });
  });
});

describe("defineTool: permission", () => {
  it("is passed through and read by the tool guard", () => {
    const tool = defineTool({
      name: "kernel_cinema_summarize",
      description: "x",
      schema: z.object({}),
      permission: "cinema:read",
      handler: async () => ({ content: [] }),
    });
    expect(tool.permission).toBe("cinema:read");
    expect(requirementForTool(tool.name, tool)).toEqual({ module: "cinema", level: "read" });
  });
});

describe("extension: twitter credentials", () => {
  const saved: Array<Record<string, unknown>> = [];
  const tw = {
    addAccount: (f: Record<string, unknown>) => { saved.push(f); return { id: "a1", ...f }; },
    updateAccount: (id: string, f: Record<string, unknown>) => { saved.push(f); return { id, handle: "h", ...f }; },
  } as never;
  const op = twitterOperations(tw, null);

  beforeEach(() => { saved.length = 0; setPermissionResolver(() => ["twitter:write"]); });

  it("editing an account needs twitter:write; setting its keys needs secrets:write too", () => {
    as(ana, () => {
      op["twitter.accounts.update"]({ id: "a1", display_name: "New name", api_key: "••••" });
      expect(saved).toHaveLength(1);
      expect(() => op["twitter.accounts.update"]({ id: "a1", api_key: "real-key" })).toThrow();
      expect(() => op["twitter.accounts.create"]({ handle: "h", access_token: "t" })).toThrow();
      expect(saved).toHaveLength(1);
    });
    setPermissionResolver(() => ["twitter:write", "secrets:write"]);
    as(ana, () => op["twitter.accounts.update"]({ id: "a1", api_key: "real-key" }));
    expect(saved).toHaveLength(2);
  });
});

describe("channels are a system module", () => {
  it("over REST and RPC alike", () => {
    expect(requirementForRoute("/api/channels/config", "POST")).toEqual({ module: "channels", level: "write" });
    expect(requirementForRpcAction("channels.config.save")).toEqual({ module: "channels", level: "write" });
  });
});

describe("HTTP: a route that declares a permission", () => {
  let server: KernelHttpServer;
  let base: string;
  let db: Database;
  let svc: AccessService;

  beforeEach(async () => {
    db = new Database(":memory:");
    runMigrations(db as never, "access", accessMigrations);
    svc = new AccessService(db as never);
    setUserTokenResolver((t) => svc.resolve(t));
    setPermissionResolver((p) => (p.kind === "user" ? svc.permissionsForUser(p.id) : []));
    server = new KernelHttpServer({
      config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: MASTER }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
    });
    server.route("GET", "/api/projects/:id/webhook-secret", () => ({ secret: "s" }), { permission: "secrets:read" });
    server.route("GET", "/api/projects/:id", () => ({ ok: true }));
    server.route("GET", "/api/projects/typo", () => ({ ok: true }), { permission: "secrets" });
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await server.stop();
    db.close();
  });

  const get = (path: string, token: string) => fetch(base + path, { headers: { authorization: `Bearer ${token}` } });

  function userWith(permissions: string[]): string {
    const role = svc.createRole({ name: `r${Math.random()}`, permissions });
    const u = svc.createUser({ name: "Ana" });
    svc.setUserRoles(u.id, [role.id]);
    return svc.createToken(u.id).token;
  }

  it("asks for it on top of what the path asks", async () => {
    const reader = userWith(["projects:read"]);
    expect((await get("/api/projects/p1", reader)).status).toBe(200);
    const denied = await get("/api/projects/p1/webhook-secret", reader);
    expect(denied.status).toBe(403);
    expect((await denied.json()).required).toBe("secrets:read");

    const both = userWith(["projects:read", "secrets:read"]);
    expect((await get("/api/projects/p1/webhook-secret", both)).status).toBe(200);
  });

  it("never widens what the path asks", async () => {
    const secretsOnly = userWith(["secrets:read"]);
    expect((await get("/api/projects/p1/webhook-secret", secretsOnly)).status).toBe(403);
  });

  it("a declaration that does not parse refuses users, not the owner", async () => {
    const reader = userWith(["projects:read", "secrets:read"]);
    expect((await get("/api/projects/typo", reader)).status).toBe(403);
    expect((await get("/api/projects/typo", MASTER)).status).toBe(200);
  });
});
