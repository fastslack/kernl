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
 *   4. swap the install, relaunch                    (helper, we are gone)
 *
 * The helper keeps the previous copy until the new one is in place. A failed
 * swap that leaves no way back is worse than not updating at all.
 *
 * ── The asset name comes from the release, not from here ───────────────────
 * It used to be built by hand, and the hand-built name drifted from the one
 * that was actually published: `Kernl-0.3.0-windows-x64.zip` against a
 * published `kernl-0.3.0-windows-x64.zip`. GitHub's download endpoint resolves
 * names case-insensitively, so the DOWNLOAD survived — and then the checksum
 * lookup, an exact string comparison against SHA256SUMS, did not. The update
 * failed after transferring three hundred megabytes. Asking the release API
 * which assets exist removes the whole class: the name we verify and the name
 * we fetch are the ones on the release.
 *
 * ── Windows has two answers ────────────────────────────────────────────────
 * An unzipped directory is swapped. An MSI install is handed back to msiexec,
 * because the MSI owns its registry entry, its uninstaller and its elevation —
 * swapping the directory under it leaves Add/Remove Programs advertising a
 * version that is no longer on disk. Which one this is comes from the
 * installer's own registry mark, not from guessing at the path.
 *
 * ── What this does NOT do ──────────────────────────────────────────────────
 * Packaged Linux is left to dpkg/rpm. Replacing files under /opt that a
 * package manager believes it owns produces a system where the next
 * `apt upgrade` fights this one. The UI points those users at their package
 * manager instead, which is the same reason install.sh shells out rather than
 * unpacking by hand.
 *
 * ── Untested on the platforms it matters most ──────────────────────────────
 * Written and exercised on Linux. The macOS path is gated on the bundle being
 * signed, which today's releases are not, so it refuses rather than producing
 * an app Gatekeeper will not open. The Windows paths are generated as text and
 * tested as text (see tests/update-helper.test.ts); neither has run on
 * Windows.
 */

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { log } from "../logger.js";
import { checkForUpdate, githubHeaders, REQUEST_TIMEOUT_MS } from "./check.js";
import {
  assetSpecFor,
  installKind,
  installRootFrom,
  isSwappable,
  relaunchCommandFor,
  stagingParentFor,
  usesInstaller,
  type AssetSpec,
  type InstallKind,
} from "./platform.js";
import { helperFor, helperFilename } from "./helper.js";

export type ApplyOutcome =
  | { ok: true; restarting: true }
  | { ok: false; reason: string; useInstead?: string };

const REPO = process.env.KERNEL_UPDATE_REPO ?? "fastslack/kernl";

/**
 * A download that stops producing bytes for this long is dead.
 *
 * Not a total timeout: three hundred megabytes over a slow line is legitimately
 * slow, and killing that would be the bug. What must not happen is the phase
 * sitting at "downloading" forever with nothing arriving and no way to cancel,
 * which is what having no timeout at all produced.
 */
const STALL_MS = 60_000;

/**
 * Where this .app lives, derived from the running module rather than assumed.
 * `Contents/Resources/mcp-server.js` → three levels up is `Kernl.app`.
 * Returns null when the layout does not match, which is every non-.app run —
 * dev, Docker, deb — and the caller refuses rather than guessing.
 */
export function macAppBundlePath(): string | null {
  if (process.platform !== "darwin") return null;
  const here = dirname(fileURLToPath(import.meta.url));
  // Packaged, the bundled server sits directly in Resources/.
  const candidate = resolve(here, "..", "..");
  return candidate.endsWith(".app/Contents") ? dirname(candidate) : null;
}

/**
 * Does this directory hold a packaged Kernl?
 *
 * The Windows packages are flat — `build-zip.sh` and `build-msi.sh` both copy
 * `bin/mcp-server.js` to the package root — so there is no `bin/` to recognise
 * and the path alone cannot tell an install from any other directory. These
 * two files are what stage-payload.sh puts there and what the MSI's own smoke
 * test looks for after installing.
 */
function looksPackaged(dir: string): boolean {
  return existsSync(join(dir, "mcp-server.js")) && existsSync(join(dir, "start.bat"));
}

/**
 * Did an MSI put this install here?
 *
 * `product.wxs` writes HKCU\Software\Matware\Kernl\installed as the shortcut
 * component's KeyPath, so the value exists for an installed copy and not for
 * an unzipped one. Undefined when the question could not be asked at all —
 * `reg` missing, a policy that blocks it — which the caller treats as "fall
 * back to the path", not as "no".
 */
async function msiRegistered(): Promise<boolean | undefined> {
  if (process.platform !== "win32") return undefined;
  return new Promise((ok) => {
    const p = spawn("reg", ["query", "HKCU\\Software\\Matware\\Kernl", "/v", "installed"], {
      stdio: "ignore",
      windowsHide: true,
    });
    p.on("error", () => ok(undefined));
    p.on("exit", (code) => ok(code === 0));
  });
}

/**
 * Would macOS open this bundle? `codesign --verify` answers for the signature;
 * it does not prove notarization, which is the other half. Good enough as a
 * gate: an unsigned bundle is certainly refused, so refusing to update is
 * right. A signed-but-unnotarized one may still be blocked, which is why the
 * failure message points at a manual download rather than promising success.
 */
async function isSignedBundle(bundle: string): Promise<boolean> {
  return new Promise((ok) => {
    const p = spawn("codesign", ["--verify", "--deep", "--strict", bundle], {
      stdio: "ignore",
    });
    p.on("error", () => ok(false));
    p.on("exit", (code) => ok(code === 0));
  });
}

/**
 * Where the current attempt is up to.
 *
 * Kept in the module rather than returned, because the caller cannot wait for
 * the answer: applying an update ends with this process exiting, so the HTTP
 * route starts the work and returns immediately and the browser polls here.
 * Without it the button had nothing to say for the length of a multi-megabyte
 * download — the same silence that made the extension update look broken.
 */
export type UpdatePhase =
  | "idle" | "checking" | "downloading" | "verifying" | "unpacking" | "handoff"
  | "failed" | "done";

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

/** Extract an archive. `tar` reads zip as well as tar.gz on every target. */
async function extract(archive: string, into: string): Promise<void> {
  await new Promise<void>((ok, bad) => {
    const p = spawn("tar", ["-xf", archive, "-C", into], { stdio: "ignore" });
    p.on("error", bad);
    p.on("exit", (c) => (c === 0 ? ok() : bad(new Error(`tar exited ${c}`))));
  });
}

/**
 * What came out of the archive.
 *
 * Read with `readdir` rather than shelling out to `find`, which does not exist
 * on Windows — the kind of detail that turns "cross-platform" into a function
 * that only ever ran on one.
 */
async function stagedFrom(dir: string, macApp: boolean): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (macApp) {
    const app = dirs.find((e) => e.name.endsWith(".app"));
    return app ? join(dir, app.name) : null;
  }
  // A release archive holds exactly one top-level directory. Anything else is
  // an archive we do not understand, and guessing which entry to move into an
  // install location is not a guess worth making.
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

/**
 * The asset this machine needs, as the release actually published it.
 *
 * Returns the real name and the real download URL, so the checksum lookup and
 * the fetch agree with each other and with the release by construction.
 */
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
 *
 * Compared case-insensitively. The names in SHA256SUMS come from whatever the
 * packagers produced, and one spelling of "kernl" is not more correct than the
 * other — refusing an update over a capital letter is not integrity, it is a
 * bug wearing integrity's clothes. The digest is still compared exactly, which
 * is the part that is actually load-bearing.
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

/**
 * The digest of a file, read in chunks.
 *
 * `readFile` then hash was a 311 MB spike for the Windows zip — a whole
 * release archive held in memory for no reason, on top of the copy already on
 * disk. On a small machine that is the difference between an update and an
 * OOM.
 */
async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * True while an attempt is running.
 *
 * Two clicks used to mean two downloads, two helpers and two exit timers,
 * racing to move the same directory — and the second helper would find the
 * install already gone. The button also stays disabled in the UI, but that is
 * the browser's opinion; a second tab, a retry after a timeout, or a POST by
 * hand all reach this the same way.
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
    const outcome = await runApply(() => {
      handedOff = true;
    });
    return outcome;
  } finally {
    // Keep the door shut when the helper has taken over: this process is
    // seconds from exiting and must not start anything else.
    if (!handedOff) applying = false;
  }
}

async function runApply(markHandedOff: () => void): Promise<ApplyOutcome> {
  const here = dirname(fileURLToPath(import.meta.url));
  const kind: InstallKind = installKind(here, process.platform, {
    packaged: looksPackaged(here),
    installerRegistered: await msiRegistered(),
  });
  phase({ phase: "checking", received: 0, total: 0, reason: undefined });

  if (kind === "linux-package") {
    return refuse(
      "On Linux your package manager owns the install.",
      "sudo apt upgrade kernl   (or dnf upgrade kernl)",
    );
  }
  if (!isSwappable(kind) && !usesInstaller(kind)) {
    return refuse("This does not look like an installed copy, so there is nothing to replace.");
  }

  const target = kind === "macos-app" ? macAppBundlePath() : installRootFrom(here, kind);
  if (!target) {
    return refuse("Could not work out which directory to replace, so nothing was touched.");
  }

  // Refuse when this build is not signed, rather than half-doing it.
  //
  // The swap itself would succeed; the relaunch is what fails. Gatekeeper will
  // not open a replacement bundle whose developer it cannot verify, so the
  // user ends up with the app closed, a new one that will not start, and a
  // backup this code already deleted. Stripping the quarantine xattr — which
  // the helper does — is not the same as being trusted.
  if (kind === "macos-app" && !(await isSignedBundle(target))) {
    return refuse(
      "This build is not signed by Apple, so macOS would refuse to open the " +
        "updated app. Download the new version manually instead.",
      `https://github.com/${REPO}/releases/latest`,
    );
  }

  const status = await checkForUpdate();
  if (!status.updateAvailable || !status.latest) {
    return refuse("Already on the newest release.");
  }

  const spec = assetSpecFor(status.latest, kind, process.arch);
  if (!spec) {
    return refuse(
      `The release publishes no build for ${process.platform}/${process.arch}.`,
      `https://github.com/${REPO}/releases/latest`,
    );
  }

  const asset = await resolveAsset(status.latest, spec);
  if (!asset) {
    return refuse(
      `Release v${status.latest} publishes no ${spec.expected}, so there is ` +
        `nothing to install on this platform.`,
      `https://github.com/${REPO}/releases/latest`,
    );
  }

  // From here on there is a directory on disk, and every exit that is not the
  // handoff has to take it with it: a failed attempt used to leave the whole
  // archive — up to three hundred megabytes — sitting in the temp dir, once
  // per click, with nothing that would ever clean it up.
  let dir: string | null = null;
  let handedOff = false;
  try {
    dir = await makeStagingDir(target, kind);
    const archive = join(dir, asset.name);

    phase({ phase: "downloading", version: status.latest, received: 0 });
    const failed = await download(asset.url, archive);
    if (failed) return refuse(`Could not download ${asset.name} (${failed}).`);

    // Verify before unpacking or installing anything.
    //
    // This replaces the running application, so trusting an HTTPS fetch on its
    // own is the wrong shape: the user consented to "update", not to "install
    // whatever this connection returns". A compromised release, a stale CDN
    // object, or an intercepting proxy all look identical to a good download
    // without this.
    phase({ phase: "verifying" });
    const expected = await publishedChecksum(status.latest, asset.name);
    if (!expected) {
      return refuse(
        `This release publishes no checksum for ${asset.name}, so the ` +
          `download cannot be verified.`,
        `https://github.com/${REPO}/releases/latest`,
      );
    }
    if ((await sha256(archive)) !== expected) {
      return refuse("The download did not match its published checksum, so it was discarded.");
    }

    // An installer is not unpacked: msiexec takes the .msi as it was published.
    let staged = archive;
    if (!usesInstaller(kind)) {
      phase({ phase: "unpacking" });
      await extract(archive, dir);
      const found = await stagedFrom(dir, kind === "macos-app");
      if (!found) return refuse("The downloaded archive did not contain what was expected.");
      staged = found;
    }

    phase({ phase: "handoff" });
    const script = join(dir, helperFilename(kind));
    await writeFile(
      script,
      helperFor(kind, {
        pid: process.pid,
        staged,
        target,
        backup: `${target}.previous`,
        relaunch: relaunchCommandFor(target, kind) ?? [],
        ...(usesInstaller(kind) ? { installer: archive } : {}),
      }),
    );
    if (kind !== "windows-dir" && kind !== "windows-msi") await chmod(script, 0o755);

    // Detached and fully severed: it has to outlive us, and it will be running
    // when this process no longer exists to own its output.
    const runner = kind === "windows-dir" || kind === "windows-msi"
      ? spawn("cmd.exe", ["/c", script], { detached: true, stdio: "ignore", windowsHide: true })
      : spawn("/bin/sh", [script], { detached: true, stdio: "ignore" });
    runner.unref();

    handedOff = true;
    markHandedOff();
    phase({ phase: "done" });
    log.info(`Update to ${status.latest} staged; handing off and exiting.`);
    return { ok: true, restarting: true };
  } catch (err) {
    return refuse(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // The handoff owns the directory from the moment the helper is spawned —
    // the staged tree and the script itself live there. A local flag rather
    // than a read of the shared phase: the phase is for the browser, and
    // deciding a recursive delete by it would turn any future `phase()` call
    // placed after the spawn into a deleted staging directory.
    if (dir && !handedOff) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
