/**
 * Filesystem path and process helpers that hold on Windows.
 *
 * The native Windows package runs the kernel with backslash paths, a
 * case-insensitive filesystem, no HOME and no POSIX tools on PATH. Checks
 * written as `p.startsWith(root + "/")` never match there, so every jail that
 * used one answered 403/404 for files that were plainly inside it — the
 * extension pages of the dashboard came up blank on Windows for exactly that.
 *
 * The helpers take the path implementation (and platform/env where it
 * matters) as parameters, so the win32 rules are testable on Linux.
 */

import nodePath from "node:path";
import { statSync, renameSync } from "node:fs";
import { rename } from "node:fs/promises";

/**
 * Codes Windows returns when another process — Claude Code, an antivirus or
 * the search indexer — briefly holds the destination open. Transient there,
 * permanent elsewhere, so the retry only happens on win32.
 */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function isTransientRename(err: unknown, attempt: number, attempts: number, platform: NodeJS.Platform): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return platform === "win32" && attempt < attempts - 1 && !!code && TRANSIENT_RENAME_CODES.has(code);
}

/** `renameSync`, retried with a short backoff while Windows reports the target locked. */
export function renameWithRetrySync(
  from: string,
  to: string,
  opts: { attempts?: number; platform?: NodeJS.Platform; rename?: (a: string, b: string) => void } = {},
): void {
  const attempts = opts.attempts ?? 6;
  const platform = opts.platform ?? process.platform;
  const doRename = opts.rename ?? renameSync;
  for (let i = 0; ; i++) {
    try {
      doRename(from, to);
      return;
    } catch (err) {
      if (!isTransientRename(err, i, attempts, platform)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
    }
  }
}

/** Async `rename` with the same win32-only retry as `renameWithRetrySync`. */
export async function renameWithRetry(
  from: string,
  to: string,
  opts: { attempts?: number; platform?: NodeJS.Platform } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 6;
  const platform = opts.platform ?? process.platform;
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (!isTransientRename(err, i, attempts, platform)) throw err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

type PathImpl = typeof nodePath.posix;

function pathFor(platform: NodeJS.Platform): PathImpl {
  return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/**
 * True when `target` is `root` or lies below it. Resolves both first, so `..`
 * segments cannot climb out, and compares through `relative()`, which follows
 * the platform's separator and (on win32) its case-insensitivity.
 */
export function isPathInside(
  root: string,
  target: string,
  opts: { allowRoot?: boolean; path?: PathImpl } = {},
): boolean {
  const p = opts.path ?? nodePath;
  const rel = p.relative(p.resolve(root), p.resolve(target));
  if (rel === "") return opts.allowRoot ?? true;
  if (p.isAbsolute(rel)) return false; // another drive on win32
  return rel !== ".." && !rel.startsWith(`..${p.sep}`);
}

/**
 * `relative(root, target)` with forward slashes, for matching against patterns
 * and for tools (Claude Code permission rules, globs) that only speak POSIX.
 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * An absolute path written the way Claude Code permission rules expect it.
 *
 * In a rule, `//path` is absolute and a single leading `/` anchors at the
 * settings source — so `Read(/app/data/ws/**)` never matched the directory it
 * named. On Windows the CLI normalises paths to POSIX form before matching
 * (`C:\Users\me` → `/c/Users/me`), so the rule must say `//c/Users/me`.
 */
export function toPermissionRulePath(absPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const drive = /^([a-zA-Z]):[\\/]?(.*)$/.exec(absPath);
    if (drive) return `//${drive[1].toLowerCase()}/${toPosixPath(drive[2])}`.replace(/\/+$/, "");
    // UNC (\\server\share\…) keeps its double slash as-is.
    return toPosixPath(absPath).replace(/\/+$/, "");
  }
  return `/${absPath.replace(/^\/+/, "/")}`.replace(/(.)\/+$/, "$1");
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Find an executable on PATH without spawning `which` (absent on Windows) or
 * `where`. On win32 it tries each PATHEXT extension, so `findOnPath("claude")`
 * finds `claude.exe` or an npm `claude.cmd` shim.
 */
export function findOnPath(
  name: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    exists?: (candidate: string) => boolean;
  } = {},
): string | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? isFile;
  const p = pathFor(platform);

  // process.env is case-insensitive on Windows; a plain object is not.
  const rawPath = env.PATH ?? env.Path ?? env.path ?? "";
  const dirs = rawPath.split(p.delimiter).filter(Boolean);

  let exts = [""];
  if (platform === "win32") {
    const pathext = env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD";
    const list = pathext.split(";").filter(Boolean).map(e => e.toLowerCase());
    // A name that already carries an extension is tried as-is first.
    exts = p.extname(name) ? ["", ...list] : list;
  }

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir.replace(/^"(.*)"$/, "$1"), name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The argv to run a shell command string: `/bin/sh -c` on POSIX,
 * `cmd.exe /d /s /c` on Windows. Pass `windowsVerbatimArguments: true` to
 * spawn alongside it on win32 so cmd sees the command line untouched.
 */
export function shellCommand(
  command: string,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform === "win32") {
    return {
      file: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: "/bin/sh", args: ["-c", command], windowsVerbatimArguments: false };
}

/**
 * `.cmd`/`.bat` shims (what npm installs on Windows) cannot be spawned
 * directly: Node and Bun refuse them without a shell. Wrap them in cmd.exe;
 * anything else runs as-is.
 */
export function spawnableCommand(
  file: string,
  args: string[],
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): { file: string; args: string[] } {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(file)) return { file, args };
  const env = opts.env ?? process.env;
  return { file: env.ComSpec ?? env.COMSPEC ?? "cmd.exe", args: ["/d", "/c", file, ...args] };
}
