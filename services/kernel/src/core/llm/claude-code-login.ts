/**
 * "Connect with my subscription" — sign the official CLI in from the dashboard.
 *
 * The connect dialog used to hand over a command to paste into a terminal. A
 * Mac user had to open Terminal, paste a line with an environment variable in
 * it, and work a TUI, all to reach one browser page. The CLI has a
 * non-interactive form for exactly this, `claude auth login --claudeai`: it
 * needs no TTY, opens the approval page in the browser itself, and listens on
 * localhost for the redirect. Approving the page is the whole flow.
 *
 * Kernl still does not sign anyone in and does not see the token: the CLI runs
 * the OAuth exchange and stores the session under CLAUDE_CONFIG_DIR, exactly
 * as the pasted command did. This only spares the terminal.
 *
 * Two modes, because the redirect goes to localhost on the machine the CLI
 * runs on:
 *
 *  - **Native** (the browser is on the same machine): the CLI opens the page
 *    and catches the redirect itself.
 *  - **Docker** (`captureBrowser`): there is no browser in the container, and
 *    the user's browser lands on the HOST's localhost, where nothing listens —
 *    "this site can't be reached", with `?code=…&state=…` in the address bar.
 *    The CLI's "browser" is a shim that records the approval link, the
 *    dashboard opens it, and the user pastes that dead address back. `deliver`
 *    hands its code to the CLI on the port the CLI itself chose. The CLI also
 *    prints a second link that ends on a page showing a code, but
 *    `auth login` never reads a pasted code — verified, with and without a PTY
 *    — so that link is not offered.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAuthEnv, stripAnsi } from "./claude-code-auth.js";

export type ClaudeLoginState = "idle" | "waiting" | "done" | "failed";

export interface ClaudeLoginStatus {
  state: ClaudeLoginState;
  /** Docker mode: the approval page for the dashboard to open. */
  authorizeUrl?: string;
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
  /** Docker mode: record the approval link instead of opening a browser. */
  captureBrowser?: boolean;
  /** Where the shim writes the link; a fresh temp dir by default. */
  shimDir?: () => string;
  /** Delivers the pasted redirect to the CLI. */
  fetchImpl?: typeof fetch;
}

/** Why a pasted address was refused — each maps to a message in the dialog. */
export type DeliverError = "not_waiting" | "bad_paste" | "wrong_login" | "unreachable";

/** The localhost port and OAuth state the CLI put in its approval link. */
export function callbackTarget(authorizeUrl: string): { port: number; state: string } | null {
  try {
    const u = new URL(authorizeUrl);
    const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
    const state = u.searchParams.get("state") ?? "";
    const port = Number(redirect.port);
    if (redirect.hostname !== "localhost" || !port || !state) return null;
    return { port, state };
  } catch {
    return null;
  }
}

/**
 * Pull code and state out of what the user pasted: the whole address from the
 * dead tab, or just its query. Anything else is refused rather than guessed.
 */
export function parsePastedRedirect(pasted: string): { code: string; state: string } | null {
  const text = pasted.trim();
  const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : text;
  const params = new URLSearchParams(query.split("#")[0]);
  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  return code && state ? { code, state } : null;
}

function writeShim(dir: string): { shim: string; file: string } {
  const file = join(dir, "authorize-url");
  const shim = join(dir, "browser.sh");
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$1" > "${file}"\n`);
  chmodSync(shim, 0o700);
  return { shim, file };
}

export function createClaudeLogin(deps: ClaudeLoginDeps) {
  const spawn = deps.spawn ?? ((cmd, args, env) => nodeSpawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] }));
  // The approval page can sit open while the user finds their password or a
  // second factor. Ten minutes is generous without leaving a process behind.
  const timeoutMs = deps.timeoutMs ?? 10 * 60_000;
  const fetchImpl = deps.fetchImpl ?? fetch;

  let status: ClaudeLoginStatus = { state: "idle" };
  let child: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let urlFile: string | null = null;

  const finish = (next: ClaudeLoginStatus) => {
    if (timer) clearTimeout(timer);
    timer = null;
    child = null;
    urlFile = null;
    status = next;
  };

  /** Docker mode: pick up the link the shim wrote, once the CLI has called it. */
  function readAuthorizeUrl(): void {
    if (!urlFile || status.authorizeUrl || status.state !== "waiting") return;
    try {
      const url = readFileSync(urlFile, "utf-8").trim();
      if (url) status = { ...status, authorizeUrl: url };
    } catch { /* not written yet */ }
  }

  function start(): ClaudeLoginStatus {
    // A second click while the page is still open reuses it, rather than
    // starting a race between two OAuth states where only one can win.
    if (child && status.state === "waiting") {
      readAuthorizeUrl();
      return status;
    }

    const cli = deps.cli();
    if (!cli) {
      status = { state: "failed", error: "no_cli" };
      return status;
    }

    const env: NodeJS.ProcessEnv = { ...process.env, ...claudeAuthEnv() };
    if (deps.captureBrowser) {
      const { shim, file } = writeShim((deps.shimDir ?? (() => mkdtempSync(join(tmpdir(), "kernl-claude-login-"))))());
      env.BROWSER = shim;
      urlFile = file;
    }

    let output = "";
    const proc = spawn(cli, ["auth", "login", "--claudeai"], env);
    child = proc;
    status = { state: "waiting" };

    const collect = (chunk: Buffer | string) => {
      output = (output + chunk.toString()).slice(-8000);
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
        const tail = stripAnsi(output).trim().split("\n")
          .filter((l) => !/^(Opening browser|If the browser)/.test(l.trim()))
          .slice(-3).join("\n");
        finish({ state: "failed", error: "exit", detail: tail || `exit code ${code}` });
      }
    });

    timer = setTimeout(() => {
      if (child !== proc) return;
      proc.kill();
      finish({ state: "failed", error: "timeout" });
    }, timeoutMs);
    timer.unref?.();

    return status;
  }

  /**
   * Hand the pasted redirect to the CLI. The port and the expected state come
   * from the link the CLI produced — never from the paste — so this can only
   * ever reach the CLI's own callback, and only for the sign-in in flight.
   */
  async function deliver(pasted: string): Promise<{ ok: true } | { ok: false; error: DeliverError }> {
    readAuthorizeUrl();
    if (status.state !== "waiting" || !status.authorizeUrl) return { ok: false, error: "not_waiting" };
    const target = callbackTarget(status.authorizeUrl);
    const got = parsePastedRedirect(pasted);
    if (!target || !got) return { ok: false, error: "bad_paste" };
    if (got.state !== target.state) return { ok: false, error: "wrong_login" };
    const q = new URLSearchParams({ code: got.code, state: got.state });
    // Both loopbacks, because "localhost" is not one address. In the kernel
    // image the CLI listened on ::1 only, while Bun's fetch resolved localhost
    // to 127.0.0.1 alone — every delivery was refused with the CLI right there.
    for (const host of ["127.0.0.1", "[::1]"]) {
      try {
        // The CLI answers with a redirect to Claude's success page; we only
        // need it to have received the code. It exits once the exchange ends.
        await fetchImpl(`http://${host}:${target.port}/callback?${q}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
        return { ok: true };
      } catch { /* not listening on this loopback — try the other */ }
    }
    return { ok: false, error: "unreachable" };
  }

  function cancel(): ClaudeLoginStatus {
    const proc = child;
    if (proc) {
      finish({ state: "idle" });
      proc.kill();
    }
    return status;
  }

  return {
    start,
    deliver,
    cancel,
    status: () => { readAuthorizeUrl(); return status; },
  };
}

export type ClaudeLogin = ReturnType<typeof createClaudeLogin>;
