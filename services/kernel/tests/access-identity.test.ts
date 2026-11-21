import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createServer, type Server } from "node:http";
import type { IncomingMessage } from "node:http";
import { runMigrations } from "../src/core/db/migrations.js";
import { accessMigrations } from "../src/modules/access/migrations.js";
import { AccessService, hashToken, USER_TOKEN_PREFIX } from "../src/modules/access/service.js";
import { registerAccessRoutes } from "../src/modules/access/api-routes.js";
import {
  SUPER_ADMIN, authorizeRequest, defaultRequestAuthorizer, resolveToken,
  setRequestAuthorizer, setUserTokenResolver,
} from "../src/core/principal.js";
import { isAuthenticated, resolveRequestPrincipal } from "../src/core/auth.js";
import { getPrincipal } from "../src/core/request-context.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import { McpHttpRouter } from "../src/server.js";
import type { KernelConfig } from "../src/core/config.js";

const MASTER = "m".repeat(40);

function store(now?: () => Date) {
  const db = new Database(":memory:");
  runMigrations(db as never, "access", accessMigrations);
  return { db, svc: new AccessService(db as never, now) };
}

function req(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage;
}

afterEach(() => {
  setUserTokenResolver(null);
  setRequestAuthorizer(null);
});

describe("principal resolution", () => {
  it("the kernel token is the super admin", () => {
    expect(resolveToken(MASTER, MASTER)).toEqual(SUPER_ADMIN);
  });

  it("with auth disabled everyone is the super admin", () => {
    expect(resolveToken(null, "")).toEqual(SUPER_ADMIN);
  });

  it("no token, or a wrong one, is no one", () => {
    expect(resolveToken(null, MASTER)).toBeNull();
    expect(resolveToken("nope", MASTER)).toBeNull();
  });

  it("asks the user resolver about any other token", () => {
    setUserTokenResolver((t) => (t === "kul_x" ? { kind: "user", id: "u1", name: "Ana", tokenId: "t1" } : null));
    expect(resolveToken("kul_x", MASTER)).toMatchObject({ kind: "user", id: "u1" });
    expect(resolveToken("kul_y", MASTER)).toBeNull();
  });

  it("a resolver that throws fails closed", () => {
    setUserTokenResolver(() => { throw new Error("db gone"); });
    expect(resolveToken("kul_x", MASTER)).toBeNull();
  });

  it("isAuthenticated still means the kernel token only", () => {
    setUserTokenResolver(() => ({ kind: "user", id: "u1", name: "Ana", tokenId: "t1" }));
    expect(isAuthenticated(req("/api/x", { authorization: `Bearer ${MASTER}` }), MASTER)).toBe(true);
    expect(isAuthenticated(req("/api/x", { authorization: "Bearer kul_x" }), MASTER)).toBe(false);
  });

  it("reads ?auth= only where headers cannot be set", () => {
    expect(resolveRequestPrincipal(req(`/api/x?auth=${MASTER}`, { accept: "text/event-stream" }), MASTER)).toEqual(SUPER_ADMIN);
    expect(resolveRequestPrincipal(req(`/api/x?auth=${MASTER}`), MASTER)).toBeNull();
  });
});

describe("default authorizer (deny by default)", () => {
  const user = { kind: "user", id: "u1", name: "Ana", tokenId: "t1" } as const;

  it("lets a user learn who they are and nothing else", () => {
    expect(defaultRequestAuthorizer(user, "/api/auth/me", "GET")).toBeNull();
    expect(defaultRequestAuthorizer(user, "/api/agents", "GET")?.status).toBe(403);
    expect(defaultRequestAuthorizer(user, "/mcp", "POST")?.status).toBe(403);
  });

  it("lets a user read what the dashboard needs to draw itself, and only read it", () => {
    expect(defaultRequestAuthorizer(user, "/api/manifest", "GET")).toBeNull();
    expect(defaultRequestAuthorizer(user, "/api/health", "GET")).toBeNull();
    expect(defaultRequestAuthorizer(user, "/api/marketplace/theme/active", "GET")).toBeNull();
    expect(defaultRequestAuthorizer(user, "/api/manifest", "POST")?.status).toBe(403);
    expect(defaultRequestAuthorizer(user, "/api/manifest/extra", "GET")?.status).toBe(403);
  });

  it("the super admin is never subject to a pluggable rule", () => {
    setRequestAuthorizer(() => ({ status: 403, body: {} }));
    expect(authorizeRequest(SUPER_ADMIN, "/api/anything", "POST")).toBeNull();
  });

  it("an authorizer that throws denies", () => {
    setRequestAuthorizer(() => { throw new Error("bug"); });
    expect(authorizeRequest(user, "/api/auth/me", "GET")?.status).toBe(403);
  });
});

describe("AccessService", () => {
  it("mints a token that resolves to its user and stores only the hash", () => {
    const { db, svc } = store();
    const u = svc.createUser({ name: "Ana", email: "Ana@Example.com" });
    expect(u.email).toBe("ana@example.com");
    const { token, record } = svc.createToken(u.id, { label: "laptop" });
    expect(token.startsWith(USER_TOKEN_PREFIX)).toBe(true);
    expect(record.prefix).toBe(token.slice(0, USER_TOKEN_PREFIX.length + 6));
    const row = db.prepare("SELECT token_hash FROM user_tokens WHERE id = ?").get(record.id) as { token_hash: string };
    expect(row.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(db.prepare("SELECT * FROM user_tokens").all())).not.toContain(token);
    expect(svc.resolve(token)).toEqual({ kind: "user", id: u.id, name: "Ana", tokenId: record.id });
    expect(svc.listTokens(u.id)[0].last_used_at).not.toBeNull();
  });

  it("a revoked token opens nothing", () => {
    const { svc } = store();
    const u = svc.createUser({ name: "Ana" });
    const { token, record } = svc.createToken(u.id);
    svc.revokeToken(record.id);
    expect(svc.resolve(token)).toBeNull();
  });

  it("an expired token opens nothing", () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const { svc } = store(() => now);
    const u = svc.createUser({ name: "Ana" });
    const { token } = svc.createToken(u.id, { expires_at: "2026-01-02T00:00:00Z" });
    expect(svc.resolve(token)).not.toBeNull();
    now = new Date("2026-01-03T00:00:00Z");
    expect(svc.resolve(token)).toBeNull();
  });

  it("refuses an expiry in the past", () => {
    const { svc } = store(() => new Date("2026-01-01T00:00:00Z"));
    const u = svc.createUser({ name: "Ana" });
    expect(() => svc.createToken(u.id, { expires_at: "2025-12-31T00:00:00Z" })).toThrow();
  });

  it("disabling a user stops their tokens; enabling brings them back", () => {
    const { svc } = store();
    const u = svc.createUser({ name: "Ana" });
    const { token } = svc.createToken(u.id);
    svc.updateUser(u.id, { status: "disabled" });
    expect(svc.resolve(token)).toBeNull();
    svc.updateUser(u.id, { status: "active" });
    expect(svc.resolve(token)).not.toBeNull();
  });

  it("deleting a user revokes every token for good", () => {
    const { svc } = store();
    const u = svc.createUser({ name: "Ana" });
    const { token } = svc.createToken(u.id);
    svc.deleteUser(u.id);
    expect(svc.resolve(token)).toBeNull();
    expect(svc.listUsers()).toEqual([]);
    expect(svc.listTokens(u.id).every((t) => t.revoked_at !== null)).toBe(true);
  });

  it("emails are unique among live users", () => {
    const { svc } = store();
    const a = svc.createUser({ name: "Ana", email: "a@x.io" });
    expect(() => svc.createUser({ name: "Otra", email: "A@x.io" })).toThrow();
    svc.deleteUser(a.id);
    expect(svc.createUser({ name: "Otra", email: "a@x.io" }).email).toBe("a@x.io");
  });

  it("ignores tokens without the user prefix (never the kernel token's job)", () => {
    const { svc } = store();
    expect(svc.resolve(MASTER)).toBeNull();
  });
});

describe("HTTP: identity at the gate", () => {
  let server: KernelHttpServer;
  let base: string;
  let svc: AccessService;
  let db: Database;
  let seen: unknown = null;

  beforeEach(async () => {
    ({ db, svc } = store());
    setUserTokenResolver((t) => svc.resolve(t));
    server = new KernelHttpServer({
      config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: MASTER }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
    });
    registerAccessRoutes(server, svc, { authEnabled: true });
    server.route("GET", "/api/probe", () => { seen = getPrincipal(); return { ok: true }; });
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await server.stop();
    db.close();
  });

  const get = (path: string, token?: string) =>
    fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  it("the super admin reaches everything and routes see who it is", async () => {
    expect((await get("/api/probe", MASTER)).status).toBe(200);
    expect(seen).toEqual(SUPER_ADMIN);
    const me = await (await get("/api/auth/me", MASTER)).json();
    expect(me).toMatchObject({ kind: "super_admin", authEnabled: true });
  });

  it("a user token reaches /api/auth/me and is refused elsewhere", async () => {
    const u = svc.createUser({ name: "Ana", email: "ana@x.io" });
    const { token } = svc.createToken(u.id);
    const me = await (await get("/api/auth/me", token)).json();
    expect(me).toMatchObject({ kind: "user", id: u.id, name: "Ana", email: "ana@x.io" });
    expect((await get("/api/probe", token)).status).toBe(403);
    expect((await get("/api/access/users", token)).status).toBe(403);
  });

  it("no token, or a revoked one, is 401", async () => {
    const u = svc.createUser({ name: "Ana" });
    const { token, record } = svc.createToken(u.id);
    svc.revokeToken(record.id);
    expect((await get("/api/auth/me")).status).toBe(401);
    expect((await get("/api/auth/me", token)).status).toBe(401);
  });

  it("verify reports which kind of token it is", async () => {
    const u = svc.createUser({ name: "Ana" });
    const { token } = svc.createToken(u.id);
    // `valid` stays "the kernel token": the tunnel guard gates the broker on it.
    expect(await (await get("/api/auth/verify", token)).json()).toEqual({ valid: false, authEnabled: true, kind: "user" });
    expect(await (await get("/api/auth/verify", MASTER)).json()).toEqual({ valid: true, authEnabled: true, kind: "super_admin" });
    expect(await (await get("/api/auth/verify", "nope")).json()).toEqual({ valid: false, authEnabled: true, kind: null });
  });

  it("the super admin manages users and tokens end to end", async () => {
    const send = (method: string, path: string, body?: unknown) =>
      fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${MASTER}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const { user } = await (await send("POST", "/api/access/users", { name: "Ana", email: "ana@x.io" })).json();
    expect((await send("POST", "/api/access/users", { name: "Dup", email: "ana@x.io" })).status).toBe(409);
    const minted = await (await send("POST", `/api/access/users/${user.id}/tokens`, { label: "cli" })).json();
    expect(minted.token.startsWith(USER_TOKEN_PREFIX)).toBe(true);
    const list = await (await send("GET", `/api/access/users/${user.id}/tokens`)).json();
    expect(JSON.stringify(list)).not.toContain(minted.token);
    expect((await get("/api/auth/me", minted.token)).status).toBe(200);
    expect((await send("DELETE", `/api/access/tokens/${minted.record.id}`)).status).toBe(200);
    expect((await get("/api/auth/me", minted.token)).status).toBe(401);
    expect((await send("DELETE", `/api/access/users/${user.id}`)).status).toBe(200);
    expect((await send("PUT", `/api/access/users/${user.id}`, { name: "x" })).status).toBe(404);
  });
});

describe("MCP: identity at /mcp", () => {
  let http: Server;
  let base: string;
  let svc: AccessService;

  beforeEach(async () => {
    ({ svc } = store());
    setUserTokenResolver((t) => svc.resolve(t));
    // Both refusals happen before the router touches the registry.
    const router = new McpHttpRouter({} as never, undefined, {}, MASTER);
    http = createServer((rq, rs) => { void router.handleRequest(rq, rs); });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const addr = http.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/mcp`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => http.close(() => r()));
  });

  const post = (token?: string) =>
    fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

  it("no token is 401", async () => {
    expect((await post()).status).toBe(401);
  });

  it("a user token is 403 until tools carry permissions", async () => {
    const u = svc.createUser({ name: "Ana" });
    const { token } = svc.createToken(u.id);
    expect((await post(token)).status).toBe(403);
  });
});
