/**
 * Keeps one long-lived child process alive.
 *
 * Binary installs (Linux tarball, macOS .app) ship `mtw-server` and the Go
 * `whatsapp-bridge` next to the kernel instead of running them as Docker
 * services, so something has to play the role compose's `restart:` plays
 * there: start the process, bring it back when it dies, and take it down with
 * the kernel.
 *
 * Restarts back off exponentially (min → max, doubling) so a binary that
 * crashes on boot does not spin a CPU, and the backoff resets once a run has
 * stayed up for a minute — a crash after a day of uptime is not the same
 * problem as a crash loop.
 *
 * Logging names the sidecar, the pid and the exit code only. The command line
 * and environment are never logged: env carries socket and session paths
 * today, and nothing stops it from carrying a secret tomorrow.
 *
 * Child stdout goes to the kernel's stderr, not its stdout: with the MCP stdio
 * transport the kernel's stdout is the protocol stream, and one stray log line
 * from a sidecar would corrupt it.
 */

import { existsSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { log } from "../logger.js";

export interface SidecarSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Which kernel env vars the child inherits: every one (the default) or only
   * the names listed. `env` is added on top either way.
   */
  inheritEnv?: "all" | readonly string[];
  /**
   * Where the running child's pid is kept, as `"<childPid> <kernelPid>"`, so
   * the next boot can find a child a SIGKILLed kernel left behind (see
   * `reapOrphan`). Removed on stop().
   */
  pidFile?: string;
  cwd?: string;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

type Proc = ReturnType<typeof Bun.spawn>;

const STABLE_UPTIME_MS = 60_000;
const KILL_GRACE_MS = 5_000;

export class SidecarSupervisor {
  private readonly spec: SidecarSpec;
  private readonly spawnFn: typeof Bun.spawn;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;

  private proc: Proc | null = null;
  private alive = false;
  private stopping = false;
  private startedAt = 0;
  private backoff: number;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartCount = 0;

  constructor(spec: SidecarSpec, spawnFn: typeof Bun.spawn = Bun.spawn) {
    this.spec = spec;
    this.spawnFn = spawnFn;
    this.minBackoff = spec.minBackoffMs ?? 1_000;
    this.maxBackoff = Math.max(spec.maxBackoffMs ?? 30_000, this.minBackoff);
    this.backoff = this.minBackoff;
  }

  get running(): boolean {
    return this.alive;
  }

  get restarts(): number {
    return this.restartCount;
  }

  start(): void {
    if (this.alive || this.restartTimer) return;
    this.stopping = false;
    this.spawnOnce();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const proc = this.proc;
    if (!proc || !this.alive) {
      this.removePidFile();
      return;
    }

    try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    const exitedInTime = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(KILL_GRACE_MS).then(() => false),
    ]);
    if (!exitedInTime) {
      log.warn(`sidecar ${this.spec.name}: did not exit on SIGTERM, sending SIGKILL`);
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      await proc.exited;
    }
    this.alive = false;
    this.removePidFile();
  }

  /**
   * Synchronous last resort for `process.on("exit")`, where nothing async
   * runs: SIGTERM the child so a kernel that dies without a clean shutdown
   * does not leave an orphan holding the port the next boot needs.
   */
  killNow(): void {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.alive) {
      try { this.proc?.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }

  private spawnOnce(): void {
    const { name, command, args = [], env, cwd, inheritEnv = "all" } = this.spec;
    let base: Record<string, string | undefined> = process.env;
    if (inheritEnv !== "all") {
      base = {};
      for (const key of inheritEnv) {
        if (process.env[key] !== undefined) base[key] = process.env[key];
      }
    }
    let proc: Proc;
    try {
      proc = this.spawnFn([command, ...args], {
        cwd,
        env: { ...base, ...env },
        stdin: "ignore",
        stdout: 2,
        stderr: "inherit",
      });
    } catch (err) {
      log.warn(`sidecar ${name}: failed to start (${(err as Error).message ?? err})`);
      this.scheduleRestart();
      return;
    }

    this.proc = proc;
    this.alive = true;
    this.startedAt = Date.now();
    if (this.spec.pidFile) {
      try { writeFileSync(this.spec.pidFile, `${proc.pid} ${process.pid}\n`); } catch (err) {
        log.warn(`sidecar ${name}: could not write pidfile (${(err as Error).message ?? err})`);
      }
    }
    log.info(`sidecar ${name}: started (pid ${proc.pid})`);

    void proc.exited.then((code) => {
      if (this.proc !== proc) return;
      this.alive = false;
      if (this.stopping) {
        log.info(`sidecar ${name}: stopped (exit ${code})`);
        return;
      }
      log.info(`sidecar ${name}: exited (code ${code})`);
      if (Date.now() - this.startedAt >= STABLE_UPTIME_MS) this.backoff = this.minBackoff;
      this.scheduleRestart();
    });
  }

  /** Removes the pidfile only while it still names this supervisor's child. */
  private removePidFile(): void {
    if (!this.spec.pidFile) return;
    try {
      const childPid = Number.parseInt(readFileSync(this.spec.pidFile, "utf8").trim().split(/\s+/)[0], 10);
      if (this.proc && childPid !== this.proc.pid) return;
      rmSync(this.spec.pidFile, { force: true });
    } catch { /* missing or unreadable: nothing to remove */ }
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    log.info(`sidecar ${this.spec.name}: restarting in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.restartCount++;
      this.spawnOnce();
    }, delay);
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive but someone else's — not ours to touch, and not ours anyway.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

const canonical = (p: string): string => {
  try { return realpathSync(p); } catch { return p; }
};

/**
 * Whether `pid` runs `command` as its executable. /proc on Linux; `ps`
 * elsewhere. A pid we cannot inspect never matches, so a recycled pid is
 * never killed. `matchScriptArgv` also accepts the path as argv[1] (a shell
 * script run by its interpreter): a test seam for fake binaries, never set in
 * production, where `gdb <binary>` at a recycled pid would otherwise match.
 */
function runsCommand(pid: number, command: string, matchScriptArgv = false): boolean {
  const want = canonical(command);
  if (existsSync(`/proc/${pid}`)) {
    try {
      if (canonical(readlinkSync(`/proc/${pid}/exe`)) === want) return true;
    } catch { /* not readable */ }
    if (!matchScriptArgv) return false;
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      return argv[1] !== undefined && argv[1] !== "" && canonical(argv[1]) === want;
    } catch {
      return false;
    }
  }
  try {
    const res = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const comm = res.stdout.toString().trim();
    return comm !== "" && canonical(comm) === want;
  } catch {
    return false;
  }
}

/**
 * A kernel killed with SIGKILL (Force Quit, the OOM killer) never runs its
 * exit hooks, so its sidecars keep running: the orphan mtw-server holds the
 * port and the orphan bridge holds the WhatsApp session. Before starting a
 * sidecar, stop the one the pidfile names — only when the kernel recorded
 * next to it is gone (a second kernel on the same data dir must not kill a
 * running kernel's children), and the child is alive and still runs the
 * bundled binary. SIGTERM, up to `graceMs`, then SIGKILL.
 * Returns true when an orphan was stopped.
 */
export async function reapOrphan(
  pidFile: string,
  command: string,
  opts: { graceMs?: number; matchScriptArgv?: boolean } = {},
): Promise<boolean> {
  const graceMs = opts.graceMs ?? KILL_GRACE_MS;
  let pid: number;
  let kernelPid: number;
  try {
    const [child, kernel] = readFileSync(pidFile, "utf8").trim().split(/\s+/);
    pid = Number.parseInt(child, 10);
    kernelPid = Number.parseInt(kernel ?? "", 10);
  } catch {
    return false;
  }
  // The owning kernel still runs (alive and still this runtime, not a
  // recycled pid): those children are not orphans, and the pidfile is theirs.
  if (
    Number.isInteger(kernelPid) && kernelPid > 1 && kernelPid !== process.pid &&
    isAlive(kernelPid) && runsCommand(kernelPid, process.execPath)
  ) {
    log.warn(`sidecar: another kernel (pid ${kernelPid}) runs these sidecars — leaving them alone`);
    return false;
  }
  const drop = () => { try { rmSync(pidFile, { force: true }); } catch { /* best-effort */ } };
  if (
    !Number.isInteger(pid) || pid <= 1 || pid === process.pid || !isAlive(pid) ||
    !runsCommand(pid, command, opts.matchScriptArgv === true)
  ) {
    drop();
    return false;
  }
  log.warn(`sidecar: stopping orphan pid ${pid} left by a previous kernel`);
  try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
  const t0 = Date.now();
  while (isAlive(pid) && Date.now() - t0 < graceMs) await Bun.sleep(50);
  if (isAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    const t1 = Date.now();
    while (isAlive(pid) && Date.now() - t1 < 1_000) await Bun.sleep(20);
  }
  drop();
  return true;
}
