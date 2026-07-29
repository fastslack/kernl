/**
 * GitCatalogProvider — clones a public git repo (shallow) into a local cache
 * and exposes its skills/extensions as catalog items.
 *
 * Discovery walks the clone for these markers (in priority order):
 *   1. extension.json    — canonical Kernl extension layout
 *   2. SKILL.md          — Anthropic Claude Code skill (yaml frontmatter)
 *   3. SKILL.json        — legacy Kernl skill layout
 *
 * The first hit wins per directory; we stop descending once we identify a
 * skill/extension. That handles repos like `coreyhaines31/marketingskills`
 * (each top-level subfolder is a skill with SKILL.md) AND repos that ship
 * a single .kernlext-style extension at the root.
 *
 * Cache layout: <dataDir>/catalog-cache/<repo-slug>/  — `git pull` on sync,
 * `git clone --depth 1` on first add. Removing a repo deletes its dir.
 *
 * Install path uses installFromDirectory with origin.source={type:'git',...}
 * — the existing receipt machinery records the git url + ref + commit_sha
 * automatically (see ExtensionService.installFromDirectory).
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../../../core/logger.js";
import type { ExtensionManifest } from "../../extensions/schema.js";
import { readManifest } from "../../extensions/bundle.js";
import {
  readSkillAsExtensionManifest,
  readSkillMdAsExtensionManifest,
} from "./normalizers.js";
import type {
  CatalogFilter,
  CatalogItem,
  CatalogProvider,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface GitCatalogProviderOptions {
  /** Stable id for this provider (e.g. "git:coreyhaines31/marketingskills"). */
  name: string;
  /** Human-readable label for the dashboard. */
  label: string;
  /** Repo URL (https or git). */
  url: string;
  /** Optional ref (branch/tag/commit). Default: HEAD of default branch. */
  ref?: string;
  /** Where to keep the cache. Defaults to `<cwd>/data/catalog-cache/<slug>`. */
  cacheDir: string;
}

interface DiscoveredItem {
  manifest: ExtensionManifest;
  directory: string;
}

export class GitCatalogProvider implements CatalogProvider {
  readonly name: string;
  readonly label: string;
  private discovered: DiscoveredItem[] = [];
  private discoveredAt: number = 0;
  /** SHA of the commit currently checked out. Stamped into receipts as
   *  source.commit_sha so installs are reproducible. */
  private commitSha: string | null = null;

  constructor(private readonly opts: GitCatalogProviderOptions) {
    this.name = opts.name;
    this.label = opts.label;
  }

  async list(filter?: CatalogFilter): Promise<CatalogItem[]> {
    if (this.discoveredAt === 0) await this.refresh();
    return applyFilter(this.toCatalogItems(), filter);
  }

  async get(idOrSlug: string): Promise<CatalogItem | null> {
    if (this.discoveredAt === 0) await this.refresh();
    const items = this.toCatalogItems();
    return items.find((i) => i.id === idOrSlug || i.slug === idOrSlug) ?? null;
  }

  /** Interface contract — fire-and-forget refresh. Use `syncWithReport()` from
   *  CatalogReposService when you need the items count + commit sha back. */
  async refresh(): Promise<void> {
    await this.syncWithReport();
  }

  /** Clone (or pull) and re-walk. Returns the count of items found and the
   *  resolved commit sha. Errors are caught and surfaced via the result, never
   *  thrown — the caller persists `sync_error` for the dashboard. */
  async syncWithReport(): Promise<{ items: number; commit_sha: string | null; error?: string }> {
    try {
      await this.cloneOrPull();
      this.commitSha = await this.readCommitSha();
      this.discovered = await this.walkForItems(this.opts.cacheDir);
      this.discoveredAt = Date.now();
      log.info(
        `GitCatalogProvider ${this.name}: ${this.discovered.length} item(s) discovered ` +
          `at commit ${this.commitSha?.slice(0, 8) ?? "unknown"}`,
      );
      return { items: this.discovered.length, commit_sha: this.commitSha };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`GitCatalogProvider ${this.name}: refresh failed: ${msg}`);
      return { items: 0, commit_sha: null, error: msg };
    }
  }

  /** Drop the cache dir entirely (e.g. user unsubscribed from this repo). */
  async destroy(): Promise<void> {
    await rm(this.opts.cacheDir, { recursive: true, force: true }).catch(() => {});
    this.discovered = [];
    this.discoveredAt = 0;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async cloneOrPull(): Promise<void> {
    const dotGit = join(this.opts.cacheDir, ".git");
    if (existsSync(dotGit)) {
      // Already cloned — fetch + reset to remote HEAD (or pinned ref).
      await execGit(this.opts.cacheDir, ["fetch", "--depth", "1", "origin"]);
      const target = this.opts.ref ?? "origin/HEAD";
      try {
        await execGit(this.opts.cacheDir, ["reset", "--hard", target]);
      } catch {
        // origin/HEAD may not exist on some shallow clones; fall back to
        // the configured branch from FETCH_HEAD.
        await execGit(this.opts.cacheDir, ["reset", "--hard", "FETCH_HEAD"]);
      }
      return;
    }

    await mkdir(this.opts.cacheDir, { recursive: true });
    const args = ["clone", "--depth", "1"];
    if (this.opts.ref) args.push("--branch", this.opts.ref, "--single-branch");
    args.push(this.opts.url, this.opts.cacheDir);
    await execFileAsync("git", args, { timeout: 120_000 });
  }

  private async readCommitSha(): Promise<string | null> {
    try {
      const { stdout } = await execGit(this.opts.cacheDir, ["rev-parse", "HEAD"]);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  /**
   * Walk a directory tree (depth-limited to 4) looking for the first marker
   * file in each subtree. The first hit per directory wins and we stop
   * descending — a "skill folder" is the leaf, no nested skills inside.
   *
   * Skips common noise dirs (.git, node_modules, .github, etc.) for speed.
   */
  private async walkForItems(root: string, depth = 4): Promise<DiscoveredItem[]> {
    const out: DiscoveredItem[] = [];
    const SKIP = new Set([
      ".git",
      "node_modules",
      ".github",
      ".vscode",
      ".idea",
      "dist",
      "build",
      "target",
      ".cache",
    ]);

    const visit = async (dir: string, remaining: number): Promise<void> => {
      if (remaining <= 0) return;
      // Marker check first — if THIS dir is itself a skill/extension, capture
      // it and stop descending.
      const captured = await this.tryReadAsItem(dir);
      if (captured) {
        out.push(captured);
        return;
      }
      let entries: { name: string; isDirectory: () => boolean }[] = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (SKIP.has(e.name)) continue;
        if (e.name.startsWith(".")) continue;
        await visit(join(dir, e.name), remaining - 1);
      }
    };

    await visit(root, depth);
    return out;
  }

  /**
   * If `dir` carries one of our marker files, parse it into an
   * ExtensionManifest. Priority: extension.json > SKILL.md > SKILL.json.
   * Returns null when there's no marker (the dir is just an organizational
   * folder).
   */
  private async tryReadAsItem(dir: string): Promise<DiscoveredItem | null> {
    if (existsSync(join(dir, "extension.json"))) {
      try {
        const manifest = await readManifest(dir);
        return { manifest, directory: dir };
      } catch (err) {
        log.warn(`GitCatalogProvider ${this.name}: invalid extension.json at ${dir}: ${err}`);
        return null;
      }
    }
    if (existsSync(join(dir, "SKILL.md"))) {
      try {
        const manifest = await readSkillMdAsExtensionManifest(dir);
        return { manifest, directory: dir };
      } catch (err) {
        log.warn(`GitCatalogProvider ${this.name}: invalid SKILL.md at ${dir}: ${err}`);
        return null;
      }
    }
    if (existsSync(join(dir, "SKILL.json"))) {
      try {
        const manifest = await readSkillAsExtensionManifest(dir);
        return { manifest, directory: dir };
      } catch (err) {
        log.warn(`GitCatalogProvider ${this.name}: invalid SKILL.json at ${dir}: ${err}`);
        return null;
      }
    }
    return null;
  }

  private toCatalogItems(): CatalogItem[] {
    return this.discovered.map((d): CatalogItem => ({
      id: d.manifest.id,
      slug: d.manifest.slug,
      origin: {
        provider: this.name,
        source: {
          type: "git",
          url: this.opts.url,
          ref: this.opts.ref ?? this.commitSha ?? undefined,
        },
        directory: resolve(d.directory),
      },
      manifest: d.manifest,
      status: "available",
      price_cents: d.manifest.pricing?.amount_cents ?? 0,
      currency: d.manifest.pricing?.currency ?? "EUR",
      install_count: 0,
      avg_rating: 0,
      review_count: 0,
      featured: false,
      verified: false,
    }));
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

async function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd, timeout: 120_000 });
}

function applyFilter(items: CatalogItem[], filter?: CatalogFilter): CatalogItem[] {
  let out = items;
  if (filter?.type) out = out.filter((i) => i.manifest.type === filter.type);
  if (filter?.category) out = out.filter((i) => i.manifest.category === filter.category);
  if (filter?.query) {
    const q = filter.query.toLowerCase();
    out = out.filter((i) => {
      const hay = [
        i.slug,
        i.manifest.name,
        i.manifest.description,
        ...(i.manifest.tags ?? []),
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }
  if (filter?.limit) out = out.slice(0, filter.limit);
  return out;
}

/** Convert a git URL to a filesystem-safe slug for the cache dir name. */
export function repoUrlToSlug(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/[:/]/g, "__")
    .replace(/\.git$/, "")
    .toLowerCase()
    .slice(0, 96);
}
