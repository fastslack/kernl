/**
 * The service behind the Claude Code sign-in dialog: probe, sign in, paste a
 * token. Everything that touches a real process lives here so the state machine
 * (claude-code-login.ts) and the parsing (claude-code-auth.ts) stay testable.
 */

import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  claudeAuthEnv,
  ensureClaudeConfigDir,
  parseAuthStatus,
  ptyCommand,
  claudeConfigDir,
  type ClaudeAuthStatus,
} from "./claude-code-auth.js";
import { ClaudeLoginSession, type LoginProcess, type LoginSessionView } from "./claude-code-login.js";
import { resetClaudeCodeSdkCache } from "./client.js";
import { log } from "../logger.js";

export interface ClaudeAuthReport extends ClaudeAuthStatus {
  /** The CLI was found — without this nothing else is possible. */
  cliFound: boolean;
  /** A PTY can be borrowed, so the in-app sign-in flow is offered. */
  interactiveLogin: boolean;
  /** Where credentials are kept, shown in the dialog so it is never a mystery. */
  configDir: string;
}

function which(cmd: string): string | null {
  try {
    const p = execFileSync("which", [cmd], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return p || null;
  } catch {
    return null;
  }
}

/** Wrap a spawned child so the session sees only what it needs. */
function adopt(child: ReturnType<typeof spawn>): LoginProcess {
  return {
    write: (d) => { child.stdin?.write(d); },
    kill: () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } },
    onData: (cb) => {
      child.stdout?.on("data", (b: Buffer) => cb(b.toString("utf-8")));
      child.stderr?.on("data", (b: Buffer) => cb(b.toString("utf-8")));
    },
    onExit: (cb) => { child.on("close", (code) => cb(code)); },
  };
}

export class ClaudeCodeAuthService {
  private sessions = new Map<string, ClaudeLoginSession>();

  constructor(
    /** Resolves the `claude` binary; the adapter's own lookup is reused. */
    private readonly findCli: () => string | undefined,
    /** Reads the operator-pasted token, if any. */
    private readonly getToken: () => string | undefined = () => undefined,
    /** Persists an operator-pasted token. */
    private readonly setToken: (t: string) => void = () => {},
  ) {}

  status(): ClaudeAuthReport {
    const cli = this.findCli();
    const base: ClaudeAuthReport = {
      loggedIn: false,
      authMethod: "none",
      cliFound: !!cli,
      interactiveLogin: !!cli && !!ptyCommand(which),
      configDir: claudeConfigDir(),
    };
    if (!cli) return base;
    try {
      const out = execFileSync(cli, ["auth", "status", "--json"], {
        encoding: "utf-8",
        env: { ...process.env, ...claudeAuthEnv({ oauthToken: this.getToken() }) },
        timeout: 20_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { ...base, ...parseAuthStatus(out) };
    } catch {
      return base;
    }
  }

  /**
   * Start `claude setup-token` under a borrowed PTY and wait for its URL.
   *
   * Resolves only once the URL is in hand (or the attempt fails), because a
   * dialog with a "Sign in" button and no link is useless — the caller gets one
   * round trip, not a polling loop.
   */
  async startLogin(): Promise<{ session: LoginSessionView } | { error: string }> {
    const cli = this.findCli();
    if (!cli) return { error: "The Claude Code CLI was not found on this host." };
    const pty = ptyCommand(which);
    if (!pty) {
      return {
        error:
          "This host cannot allocate a terminal for the sign-in flow. " +
          "Run `claude setup-token` on any machine and paste the token instead.",
      };
    }

    ensureClaudeConfigDir();
    // The PTY helper takes the command as one string; quote the path so a
    // directory with spaces (a Windows-style install) still works.
    // `stty cols` is not cosmetic. Ink hard-wraps to the terminal width, and at
    // the PTY's default 80 columns the OAuth URL came back cut at exactly 80
    // characters — a link that loads a broken page. Widening the window before
    // the CLI starts is what keeps the URL on one line.
    const cmd = `stty cols 400 2>/dev/null; '${cli.replace(/'/g, "'\\''")}' setup-token`;
    const [bin, ...rest] = pty.map((a) => a.replace("%CMD%", cmd));

    const child = spawn(bin, rest, {
      env: { ...process.env, ...claudeAuthEnv({ oauthToken: this.getToken() }) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const id = randomBytes(9).toString("base64url");
    const session = new ClaudeLoginSession(id, adopt(child));
    this.sessions.set(id, session);

    const url = await session.waitForUrl();
    if (!url) {
      this.sessions.delete(id);
      return { error: session.view().error ?? "The CLI did not produce a sign-in URL." };
    }
    return { session: session.view() };
  }

  /** Hand back the code from the browser and report whether sign-in took. */
  async submitCode(id: string, code: string): Promise<{ ok: boolean; status?: ClaudeAuthReport; error?: string }> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "That sign-in session has expired. Start again." };
    // Two ways this can end, raced against each other:
    //   · the session sees an error in the output and fails fast, or
    //   · `auth status` starts reporting a session, which is the CLI's own
    //     answer to "did it work" and does not depend on parsing its UI.
    // The scrape-only version stalled for the full timeout whenever the CLI
    // succeeded quietly, which is exactly what it does.
    const settled = session.submitCode(code);
    const confirmed = this.pollUntilAuthenticated(20, 1000).then((yes) => {
      if (yes) session.markSucceeded();
      return yes;
    });
    const ok = (await Promise.race([settled, confirmed])) || (await settled);
    this.sessions.delete(id);
    if (!ok) {
      // Keep the raw terminal output — a flow that stalls is impossible to
      // diagnose from a timeout message alone.
      this.dumpTranscript(id, session.transcript());
      return { ok: false, error: session.view().error ?? "Sign-in failed." };
    }
    const token = session.token;
    if (token) this.setToken(token);
    // Same rule as the pasted-token route: a session is only "signed in" once a
    // real call succeeds. `auth status` flipping is not proof.
    const check = this.verifyCredential();
    if (!check.ok) {
      this.dumpTranscript(id, session.transcript());
      return { ok: false, error: check.detail || "Signed in, but the credential does not work." };
    }
    // The memoised provider decided at boot that it was unusable; without this
    // a successful sign-in would appear to do nothing until a restart.
    resetClaudeCodeSdkCache();
    log.info("claude-code: signed in via the dashboard");
    return { ok: true, status: this.status() };
  }



  /**
   * Prove the credential works by making a real call.
   *
   * `auth status` answers "is something configured", not "does it work" — it
   * reported a healthy session for a token we invented, and for a verification
   * code pasted into the token box. Only a real completion distinguishes the
   * two, and a wrong answer here costs the operator an hour of confusion.
   */
  private verifyCredential(): { ok: boolean; detail: string } {
    const cli = this.findCli();
    if (!cli) return { ok: false, detail: "The Claude Code CLI was not found." };
    try {
      const out = execFileSync(cli, ["-p", "ok", "--max-turns", "1"], {
        encoding: "utf-8",
        env: { ...process.env, ...claudeAuthEnv({ oauthToken: this.getToken() }) },
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (/not logged in|unauthori[sz]ed|invalid[_ -]?api[_ -]?key|authentication/i.test(out)) {
        return { ok: false, detail: out.trim().slice(0, 200) };
      }
      return { ok: true, detail: "" };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const text = `${e.stdout ?? ""} ${e.stderr ?? ""} ${e.message ?? ""}`.trim();
      // A bad credential makes the CLI hang rather than fail, so the timeout IS
      // the rejection. Saying "ETIMEDOUT" would send the operator hunting for a
      // network problem that isn't there.
      if (/ETIMEDOUT|timed? ?out/i.test(text)) {
        return { ok: false, detail: "The credential was not accepted — the CLI never answered. Check that the token is current." };
      }
      return { ok: false, detail: text.slice(0, 200) || "The credential was rejected." };
    }
  }

  /** Ask the CLI, once a second, whether it now has a session. */
  private async pollUntilAuthenticated(tries: number, everyMs: number): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, everyMs));
      if (this.status().loggedIn) return true;
    }
    return false;
  }

  /** Write the terminal transcript next to the credentials for inspection. */
  private dumpTranscript(id: string, text: string): void {
    try {
      writeFileSync(resolve(ensureClaudeConfigDir(), `login-${id}.log`), text, { mode: 0o600 });
    } catch { /* diagnostics must never break the flow */ }
  }

  /** The no-terminal route: store a token minted by `claude setup-token`. */
  saveToken(token: string): { ok: boolean; status?: ClaudeAuthReport; error?: string } {
    const t = token.trim();
    if (!t) return { ok: false, error: "Paste a token first." };
    // Shape check first, because the likeliest paste here is the wrong string:
    // a verification code went in and was accepted, and the dialog then reported
    // a healthy session while every request failed.
    if (!/^sk-ant-/.test(t)) {
      return {
        ok: false,
        error: "That does not look like a token. `claude setup-token` returns one starting with `sk-ant-`.",
      };
    }
    const previous = this.getToken();
    this.setToken(t);
    resetClaudeCodeSdkCache();
    const check = this.verifyCredential();
    if (!check.ok) {
      // Put back whatever was there — a failed paste must not log you out.
      this.setToken(previous ?? "");
      resetClaudeCodeSdkCache();
      return { ok: false, error: check.detail || "The CLI did not accept that token." };
    }
    return { ok: true, status: this.status() };
  }

  cancel(id: string): void {
    this.sessions.get(id)?.cancel();
    this.sessions.delete(id);
  }
}
