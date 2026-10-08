/**
 * The tor daemon, run by the kernel itself.
 *
 * It used to be the container entrypoint's job, behind KERNEL_TOR=1 in `.env`
 * and a restart — and a native install had no tor at all. Now the kernel
 * starts and stops it from a switch on the Friends page, with the binary the
 * native packages ship (stage-payload.sh) or, in Docker, the one apt put in
 * the image.
 *
 * The switch is stored under its own `app_settings` key rather than as
 * KERNEL_TOR: stored settings only fill env keys that are unset, and the
 * compose file always sets KERNEL_TOR, so a toggle saved under that name would
 * be overridden on every boot. KERNEL_TOR stays as the default for an instance
 * that never touched the switch.
 *
 * A tor that is already listening on our tunnel port (a system tor, an older
 * entrypoint) is adopted rather than fought: we report it as up and never try
 * to kill a process we did not start.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SqliteDb } from "../db/sqlite.js";
import { log } from "../logger.js";
import { findBundledTool } from "../media-tools.js";
import { DEFAULT_HIDDEN_SERVICE_DIR, DEFAULT_HTTP_TUNNEL_PORT, DEFAULT_SOCKS_PORT, detectTor, isTorListening } from "./tor.js";

export const TOR_SETTING_KEY = "peering.tor";

export type TorState =
  | "off"
  /** Enabled, but no tor binary anywhere we look. */
  | "missing"
  | "starting"
  | "up"
  | "error";

export interface TorStatusView {
  enabled: boolean;
  state: TorState;
  /** 0–100 while starting, from tor's own "Bootstrapped N%" lines. */
  progress: number;
  /** The onion address once published, "" otherwise. */
  onion: string;
  /** What went wrong, in a sentence, when state is "error" or "missing". */
  error: string;
  /** True when the running tor is not ours (adopted), so "off" cannot stop it. */
  external: boolean;
}

export interface TorDaemonOptions {
  sqlite: SqliteDb;
  /**
   * Port the hidden service forwards to: the onion gateway, never the
   * kernel's own port (see onion-gateway.ts for why).
   */
  servicePort: number;
  /** Called whenever the onion goes up or down, so presence can be republished. */
  onChange?: () => void;
  /** Base for data/tor when KERNEL_TOR_HIDDEN_SERVICE_DIR is unset. Defaults to cwd. */
  baseDir?: string;
  /** Injected in tests. */
  findBinary?: () => string | null;
  spawnImpl?: typeof spawn;
  isListening?: (port: number) => Promise<boolean>;
  /** How long to wait for "Bootstrapped 100%" before calling it an error. */
  bootTimeoutMs?: number;
}

/** Where a tor binary might be, best first. */
export function findTorBinary(): string | null {
  const exe = process.platform === "win32" ? "tor.exe" : "tor";
  if (process.env.KERNEL_TOR_BIN && existsSync(process.env.KERNEL_TOR_BIN)) return process.env.KERNEL_TOR_BIN;
  const bundled = findBundledTool("tor", exe);
  if (bundled) return bundled;
  const onPath = typeof Bun !== "undefined" ? Bun.which("tor") : null;
  if (onPath) return onPath;
  // A Finder-launched app gets launchd's PATH, which has no Homebrew in it.
  for (const p of ["/opt/homebrew/bin/tor", "/usr/local/bin/tor", "/usr/bin/tor"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

export class TorDaemon {
  private child: ChildProcess | null = null;
  private state: TorState = "off";
  private progress = 0;
  private error = "";
  private external = false;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly httpPort = Number(process.env.KERNEL_TOR_HTTP_PORT ?? DEFAULT_HTTP_TUNNEL_PORT);
  private readonly socksPort = Number(process.env.KERNEL_TOR_SOCKS_PORT ?? DEFAULT_SOCKS_PORT);

  constructor(private opts: TorDaemonOptions) {}

  /** The switch: stored choice first, KERNEL_TOR for an instance that never used it. */
  enabled(): boolean {
    try {
      const row = this.opts.sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get(TOR_SETTING_KEY) as
        | { value: string }
        | undefined;
      if (row && row.value !== "") return row.value === "1";
    } catch {
      /* no app_settings yet: fall through to the environment */
    }
    return process.env.KERNEL_TOR === "1";
  }

  status(): TorStatusView {
    const onion = this.state === "up" ? detectTor({ dataDir: this.opts.baseDir }).onionUrl : "";
    return {
      enabled: this.enabled(),
      state: this.state,
      progress: this.state === "up" ? 100 : this.progress,
      onion,
      error: this.error,
      external: this.external,
    };
  }

  /** Bring tor to whatever the switch says. Safe to call repeatedly. */
  async reconcile(): Promise<TorStatusView> {
    if (this.enabled()) await this.start();
    else this.stop();
    return this.status();
  }

  /** Flip the switch, persist it, and act on it. */
  async setEnabled(on: boolean): Promise<TorStatusView> {
    this.opts.sqlite
      .prepare(
        `INSERT INTO app_settings (key, value, type, label, description, category, updated_at, updated_by)
         VALUES (?, ?, 'boolean', 'Reachable from anywhere (Tor)', ?, 'integrations', ?, 'user')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = 'user'`,
      )
      .run(
        TOR_SETTING_KEY,
        on ? "1" : "0",
        "Runs a Tor onion service so friends reach this Kernl from any network. Switched from the Friends page.",
        new Date().toISOString(),
      );
    return this.reconcile();
  }

  private hiddenServiceDir(): string {
    return (
      process.env.KERNEL_TOR_HIDDEN_SERVICE_DIR ?? resolve(this.opts.baseDir ?? process.cwd(), DEFAULT_HIDDEN_SERVICE_DIR)
    );
  }

  private async start(): Promise<void> {
    if (this.state === "starting" || this.state === "up") return;
    const listening = this.opts.isListening ?? ((p: number) => isTorListening(p));

    if (await listening(this.httpPort)) {
      // Someone else's tor already owns the port. Use it; never kill it.
      this.external = true;
      this.setState(detectTor({ dataDir: this.opts.baseDir }).available ? "up" : "error", 100,
        detectTor({ dataDir: this.opts.baseDir }).available
          ? ""
          : `A tor is already running on port ${this.httpPort}, but it publishes no onion address for this Kernl.`);
      return;
    }
    this.external = false;

    const bin = (this.opts.findBinary ?? findTorBinary)();
    if (!bin) {
      this.setState("missing", 0, "This install has no Tor. Update Kernl to a version that bundles it.");
      return;
    }

    const hsDir = this.hiddenServiceDir();
    const torDir = dirname(hsDir);
    const torrc = join(torDir, "torrc");
    try {
      mkdirSync(hsDir, { recursive: true });
      // tor refuses to start unless the key directory is private to its user.
      if (process.platform !== "win32") chmodSync(hsDir, 0o700);
      // HTTPTunnelPort is how our own fetch reaches onions: Bun rejects socks5.
      writeFileSync(
        torrc,
        [
          `DataDirectory ${join(torDir, "state")}`,
          `SocksPort 127.0.0.1:${this.socksPort}`,
          `HTTPTunnelPort 127.0.0.1:${this.httpPort}`,
          `HiddenServiceDir ${hsDir}`,
          `HiddenServicePort 80 127.0.0.1:${this.opts.servicePort}`,
          "Log notice stdout",
          "",
        ].join("\n"),
      );
    } catch (err) {
      this.setState("error", 0, `Could not prepare Tor's folder (${torDir}): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // The Linux expert bundle has no RUNPATH: without this it loads the
    // system's libevent and dies on a missing symbol. macOS uses
    // @executable_path and Windows looks beside the .exe on its own.
    const env = { ...process.env };
    if (process.platform === "linux") {
      env.LD_LIBRARY_PATH = [dirname(bin), env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    }

    this.setState("starting", 0, "");
    let child: ChildProcess;
    try {
      child = (this.opts.spawnImpl ?? spawn)(bin, ["-f", torrc], { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      this.setState("error", 0, `Tor did not start: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.child = child;
    // A native kernel that exits would otherwise leave tor holding the port,
    // and the next start would find it and could only adopt, never stop it.
    const killOnExit = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    process.once("exit", killOnExit);
    child.once("exit", () => process.removeListener("exit", killOnExit));
    let lastLine = "";

    const onLine = (line: string) => {
      if (!line.trim()) return;
      lastLine = line.trim();
      const m = /Bootstrapped (\d+)%/.exec(line);
      if (m) {
        const pct = Number(m[1]);
        if (pct >= 100) this.markUp();
        else if (this.state === "starting") this.progress = pct;
      }
    };
    let buf = "";
    const feed = (chunk: Buffer | string) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("error", (err) => {
      this.child = null;
      this.setState("error", 0, `Tor did not start: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return; // stopped on purpose, or replaced
      this.child = null;
      const wasUp = this.state === "up";
      this.setState("error", 0, `Tor stopped (${signal ?? `exit ${code}`})${lastLine ? `: ${lastLine.replace(/^.*\[\w+\]\s*/, "")}` : ""}`);
      if (wasUp) this.opts.onChange?.();
    });

    this.bootTimer = setTimeout(() => {
      if (this.state === "starting") {
        log.warn("peering: tor did not finish bootstrapping in time");
        this.error = "Tor is taking long to connect. It keeps trying; a firewall that blocks it would explain this.";
      }
    }, this.opts.bootTimeoutMs ?? 120_000);
  }

  private markUp(): void {
    if (this.state === "up") return;
    // The hostname file appears a moment after the descriptor is built; tor
    // writes it before it reports 100%, but do not trust that ordering blindly.
    const tor = detectTor({ dataDir: this.opts.baseDir });
    if (!tor.available) {
      this.progress = 99;
      setTimeout(() => this.markUp(), 500);
      return;
    }
    this.clearBootTimer();
    this.setState("up", 100, "");
    log.info(`peering: tor is up — ${tor.onionUrl}`);
    this.opts.onChange?.();
  }

  stop(): void {
    this.clearBootTimer();
    const wasUp = this.state === "up";
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    // An adopted tor keeps running; we only stop advertising it.
    this.external = false;
    this.setState("off", 0, "");
    if (wasUp) this.opts.onChange?.();
  }

  /** Is our onion answering right now? What the descriptor should advertise. */
  isUp(): boolean {
    return this.state === "up";
  }

  private clearBootTimer(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = null;
  }

  private setState(state: TorState, progress: number, error: string): void {
    this.state = state;
    this.progress = progress;
    this.error = error;
  }
}
