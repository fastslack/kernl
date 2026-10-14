import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sandboxCredentials,
  writeSandboxCredentials,
  needsRefresh,
  ensureFreshClaudeSession,
} from "../src/core/sandbox/claude-session.js";
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

describe("a dead Claude Code session", () => {
  it("is an auth failure, not a transient one", () => {
    expect(classifyError(new Error("Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed"))).toBe("auth");
    expect(classifyError(new Error("Not logged in · Please run /login"))).toBe("auth");
  });
});
