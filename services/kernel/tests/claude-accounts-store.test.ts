/**
 * Claude Code account store: the list lives in provider config `claude-code`
 * under `accounts`; the SDK reads it through the resolver this store registers.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCredentialSource, getStoredConfig } from "../src/core/llm/credentials.js";
import {
  initClaudeAccounts, listAccounts, addAccount, renameAccount, moveAccount, removeAccount, duplicateOf,
} from "../src/core/llm/claude-accounts-store.js";
import {
  setClaudeAccountResolver, setClaudePrimaryTokenProbe, primaryClaudeAccountId, claudeAccountDir, listClaudeAccounts,
} from "../src/sdk/claude-accounts.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { registerLlmProviderRoutes } from "../src/core/llm/provider-routes.js";
import type { LlmProviderRegistry } from "../src/core/llm/provider-registry.js";
import type { ModelBlocklist } from "../src/core/llm/model-blocklist.js";

let store: Record<string, Record<string, unknown>>;
let xdg: string;
let prevXdg: string | undefined;
let prevToken: string | undefined;
let changes: string[];

function session(id: string, identity?: { accountUuid: string; organizationUuid: string; emailAddress?: string }) {
  const dir = claudeAccountDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: identity ?? { accountUuid: "x" } }));
}

beforeEach(() => {
  store = {};
  setCredentialSource({
    loadConfig: (s) => ({ ...(store[s] ?? {}) }),
    saveConfig: (s, c) => { store[s] = { ...c }; return true; },
  });
  xdg = mkdtempSync(join(tmpdir(), "claude-accts-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  changes = [];
  initClaudeAccounts({ onChange: (why) => changes.push(why) });
});

afterEach(() => {
  setClaudeAccountResolver(null);
  setClaudePrimaryTokenProbe(null);
  setCredentialSource(null);
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
  if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
  rmSync(xdg, { recursive: true, force: true });
});

describe("claude accounts store", () => {
  it("upgrade: no stored list means one default account, read from the legacy dir", () => {
    session("default", { accountUuid: "a1", organizationUuid: "o1", emailAddress: "me@x.com" });
    const list = listAccounts();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("default");
    expect(list[0]!.primary).toBe(true);
    expect(list[0]!.connected).toBe(true);
    expect(list[0]!.identity?.email).toBe("me@x.com");
    expect(store["claude-code"]).toBeUndefined();
  });

  it("add, rename, move and remove round-trip through the stored config", () => {
    const a = addAccount("Work");
    expect(a.id).toMatch(/^[0-9a-f]{8}$/);
    expect(statSync(claudeAccountDir(a.id)).mode & 0o777).toBe(0o700);
    expect(getStoredConfig("claude-code").accounts).toEqual([{ id: "default", label: "" }, { id: a.id, label: "Work" }]);

    renameAccount(a.id, "Personal");
    expect(listAccounts().map((x) => x.label)).toEqual(["", "Personal"]);

    moveAccount(a.id, "up");
    expect(listAccounts().map((x) => x.id)).toEqual([a.id, "default"]);
    moveAccount(a.id, "up"); // already first: no-op
    expect(listAccounts().map((x) => x.id)).toEqual([a.id, "default"]);

    removeAccount(a.id);
    expect(listAccounts().map((x) => x.id)).toEqual(["default"]);
    expect(existsSync(claudeAccountDir(a.id))).toBe(false);
    expect(changes).toHaveLength(4);
    expect(changes[0]).toBe("Claude accounts changed");
  });

  it("moveAccount changes the primary when both are connected", () => {
    session("default");
    const a = addAccount("B");
    session(a.id);
    expect(primaryClaudeAccountId()).toBe("default");
    moveAccount(a.id, "up");
    expect(primaryClaudeAccountId()).toBe(a.id);
    expect(listAccounts().find((x) => x.id === a.id)!.primary).toBe(true);
  });

  it("refuses to remove the last account", () => {
    expect(() => removeAccount("default")).toThrow(/last/i);
    expect(changes).toHaveLength(0);
  });

  it("removing default only drops it from the list and keeps its files", () => {
    session("default");
    const a = addAccount("B");
    removeAccount("default");
    expect(listAccounts().map((x) => x.id)).toEqual([a.id]);
    expect(existsSync(join(claudeAccountDir("default"), ".claude.json"))).toBe(true);
  });

  it("duplicateOf matches on account and organization together", () => {
    const a = addAccount("A"); session(a.id, { accountUuid: "u", organizationUuid: "o1" });
    const b = addAccount("B"); session(b.id, { accountUuid: "u", organizationUuid: "o1" });
    const c = addAccount("C"); session(c.id, { accountUuid: "u", organizationUuid: "o2" });
    expect(duplicateOf(b.id)?.id).toBe(a.id);
    expect(duplicateOf(c.id)).toBeNull();
    expect(duplicateOf("default")).toBeNull();
  });

  it("the primary token probe sees a stored oauthToken", () => {
    expect(listAccounts()[0]!.connected).toBe(false);
    store["claude-code"] = { oauthToken: "sk-ant-oat01-x" };
    expect(listAccounts()[0]!.connected).toBe(true);
  });
});

describe("PUT /api/llm-providers/claude-code/config and accounts", () => {
  let server: KernelHttpServer;
  let base: string;
  beforeEach(async () => {
    const registry = {
      loadConfig: (slug: string) => ({ ...(store[slug] ?? {}) }),
      saveConfig: (slug: string, cfg: Record<string, unknown>) => { store[slug] = { ...cfg }; return true; },
      getConfigSchema: () => [],
      getProvider: () => undefined,
      stopProvider: async () => true,
      startProvider: async () => true,
      getStatuses: () => [],
      lastStartError: null,
    } as unknown as LlmProviderRegistry;
    server = new KernelHttpServer({ config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig });
    registerLlmProviderRoutes(server, registry, {} as unknown as ModelBlocklist);
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(async () => { await server.stop(); });

  const put = (config: Record<string, unknown>) =>
    fetch(`${base}/api/llm-providers/claude-code/config`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config }),
    });

  it("a form save without accounts keeps the stored list", async () => {
    const a = addAccount("Work");
    const r = await put({ defaultModel: "sonnet" });
    expect(r.status).toBe(200);
    expect(store["claude-code"]!.defaultModel).toBe("sonnet");
    expect(store["claude-code"]!.accounts).toEqual([{ id: "default", label: "" }, { id: a.id, label: "Work" }]);
  });

  it("a client cannot set accounts", async () => {
    const a = addAccount("Work");
    await put({ accounts: [{ id: "evil", label: "x" }] });
    expect((store["claude-code"]!.accounts as Array<{ id: string }>).map((x) => x.id)).toEqual(["default", a.id]);
    store["claude-code"] = {};
    await put({ accounts: [{ id: "evil", label: "x" }] });
    expect(store["claude-code"]!.accounts).toBeUndefined();
  });
});

describe("hardening", () => {
  it("the resolver works with no onChange set", () => {
    setClaudeAccountResolver(null);
    initClaudeAccounts();
    store["claude-code"] = { accounts: [{ id: "default", label: "" }, { id: "abcdef12", label: "B" }] };
    expect(listClaudeAccounts().map((a) => a.id)).toEqual(["default", "abcdef12"]);
  });

  it("ignores stored ids that are not default or 8 hex chars, and never deletes outside the accounts dir", () => {
    const outside = join(xdg, "kernl", "precious");
    mkdirSync(outside, { recursive: true });
    store["claude-code"] = { accounts: [{ id: "default", label: "" }, { id: "..", label: "x" }, { id: "../precious", label: "y" }, { id: "abcdef12", label: "ok" }] };
    expect(listAccounts().map((a) => a.id)).toEqual(["default", "abcdef12"]);
    expect(() => removeAccount("..")).toThrow();
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(xdg, "kernl"))).toBe(true);
  });

  it("a failing hook does not fail a persisted mutation, and remove still deletes the dir", () => {
    initClaudeAccounts({ onChange: () => { throw new Error("boom"); } });
    const a = addAccount("A");
    expect(existsSync(claudeAccountDir(a.id))).toBe(true);
    removeAccount(a.id);
    expect(existsSync(claudeAccountDir(a.id))).toBe(false);
  });

  it("a failed save creates no directory", () => {
    setCredentialSource({ loadConfig: () => ({}), saveConfig: () => false });
    expect(() => addAccount("A")).toThrow();
    expect(existsSync(join(xdg, "kernl", "claude-accounts"))).toBe(false);
  });
});
