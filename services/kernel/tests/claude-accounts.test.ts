import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeAccountDir,
  claudeAuthEnv,
  claudeConfigDir,
  isClaudeAccountConnected,
  listClaudeAccounts,
  primaryClaudeAccountId,
  readClaudeIdentity,
  setClaudeAccountResolver,
  setClaudePrimaryTokenProbe,
} from "../src/sdk/index.js";

let xdg: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "claude-accounts-"));
  env = { XDG_CONFIG_HOME: xdg };
  setClaudeAccountResolver(null);
  setClaudePrimaryTokenProbe(() => false);
});

afterEach(() => {
  setClaudeAccountResolver(null);
  setClaudePrimaryTokenProbe(null);
  rmSync(xdg, { recursive: true, force: true });
});

function session(id: string) {
  const dir = claudeAccountDir(id, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), "{}");
}

describe("claude accounts", () => {
  test("account dirs", () => {
    expect(claudeAccountDir("default", env).endsWith("/kernl/claude")).toBe(true);
    expect(claudeAccountDir("b1", env).endsWith("/kernl/claude-accounts/b1")).toBe(true);
  });

  test("no resolver: single default account and legacy config dir", () => {
    expect(listClaudeAccounts()).toEqual([{ id: "default", label: "" }]);
    expect(claudeConfigDir(env)).toBe(claudeAccountDir("default", env));
  });

  test("primary is the first account with a session", () => {
    setClaudeAccountResolver(() => [{ id: "A", label: "a" }, { id: "B", label: "b" }]);
    session("B");
    expect(primaryClaudeAccountId(env)).toBe("B");
    expect(claudeConfigDir(env)).toBe(claudeAccountDir("B", env));
  });

  test("nothing connected: primary falls back to the first", () => {
    setClaudeAccountResolver(() => [{ id: "A", label: "a" }, { id: "B", label: "b" }]);
    expect(primaryClaudeAccountId(env)).toBe("A");
  });

  test("pasted token counts for the first account only", () => {
    setClaudeAccountResolver(() => [{ id: "A", label: "a" }, { id: "B", label: "b" }]);
    setClaudePrimaryTokenProbe(() => true);
    expect(isClaudeAccountConnected("A", env)).toBe(true);
    expect(isClaudeAccountConnected("B", env)).toBe(false);
    expect(primaryClaudeAccountId(env)).toBe("A");
  });

  test("no probe: the environment variable decides", () => {
    setClaudePrimaryTokenProbe(null);
    const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok";
      expect(isClaudeAccountConnected("default", env)).toBe(true);
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "";
      expect(isClaudeAccountConnected("default", env)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
    }
  });

  test("readClaudeIdentity", () => {
    const dir = claudeAccountDir("b1", env);
    mkdirSync(dir, { recursive: true });
    expect(readClaudeIdentity(dir)).toBeNull();
    writeFileSync(join(dir, ".claude.json"), "{nope");
    expect(readClaudeIdentity(dir)).toBeNull();
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "x@y.z", accountUuid: "u", organizationUuid: "o", organizationName: "Acme" },
      }),
    );
    expect(readClaudeIdentity(dir)).toEqual({
      email: "x@y.z",
      accountUuid: "u",
      organizationUuid: "o",
      organizationName: "Acme",
    });
  });

  test("claudeAuthEnv carries the token only for the primary", () => {
    setClaudeAccountResolver(() => [{ id: "a0", label: "" }, { id: "b1", label: "" }]);
    const secondary = claudeAuthEnv({ accountId: "b1", env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "t" } });
    expect(secondary.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(secondary.CLAUDE_CONFIG_DIR).toBe(claudeAccountDir("b1", env));
    const primary = claudeAuthEnv({ accountId: "a0", env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "t" } });
    expect(primary.CLAUDE_CODE_OAUTH_TOKEN).toBe("t");
    expect(claudeAuthEnv({ env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "t" } }).CLAUDE_CODE_OAUTH_TOKEN).toBe("t");
  });

  test("explicit oauthToken makes the first account primary and is injected", () => {
    setClaudeAccountResolver(() => [{ id: "A", label: "" }, { id: "B", label: "" }]);
    session("B");
    const out = claudeAuthEnv({ oauthToken: "tok", env });
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    expect(out.CLAUDE_CONFIG_DIR).toBe(claudeAccountDir("A", env));
  });

  test("explicit oauthToken is dropped for another account", () => {
    setClaudeAccountResolver(() => [{ id: "A", label: "" }, { id: "B", label: "" }]);
    session("B");
    const out = claudeAuthEnv({ oauthToken: "tok", accountId: "B", env });
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(out.CLAUDE_CONFIG_DIR).toBe(claudeAccountDir("B", env));
  });

  test("a throwing resolver falls back to the default account", () => {
    setClaudeAccountResolver(() => {
      throw new Error("store down");
    });
    expect(listClaudeAccounts()).toEqual([{ id: "default", label: "" }]);
    expect(claudeConfigDir(env)).toBe(claudeAccountDir("default", env));
  });

  test("an empty list is treated as no resolver", () => {
    setClaudeAccountResolver(() => []);
    expect(listClaudeAccounts()).toEqual([{ id: "default", label: "" }]);
    expect(primaryClaudeAccountId(env)).toBe("default");
  });
});
