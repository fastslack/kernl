/**
 * What the update module needs to know about the machine it runs on, and the
 * bookkeeping that outlives the process that started an update.
 *
 * platform.ts decides; this file asks. It stats files, queries the Windows
 * registry, reads /proc, and owns the small JSON files through which a kernel
 * that exited for an update learns, on its next boot, how that update went:
 *
 *   data/update-attempt.json   written before the handoff: from, to, where
 *   data/update-result.json    written by the helper: a result code
 *   data/update-last.json      what the UI is shown afterwards
 *
 * Before this, nothing came back from a helper. The dashboard said "Kernl is
 * restarting" forever, whether the update landed, failed at a UAC prompt, or
 * left no kernel running at all.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";
import { isPathInside } from "../fs-paths.js";
import { currentVersion } from "./version.js";
import {
  DOCKER_UPDATE_HINT,
  descendantsOf,
  installKind,
  installRootFrom,
  isContainer,
  macBundleFromModuleDir,
  macUpdateBlocker,
  parentFromProcStat,
  type InstallKind,
  type PackageFormat,
} from "./platform.js";

// ── Where things are ────────────────────────────────────────────────────────

/** The directory the running kernel module lives in. */
export function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * The kernel's data directory. config.ts resolves `data/kernel.db` against the
 * working directory, which every launcher sets to the per-user data folder.
 */
export function updateDataDir(): string {
  return resolve(process.cwd(), "data");
}

/** A Windows system tool by full path — see helper.ts for why never by name. */
export function system32(exe: string): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

// ── Probes ──────────────────────────────────────────────────────────────────

/**
 * Does this directory hold a packaged Kernl? The Windows packages are flat, so
 * the path alone cannot tell; these two files are what stage-payload.sh puts
 * there and what the MSI smoke test looks for.
 */
function looksPackaged(dir: string): boolean {
  return existsSync(join(dir, "mcp-server.js")) && existsSync(join(dir, "start.bat"));
}

/** One registry value, 64-bit view. Undefined when `reg` could not run. */
async function registryValue(key: string, name: string): Promise<string | null | undefined> {
  return new Promise((ok) => {
    let out = "";
    const p = spawn(system32("reg.exe"), ["query", key, "/v", name, "/reg:64"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    p.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
    p.on("error", () => ok(undefined));
    p.on("exit", (code) => {
      if (code !== 0) return ok(null);
      const line = out.split(/\r?\n/).find((l) => l.trim().toLowerCase().startsWith(name.toLowerCase()));
      const m = line ? /REG_\w+\s+(.*)$/.exec(line.trim()) : null;
      ok(m ? m[1]!.trim() : "");
    });
  });
}

/**
 * The MSI's own marks. product.wxs writes HKLM\Software\Matware\Kernl with
 * `installed` and `InstallDir` for the whole machine; releases up to 0.3.0
 * only wrote `installed` under HKCU, for the account that ran the installer.
 */
async function windowsMsiMarks(): Promise<{ installerRegistered?: boolean; msiInstallDir?: string | null }> {
  const key = "Software\\Matware\\Kernl";
  const dir = await registryValue(`HKLM\\${key}`, "InstallDir");
  if (dir === undefined) return {}; // `reg` unavailable: fall back to the path
  if (dir) return { installerRegistered: true, msiInstallDir: dir };
  const machine = await registryValue(`HKLM\\${key}`, "installed");
  const user = await registryValue(`HKCU\\${key}`, "installed");
  return { installerRegistered: machine != null || user != null, msiInstallDir: null };
}

function inContainer(): boolean {
  if (process.platform !== "linux") return false;
  return isContainer({
    dockerenv: existsSync("/.dockerenv"),
    env: process.env,
    cgroup: readText("/proc/1/cgroup"),
  });
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Which package manager owns /opt/kernl, if either. */
export function linuxPackageFormat(): PackageFormat | null {
  if (existsSync("/var/lib/dpkg/info/kernl.list")) return "deb";
  try {
    const r = spawnSync("rpm", ["-q", "kernl"], { stdio: "ignore" });
    if (r.status === 0) return "rpm";
  } catch {
    /* no rpm */
  }
  return null;
}

// ── The install, described ──────────────────────────────────────────────────

export interface InstallInfo {
  kind: InstallKind;
  /** What an update replaces or upgrades; null when there is nothing. */
  target: string | null;
  /** False when the UI should not offer the button at all. */
  canApply: boolean;
  /** Why not, when it cannot. */
  reason?: string;
  /** What to do instead — a command or an instruction. */
  hint?: string;
}

let installCache: Promise<InstallInfo> | null = null;

/**
 * How this copy was installed and whether it can update itself — asked once
 * per process, because none of it changes while the kernel runs.
 */
export function detectInstall(): Promise<InstallInfo> {
  installCache ??= describe();
  return installCache;
}

/** Tests, and nothing else. */
export function resetInstallCache(): void {
  installCache = null;
}

async function describe(): Promise<InstallInfo> {
  const here = moduleDir();
  const marks = process.platform === "win32" ? await windowsMsiMarks() : {};
  const kind = installKind(here, process.platform, {
    packaged: looksPackaged(here),
    container: inContainer(),
    ...marks,
  });

  if (kind === "docker") {
    return {
      kind,
      target: null,
      canApply: false,
      reason: "Kernl is running in a container. The image is what gets updated, not the files inside it.",
      hint: DOCKER_UPDATE_HINT,
    };
  }
  if (kind === "unknown") {
    return {
      kind,
      target: null,
      canApply: false,
      reason: "This is not an installed copy (a source checkout or an unrecognised layout), so there is nothing to replace.",
    };
  }
  if (kind === "linux-package") {
    return { kind, target: "/opt/kernl", canApply: true };
  }

  const target = kind === "macos-app" ? macBundleFromModuleDir(here) : installRootFrom(here, kind);
  if (!target) {
    return {
      kind,
      target: null,
      canApply: false,
      reason: "Could not work out which directory an update would replace.",
    };
  }

  if (kind === "macos-app") {
    const blocker = macUpdateBlocker(target, {
      parentWritable: writable(dirname(target)),
      bundleWritable: writable(target),
    });
    if (blocker) return { kind, target, canApply: false, reason: blocker.reason, hint: blocker.useInstead };
  }

  // A swap moves the whole install aside and deletes it once the new one
  // works. A kernel started from inside that folder keeps its database there —
  // config.ts resolves data/ against the working directory — and the update
  // would delete it along with the old copy.
  if (kind !== "windows-msi" && isPathInside(target, process.cwd())) {
    return {
      kind,
      target,
      canApply: false,
      reason:
        `Kernl is keeping its data inside the folder an update replaces (${process.cwd()}), ` +
        "so updating would delete it.",
      hint:
        kind === "linux-portable"
          ? `mkdir -p ~/.local/share/kernl && mv "${join(process.cwd(), "data")}" ~/.local/share/kernl/ — then start Kernl with ${join(target, "kernl")}`
          : "Start Kernl with its launcher (start.bat or the app), which keeps data in your user folder, then update.",
    };
  }

  return { kind, target, canApply: true };
}

// ── What happened last time ─────────────────────────────────────────────────

export interface UpdateAttempt {
  from: string;
  to: string;
  kind: InstallKind;
  target: string | null;
  /** The previous copy while it is parked; removed once the new one works. */
  backup: string | null;
  /** The download; removed once the attempt is settled. */
  staging: string | null;
  startedAt: number;
}

export interface LastUpdate {
  from: string;
  to: string;
  result: "ok" | "failed" | "rolled-back";
  code?: string;
  message?: string;
  at: number;
}

const attemptFile = () => join(updateDataDir(), "update-attempt.json");
export const updateResultFile = () => join(updateDataDir(), "update-result.json");
const lastFile = () => join(updateDataDir(), "update-last.json");

function readJson<T>(path: string): T | null {
  const text = readText(path);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Written just before the handoff, so the next boot knows there was one. */
export function recordAttempt(attempt: UpdateAttempt): void {
  mkdirSync(updateDataDir(), { recursive: true });
  rmSync(updateResultFile(), { force: true });
  writeFileSync(attemptFile(), JSON.stringify(attempt, null, 2));
}

/** The helper's codes, as sentences. */
export function describeUpdateCode(code: string | undefined): string {
  switch (code) {
    case "kernel-did-not-exit":
      return "Kernl did not close within a minute, so nothing was replaced.";
    case "move-aside":
      return "The previous copy could not be moved aside — a file in it was still in use, or this account cannot write there. Nothing was replaced.";
    case "move-in":
      return "The new copy could not be moved into place, so the previous one was put back.";
    case "new-version-did-not-start":
      return "The new version did not start within five minutes, so the previous one was started instead. If the new version had already upgraded the database, the previous one may not open it — install the new version by hand from the releases page.";
    case "rollback-failed":
      return "The new version did not start, and the previous copy could not be put back. Reinstall Kernl from the releases page; your data is untouched.";
    case "uac-declined":
      return "The Windows administrator prompt was declined, so the installer did not run.";
    case "no-result":
      return "The update never reported back, and Kernl is still on the previous version.";
    default:
      if (code?.startsWith("msiexec-")) {
        return `The Windows installer failed (exit code ${code.slice("msiexec-".length)}). Kernl was started again on the previous version.`;
      }
      return code ? `The update failed (${code}).` : "The update failed.";
  }
}

/** An attempt this old with no answer is not in progress any more. */
const SETTLE_AFTER_MS = 20 * 60 * 1000;

/**
 * Settle a previous attempt, if there was one: decide how it went, clean up
 * what it left behind, and remember the outcome for the UI.
 *
 * The new kernel running is the proof that matters — it is only here to call
 * this because it booted — so a matching version is success whatever the
 * helper managed to write. That is also when the parked previous copy is
 * finally removed: the helper keeps it until the new version has answered.
 *
 * Synchronous and cheap, so the status route can call it on every request.
 */
export function finalizeUpdateOnBoot(): LastUpdate | null {
  const attempt = readJson<UpdateAttempt>(attemptFile());
  if (!attempt) return readJson<LastUpdate>(lastFile());

  const result = readJson<{ result?: string; code?: string }>(updateResultFile());
  const running = currentVersion();
  let last: LastUpdate;

  if (running && running === attempt.to) {
    last = { from: attempt.from, to: attempt.to, result: "ok", at: Date.now() };
  } else if (result?.result === "failed" || result?.result === "rolled-back") {
    last = {
      from: attempt.from,
      to: attempt.to,
      result: result.result,
      code: result.code,
      message: describeUpdateCode(result.code),
      at: Date.now(),
    };
  } else if (Date.now() - attempt.startedAt > SETTLE_AFTER_MS) {
    last = {
      from: attempt.from,
      to: attempt.to,
      result: "failed",
      code: result?.code ?? "no-result",
      message: describeUpdateCode(result?.code ?? "no-result"),
      at: Date.now(),
    };
  } else {
    // Still going — an MSI can sit at its UAC prompt for as long as the user
    // leaves it. Ask again on the next request.
    return readJson<LastUpdate>(lastFile());
  }

  const remove = (p: string | null) => {
    if (!p) return;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch (err) {
      log.warn(`update: could not remove ${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  remove(attempt.staging);
  if (last.result === "ok") remove(attempt.backup);
  if (last.result === "rolled-back" && attempt.target) remove(`${attempt.target}.failed`);

  try {
    writeFileSync(lastFile(), JSON.stringify(last, null, 2));
    rmSync(attemptFile(), { force: true });
    rmSync(updateResultFile(), { force: true });
  } catch {
    /* read-only data dir: the UI just will not hear about it */
  }
  if (last.result === "ok") log.info(`Update to ${last.to} completed.`);
  else log.warn(`Update to ${last.to} did not complete: ${last.message}`);
  return last;
}

// ── Leaving for an update ───────────────────────────────────────────────────

export type ExitPlan =
  | { kind: "exit"; helperPid?: number }
  | { kind: "systemd-user"; unit: string }
  | { kind: "systemd-system"; unit: string };

let exitPlan: ExitPlan | null = null;

/** apply.ts says how this process should go once the 202 has been sent. */
export function setUpdateExitPlan(plan: ExitPlan): void {
  exitPlan = plan;
}

async function childPairs(): Promise<{ pid: number; ppid: number }[]> {
  if (process.platform === "linux") {
    const pairs: { pid: number; ppid: number }[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const ppid = parentFromProcStat(readText(`/proc/${name}/stat`));
      if (ppid != null) pairs.push({ pid: Number(name), ppid });
    }
    return pairs;
  }
  const [file, args] = process.platform === "win32"
    ? [
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
      ]
    : ["ps", ["-A", "-o", "pid=,ppid="]];
  const r = spawnSync(file, args, { encoding: "utf-8", windowsHide: true, timeout: 10_000 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((f) => f.length === 2 && f.every(Number.isInteger))
    .map(([pid, ppid]) => ({ pid: pid!, ppid: ppid! }));
}

/**
 * Stop every process this kernel started, except the update helper.
 *
 * whisper-cli, ffmpeg and bun children keep files in the install directory
 * open. On Windows an open file is a locked file, and the helper's `move` of
 * the install failed for as long as any of them lived.
 */
export async function stopChildProcesses(exclude: number[] = []): Promise<void> {
  let pids: number[];
  try {
    pids = descendantsOf(process.pid, await childPairs(), exclude);
  } catch {
    return;
  }
  if (pids.length === 0) return;
  log.info(`update: stopping ${pids.length} child process(es) before exit`);
  if (process.platform === "win32") {
    for (const pid of pids) {
      spawnSync(system32("taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    }
    return;
  }
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  await new Promise((r) => setTimeout(r, 2000));
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

/**
 * Leave, the way this update needs.
 *
 * Replaces a bare `process.exit(0)`, which skipped the kernel's own shutdown —
 * sqlite, the HTTP server and every module left open — and left child
 * processes holding the install. The shutdown handlers are reached by emitting
 * the signal in-process, which works on Windows too, where no real SIGTERM is
 * ever delivered.
 */
export async function exitForUpdate(): Promise<void> {
  const plan = exitPlan ?? { kind: "exit" as const };
  await stopChildProcesses(plan.kind === "exit" && plan.helperPid ? [plan.helperPid] : []).catch(() => {});

  if (plan.kind === "systemd-user") {
    // systemd stops this process through its SIGTERM and starts the unit
    // again, now from the upgraded package.
    spawn("systemctl", ["--user", "--no-block", "restart", plan.unit], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => process.exit(0), 30_000).unref();
    return;
  }
  if (plan.kind === "systemd-system") {
    // A system unit cannot be restarted by this user. A non-zero exit is what
    // `Restart=on-failure` restarts on, and the files are already new.
    process.exit(75);
  }

  if (process.listenerCount("SIGTERM") > 0) {
    setTimeout(() => process.exit(0), 15_000).unref();
    (process.emit as (event: string) => boolean)("SIGTERM");
    return;
  }
  process.exit(0);
}
