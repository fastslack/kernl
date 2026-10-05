/**
 * "Connect with my subscription" runs `claude auth login --claudeai` for the
 * user instead of asking them to paste a command into a terminal. The CLI
 * opens the approval page and exits once it is approved; these pin the state
 * machine the dashboard polls.
 */
import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callbackTarget, createClaudeLogin, parsePastedRedirect,
} from "../src/core/llm/claude-code-login.js";

const AUTHORIZE = "https://claude.com/cai/oauth/authorize?code=true&client_id=x"
  + "&redirect_uri=http%3A%2F%2Flocalhost%3A38997%2Fcallback&state=abc123";

function fakeChild() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill(): void };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  return proc;
}

function setup(opts: { cli?: string | null; timeoutMs?: number; captureBrowser?: boolean; fetchImpl?: typeof fetch } = {}) {
  const shimDir = mkdtempSync(join(tmpdir(), "kernl-login-test-"));
  const spawned: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; proc: ReturnType<typeof fakeChild> }> = [];
  let signedIn = 0;
  const login = createClaudeLogin({
    cli: () => (opts.cli === undefined ? "/payload/claude" : opts.cli),
    spawn: (cmd, args, env) => {
      const proc = fakeChild();
      spawned.push({ cmd, args, env, proc });
      return proc as unknown as ChildProcess;
    },
    onSignedIn: () => { signedIn++; },
    timeoutMs: opts.timeoutMs,
    captureBrowser: opts.captureBrowser,
    shimDir: () => shimDir,
    fetchImpl: opts.fetchImpl,
  });
  return { login, spawned, signedIn: () => signedIn, shimDir };
}

describe("callbackTarget", () => {
  it("reads the CLI's own port and state from its approval link", () => {
    expect(callbackTarget(AUTHORIZE)).toEqual({ port: 38997, state: "abc123" });
  });

  it("refuses a link that does not call back to localhost", () => {
    const manual = "https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s";
    expect(callbackTarget(manual)).toBeNull();
  });
});

describe("parsePastedRedirect", () => {
  it("takes the whole address from the tab that did not load", () => {
    expect(parsePastedRedirect("  http://localhost:38997/callback?code=C0de&state=abc123 \n"))
      .toEqual({ code: "C0de", state: "abc123" });
  });

  it("takes just the query too", () => {
    expect(parsePastedRedirect("code=C0de&state=abc123")).toEqual({ code: "C0de", state: "abc123" });
  });

  it("refuses anything without both code and state", () => {
    expect(parsePastedRedirect("http://localhost:38997/callback?code=C0de")).toBeNull();
    expect(parsePastedRedirect("hola")).toBeNull();
  });
});

describe("createClaudeLogin", () => {
  it("runs the subscription sign-in with Kernl's config dir", () => {
    const { login, spawned } = setup();
    expect(login.start().state).toBe("waiting");
    expect(spawned[0].cmd).toBe("/payload/claude");
    expect(spawned[0].args).toEqual(["auth", "login", "--claudeai"]);
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toMatch(/kernl[\\/]claude$/);
  });

  it("opens the user's own browser natively", () => {
    const { login, spawned } = setup();
    login.start();
    expect(spawned[0].env.BROWSER).toBe(process.env.BROWSER);
  });

  it("in Docker, records the approval link instead of opening a browser", () => {
    const { login, spawned } = setup({ captureBrowser: true });
    login.start();
    const shim = spawned[0].env.BROWSER!;
    expect(readFileSync(shim, "utf-8")).toStartWith("#!/bin/sh");
    expect(login.status().authorizeUrl).toBeUndefined();
    // What the CLI does with $BROWSER: run it with the link.
    const file = /> "([^"]+)"/.exec(readFileSync(shim, "utf-8"))![1];
    writeFileSync(file, AUTHORIZE + "\n");
    expect(login.status().authorizeUrl).toBe(AUTHORIZE);
  });

  it("is done when the CLI exits cleanly, and says so once", () => {
    const { login, spawned, signedIn } = setup();
    login.start();
    spawned[0].proc.emit("exit", 0);
    expect(login.status().state).toBe("done");
    expect(signedIn()).toBe(1);
  });

  it("reuses the page already open instead of racing a second sign-in", () => {
    const { login, spawned } = setup();
    login.start();
    login.start();
    expect(spawned).toHaveLength(1);
  });

  it("reports the CLI's last words when it fails", () => {
    const { login, spawned, signedIn } = setup();
    login.start();
    spawned[0].proc.stderr.emit("data", "OAuth error: access denied\n");
    spawned[0].proc.emit("exit", 1);
    expect(login.status()).toEqual({ state: "failed", error: "exit", detail: "OAuth error: access denied" });
    expect(signedIn()).toBe(0);
  });

  it("fails plainly when there is no CLI at all", () => {
    const { login, spawned } = setup({ cli: null });
    expect(login.start()).toEqual({ state: "failed", error: "no_cli" });
    expect(spawned).toHaveLength(0);
  });

  it("gives up and kills the CLI when the page is never approved", async () => {
    const { login, spawned } = setup({ timeoutMs: 5 });
    login.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(login.status().state).toBe("failed");
    expect(login.status().error).toBe("timeout");
    expect(spawned[0].proc.killed).toBe(true);
  });

  it("cancel kills the CLI and ignores its late exit", () => {
    const { login, spawned, signedIn } = setup();
    login.start();
    expect(login.cancel().state).toBe("idle");
    expect(spawned[0].proc.killed).toBe(true);
    spawned[0].proc.emit("exit", 0);
    expect(login.status().state).toBe("idle");
    expect(signedIn()).toBe(0);
  });

  it("can start again after finishing", () => {
    const { login, spawned } = setup();
    login.start();
    spawned[0].proc.emit("exit", 0);
    expect(login.start().state).toBe("waiting");
    expect(spawned).toHaveLength(2);
  });

  describe("deliver", () => {
    function inFlight(fetchImpl?: typeof fetch) {
      const calls: string[] = [];
      const ctx = setup({
        captureBrowser: true,
        fetchImpl: fetchImpl ?? (async (u: string | URL | Request) => { calls.push(String(u)); return new Response(null, { status: 302 }); }) as typeof fetch,
      });
      ctx.login.start();
      const file = /> "([^"]+)"/.exec(readFileSync(ctx.spawned[0].env.BROWSER!, "utf-8"))![1];
      writeFileSync(file, AUTHORIZE);
      return { ...ctx, calls };
    }

    it("hands the code to the CLI's callback on its own port", async () => {
      const { login, calls } = inFlight();
      expect(await login.deliver("http://localhost:1/callback?code=C0de&state=abc123")).toEqual({ ok: true });
      // The port comes from the CLI's link, never from the paste.
      expect(calls).toEqual(["http://localhost:38997/callback?code=C0de&state=abc123"]);
    });

    it("refuses an address from another sign-in", async () => {
      const { login, calls } = inFlight();
      expect(await login.deliver("http://localhost:38997/callback?code=C0de&state=other")).toEqual({ ok: false, error: "wrong_login" });
      expect(calls).toHaveLength(0);
    });

    it("refuses a paste it cannot read", async () => {
      const { login } = inFlight();
      expect(await login.deliver("no sé qué copiar")).toEqual({ ok: false, error: "bad_paste" });
    });

    it("says so when nothing is waiting", async () => {
      const { login } = setup({ captureBrowser: true });
      expect(await login.deliver("code=C0de&state=abc123")).toEqual({ ok: false, error: "not_waiting" });
    });

    it("reports a CLI that is not listening", async () => {
      const { login } = inFlight((async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
      expect(await login.deliver("code=C0de&state=abc123")).toEqual({ ok: false, error: "unreachable" });
    });
  });
});
