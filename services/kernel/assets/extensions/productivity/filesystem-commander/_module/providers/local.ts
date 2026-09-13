/**
 * Local filesystem provider.
 *
 * Paths must resolve within one of `allowedRoots` (which default to the OS
 * user's home directory). Any attempt to escape via `..` or symlinks
 * pointing outside the scope is rejected with `PathOutOfScopeError`.
 */

import { accessSync, constants, createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rename as fsRename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname, basename, isAbsolute, sep, relative } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { FsEntry, FsEntryKind, FsListing, FsStat } from "../types.js";
import {
  type FsProvider,
  type WriteStreamOptions,
  PathOutOfScopeError,
} from "./provider.js";

function toIso(d: Date): string {
  return d.toISOString();
}

function modeToPermString(mode: number): string {
  const out: string[] = [];
  for (const shift of [6, 3, 0]) {
    out.push(
      (mode >> (shift + 2)) & 1 ? "r" : "-",
      (mode >> (shift + 1)) & 1 ? "w" : "-",
      (mode >> shift) & 1 ? "x" : "-",
    );
  }
  return out.join("");
}

function kindOfStat(s: {
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  isFile: () => boolean;
}): FsEntryKind {
  if (s.isSymbolicLink()) return "symlink";
  if (s.isDirectory()) return "dir";
  if (s.isFile()) return "file";
  return "special";
}

export class LocalProvider implements FsProvider {
  readonly id = "local";
  readonly kind = "local" as const;
  readonly label = "Local";

  private roots: string[];

  constructor(allowedRoots: string[]) {
    // Empty config → default to $HOME.
    const src = allowedRoots.length ? allowedRoots : [homedir()];
    // Resolve + normalize so comparisons are reliable.
    this.roots = src.map((r) => resolve(r));
  }

  /** Assert path is within one of the roots. Returns the resolved absolute path. */
  private guard(p: string): string {
    if (!isAbsolute(p)) throw new PathOutOfScopeError(p);
    const abs = resolve(p);
    for (const root of this.roots) {
      const rel = relative(root, abs);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
    }
    throw new PathOutOfScopeError(p);
  }

  getAllowedRoots(): string[] {
    return [...this.roots];
  }

  /**
   * Each root plus whether this process can actually write into it.
   *
   * Probed rather than configured: a root can be unwritable because the mount
   * is read-only, because of ownership, or because of the mode bits, and the
   * config knows about none of those. The UI uses it to disable operations
   * that would otherwise fail only after the user committed to them.
   */
  getRootsInfo(): Array<{ path: string; writable: boolean }> {
    return this.roots.map((path) => {
      let writable = false;
      try {
        accessSync(path, constants.W_OK);
        writable = true;
      } catch {
        // Read-only mount, wrong owner, or restrictive mode — all mean "no".
      }
      return { path, writable };
    });
  }

  async list(path: string): Promise<FsListing> {
    const abs = this.guard(path);
    const names = await readdir(abs);
    const entries: FsEntry[] = [];
    await Promise.all(
      names.map(async (name) => {
        const child = resolve(abs, name);
        try {
          const s = await lstat(child);
          const kind = kindOfStat(s);
          const entry: FsEntry = {
            name,
            kind,
            size: Number(s.size),
            mtime: toIso(s.mtime),
            permissions: modeToPermString(s.mode),
            ownerUid: s.uid,
            ownerGid: s.gid,
          };
          if (kind === "symlink") {
            try {
              entry.target = await readlink(child);
            } catch {
              // dangling symlink — leave target undefined
            }
          }
          entries.push(entry);
        } catch {
          // Permission-denied or race condition — skip the entry
        }
      }),
    );
    entries.sort((a, b) => {
      if (a.kind === "dir" && b.kind !== "dir") return -1;
      if (b.kind === "dir" && a.kind !== "dir") return 1;
      return a.name.localeCompare(b.name);
    });
    // No parent above a configured root (compared through relative(), which
    // is case-insensitive on Windows) or above a filesystem root: dirname("C:\\")
    // is "C:\\" itself, so "parent" navigation used to loop on the spot.
    const atRoot = abs === sep || dirname(abs) === abs || this.roots.some((root) => relative(root, abs) === "");
    const parent = atRoot ? null : dirname(abs);
    return { path: abs, entries, parent };
  }

  async stat(path: string): Promise<FsStat> {
    const abs = this.guard(path);
    const s = await lstat(abs);
    const kind = kindOfStat(s);
    return {
      path: abs,
      name: basename(abs),
      kind,
      size: Number(s.size),
      mtime: toIso(s.mtime),
      atime: toIso(s.atime),
      ctime: toIso(s.ctime),
      permissions: modeToPermString(s.mode),
      ownerUid: s.uid,
      ownerGid: s.gid,
    };
  }

  async readStream(
    path: string,
    range?: { start: number; end?: number },
  ): Promise<Readable> {
    const abs = this.guard(path);
    return createReadStream(abs, range);
  }

  async writeStream(path: string, opts?: WriteStreamOptions): Promise<Writable> {
    const abs = this.guard(path);
    // Enforce overwrite semantics before opening the stream so callers get
    // an error up-front rather than a half-written file.
    if (opts?.overwrite === false) {
      try {
        await stat(abs);
        throw new Error(`File already exists: ${abs}`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
      }
    }
    return createWriteStream(abs, { flags: "w" });
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const abs = this.guard(path);
    await mkdir(abs, { recursive: opts?.recursive ?? false });
  }

  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const abs = this.guard(path);
    // Safety belt: refuse to delete a configured root itself. Compared through
    // relative() rather than includes(): Windows paths are case-insensitive, so
    // `c:\users\me` passes guard() and yet is not `C:\Users\me` to includes().
    if (this.roots.some((root) => relative(root, abs) === "")) {
      throw new Error(`Refusing to delete root path: ${abs}`);
    }
    await rm(abs, { recursive: opts?.recursive ?? false, force: false });
  }

  async rename(from: string, to: string): Promise<void> {
    const absFrom = this.guard(from);
    const absTo = this.guard(to);
    await fsRename(absFrom, absTo);
  }
}
