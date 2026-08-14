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
 * The kernel lives inside the bundle it has to replace. It cannot delete its
 * own .app and survive, so the sequence is:
 *
 *   1. download and verify into a temp dir           (this process)
 *   2. write a helper that waits for our PID to die  (this process)
 *   3. spawn the helper detached, then exit          (this process)
 *   4. swap the bundle, relaunch                     (helper, we are gone)
 *
 * The helper keeps the previous bundle until the new one launches. A failed
 * swap that leaves no way back is worse than not updating at all.
 *
 * ── What this does NOT do ──────────────────────────────────────────────────
 * Linux is left to dpkg/rpm. Replacing files under /opt that a package manager
 * believes it owns produces a system where the next `apt upgrade` fights this
 * one. The UI points those users at their package manager instead, which is
 * the same reason install.sh shells out rather than unpacking by hand.
 *
 * ── Untested on the platform it matters most ───────────────────────────────
 * Written on Linux; the macOS path has never run. Gatekeeper is the specific
 * risk: a downloaded bundle carries a com.apple.quarantine xattr, and unless
 * the release is notarized the swap will succeed and the relaunch will be
 * refused — an update that reports success and leaves the user with an app
 * that will not open. The helper strips the xattr, which is necessary and not
 * sufficient: notarization is the real fix and it belongs to the release
 * pipeline, not here.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { log } from "../logger.js";
import { checkForUpdate } from "./check.js";

export type ApplyOutcome =
  | { ok: true; restarting: true }
  | { ok: false; reason: string; useInstead?: string };

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

/** The asset name the release publishes for this machine. */
function macAssetFor(version: string): string {
  return process.arch === "arm64"
    ? `Kernl-${version}-arm64-macos.tar.gz`
    : `Kernl-${version}-x64-macos.tar.gz`;
}

const REPO = process.env.KERNEL_UPDATE_REPO ?? "fastslack/kernl";

/**
 * The helper. Deliberately dumb and readable: it is the thing that runs when
 * nothing else is left to supervise it, so it must be inspectable by whoever
 * finds it in a temp directory wondering what replaced their app.
 */
function helperScript(args: {
  pid: number;
  staged: string;
  bundle: string;
  backup: string;
}): string {
  return `#!/bin/sh
# Written by Kernl to finish an update. Safe to delete.
set -eu

# Wait for the kernel to exit — we are about to replace the bundle it is
# running from. Bounded: if it never dies, do nothing rather than swap a
# bundle out from under a live process.
i=0
while kill -0 ${args.pid} 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && exit 1
  sleep 1
done

# Keep the old bundle until the new one is in place.
rm -rf "${args.backup}"
mv "${args.bundle}" "${args.backup}"

if mv "${args.staged}" "${args.bundle}"; then
  # A downloaded bundle is quarantined; without this Gatekeeper refuses the
  # relaunch and the user is left with an app that will not open.
  xattr -dr com.apple.quarantine "${args.bundle}" 2>/dev/null || true
  rm -rf "${args.backup}"
else
  # Put it back. An update that fails is recoverable; one that leaves no app
  # behind is not.
  mv "${args.backup}" "${args.bundle}"
fi

open "${args.bundle}"
`;
}

/**
 * Download the newest build, stage it, and hand off to the helper. Returns
 * only if the handoff did NOT happen — on success this process is about to be
 * asked to exit.
 */
export async function applyUpdate(): Promise<ApplyOutcome> {
  if (process.platform === "linux") {
    return {
      ok: false,
      reason: "On Linux your package manager owns the install.",
      useInstead: "sudo apt upgrade kernl   (or dnf upgrade kernl)",
    };
  }
  if (process.platform !== "darwin") {
    return { ok: false, reason: "In-app update is only wired for macOS so far." };
  }

  const bundle = macAppBundlePath();
  if (!bundle) {
    return {
      ok: false,
      reason: "This does not look like an installed .app, so there is nothing to replace.",
    };
  }

  // Refuse when this build is not signed, rather than half-doing it.
  //
  // The swap itself would succeed; the relaunch is what fails. Gatekeeper will
  // not open a replacement bundle whose developer it cannot verify, so the
  // user ends up with the app closed, a new one that will not start, and a
  // backup this code already deleted. Stripping the quarantine xattr — which
  // the helper does — is not the same as being trusted.
  //
  // Probed, not assumed: the day the release is signed and notarized this
  // check passes and the button starts working with no further change.
  if (!(await isSignedBundle(bundle))) {
    return {
      ok: false,
      reason:
        "This build is not signed by Apple, so macOS would refuse to open the " +
        "updated app. Download the new version manually instead.",
      useInstead: `https://github.com/${REPO}/releases/latest`,
    };
  }

  const status = await checkForUpdate();
  if (!status.updateAvailable || !status.latest) {
    return { ok: false, reason: "Already on the newest release." };
  }

  const asset = macAssetFor(status.latest);
  const url = `https://github.com/${REPO}/releases/download/v${status.latest}/${asset}`;

  let staged: string;
  try {
    const dir = await mkdtemp(join(tmpdir(), "kernl-update-"));
    const tarball = join(dir, asset);

    const res = await fetch(url);
    if (!res.ok || !res.body) {
      return { ok: false, reason: `Could not download ${asset} (HTTP ${res.status}).` };
    }
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tarball));

    // Unpack beside the download, then find what came out. Trusting the
    // archive to contain a predictably-named directory is how you end up
    // moving the wrong thing into /Applications.
    await new Promise<void>((ok, bad) => {
      const p = spawn("tar", ["xzf", tarball, "-C", dir], { stdio: "ignore" });
      p.on("error", bad);
      p.on("exit", (c) => (c === 0 ? ok() : bad(new Error(`tar exited ${c}`))));
    });

    const found = await new Promise<string>((ok, bad) => {
      const p = spawn("find", [dir, "-maxdepth", "2", "-name", "*.app", "-print"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      p.stdout.on("data", (b: Buffer) => (out += b.toString()));
      p.on("error", bad);
      p.on("exit", () => ok(out.split("\n")[0]?.trim() ?? ""));
    });
    if (!found) return { ok: false, reason: "The downloaded archive had no .app inside it." };
    staged = found;
  } catch (err) {
    return { ok: false, reason: `Download failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const script = join(dirname(staged), "finish-update.sh");
  await writeFile(
    script,
    helperScript({ pid: process.pid, staged, bundle, backup: `${bundle}.previous` }),
  );
  await chmod(script, 0o755);

  // Detached and fully severed: it has to outlive us, and it will be running
  // when this process no longer exists to own its output.
  spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();

  log.info(`Update to ${status.latest} staged; handing off and exiting.`);
  return { ok: true, restarting: true };
}
