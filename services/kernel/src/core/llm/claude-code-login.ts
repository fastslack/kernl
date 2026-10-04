/**
 * "Connect with my subscription" — sign the official CLI in from the dashboard.
 *
 * The connect dialog used to hand over a command to paste into a terminal. A
 * Mac user had to open Terminal, paste a line with an environment variable in
 * it, and work a TUI, all to reach one browser page. The CLI has a
 * non-interactive form for exactly this, `claude auth login --claudeai`: it
 * needs no TTY, opens the approval page in the default browser itself, and
 * listens on localhost for the redirect. Approving the page is the whole flow.
 *
 * Kernl still does not sign anyone in and does not see the token: the CLI runs
 * the OAuth exchange and stores the session under CLAUDE_CONFIG_DIR, exactly
 * as the pasted command did. This only spares the terminal.
 *
 * The redirect goes to localhost on the machine the kernel runs on, so this
 * works when the browser is on that machine — a native install. Inside Docker
 * the CLI has no browser to open and the host cannot reach its callback port;
 * the dialog keeps the command for that case.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { claudeAuthEnv, stripAnsi } from "./claude-code-auth.js";

export type ClaudeLoginState = "idle" | "waiting" | "done" | "failed";

export interface ClaudeLoginStatus {
  state: ClaudeLoginState;
  /** Link to the approval page, as the CLI printed it — for "didn't open?". */
  url?: string;
  /** "no_cli" | "timeout" | "exit" — what went wrong, when it did. */
  error?: string;
  detail?: string;
}

export interface ClaudeLoginDeps {
  cli: () => string | null;
  spawn?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  /** Called once the CLI exits cleanly: re-read the session, reset caches. */
  onSignedIn?: () => void;
  timeoutMs?: number;
}

/** The first https URL the CLI prints — its "If the browser didn't open, visit:" line. */
export function loginUrlFrom(output: string): string | undefined {
  return /https:\/\/\S+/.exec(stripAnsi(output))?.[0];
}

export function createClaudeLogin(deps: ClaudeLoginDeps) {
  const spawn = deps.spawn ?? ((cmd, args, env) => nodeSpawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] }));
  // The approval page can sit open while the user finds their password or a
  // second factor. Ten minutes is generous without leaving a process behind.
  const timeoutMs = deps.timeoutMs ?? 10 * 60_000;

  let status: ClaudeLoginStatus = { state: "idle" };
  let child: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finish = (next: ClaudeLoginStatus) => {
    if (timer) clearTimeout(timer);
    timer = null;
    child = null;
    status = next;
  };

  function start(): ClaudeLoginStatus {
    // A second click while the page is still open reuses it, rather than
    // starting a race between two OAuth states where only one can win.
    if (child && status.state === "waiting") return status;

    const cli = deps.cli();
    if (!cli) {
      status = { state: "failed", error: "no_cli" };
      return status;
    }

    let output = "";
    const proc = spawn(cli, ["auth", "login", "--claudeai"], { ...process.env, ...claudeAuthEnv() });
    child = proc;
    status = { state: "waiting" };

    const collect = (chunk: Buffer | string) => {
      output = (output + chunk.toString()).slice(-8000);
      if (!status.url) {
        const url = loginUrlFrom(output);
        if (url) status = { ...status, url };
      }
    };
    proc.stdout?.on("data", collect);
    proc.stderr?.on("data", collect);

    proc.on("error", (err) => {
      if (child !== proc) return;
      finish({ state: "failed", error: "exit", detail: err.message });
    });
    proc.on("exit", (code) => {
      if (child !== proc) return;
      if (code === 0) {
        try { deps.onSignedIn?.(); } catch { /* the session is there either way */ }
        finish({ state: "done" });
      } else {
        const tail = stripAnsi(output).trim().split("\n").slice(-3).join("\n");
        finish({ state: "failed", error: "exit", detail: tail || `exit code ${code}` });
      }
    });

    timer = setTimeout(() => {
      if (child !== proc) return;
      proc.kill();
      finish({ state: "failed", error: "timeout", url: status.url });
    }, timeoutMs);
    timer.unref?.();

    return status;
  }

  function cancel(): ClaudeLoginStatus {
    const proc = child;
    if (proc) {
      finish({ state: "idle" });
      proc.kill();
    }
    return status;
  }

  return { start, cancel, status: () => status };
}

export type ClaudeLogin = ReturnType<typeof createClaudeLogin>;
