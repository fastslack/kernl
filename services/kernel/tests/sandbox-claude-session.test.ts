import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sandboxCredentials,
  writeSandboxCredentials,
  writeSandboxClaudeJson,
  needsRefresh,
  ensureFreshClaudeSession,
  prepareSandboxCredentials,
} from "../src/core/sandbox/claude-session.js";
import { claudeAccountDir, setClaudeAccountResolver } from "../src/sdk/claude-accounts.js";
import { kernlClaudeSessionFiles } from "../src/core/sandbox/drivers/docker-driver.js";
import { classifyError } from "../src/core/llm/provider-health.js";

// A sandbox that refreshed the session rotated the refresh token away from
// Kernl's own file, and the next kernel call blanked the session for everyone.

const HOUR = 60 * 60 * 1000;
const session = (expiresAt: number, refreshToken = "rt-1") => ({
  claudeAiOauth: { accessToken: "at-1", refreshToken, expiresAt, scopes: ["user:inference"], subscriptionType: "max" },
});

describe("sandbox credentials", () => {
  it("keep the access token and drop the refresh token", () => {
    const copy = JSON.parse(sandboxCredentials(JSON.stringify(session(123)))!);
    expect(copy.claudeAiOauth.accessToken).toBe("at-1");
    expect(copy.claudeAiOauth.expiresAt).toBe(123);
    expect(copy.claudeAiOauth.subscriptionType).toBe("max");
    expect("refreshToken" in copy.claudeAiOauth).toBe(false);
  });

  it("are not written for a blank or unreadable session", () => {
    expect(sandboxCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "" } }))).toBeNull();
    expect(sandboxCredentials("not json")).toBeNull();
  });
});

// Bind-mounting the live .claude.json lost a race with the CLI's atomic
// rewrite (tmp + rename): runc mounted an inode that no longer existed and the
// run died at 0.17s with exit 127. Each run mounts its own copy instead.
describe("sandbox .claude.json", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kernl-claude-json-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is a private per-run copy that a rewrite of the original does not touch", () => {
    const src = join(dir, ".claude.json");
    const dest = join(dir, "run-1-claude.json");
    writeFileSync(src, JSON.stringify({ userID: "u1" }));
    expect(writeSandboxClaudeJson(src, dest)).toBe(dest);
    expect(statSync(dest).mode & 0o777).toBe(0o600);

    writeFileSync(`${src}.tmp`, JSON.stringify({ userID: "u2" }));
    renameSync(`${src}.tmp`, src);
    expect(JSON.parse(readFileSync(dest, "utf-8")).userID).toBe("u1");
  });

  it("is not written when there is no original", () => {
    expect(writeSandboxClaudeJson(join(dir, "missing.json"), join(dir, "out.json"))).toBeNull();
  });
});

describe("refresh before a sandbox run", () => {
  let dir: string;
  let creds: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kernl-session-"));
    creds = join(dir, ".credentials.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is needed only for a refreshable session close to expiry", () => {
    const now = 1_000_000;
    expect(needsRefresh(session(now + 10 * 60 * 1000).claudeAiOauth, now, 30 * 60 * 1000)).toBe(true);
    expect(needsRefresh(session(now + 2 * HOUR).claudeAiOauth, now, 30 * 60 * 1000)).toBe(false);
    expect(needsRefresh(session(now, "").claudeAiOauth, now, 30 * 60 * 1000)).toBe(false);
  });

  it("leaves a long-lived session alone", async () => {
    writeFileSync(creds, JSON.stringify(session(Date.now() + 5 * HOUR)));
    let pinged = 0;
    await ensureFreshClaudeSession({ credsPath: creds, ping: async () => { pinged++; } });
    expect(pinged).toBe(0);
  });

  it("marks a near-expiry session expired so the CLI refreshes it in place", async () => {
    writeFileSync(creds, JSON.stringify(session(Date.now() + 60_000)));
    let seenExpiry = Infinity;
    await ensureFreshClaudeSession({
      credsPath: creds,
      ping: async () => {
        seenExpiry = JSON.parse(readFileSync(creds, "utf-8")).claudeAiOauth.expiresAt;
        // What the CLI does: a new pair, written where Kernl reads it.
        writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: "at-2", refreshToken: "rt-2", expiresAt: Date.now() + 8 * HOUR } }));
      },
    });
    expect(seenExpiry).toBeLessThan(Date.now());
    const copy = JSON.parse(readFileSync(writeSandboxCredentials(creds, join(dir, "copy.json"))!, "utf-8"));
    expect(copy.claudeAiOauth.accessToken).toBe("at-2");
    expect(copy.claudeAiOauth.refreshToken).toBeUndefined();
  });

  it("never throws and keeps the tokens when the refresh fails", async () => {
    writeFileSync(creds, JSON.stringify(session(Date.now() + 60_000)));
    await ensureFreshClaudeSession({ credsPath: creds, ping: async () => { throw new Error("offline"); } });
    const after = JSON.parse(readFileSync(creds, "utf-8")).claudeAiOauth;
    expect(after.accessToken).toBe("at-1");
    expect(after.refreshToken).toBe("rt-1");
  });
});

// Each account has its own credentials file and its own refresh: one shared
// in-flight slot would hand account B the promise of account A's refresh and
// leave B's token to expire mid-run.
describe("refresh with several accounts", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "kernl-session-multi-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fresh = (at: string) => JSON.stringify({ claudeAiOauth: { accessToken: at, refreshToken: `rt-${at}`, expiresAt: Date.now() + 8 * HOUR } });

  it("refreshes two files concurrently, each ping rewriting only its own file", async () => {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeFileSync(a, JSON.stringify(session(Date.now() + 60_000)));
    writeFileSync(b, JSON.stringify(session(Date.now() + 60_000)));
    const pings = { a: 0, b: 0 };
    await Promise.all([
      ensureFreshClaudeSession({ credsPath: a, ping: async () => { pings.a++; writeFileSync(a, fresh("at-a")); } }),
      ensureFreshClaudeSession({ credsPath: b, ping: async () => { pings.b++; writeFileSync(b, fresh("at-b")); } }),
    ]);
    expect(pings).toEqual({ a: 1, b: 1 });
    expect(JSON.parse(readFileSync(a, "utf-8")).claudeAiOauth.accessToken).toBe("at-a");
    expect(JSON.parse(readFileSync(b, "utf-8")).claudeAiOauth.accessToken).toBe("at-b");
  });

  it("shares one refresh between two launches on the same file", async () => {
    const a = join(dir, "a.json");
    writeFileSync(a, JSON.stringify(session(Date.now() + 60_000)));
    let pinged = 0;
    const ping = async () => { pinged++; await new Promise((r) => setTimeout(r, 20)); writeFileSync(a, fresh("at-a")); };
    await Promise.all([ensureFreshClaudeSession({ credsPath: a, ping }), ensureFreshClaudeSession({ credsPath: a, ping })]);
    expect(pinged).toBe(1);
  });

  it("prepares an account's credentials by pinging that account", async () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    setClaudeAccountResolver(() => [{ id: "default", label: "" }, { id: "second", label: "" }]);
    try {
      const { creds } = kernlClaudeSessionFiles("second");
      expect(creds.startsWith(claudeAccountDir("second"))).toBe(true);
      const { mkdirSync } = await import("node:fs");
      mkdirSync(claudeAccountDir("second"), { recursive: true });
      writeFileSync(creds, JSON.stringify(session(Date.now() + HOUR * 5)));
      const out = await prepareSandboxCredentials(creds, join(dir, "copy.json"), "second");
      expect(out).toBe(join(dir, "copy.json"));
      expect(JSON.parse(readFileSync(out!, "utf-8")).claudeAiOauth.refreshToken).toBeUndefined();
    } finally {
      setClaudeAccountResolver(null);
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved;
    }
  });
});

describe("a dead Claude Code session", () => {
  it("is an auth failure, not a transient one", () => {
    expect(classifyError(new Error("Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed"))).toBe("auth");
    expect(classifyError(new Error("Not logged in · Please run /login"))).toBe("auth");
  });
});
