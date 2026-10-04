/**
 * "Connect with my subscription" runs `claude auth login --claudeai` for the
 * user instead of asking them to paste a command into a terminal. The CLI
 * opens the approval page and exits once it is approved; these pin the state
 * machine the dashboard polls.
 */
import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createClaudeLogin, loginUrlFrom } from "../src/core/llm/claude-code-login.js";

const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc";

function fakeChild() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill(): void };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  return proc;
}

function setup(opts: { cli?: string | null; timeoutMs?: number } = {}) {
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
  });
  return { login, spawned, signedIn: () => signedIn };
}

describe("loginUrlFrom", () => {
  it("pulls the approval link out of the CLI's output", () => {
    expect(loginUrlFrom(`Opening browser to sign in…\nIf the browser didn't open, visit: ${URL}\n`)).toBe(URL);
  });

  it("returns nothing before the link is printed", () => {
    expect(loginUrlFrom("Opening browser to sign in…")).toBeUndefined();
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

  it("exposes the link once the CLI prints it", () => {
    const { login, spawned } = setup();
    login.start();
    spawned[0].proc.stdout.emit("data", `If the browser didn't open, visit: ${URL}\n`);
    expect(login.status()).toEqual({ state: "waiting", url: URL });
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
});
