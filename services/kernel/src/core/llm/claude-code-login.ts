/**
 * The interactive half of Claude Code sign-in, driven from the dashboard.
 *
 * `claude setup-token` is an Ink TUI: it demands a real TTY and refuses to run
 * under a plain pipe ("Raw mode is not supported"). So the child is given a
 * borrowed PTY (`script`), its output is scraped for the OAuth URL, and the
 * verification code the operator gets back from the browser is written to its
 * stdin. That is the whole protocol — three states and a timeout.
 *
 * The process is deliberately owned by a session object rather than a request:
 * the CLI keeps running between "give me the URL" and "here is the code", which
 * are two separate HTTP calls minutes apart.
 */

import { extractLoginUrl, stripAnsi } from "./claude-code-auth.js";

export type LoginState = "starting" | "awaiting_code" | "completing" | "done" | "failed";

/** The pieces of a child process this needs — narrow, so tests can fake it. */
export interface LoginProcess {
  write(data: string): void;
  kill(): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

export interface LoginSessionView {
  id: string;
  state: LoginState;
  url: string | null;
  error: string | null;
}

/** How long to wait for the CLI to print its URL before giving up. */
const URL_TIMEOUT_MS = 45_000;
/** How long the operator has to come back with the code. */
const CODE_TIMEOUT_MS = 10 * 60_000;

export class ClaudeLoginSession {
  private buffer = "";
  private _state: LoginState = "starting";
  private _url: string | null = null;
  private _error: string | null = null;
  /** The credential `setup-token` minted, once it appears in the output. */
  private _token: string | null = null;
  private urlWaiters: Array<(u: string | null) => void> = [];
  private exitWaiters: Array<(ok: boolean) => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly id: string,
    private readonly proc: LoginProcess,
    private readonly now: () => number = Date.now,
  ) {
    proc.onData((chunk) => this.ingest(chunk));
    proc.onExit((code) => this.finish(code));
    this.arm(URL_TIMEOUT_MS, "Timed out waiting for the sign-in URL.");
  }

  get state(): LoginState { return this._state; }
  get url(): string | null { return this._url; }
  get token(): string | null { return this._token; }

  view(): LoginSessionView {
    return { id: this.id, state: this._state, url: this._url, error: this._error };
  }

  /**
   * Feed terminal output in.
   *
   * The buffer is capped because a TUI redraws continuously — an idle login
   * dialog would otherwise grow a megabyte of cursor moves per minute. The tail
   * is what matters: the URL is printed once and we keep enough context around
   * it to survive Ink's line wrapping.
   */
  private ingest(chunk: string): void {
    this.buffer = (this.buffer + chunk).slice(-64_000);
    // A rejected code does not end the process — the CLI reports the problem
    // and offers "Press Enter to retry", so waiting for an exit would stall
    // until the timeout and then blame the CLI for not finishing. Read its
    // verdict instead and fail immediately with the reason it gave.
    if (this._state === "completing") {
      const flat = stripAnsi(this.buffer);
      // Success is a token appearing, NOT the process ending. `setup-token`
      // mints a credential and then sits there displaying it, so waiting for an
      // exit hung the dialog on the happy path exactly as it did on the sad one.
      const tok = /sk-ant-[A-Za-z0-9_-]{20,}/.exec(flat);
      if (tok) {
        this._token = tok[0];
        this.proc.kill();
        this.settle(true);
        return;
      }
      const err = /OAuth error:\s*([^\n\r]+)/i.exec(flat);
      if (err) {
        this._error = err[1].trim().slice(0, 200);
        this.proc.kill();
        this.settle(false);
      }
      return;
    }
    if (this._url || this._state !== "starting") return;
    const url = extractLoginUrl(this.buffer);
    if (!url) return;
    this._url = url;
    this._state = "awaiting_code";
    this.arm(CODE_TIMEOUT_MS, "Timed out waiting for the verification code.");
    for (const w of this.urlWaiters.splice(0)) w(url);
  }

  /** Resolve once the CLI has printed its URL, or when we give up on it. */
  waitForUrl(): Promise<string | null> {
    if (this._url) return Promise.resolve(this._url);
    if (this._state === "failed") return Promise.resolve(null);
    return new Promise((resolve) => this.urlWaiters.push(resolve));
  }

  /** Hand the browser's verification code to the waiting CLI. */
  submitCode(code: string): Promise<boolean> {
    if (this._state !== "awaiting_code") {
      return Promise.resolve(false);
    }
    this._state = "completing";
    this.arm(URL_TIMEOUT_MS, "The CLI did not finish after the code was sent.");
    // CR, not LF. The prompt is an Ink field in raw mode, where Enter is \r —
    // sending \n left the code sitting in the input box untouched and the whole
    // dialog hung until the timeout.
    this.proc.write(`${code.trim()}\r`);
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  private finish(code: number | null): void {
    if (this._state === "done" || this._state === "failed") return;
    const ok = code === 0 && this._state === "completing";
    if (!ok && !this._error) {
      // Surface the CLI's own last words rather than a generic failure — it
      // reports things like an expired code or a revoked subscription.
      this._error = this.tailMessage() || `The sign-in process exited with code ${code}.`;
    }
    this.settle(ok);
  }

  /** Everything the CLI has printed, for diagnosing a flow that stalled. */
  transcript(): string {
    return stripAnsi(this.buffer);
  }

  /**
   * Declare success from outside — the caller confirmed with `auth status`.
   *
   * Scraping the TUI for a success marker was guesswork that failed twice: the
   * CLI neither exits nor reliably prints anything we can pattern-match. Asking
   * it whether it is authenticated is the interface that actually exists.
   */
  markSucceeded(): void {
    this.proc.kill();
    this.settle(true);
  }

  /** Resolve everyone waiting, exactly once. */
  private settle(ok: boolean): void {
    this.clear();
    if (this._state === "done" || this._state === "failed") return;
    this._state = ok ? "done" : "failed";
    for (const w of this.urlWaiters.splice(0)) w(this._url);
    for (const w of this.exitWaiters.splice(0)) w(ok);
  }

  /** Last readable line of CLI output, for error reporting. */
  private tailMessage(): string {
    const lines = this.buffer
      .replace(/\r/g, "\n")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 3 && /[a-z]/i.test(l));
    return lines.length ? lines[lines.length - 1].slice(0, 200) : "";
  }

  private arm(ms: number, message: string): void {
    this.clear();
    this.timer = setTimeout(() => {
      this._error = message;
      this._state = "failed";
      this.proc.kill();
      for (const w of this.urlWaiters.splice(0)) w(null);
      for (const w of this.exitWaiters.splice(0)) w(false);
    }, ms);
    // Never hold the process open for a dialog nobody is watching.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Abandon the flow — the operator closed the dialog. */
  cancel(): void {
    this.clear();
    if (this._state === "done") return;
    this._state = "failed";
    this._error = this._error ?? "Cancelled.";
    this.proc.kill();
    for (const w of this.urlWaiters.splice(0)) w(null);
    for (const w of this.exitWaiters.splice(0)) w(false);
  }
}
