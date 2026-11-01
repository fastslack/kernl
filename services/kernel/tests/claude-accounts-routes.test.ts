/**
 * The Claude Code subscription account routes the dashboard drives: list with
 * email and limits, add / rename / reorder / remove, and sign in to one account.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { registerConnectRoutes } from "../src/core/llm/connect-routes.js";
import { setCredentialSource } from "../src/core/llm/credentials.js";
import { initClaudeAccounts } from "../src/core/llm/claude-accounts-store.js";
import { createClaudeLogin } from "../src/core/llm/claude-code-login.js";
import { claudeAccountDir, setClaudeAccountResolver } from "../src/sdk/claude-accounts.js";
import { clearClaudeLimits, rememberClaudeAccountDown, rememberClaudeLimit, listClaudeLimits } from "../src/sdk/claude-limits.js";
import { duplicateOf } from "../src/core/llm/claude-accounts-store.js";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

let store: Record<string, Record<string, unknown>>;
let server: KernelHttpServer;
let base: string;
let xdg: string;
let prevXdg: string | undefined;
let spawned: Array<{ env: NodeJS.ProcessEnv; proc: EventEmitter }>;

const json = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ACC = "/api/llm/claude-code/accounts";

function signIn(id: string, accountUuid: string, email: string) {
  const dir = claudeAccountDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid, organizationUuid: "org1" } }));
}

beforeEach(async () => {
  store = {}; spawned = [];
  prevXdg = process.env.XDG_CONFIG_HOME;
  xdg = mkdtempSync(join(tmpdir(), "kernl-acc-routes-"));
  process.env.XDG_CONFIG_HOME = xdg;
  setCredentialSource({ loadConfig: (s) => ({ ...(store[s] ?? {}) }), saveConfig: (s, c) => { store[s] = { ...(store[s] ?? {}), ...c }; return true; } });
  initClaudeAccounts();
  clearClaudeLimits();
  server = new KernelHttpServer({ config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig });
  registerConnectRoutes(server, {
    registry: { startProvider: async () => true, stopProvider: async () => true },
    getChain: () => [],
    setChain: () => {},
    onChanged: () => {},
    claudeLogin: createClaudeLogin({
      cli: () => "/payload/claude",
      spawn: (_c, _a, env) => {
        const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill(): void };
        proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
        spawned.push({ env, proc });
        return proc as unknown as ChildProcess;
      },
      duplicateOf: (id) => { const o = duplicateOf(id); return o ? { id: o.id, label: o.label } : null; },
    }),
  });
  expect(await server.start()).toBe(true);
  const addr = server.nodeServer!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterEach(async () => {
  await server.stop();
  setCredentialSource(null);
  setClaudeAccountResolver(null);
  clearClaudeLimits();
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(xdg, { recursive: true, force: true });
});

describe("claude account routes", () => {
  it("lists the default account with identity, limits and down flag, and no paths or tokens", async () => {
    signIn("default", "u1", "me@x.com");
    rememberClaudeLimit("claude-sonnet-4-5", { kind: "rate_limit", detail: "weekly" }, Date.now());
    const body = await (await json("GET", ACC)).json() as any;
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({ id: "default", primary: true, connected: true, down: false, identity: { email: "me@x.com" } });
    expect(body.accounts[0].limits).toEqual([
      { model: "claude-sonnet-4-5", until: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), detail: "weekly" },
    ]);
    expect(JSON.stringify(body)).not.toContain(xdg);
  });

  it("flags an account whose session failed as down", async () => {
    rememberClaudeAccountDown("default");
    const body = await (await json("GET", ACC)).json() as any;
    expect(body.accounts[0].down).toBe(true);
  });

  it("round-trips add, rename, move and remove, answering with the fresh list each time", async () => {
    let body = await (await json("POST", ACC, { label: "Personal" })).json() as any;
    expect(body.accounts.map((a: any) => a.label)).toEqual(["", "Personal"]);
    const id = body.accounts[1].id as string;

    body = await (await json("PUT", `${ACC}/${id}`, { label: " Work " })).json() as any;
    expect(body.accounts[1].label).toBe("Work");

    body = await (await json("PUT", `${ACC}/${id}`, { move: "up" })).json() as any;
    expect(body.accounts.map((a: any) => a.id)).toEqual([id, "default"]);

    body = await (await json("DELETE", `${ACC}/${id}`)).json() as any;
    expect(body.accounts.map((a: any) => a.id)).toEqual(["default"]);
  });

  it("answers 404 for an unknown account and 400 for the last one", async () => {
    expect((await json("PUT", `${ACC}/deadbeef`, { label: "x" })).status).toBe(404);
    expect((await json("DELETE", `${ACC}/deadbeef`)).status).toBe(404);
    const r = await json("DELETE", `${ACC}/default`);
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toContain("last Claude account");
  });

  it("rejects malformed input with 400", async () => {
    expect((await json("POST", ACC, { label: 5 })).status).toBe(400);
    expect((await json("PUT", `${ACC}/default`, { move: "sideways" })).status).toBe(400);
    expect((await json("POST", "/api/llm/claude-code/login", { accountId: 7 })).status).toBe(400);
    expect(spawned).toHaveLength(0);
  });

  it("caps labels at 80 trimmed characters on POST and PUT", async () => {
    expect((await json("POST", ACC, { label: "x".repeat(81) })).status).toBe(400);
    expect((await json("PUT", `${ACC}/default`, { label: "y".repeat(81) })).status).toBe(400);
    expect((await json("POST", ACC, { label: ` ${"x".repeat(80)} ` })).status).toBe(200);
    expect((await json("PUT", `${ACC}/default`, { label: "y".repeat(80) })).status).toBe(200);
  });

  it("signs in to the chosen account and reports a duplicate of another", async () => {
    const added = await (await json("POST", ACC, {})).json() as any;
    const id = added.accounts[1].id as string;
    const r = await (await json("POST", "/api/llm/claude-code/login", { accountId: id })).json() as any;
    expect(r).toMatchObject({ state: "waiting", accountId: id });
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toBe(claudeAccountDir(id));

    signIn("default", "u1", "me@x.com");
    signIn(id, "u1", "me@x.com");
    spawned[0].proc.emit("exit", 0);
    const st = await (await json("GET", "/api/llm/claude-code/login")).json() as any;
    expect(st).toMatchObject({ state: "done", accountId: id, duplicateOf: { id: "default" } });
  });

  it("without an accountId signs in to the primary, as before", async () => {
    const r = await (await json("POST", "/api/llm/claude-code/login", {})).json() as any;
    expect(r.state).toBe("waiting");
    expect(r.accountId).toBeUndefined();
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toBe(claudeAccountDir("default"));
  });

  it("answers 404 when signing in to an unknown account", async () => {
    expect((await json("POST", "/api/llm/claude-code/login", { accountId: "deadbeef" })).status).toBe(404);
    expect(spawned).toHaveLength(0);
  });
});

describe("listClaudeLimits", () => {
  it("lists one account's live limits, account-wide as '*', and drops expired ones", () => {
    const now = 1_000_000;
    rememberClaudeLimit("claude-opus-4", { kind: "rate_limit", detail: "opus", resetsAt: now + 5000 }, now, "a1a1a1a1");
    rememberClaudeLimit("x", { kind: "rate_limit", detail: "5h", limitType: "five_hour", resetsAt: now + 9000 }, now, "a1a1a1a1");
    rememberClaudeLimit("claude-opus-4", { kind: "rate_limit", detail: "other", resetsAt: now + 5000 }, now, "b2b2b2b2");
    expect(listClaudeLimits("a1a1a1a1", now)).toEqual([
      { model: "*", blockedUntil: now + 9000, detail: "5h" },
      { model: "claude-opus-4", blockedUntil: now + 5000, detail: "opus" },
    ]);
    expect(listClaudeLimits("a1a1a1a1", now + 6000).map((l) => l.model)).toEqual(["*"]);
  });
});
