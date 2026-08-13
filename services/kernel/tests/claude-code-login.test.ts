import { describe, it, expect } from "bun:test";
import { ClaudeLoginSession, type LoginProcess } from "../src/core/llm/claude-code-login.js";

/** A stand-in for the PTY child, so the state machine is testable offline. */
function fakeProc() {
  let onData: (c: string) => void = () => {};
  let onExit: (c: number | null) => void = () => {};
  const written: string[] = [];
  let killed = false;
  const proc: LoginProcess = {
    write: (d) => written.push(d),
    kill: () => { killed = true; },
    onData: (cb) => { onData = cb; },
    onExit: (cb) => { onExit = cb; },
  };
  return {
    proc,
    written,
    get killed() { return killed; },
    emit: (s: string) => onData(s),
    exit: (c: number | null) => onExit(c),
  };
}

// Must carry `state=` — extractLoginUrl rejects anything that looks cut off,
// which is what stops a wrapped 80-column URL reaching the operator.
const URL_LINE = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=s1\r\n";

describe("ClaudeLoginSession", () => {
  it("surfaces the URL as soon as the CLI prints it", async () => {
    const f = fakeProc();
    const s = new ClaudeLoginSession("s1", f.proc);
    expect(s.state).toBe("starting");
    f.emit("Welcome to Claude Code\r\n");
    expect(s.state).toBe("starting"); // nothing to show yet
    f.emit(URL_LINE);
    expect(s.state).toBe("awaiting_code");
    expect(await s.waitForUrl()).toContain("/oauth/authorize");
  });

  it("resolves a waiter that asked before the URL existed", async () => {
    // The dialog opens and polls immediately; the CLI takes a second to boot.
    const f = fakeProc();
    const s = new ClaudeLoginSession("s2", f.proc);
    const pending = s.waitForUrl();
    f.emit(URL_LINE);
    expect(await pending).toContain("/oauth/authorize");
  });

  it("writes the verification code to the CLI's stdin", async () => {
    const f = fakeProc();
    const s = new ClaudeLoginSession("s3", f.proc);
    f.emit(URL_LINE);
    const done = s.submitCode("  code-123  ");
    expect(f.written).toEqual(["code-123\r"]); // trimmed, CR — the TUI's Enter
    expect(s.state).toBe("completing");
    f.exit(0);
    expect(await done).toBe(true);
    expect(s.state).toBe("done");
  });

  it("refuses a code before the URL stage — there is nothing listening yet", async () => {
    const f = fakeProc();
    const s = new ClaudeLoginSession("s4", f.proc);
    expect(await s.submitCode("early")).toBe(false);
    expect(f.written).toEqual([]);
  });

  it("fails when the CLI exits non-zero, quoting its last words", async () => {
    const f = fakeProc();
    const s = new ClaudeLoginSession("s5", f.proc);
    f.emit(URL_LINE);
    const done = s.submitCode("bad-code");
    f.emit("\r\nInvalid verification code\r\n");
    f.exit(1);
    expect(await done).toBe(false);
    expect(s.view().state).toBe("failed");
    expect(s.view().error).toContain("Invalid verification code");
  });

  it("treats an exit before any code as a failure, not a success", async () => {
    // The CLI died on its own — a zero exit here must not read as "logged in".
    const f = fakeProc();
    const s = new ClaudeLoginSession("s6", f.proc);
    f.emit(URL_LINE);
    f.exit(0);
    expect(s.view().state).toBe("failed");
  });

  it("kills the child when the operator closes the dialog", () => {
    const f = fakeProc();
    const s = new ClaudeLoginSession("s7", f.proc);
    f.emit(URL_LINE);
    s.cancel();
    expect(f.killed).toBe(true);
    expect(s.view().state).toBe("failed");
  });

  it("keeps a redrawing TUI from growing without bound", async () => {
    // Ink repaints continuously; an idle dialog would buffer megabytes.
    const f = fakeProc();
    const s = new ClaudeLoginSession("s8", f.proc);
    for (let i = 0; i < 200; i++) f.emit("x".repeat(1000));
    f.emit(URL_LINE);
    // Still finds the URL after heavy churn, because the tail is what is kept.
    expect(await s.waitForUrl()).toContain("/oauth/authorize");
  });

  it("fails immediately on a rejected code instead of waiting for an exit", async () => {
    // The CLI does NOT exit on a bad code — it prints the error and offers
    // "Press Enter to retry", so waiting for a close stalled the dialog for the
    // full timeout and then blamed the CLI for not finishing.
    const f = fakeProc();
    const s = new ClaudeLoginSession("s10", f.proc);
    f.emit(URL_LINE);
    const done = s.submitCode("wrong");
    f.emit("\r\nOAuth error: Invalid code. Please make sure the full code was copied\r\n");
    expect(await done).toBe(false);
    expect(s.view().error).toContain("Invalid code");
    expect(f.killed).toBe(true);
  });

  it("succeeds when the token appears, without waiting for an exit", async () => {
    // `setup-token` mints the credential and then sits there displaying it. It
    // never closes, so treating exit as the success signal hung the dialog on
    // the happy path exactly as it did on a bad code.
    const f = fakeProc();
    const s = new ClaudeLoginSession("s11", f.proc);
    f.emit(URL_LINE);
    const done = s.submitCode("good-code");
    f.emit("\r\n  sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789  \r\n");
    expect(await done).toBe(true);
    expect(s.token).toBe("sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    expect(s.view().state).toBe("done");
    expect(f.killed).toBe(true); // nothing left running
  });

  it("does not re-fire waiters once the session is settled", async () => {
    const f = fakeProc();
    const s = new ClaudeLoginSession("s9", f.proc);
    f.emit(URL_LINE);
    const done = s.submitCode("c");
    f.exit(0);
    expect(await done).toBe(true);
    f.exit(1); // a stray second exit event must not flip the verdict
    expect(s.view().state).toBe("done");
  });
});
