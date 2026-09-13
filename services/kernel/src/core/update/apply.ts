/**
 * Apply an update from inside the running app — the button behind the notice.
 *
 * A desktop app that makes you open a terminal to update is a desktop app with
 * a missing feature. The earlier objection here was to updating *silently*,
 * which is a different thing: migrations run at boot and only go forward, so
 * the user has to choose. A button is the user choosing. Nothing on this path
 * runs without one.
 *
 * ── Why a helper script ────────────────────────────────────────────────────
 * The kernel lives inside the directory it has to replace. It cannot delete
 * its own install and survive, so the sequence is:
 *
 *   1. download and verify into a staging dir        (this process)
 *   2. write a helper that waits for our PID to die  (this process)
 *   3. spawn the helper detached, then exit          (this process)
 *   4. swap the install, relaunch, wait for health   (helper, we are gone)
 *   5. settle the attempt and clean up               (the next kernel)
 *
 * The helper keeps the previous copy until the new one answers, and puts it
 * back if it does not. Every way out of the helper starts Kernl again.
 *
 * ── The asset name comes from the release, not from here ───────────────────
 * It used to be built by hand, and the hand-built name drifted from the one
 * that was actually published: `Kernl-0.3.0-windows-x64.zip` against a
 * published `kernl-0.3.0-windows-x64.zip`. Asking the release API which assets
 * exist removes the whole class: the name we verify and the name we fetch are
 * the ones on the release.
 *
 * ── Three kinds of install, three ways to update ───────────────────────────
 * A directory nobody else owns (portable Windows, portable Linux, a macOS
 * bundle) is swapped. An MSI install is handed back to msiexec, which owns its
 * registry entry, its uninstaller and its elevation. A dpkg or rpm install is
 * upgraded by its package manager through the desktop's administrator prompt —
 * replacing files under /opt by hand would leave a package database that
 * disagrees with the disk.
 *
 * ── Untested on the platforms it matters most ──────────────────────────────
 * Written and exercised on Linux. The Windows and macOS helpers are generated
 * as text and tested as text (see tests/update-helper.test.ts); neither has run
 * on those systems, and neither has the pkexec path on a desktop session.
 */

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { log } from "../logger.js";
import { findOnPath } from "../fs-paths.js";
import { checkForUpdate, githubHeaders, REQUEST_TIMEOUT_MS } from "./check.js";
import {
  assetSpecFor,
  packageAssetSpec,
  packageInstallPlan,
  relaunchCommandFor,
  restartMethodFor,
  stagingParentFor,
  usesInstaller,
  type AssetSpec,
  type InstallKind,
} from "./platform.js";
import { helperFor, helperFilename } from "./helper.js";
import {
  detectInstall,
  linuxPackageFormat,
  recordAttempt,
  setUpdateExitPlan,
  system32,
  updateDataDir,
  updateResultFile,
  type InstallInfo,
} from "./install.js";

export { exitForUpdate, finalizeUpdateOnBoot } from "./install.js";

export type ApplyOutcome =
  | { ok: true; restarting: true }
  | { ok: false; reason: string; useInstead?: string };

const REPO = process.env.KERNEL_UPDATE_REPO ?? "fastslack/kernl";
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const INSTALL_SH = "curl -fsSL https://raw.githubusercontent.com/fastslack/kernl/stable/install.sh | sh";

/**
 * A download that stops producing bytes for this long is dead.
 *
 * Not a total timeout: three hundred megabytes over a slow line is legitimately
 * slow, and killing that would be the bug. What must not happen is the phase
 * sitting at "downloading" forever with nothing arriving and no way to cancel,
 * which is what having no timeout at all produced.
 */
const STALL_MS = 60_000;

function isWindowsKind(kind: InstallKind): boolean {
  return kind === "windows-dir" || kind === "windows-msi";
}

/** What the helper polls once the new kernel has been started. */
export function healthUrl(): string {
  return `http://127.0.0.1:${process.env.DASHBOARD_PORT ?? "3086"}/api/health`;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * What `codesign` says about the bundle about to replace this one.
 *
 * Checked on the STAGED copy, because that is the code about to run. This used
 * to check the bundle already installed — which says nothing about the new one
 * — and then refused every update, because releases are not signed yet: an app
 * that could never update itself. An unsigned download is installed with its
 * quarantine attribute removed; one whose signature is present but broken is
 * the case worth refusing.
 */
async function codesignState(bundle: string): Promise<"valid" | "unsigned" | "invalid" | "unavailable"> {
  return new Promise((ok) => {
    let err = "";
    const p = spawn("codesign", ["--verify", "--deep", "--strict", bundle], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    p.stderr?.on("data", (b: Buffer) => { err += b.toString(); });
    p.on("error", () => ok("unavailable"));
    p.on("exit", (code) =>
      ok(code === 0 ? "valid" : /not signed at all/i.test(err) ? "unsigned" : "invalid"),
    );
  });
}

/**
 * Where the current attempt is up to.
 *
 * Kept in the module rather than returned, because the caller cannot wait for
 * the answer: applying an update ends with this process exiting, so the HTTP
 * route starts the work and returns immediately and the browser polls here.
 */
export type UpdatePhase =
  | "idle" | "checking" | "downloading" | "verifying" | "unpacking" | "installing"
  | "handoff" | "failed" | "done";

export interface UpdateProgress {
  phase: UpdatePhase;
  /** Bytes written so far. */
  received: number;
  /** Total bytes, or 0 when the server sends no content-length. */
  total: number;
  version?: string;
  reason?: string;
}

let progress: UpdateProgress = { phase: "idle", received: 0, total: 0 };

export function updateProgress(): UpdateProgress {
  return { ...progress };
}

function phase(next: Partial<UpdateProgress>): void {
  progress = { ...progress, ...next };
}

/** Record the refusal on the way out, so the poller sees why it stopped. */
function refuse(reason: string, useInstead?: string): ApplyOutcome {
  phase({ phase: "failed", reason });
  return { ok: false, reason, ...(useInstead ? { useInstead } : {}) };
}

/**
 * Extract an archive. `tar` reads zip as well as tar.gz on every target — as
 * long as it is the right tar. On Windows that is System32's bsdtar, by full
 * path: Git for Windows puts GNU tar on PATH, which cannot read a zip and takes
 * `C:\…` for a remote `host:path`.
 */
async function extract(archive: string, into: string): Promise<void> {
  const tar = process.platform === "win32" ? system32("tar.exe") : "tar";
  await new Promise<void>((ok, bad) => {
    const p = spawn(tar, ["-xf", archive, "-C", into], { stdio: "ignore", windowsHide: true });
    p.on("error", bad);
    p.on("exit", (c) => (c === 0 ? ok() : bad(new Error(`tar exited ${c}`))));
  });
}

/**
 * What came out of the archive.
 *
 * Read with `readdir` rather than shelling out to `find`, which does not exist
 * on Windows.
 */
async function stagedFrom(dir: string, macApp: boolean): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (macApp) {
    const app = dirs.find((e) => e.name.endsWith(".app"));
    return app ? join(dir, app.name) : null;
  }
  // A release archive holds exactly one top-level directory. Anything else is
  // an archive we do not understand.
  return dirs.length === 1 && dirs[0] ? join(dir, dirs[0].name) : null;
}

/**
 * A staging directory on the same volume as the install, falling back to the
 * system temp dir when that is not writable (Program Files, a read-only
 * mount). See `stagingParentFor` for why the volume matters.
 */
async function makeStagingDir(target: string, kind: InstallKind): Promise<string> {
  const parent = stagingParentFor(target, kind);
  if (parent) {
    try {
      return await mkdtemp(join(parent, ".kernl-update-"));
    } catch {
      /* not writable — the temp dir will do, and the helper will say if not */
    }
  }
  return await mkdtemp(join(tmpdir(), "kernl-update-"));
}

/** The asset this machine needs, as the release actually published it. */
async function resolveAsset(
  version: string,
  spec: AssetSpec,
): Promise<{ name: string; url: string } | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    assets?: { name?: string; browser_download_url?: string }[];
  };
  for (const a of body.assets ?? []) {
    if (a.name && a.browser_download_url && spec.pattern.test(a.name)) {
      return { name: a.name, url: a.browser_download_url };
    }
  }
  return null;
}

/**
 * The published checksum for `name`, or null when the release does not list it.
 * Compared case-insensitively on the name; the digest is compared exactly.
 */
async function publishedChecksum(version: string, name: string): Promise<string | null> {
  const res = await fetch(
    `https://github.com/${REPO}/releases/download/v${version}/SHA256SUMS`,
    { headers: githubHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!res.ok) return null;
  const wanted = name.toLowerCase();
  for (const line of (await res.text()).split("\n")) {
    const [digest, file] = line.trim().split(/\s+/);
    if (!digest || !file) continue;
    if (file.replace(/^\*/, "").toLowerCase() === wanted) return digest;
  }
  return null;
}

/** Stream `url` to `dest`, counting bytes so the browser has something to draw. */
async function download(url: string, dest: string): Promise<string | null> {
  const ac = new AbortController();
  let stall = setTimeout(() => ac.abort(), STALL_MS);
  try {
    const res = await fetch(url, { headers: githubHeaders(), signal: ac.signal });
    if (!res.ok || !res.body) return `HTTP ${res.status}`;
    phase({ total: Number(res.headers.get("content-length") ?? 0) });

    const out = createWriteStream(dest);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      // Bytes arrived, so the clock starts again.
      clearTimeout(stall);
      stall = setTimeout(() => ac.abort(), STALL_MS);
      received += value.byteLength;
      phase({ received });
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((ok) => out.once("drain", ok));
      }
    }
    await new Promise<void>((ok) => out.end(ok));
    return null;
  } catch (err) {
    if (ac.signal.aborted) return `stalled for ${STALL_MS / 1000}s with nothing received`;
    return err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(stall);
  }
}

/** The digest of a file, read in chunks rather than held in memory. */
async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Verify a download against SHA256SUMS. Null when it matches, a refusal when not.
 *
 * This catches a corrupted or truncated download, a stale CDN object and a
 * proxy that rewrote the bytes. It does NOT protect against a compromised
 * release: SHA256SUMS is published by the same release as the archive, so
 * whoever can replace one can replace the other. That needs a signature made
 * with a key the release process keeps, and there is none yet.
 */
async function verify(version: string, name: string, file: string): Promise<ApplyOutcome | null> {
  phase({ phase: "verifying" });
  const expected = await publishedChecksum(version, name);
  if (!expected) {
    return refuse(
      `This release publishes no checksum for ${name}, so the download cannot be verified.`,
      RELEASES_URL,
    );
  }
  if ((await sha256(file)) !== expected) {
    return refuse("The download did not match its published checksum, so it was discarded.");
  }
  return null;
}

/**
 * True while an attempt is running.
 *
 * Two clicks used to mean two downloads, two helpers and two exit timers,
 * racing to move the same directory. The button also stays disabled in the
 * UI, but a second tab, a retry after a timeout, or a POST by hand all reach
 * this the same way.
 */
let applying = false;

export async function applyUpdate(): Promise<ApplyOutcome> {
  if (applying) {
    return {
      ok: false,
      reason: "An update is already in progress — watch the progress below.",
    };
  }
  applying = true;
  let handedOff = false;
  try {
    return await runApply(() => {
      handedOff = true;
    });
  } finally {
    // Keep the door shut when the helper has taken over: this process is
    // seconds from exiting and must not start anything else.
    if (!handedOff) applying = false;
  }
}

async function runApply(markHandedOff: () => void): Promise<ApplyOutcome> {
  phase({ phase: "checking", received: 0, total: 0, reason: undefined });

  const install = await detectInstall();
  if (!install.canApply || !install.target) {
    return refuse(install.reason ?? "This copy of Kernl cannot update itself.", install.hint);
  }
  const { kind, target } = install;

  const status = await checkForUpdate();
  if (!status.updateAvailable || !status.latest) {
    return refuse("Already on the newest release.");
  }

  if (kind === "linux-package") {
    return applyPackage(status.current, status.latest, install, markHandedOff);
  }

  const spec = assetSpecFor(status.latest, kind, process.arch);
  if (!spec) {
    return refuse(`The release publishes no build for ${process.platform}/${process.arch}.`, RELEASES_URL);
  }

  const asset = await resolveAsset(status.latest, spec);
  if (!asset) {
    return refuse(
      `Release v${status.latest} publishes no ${spec.expected}, so there is nothing to install on this platform.`,
      RELEASES_URL,
    );
  }

  // From here on there is a directory on disk, and every exit that is not the
  // handoff has to take it with it.
  let dir: string | null = null;
  let handedOff = false;
  try {
    dir = await makeStagingDir(target, kind);
    const archive = join(dir, asset.name);

    phase({ phase: "downloading", version: status.latest, received: 0 });
    const failed = await download(asset.url, archive);
    if (failed) return refuse(`Could not download ${asset.name} (${failed}).`);

    const bad = await verify(status.latest, asset.name, archive);
    if (bad) return bad;

    // An installer is not unpacked: msiexec takes the .msi as it was published.
    let staged = archive;
    if (!usesInstaller(kind)) {
      phase({ phase: "unpacking" });
      await extract(archive, dir);
      const found = await stagedFrom(dir, kind === "macos-app");
      if (!found) return refuse("The downloaded archive did not contain what was expected.");
      staged = found;
    }

    if (kind === "macos-app") {
      const signature = await codesignState(staged);
      if (signature === "invalid") {
        return refuse(
          "The downloaded app's code signature is broken, so it was discarded rather than installed.",
          RELEASES_URL,
        );
      }
      if (signature !== "valid") {
        log.warn(`update: ${asset.name} is not signed (${signature}); installing it with its quarantine attribute removed.`);
      }
    }

    phase({ phase: "handoff" });
    const backup = `${target}.previous`;
    const windows = isWindowsKind(kind);
    const script = join(dir, helperFilename(kind));
    await writeFile(
      script,
      helperFor(kind, {
        pid: process.pid,
        staged,
        target,
        backup,
        relaunch: relaunchCommandFor(target, kind, {
          launcher: kind === "linux-portable" && existsSync(join(staged, "kernl")),
        }) ?? [],
        ...(usesInstaller(kind) ? { installer: archive } : {}),
        resultFile: updateResultFile(),
        version: status.latest,
        healthUrl: healthUrl(),
        // POSIX can remove the directory its own script runs from; cmd.exe
        // cannot, so on Windows the next boot removes it.
        ...(windows ? {} : { stagingDir: dir }),
      }),
    );
    if (!windows) await chmod(script, 0o755);

    recordAttempt({
      from: status.current,
      to: status.latest,
      kind,
      target,
      backup: usesInstaller(kind) ? null : backup,
      staging: dir,
      startedAt: Date.now(),
    });

    // Detached and fully severed: it has to outlive us.
    const runner = windows
      ? spawn(process.env.ComSpec ?? system32("cmd.exe"), ["/d", "/c", script], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        })
      : spawn("/bin/sh", [script], { detached: true, stdio: "ignore" });
    runner.unref();
    setUpdateExitPlan({ kind: "exit", helperPid: runner.pid });

    handedOff = true;
    markHandedOff();
    phase({ phase: "done" });
    log.info(`Update to ${status.latest} staged; handing off and exiting.`);
    return { ok: true, restarting: true };
  } catch (err) {
    return refuse(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // The handoff owns the directory from the moment the helper is spawned.
    if (dir && !handedOff) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Run a command to completion, keeping the tail of stderr for the message. */
async function runCommand(argv: string[]): Promise<{ code: number; tail: string }> {
  return new Promise((ok) => {
    let err = "";
    const p = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
    p.stderr?.on("data", (b: Buffer) => { err = (err + b.toString()).slice(-2000); });
    p.on("error", (e) => ok({ code: 127, tail: e.message }));
    p.on("exit", (code) =>
      ok({ code: code ?? 1, tail: err.trim().split("\n").slice(-2).join(" ").slice(0, 300) }),
    );
  });
}

/**
 * Upgrade a dpkg or rpm install from inside the app.
 *
 * The package manager does the replacing — anything else leaves a package
 * database that disagrees with the disk — and pkexec, the desktop's
 * administrator prompt, is how the app asks for the rights it needs. Linux
 * keeps running the old process from replaced files, so the install happens
 * with the kernel still up and able to report a refusal. The restart comes
 * afterwards: by systemd when it runs the kernel, by a helper otherwise.
 */
async function applyPackage(
  from: string,
  to: string,
  install: InstallInfo,
  markHandedOff: () => void,
): Promise<ApplyOutcome> {
  const format = linuxPackageFormat();
  if (!format) {
    return refuse(
      "Kernl is installed under /opt/kernl, but neither dpkg nor rpm lists it, so there is no package to upgrade.",
      INSTALL_SH,
    );
  }
  const spec = packageAssetSpec(to, format, process.arch);
  if (!spec) return refuse(`The release publishes no .${format} for ${process.arch}.`, RELEASES_URL);
  const asset = await resolveAsset(to, spec);
  if (!asset) return refuse(`Release v${to} publishes no ${spec.expected}.`, RELEASES_URL);

  // Kept under the data directory rather than a temp dir: when the install
  // cannot run from here, the fallback is a command naming this file.
  const dir = join(updateDataDir(), "updates", to);
  await mkdir(dir, { recursive: true });
  const file = join(dir, asset.name);

  phase({ phase: "downloading", version: to, received: 0 });
  const failed = await download(asset.url, file);
  if (failed) return refuse(`Could not download ${asset.name} (${failed}).`);
  const bad = await verify(to, asset.name, file);
  if (bad) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return bad;
  }

  const plan = packageInstallPlan(format, file, {
    isRoot: process.getuid?.() === 0,
    find: (tool) => findOnPath(tool),
  });
  if (!plan.argv) {
    return refuse(
      "Installing a system package needs administrator rights, and this machine has no graphical " +
        "password prompt (pkexec). The package is downloaded and verified — install it with:",
      plan.manual,
    );
  }

  phase({ phase: "installing" });
  const run = await runCommand(plan.argv);
  if (run.code === 126 || run.code === 127) {
    return refuse(
      "The administrator password prompt was dismissed or could not be shown, so nothing was " +
        "installed. The package is downloaded and verified — install it with:",
      plan.manual,
    );
  }
  if (run.code !== 0) {
    return refuse(
      `The package manager failed (exit ${run.code})${run.tail ? `: ${run.tail}` : ""}.`,
      plan.manual,
    );
  }

  // Installed. What is still running is the previous version.
  recordAttempt({
    from,
    to,
    kind: install.kind,
    target: install.target,
    backup: null,
    staging: dir,
    startedAt: Date.now(),
  });
  const method = restartMethodFor(process.env, readText("/proc/self/cgroup"));
  if (method.kind === "relaunch") {
    const script = join(dir, helperFilename("linux-package"));
    await writeFile(
      script,
      helperFor("linux-package", {
        pid: process.pid,
        staged: file,
        target: install.target ?? "/opt/kernl",
        backup: "",
        relaunch: ["/usr/bin/kernl"],
        resultFile: updateResultFile(),
        version: to,
        healthUrl: healthUrl(),
        stagingDir: dir,
      }),
    );
    await chmod(script, 0o755);
    const runner = spawn("/bin/sh", [script], { detached: true, stdio: "ignore" });
    runner.unref();
    setUpdateExitPlan({ kind: "exit", helperPid: runner.pid });
  } else {
    setUpdateExitPlan(method);
  }

  markHandedOff();
  phase({ phase: "done" });
  log.info(`Kernl ${to} installed by ${format}; restarting.`);
  return { ok: true, restarting: true };
}
