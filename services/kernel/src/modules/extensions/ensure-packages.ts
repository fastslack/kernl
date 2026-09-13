/**
 * Make an extension's declared npm packages resolvable before it is enabled.
 *
 * Most extensions need nothing here: the small, widely-used libraries ship in
 * the payload and resolve by walking up from the extension directory. The
 * heavy, rarely-used SDKs — discord.js, grammy, @slack/bolt, the AWS and
 * Anthropic clients — do not ship, because they cost roughly 100 MB of
 * transitive closure to serve a minority of installs. Those are fetched the
 * moment someone actually enables the extension.
 *
 * The bundled tree is read-only (/opt/kernl, /Applications/Kernl.app), so an
 * extension that needs packages is first copied into the user's data
 * directory, where its node_modules can live beside it and normal resolution
 * finds them.
 *
 * Failure is deliberately loud. Enabling an extension whose dependencies are
 * missing produces something that looks installed and throws on first use;
 * refusing to enable it says what happened while the user is still looking at
 * the screen.
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { existsSync as fsExists } from "node:fs";
import { delimiter as PATH_DELIM } from "node:path";
import { spawn } from "node:child_process";
import { log } from "../../core/logger.js";
import { assetsRoot } from "../../core/assets-root.js";
import { isPathInside } from "../../core/fs-paths.js";
import type { ExtensionManifest } from "./schema.js";

/**
 * Does an existing link already point at `target`? A Windows junction reads
 * back with a trailing separator (and sometimes a different drive-letter case),
 * so a plain `===` there re-created the link on every boot.
 */
export function sameLinkTarget(current: string, target: string, win = process.platform === "win32"): boolean {
  if (!win) return current === target;
  const norm = (p: string) => resolve(p.replace(/^\\\\\?\\/, "")).replace(/[\\/]+$/, "").toLowerCase();
  return norm(current) === norm(target);
}

/**
 * Make the payload's own node_modules reachable from a materialized extension.
 *
 * Resolution walks up from the extension directory. Inside the shipped bundle
 * that walk reaches the payload's node_modules, so everything the package ships
 * — @huggingface/transformers, sharp, onnxruntime-node — resolves for free.
 * `<data>/extensions/<slug>` has no such ancestor, so the moment an extension is
 * materialized every payload package it did not declare stops resolving.
 * Cinema's subtitle job died exactly there, on
 * `Cannot find module '@huggingface/transformers'`, after ffmpeg had already
 * spent three minutes pulling the audio down.
 *
 * Declaring them per extension is not the answer: transformers alone is 47 MB
 * and onnxruntime-node another 31 MB, both already sitting in the payload. One
 * symlink at `<data>/extensions/node_modules` restores exactly the link the
 * copy broke, and sits far enough down the walk that an extension's own
 * node_modules still wins for whatever it does declare.
 *
 * Refreshed on every boot on purpose: the payload path can move under the link
 * and leave it dangling, at which point the failure comes back with no message
 * anywhere. The .dmg now installs a plain /Applications/Kernl.app so an
 * upgrade lands on the same path, but the portable tarball still unpacks to
 * Kernl-<version>-<arch>.app, and nothing stops anyone moving the bundle.
 */
export function linkPayloadModules(extensionsDir: string): void {
  const root = assetsRoot();
  const payload = resolve(root, "node_modules");
  if (!existsSync(payload)) return;

  // Docker (/app/data/extensions) and dev (services/kernel/data/extensions)
  // keep the data dir inside the tree that owns node_modules, so the walk
  // already reaches it. Nothing to link, and linking would be self-referential.
  if (isPathInside(root, extensionsDir, { allowRoot: false })) return;

  const link = join(extensionsDir, "node_modules");
  const win = process.platform === "win32";
  try {
    mkdirSync(extensionsDir, { recursive: true });
    const current = lstatSync(link, { throwIfNoEntry: false });
    if (current?.isSymbolicLink()) {
      if (sameLinkTarget(readlinkSync(link), payload, win)) return; // already correct
      rmSync(link, { force: true });
    } else if (current) {
      // A real directory here belongs to someone else — never clobber it.
      return;
    }
    // A "dir" symlink on Windows needs admin or Developer Mode and threw EPERM
    // for every ordinary user, so payload packages never resolved there. A
    // junction needs no privilege and takes the same absolute target.
    symlinkSync(payload, link, win ? "junction" : "dir");
    log.info(`Extensions: payload node_modules linked at ${link}`);
  } catch (err) {
    // Not fatal on its own: extensions that declare everything they import
    // still work. Say so, because the symptom otherwise surfaces much later.
    log.warn(
      `Extensions: could not link payload node_modules into ${extensionsDir} — ` +
        `${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Walk up from `startDir` looking for `node_modules/<pkg>/package.json`. */
export function isResolvable(pkg: string, startDir: string): boolean {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "node_modules", pkg, "package.json"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Find something that can install npm packages.
 *
 * This used to assume `process.execPath` was the bun CLI, which holds when the
 * kernel is started as `bun dist/mcp-server.js` — i.e. in Docker. A native
 * package ships a bun-COMPILED single binary instead, so `process.execPath` is
 * the kernel itself, and a compiled binary has no `install` subcommand: the
 * spawn either fails or gets interpreted as kernel arguments. The provisioner
 * then reported a failure nobody could act on, and the extensions it was meant
 * to unblock — Cinema among them — stayed parked forever on exactly the
 * platforms that need provisioning most.
 *
 * Order: the running binary when it really is bun, then bun on PATH, then npm.
 */
function findPackageManager(): { cmd: string; args: string[] } | null {
  const exec = process.execPath;
  if (/^bun(\.exe)?$/i.test(basename(exec))) return { cmd: exec, args: ["install", "--no-progress"] };

  const onWindows = process.platform === "win32";
  const dirs = (process.env.PATH ?? "").split(PATH_DELIM).filter(Boolean);
  const candidates: Array<{ names: string[]; args: string[] }> = [
    { names: onWindows ? ["bun.exe"] : ["bun"], args: ["install", "--no-progress"] },
    { names: onWindows ? ["npm.cmd", "npm.exe"] : ["npm"], args: ["install", "--no-audit", "--no-fund"] },
  ];
  for (const c of candidates) {
    for (const dir of dirs) {
      for (const name of c.names) {
        const full = join(dir, name);
        if (fsExists(full)) return { cmd: full, args: c.args };
      }
    }
  }
  return null;
}

function runBunInstall(cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const pm = findPackageManager();
    if (!pm) {
      reject(new Error(
        "no package manager available — install bun or npm and make it reachable on PATH, " +
        "then enable the extension again",
      ));
      return;
    }
    const child = spawn(pm.cmd, pm.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(cwd, ".bun-cache") },
    });

    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += String(d); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s — check the network`));
    }, timeoutMs);

    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolvePromise();
      // Offline is by far the most common cause, and bun's own wording for it
      // is not something to put in front of a user.
      const offline = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network|getaddrinfo/i.test(stderr);
      reject(new Error(
        offline
          ? "could not reach the npm registry — check your internet connection"
          : `bun install failed (exit ${code}): ${stderr.trim().slice(-400) || "no output"}`,
      ));
    });
  });
}

/**
 * True when the extension declares packages that are not currently available.
 *
 * Such an extension must not be activated on sight. The loader would try to
 * import it at boot, fail on the missing package, and park it in `error` — so
 * a fresh install showed ten extensions apparently broken when they were
 * simply waiting to be asked for. Left in `installed`, they appear as
 * available, and enabling one is what fetches its packages.
 */
export function needsPackageInstall(manifest: ExtensionManifest, installPath: string): boolean {
  const declared = Object.keys(manifest.backend?.packages ?? {});
  if (!declared.length || !installPath) return false;
  return declared.some((p) => !isResolvable(p, installPath));
}

export interface EnsurePackagesResult {
  /** Where the extension should be loaded from now. Unchanged unless copied. */
  installPath: string;
  /** Packages actually fetched. Empty when everything already resolved. */
  installed: string[];
}

/**
 * Ensure `manifest.backend.packages` resolve for this extension.
 *
 * Returns the path the extension should load from: unchanged when nothing had
 * to be fetched, or the writable copy when it did. Throws with a
 * user-presentable message when the packages cannot be obtained.
 */
export async function ensureExtensionPackages(args: {
  manifest: ExtensionManifest;
  slug: string;
  installPath: string;
  /** Writable root for materialized extensions — `<data>/extensions`. */
  extensionsDir: string;
  timeoutMs?: number;
}): Promise<EnsurePackagesResult> {
  const { manifest, slug, installPath, extensionsDir, timeoutMs = 180_000 } = args;
  const declared = manifest.backend?.packages ?? {};
  const names = Object.keys(declared);
  if (!names.length) return { installPath, installed: [] };

  if (!names.some((n) => !isResolvable(n, installPath))) return { installPath, installed: [] };

  // Copy out of the read-only bundle so node_modules can sit beside the code.
  // Already-writable extensions (anything installed from the marketplace) stay
  // where they are.
  let target = installPath;
  const alreadyWritable = isPathInside(extensionsDir, installPath);
  if (!alreadyWritable) {
    target = join(extensionsDir, slug);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(installPath, target, { recursive: true });
    log.info(`${slug}: materialized into ${target}`);
  }

  // Ask again, here. Resolution walks up the directory tree, and the two
  // places share no ancestry: the bundle sits inside the payload's
  // node_modules, so everything that ships with it resolves from there and
  // never looks missing, while <data>/extensions/<slug> has nothing above it.
  // Deciding at the source leaves exactly those packages out of the copy — the
  // extension activates, and the next boot dies on its first bare import.
  const needed = names.filter((n) => !isResolvable(n, target));
  if (!needed.length) return { installPath: target, installed: [] };

  log.info(`${slug}: ${needed.length} package(s) to fetch: ${needed.join(", ")}`);

  // Only the ones missing here. Re-resolving what already works would drag the
  // whole set over the network for one absent package.
  const deps = Object.fromEntries(needed.map((n) => [n, declared[n]]));
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify({ name: `kernl-ext-${slug}`, version: "0.0.0", private: true, dependencies: deps }, null, 2),
    "utf-8",
  );

  try {
    await runBunInstall(target, timeoutMs);
  } catch (err) {
    throw new Error(
      `${slug} needs ${needed.join(", ")} and they could not be installed: ` +
        `${err instanceof Error ? err.message : err}`,
    );
  }

  // Trust nothing: a zero exit code with an unresolvable package still leaves
  // the extension broken at first use, which is the failure being prevented.
  // Checked against everything declared, not just what was fetched — the
  // install rewrites node_modules here, and the point is that the extension
  // can import all of it from where it is about to be loaded.
  const stillMissing = names.filter((n) => !isResolvable(n, target));
  if (stillMissing.length) {
    throw new Error(`${slug}: ${stillMissing.join(", ")} still cannot be resolved after installing`);
  }

  log.info(`${slug}: installed ${needed.join(", ")}`);
  return { installPath: target, installed: needed };
}
