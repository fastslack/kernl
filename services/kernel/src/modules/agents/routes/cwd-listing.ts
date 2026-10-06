/**
 * One level of an agent's working folder, for the Workspace tab.
 *
 * The tab used to receive the whole tree in one response. A real repo mounted
 * from the host made that 224,741 entries and 35 MB (a pnpm store, e2e
 * screenshots, a Python venv): the request took seconds and the browser hung
 * on the answer. The tab now asks for the root and then for each folder the
 * operator opens, so a request costs one readdir plus one per subfolder.
 */

import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isPathInside } from "../../../core/fs-paths.js";

/** Never listed: not the operator's files, and the heaviest folders of any repo. */
const SKIP = new Set(["node_modules", ".git", ".wrangler"]);

/** Entries per folder before the listing is cut — a screenshots folder can hold tens of thousands. */
export const DIR_LISTING_LIMIT = 500;

export interface DirEntry {
  /** Relative to the agent's root, `/`-separated. */
  path: string;
  type: "dir" | "file";
  size: number;
  /** Folders only: how many entries they hold, without opening them. */
  count?: number;
}

export interface DirListing {
  dir: string;
  entries: DirEntry[];
  /** Entries the folder holds, skipped names excluded — more than `entries` when cut. */
  total: number;
  truncated: boolean;
}

/** `null` when `dir` escapes `root` or is not a folder. */
export async function listDirLevel(root: string, dir: string, limit = DIR_LISTING_LIMIT): Promise<DirListing | null> {
  const rel = dir.replace(/^\/+|\/+$/g, "");
  const abs = rel ? resolve(root, rel) : root;
  if (rel && !isPathInside(root, abs)) return null;
  let ents;
  try {
    ents = await readdir(abs, { withFileTypes: true });
  } catch {
    return null;
  }
  const kept = ents
    .filter((e) => !SKIP.has(e.name))
    // Folders first, then by name, so a cut drops files before folders.
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const entries: DirEntry[] = [];
  for (const e of kept.slice(0, limit)) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    const full = resolve(abs, e.name);
    if (e.isDirectory()) {
      const inner = await readdir(full).catch(() => [] as string[]);
      entries.push({ path, type: "dir", size: 0, count: inner.filter((n) => !SKIP.has(n)).length });
    } else {
      const s = await stat(full).catch(() => null);
      entries.push({ path, type: "file", size: s?.size ?? 0 });
    }
  }
  return { dir: rel, entries, total: kept.length, truncated: kept.length > limit };
}
