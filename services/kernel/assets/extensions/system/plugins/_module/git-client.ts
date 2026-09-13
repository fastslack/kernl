import { mkdir, rm, readFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { open as openZip, type ZipFile, type Entry as ZipEntry } from "yauzl";
import { log } from "../../../../../src/core/logger.js";
import { isPathInside } from "../../../../../src/core/fs-paths.js";
import type { PluginManifest } from "./types.js";

const execFileAsync = promisify(execFile);

export interface RepoInfo {
  name: string;
  description: string;
  clone_url: string;
  stars: number;
  updated_at: string;
}

// ── Fetch plugin list from a repo ──────────────────────────

/**
 * A "repo" can be:
 * 1. A GitLab group/GitHub org — lists all projects as potential plugins
 * 2. A single project repo — contains plugin.json at the root
 */

export async function fetchRepoIndex(
  url: string,
  type: string,
  token: string,
): Promise<RepoInfo[]> {
  try {
    if (type === "gitlab") return await fetchGitLabGroup(url, token);
    if (type === "github") return await fetchGitHubOrg(url, token);
    if (type === "gitea") return await fetchGiteaOrg(url, token);

    // Fallback: treat as single repo
    return [{
      name: extractRepoName(url),
      description: "",
      clone_url: url,
      stars: 0,
      updated_at: new Date().toISOString(),
    }];
  } catch (err) {
    log.warn(`Failed to fetch repo index for ${url}:`, err);
    return [];
  }
}

// ── GitLab API ─────────────────────────────────────────────

async function fetchGitLabGroup(url: string, type: string): Promise<RepoInfo[]> {
  const parsed = new URL(url);
  const pathParts = parsed.pathname.replace(/^\//, "").replace(/\/$/, "");
  const apiBase = `${parsed.protocol}//${parsed.host}/api/v4`;
  const encodedPath = encodeURIComponent(pathParts);

  const headers: Record<string, string> = { "Accept": "application/json" };
  if (type) headers["PRIVATE-TOKEN"] = type;

  // Try as group first
  let response = await fetch(
    `${apiBase}/groups/${encodedPath}/projects?per_page=100&simple=true`,
    { headers },
  );

  if (!response.ok) {
    // Try as single project
    response = await fetch(`${apiBase}/projects/${encodedPath}`, { headers });
    if (!response.ok) return [];

    const project = await response.json() as any;
    return [{
      name: project.path || project.name,
      description: project.description || "",
      clone_url: project.http_url_to_repo || url,
      stars: project.star_count || 0,
      updated_at: project.last_activity_at || "",
    }];
  }

  const projects = await response.json() as any[];
  return projects
    .filter((p: any) => !p.archived)
    .map((p: any) => ({
      name: p.path || p.name,
      description: p.description || "",
      clone_url: p.http_url_to_repo || "",
      stars: p.star_count || 0,
      updated_at: p.last_activity_at || "",
    }));
}

// ── GitHub API ─────────────────────────────────────────────

async function fetchGitHubOrg(url: string, token: string): Promise<RepoInfo[]> {
  const parsed = new URL(url);
  const parts = parsed.pathname.replace(/^\//, "").replace(/\/$/, "").split("/");
  const orgOrUser = parts[0];

  const headers: Record<string, string> = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "Kernl-PluginManager",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // Try as org, fallback to user, fallback to single repo
  let response = await fetch(
    `https://api.github.com/orgs/${orgOrUser}/repos?per_page=100`,
    { headers },
  );

  if (!response.ok) {
    response = await fetch(
      `https://api.github.com/users/${orgOrUser}/repos?per_page=100&sort=updated`,
      { headers },
    );
    if (!response.ok) {
      if (parts.length >= 2) {
        response = await fetch(
          `https://api.github.com/repos/${parts[0]}/${parts[1]}`,
          { headers },
        );
        if (!response.ok) return [];
        const repo = await response.json() as any;
        return [{
          name: repo.name,
          description: repo.description || "",
          clone_url: repo.clone_url || url,
          stars: repo.stargazers_count || 0,
          updated_at: repo.updated_at || "",
        }];
      }
      return [];
    }
  }

  const repos = await response.json() as any[];
  return repos
    .filter((r: any) => !r.archived)
    .map((r: any) => ({
      name: r.name,
      description: r.description || "",
      clone_url: r.clone_url || "",
      stars: r.stargazers_count || 0,
      updated_at: r.updated_at || "",
    }));
}

// ── Gitea API ──────────────────────────────────────────────

async function fetchGiteaOrg(url: string, token: string): Promise<RepoInfo[]> {
  const parsed = new URL(url);
  const parts = parsed.pathname.replace(/^\//, "").replace(/\/$/, "").split("/");
  const org = parts[0];
  const apiBase = `${parsed.protocol}//${parsed.host}/api/v1`;

  const headers: Record<string, string> = { "Accept": "application/json" };
  if (token) headers["Authorization"] = `token ${token}`;

  const response = await fetch(`${apiBase}/orgs/${org}/repos?limit=100`, { headers });
  if (!response.ok) return [];
  const repos = await response.json() as any[];

  return repos.map((r: any) => ({
    name: r.name,
    description: r.description || "",
    clone_url: r.clone_url || "",
    stars: r.stars_count || 0,
    updated_at: r.updated_at || "",
  }));
}

// ── Clone / Download ───────────────────────────────────────

/** Clone a plugin repo into target directory using git (execFile, no shell) */
export async function clonePlugin(
  cloneUrl: string,
  targetDir: string,
  token?: string,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });

  // Inject token into URL for private repos
  let authUrl = cloneUrl;
  if (token && cloneUrl.startsWith("https://")) {
    const parsed = new URL(cloneUrl);
    parsed.username = "oauth2";
    parsed.password = token;
    authUrl = parsed.toString();
  }

  try {
    await execFileAsync("git", ["clone", "--depth", "1", authUrl, targetDir], {
      timeout: 60_000,
    });
  } catch (err) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    // ENOENT = the git binary itself is missing; git is not part of a stock
    // Windows install.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Failed to clone ${cloneUrl}: git is not installed or not on PATH. ` +
        "Install Git (on Windows: https://git-scm.com/download/win) and restart Kernl, " +
        "or install the plugin from a .zip or .tar.gz file instead.",
      );
    }
    throw new Error(`Failed to clone ${cloneUrl}: ${err}`);
  }

  // Remove .git directory (don't need history)
  await rm(join(targetDir, ".git"), { recursive: true, force: true }).catch(() => {});
}

// ── Archive Extraction ─────────────────────────────────────

/**
 * Windows 10+ ships bsdtar as System32\tar.exe, which reads .tar and .tar.gz.
 * Call it by path: when Git for Windows' GNU tar comes first on PATH, it reads
 * `-f C:\...` as a remote host and fails with "Cannot connect to C:".
 */
function tarBinary(): string {
  if (process.platform !== "win32") return "tar";
  const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(system) ? system : "tar";
}

/**
 * Extract a zip in-process. `unzip` is not on a stock Windows install (nor on
 * many minimal Linux images), and yauzl is already a kernel dependency.
 * Entries that would land outside targetDir are refused.
 */
function extractZip(archivePath: string, targetDir: string): Promise<void> {
  return new Promise((resolveP, reject) => {
    openZip(archivePath, { lazyEntries: true }, (openErr, zip?: ZipFile) => {
      if (openErr || !zip) {
        reject(openErr ?? new Error(`could not open ${archivePath}`));
        return;
      }
      const fail = (err: unknown) => {
        try { zip.close(); } catch { /* already closed */ }
        reject(err);
      };
      zip.on("error", fail);
      zip.on("end", () => resolveP());
      zip.on("entry", (entry: ZipEntry) => {
        const dest = join(targetDir, entry.fileName);
        if (!isPathInside(targetDir, dest, { allowRoot: false })) {
          fail(new Error(`zip entry escapes the target directory: ${entry.fileName}`));
          return;
        }
        if (entry.fileName.endsWith("/")) {
          mkdir(dest, { recursive: true }).then(() => zip.readEntry(), fail);
          return;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            fail(streamErr ?? new Error(`could not read ${entry.fileName}`));
            return;
          }
          mkdir(dirname(dest), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(dest)))
            .then(() => zip.readEntry(), fail);
        });
      });
      zip.readEntry();
    });
  });
}

/** Extract a .zip or .tar.gz archive into targetDir */
export async function extractArchive(
  archivePath: string,
  targetDir: string,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });

  const lower = archivePath.toLowerCase();

  try {
    if (lower.endsWith(".zip")) {
      await extractZip(archivePath, targetDir);
    } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
      await execFileAsync(tarBinary(), ["-xzf", archivePath, "-C", targetDir, "--strip-components=1"], {
        timeout: 60_000,
      });
    } else if (lower.endsWith(".tar")) {
      await execFileAsync(tarBinary(), ["-xf", archivePath, "-C", targetDir, "--strip-components=1"], {
        timeout: 60_000,
      });
    } else {
      throw new Error(`Unsupported archive format: ${archivePath}. Use .zip, .tar.gz, or .tar`);
    }
  } catch (err) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Failed to extract ${archivePath}: ${err}`);
  }

  // zip may extract into a subdirectory — detect and flatten if needed
  if (lower.endsWith(".zip")) {
    await flattenSingleSubdir(targetDir);
  }
}

/** If targetDir contains a single subdirectory, move contents up */
async function flattenSingleSubdir(dir: string): Promise<void> {
  const { readdir, rename, stat: fsStat } = await import("node:fs/promises");
  const entries = await readdir(dir);

  // Skip if plugin.json already at root
  if (entries.includes("plugin.json")) return;

  // Check if there's exactly one subdirectory
  if (entries.length === 1) {
    const subPath = join(dir, entries[0]);
    const s = await fsStat(subPath);
    if (s.isDirectory()) {
      // Move contents up
      const subEntries = await readdir(subPath);
      for (const entry of subEntries) {
        await rename(join(subPath, entry), join(dir, entry));
      }
      await rm(subPath, { recursive: true, force: true });
    }
  }
}

/** Download a file from URL to a local path */
export async function downloadFile(
  url: string,
  destPath: string,
  token?: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (token) {
    if (url.includes("gitlab")) headers["PRIVATE-TOKEN"] = token;
    else headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);

  const buffer = await response.arrayBuffer();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(destPath, Buffer.from(buffer));
}

/** Read and validate plugin.json from a directory */
export async function readManifest(pluginDir: string): Promise<PluginManifest> {
  const manifestPath = join(pluginDir, "plugin.json");

  let content: string;
  try {
    content = await readFile(manifestPath, "utf-8");
  } catch {
    throw new Error(`No plugin.json found in ${pluginDir}`);
  }

  const manifest = JSON.parse(content) as PluginManifest;
  validateManifest(manifest);
  return manifest;
}

/** Basic manifest validation */
export function validateManifest(manifest: PluginManifest): void {
  if (!manifest.name || typeof manifest.name !== "string") {
    throw new Error("plugin.json: 'name' is required (string)");
  }
  if (!/^[a-z0-9-]+$/.test(manifest.name)) {
    throw new Error("plugin.json: 'name' must be lowercase alphanumeric with hyphens only");
  }
  if (!manifest.version || typeof manifest.version !== "string") {
    throw new Error("plugin.json: 'version' is required (string, semver)");
  }
  if (!manifest.description || typeof manifest.description !== "string") {
    throw new Error("plugin.json: 'description' is required");
  }
  if (!manifest.author || typeof manifest.author !== "string") {
    throw new Error("plugin.json: 'author' is required");
  }
  if (manifest.backend && !manifest.backend.entry) {
    throw new Error("plugin.json: 'backend.entry' is required when backend is specified");
  }
}

// ── Helpers ────────────────────────────────────────────────

function extractRepoName(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts[parts.length - 1]?.replace(/\.git$/, "") || "unknown";
  } catch {
    return "unknown";
  }
}
