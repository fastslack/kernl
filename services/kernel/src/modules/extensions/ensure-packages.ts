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

import { existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { log } from "../../core/logger.js";
import type { ExtensionManifest } from "./schema.js";

/** Walk up from `startDir` looking for `node_modules/<pkg>/package.json`. */
function isResolvable(pkg: string, startDir: string): boolean {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "node_modules", pkg, "package.json"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function runBunInstall(cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // process.execPath is the bun binary running the kernel — the packages
    // vendor their own runtime, so there is always one, and it is the same
    // one the extension will be loaded with.
    const child = spawn(process.execPath, ["install", "--no-progress"], {
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

  const missing = names.filter((n) => !isResolvable(n, installPath));
  if (!missing.length) return { installPath, installed: [] };

  log.info(`${slug}: ${missing.length} package(s) to fetch: ${missing.join(", ")}`);

  // Copy out of the read-only bundle so node_modules can sit beside the code.
  // Already-writable extensions (anything installed from the marketplace) stay
  // where they are.
  let target = installPath;
  const alreadyWritable = resolve(installPath).startsWith(resolve(extensionsDir));
  if (!alreadyWritable) {
    target = join(extensionsDir, slug);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(installPath, target, { recursive: true });
    log.info(`${slug}: materialized into ${target}`);
  }

  // Only the missing ones. Re-resolving what already works would drag the
  // whole set over the network for one absent package.
  const deps = Object.fromEntries(missing.map((n) => [n, declared[n]]));
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify({ name: `kernl-ext-${slug}`, version: "0.0.0", private: true, dependencies: deps }, null, 2),
    "utf-8",
  );

  try {
    await runBunInstall(target, timeoutMs);
  } catch (err) {
    throw new Error(
      `${slug} needs ${missing.join(", ")} and they could not be installed: ` +
        `${err instanceof Error ? err.message : err}`,
    );
  }

  // Trust nothing: a zero exit code with an unresolvable package still leaves
  // the extension broken at first use, which is the failure being prevented.
  const stillMissing = missing.filter((n) => !isResolvable(n, target));
  if (stillMissing.length) {
    throw new Error(`${slug}: ${stillMissing.join(", ")} still cannot be resolved after installing`);
  }

  log.info(`${slug}: installed ${missing.join(", ")}`);
  return { installPath: target, installed: missing };
}
