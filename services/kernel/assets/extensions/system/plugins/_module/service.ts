import { resolve, join } from "node:path";
import { rm, readFile, access, copyFile, mkdir } from "node:fs/promises";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";
import type {
  PluginRepo,
  PluginRegistryEntry,
  InstalledPlugin,
  PluginManifest,
  PluginFrontendDescriptor,
} from "./types.js";
import {
  fetchRepoIndex,
  clonePlugin,
  readManifest,
  validateManifest,
  extractArchive,
  downloadFile,
} from "./git-client.js";

const PLUGINS_DIR = resolve("data", "plugins");

export class PluginManagerService {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
    private config: KernelConfig,
  ) {}

  // ── Repository Management ────────────────────────────────

  addRepo(input: {
    name: string;
    url: string;
    type?: string;
    token?: string;
  }): PluginRepo {
    const now = isoNow();
    const repo: PluginRepo = {
      id: newId(),
      name: input.name,
      url: input.url.replace(/\/$/, ""),
      type: input.type ?? "gitlab",
      token: input.token ?? "",
      last_synced_at: "",
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO plugin_repos (id, name, url, type, token, last_synced_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(repo.id, repo.name, repo.url, repo.type, repo.token, repo.last_synced_at, repo.created_at);

    return repo;
  }

  listRepos(): PluginRepo[] {
    return this.db
      .prepare("SELECT * FROM plugin_repos ORDER BY created_at DESC")
      .all() as PluginRepo[];
  }

  removeRepo(id: string): boolean {
    const existing = this.db.prepare("SELECT id FROM plugin_repos WHERE id = ?").get(id);
    if (!existing) return false;
    this.db.prepare("DELETE FROM plugin_registry WHERE repo_id = ?").run(id);
    this.db.prepare("DELETE FROM plugin_repos WHERE id = ?").run(id);
    return true;
  }

  // ── Sync & Browse ────────────────────────────────────────

  async syncRepo(repoId: string): Promise<{ found: number }> {
    const repo = this.db.prepare("SELECT * FROM plugin_repos WHERE id = ?").get(repoId) as PluginRepo | undefined;
    if (!repo) throw new Error(`Repo not found: ${repoId}`);

    const entries = await fetchRepoIndex(repo.url, repo.type, repo.token);

    // Clear old entries for this repo
    this.db.prepare("DELETE FROM plugin_registry WHERE repo_id = ?").run(repoId);

    // Insert new entries
    const stmt = this.db.prepare(
      `INSERT INTO plugin_registry (id, repo_id, plugin_name, description, author, version, clone_url, stars, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const entry of entries) {
      stmt.run(
        newId(), repoId, entry.name, entry.description, "",
        "", entry.clone_url, entry.stars, entry.updated_at,
      );
    }

    // Update last_synced_at
    this.db.prepare("UPDATE plugin_repos SET last_synced_at = ? WHERE id = ?").run(isoNow(), repoId);

    return { found: entries.length };
  }

  async syncAllRepos(): Promise<{ total: number }> {
    const repos = this.listRepos();
    let total = 0;
    for (const repo of repos) {
      try {
        const result = await this.syncRepo(repo.id);
        total += result.found;
      } catch (err) {
        log.warn(`Failed to sync repo ${repo.name}:`, err);
      }
    }
    return { total };
  }

  browsePlugins(repoId?: string): PluginRegistryEntry[] {
    if (repoId) {
      return this.db
        .prepare("SELECT * FROM plugin_registry WHERE repo_id = ? ORDER BY stars DESC, plugin_name")
        .all(repoId) as PluginRegistryEntry[];
    }
    return this.db
      .prepare("SELECT * FROM plugin_registry ORDER BY stars DESC, plugin_name")
      .all() as PluginRegistryEntry[];
  }

  // ── Install / Uninstall ──────────────────────────────────

  async install(input: {
    clone_url?: string;
    registry_id?: string;
    repo_id?: string;
  }): Promise<InstalledPlugin> {
    let cloneUrl = input.clone_url ?? "";
    let repoId = input.repo_id ?? "";

    // Resolve from registry if registry_id provided
    if (input.registry_id) {
      const entry = this.db
        .prepare("SELECT * FROM plugin_registry WHERE id = ?")
        .get(input.registry_id) as PluginRegistryEntry | undefined;
      if (!entry) throw new Error(`Registry entry not found: ${input.registry_id}`);
      cloneUrl = entry.clone_url;
      repoId = entry.repo_id;
    }

    if (!cloneUrl) throw new Error("No clone_url or registry_id provided");

    // Get token from repo if available
    let token = "";
    if (repoId) {
      const repo = this.db.prepare("SELECT token FROM plugin_repos WHERE id = ?").get(repoId) as { token: string } | undefined;
      if (repo) token = repo.token;
    }

    // Clone to temp directory
    const tempDir = resolve("data", "plugins", `.tmp-${Date.now()}`);
    await clonePlugin(cloneUrl, tempDir, token || undefined);

    // Read and validate manifest
    let manifest: PluginManifest;
    try {
      manifest = await readManifest(tempDir);
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true });
      throw err;
    }

    // Check if already installed
    const existing = this.db
      .prepare("SELECT id FROM installed_plugins WHERE name = ?")
      .get(manifest.name);
    if (existing) {
      await rm(tempDir, { recursive: true, force: true });
      throw new Error(`Plugin "${manifest.name}" is already installed. Use update instead.`);
    }

    // Move to final location
    const installDir = resolve(PLUGINS_DIR, manifest.name);
    await rm(installDir, { recursive: true, force: true });
    await mkdir(resolve(PLUGINS_DIR), { recursive: true });

    // Rename temp to final
    const { rename } = await import("node:fs/promises");
    await rename(tempDir, installDir);

    // Save to database
    const now = isoNow();
    const plugin: InstalledPlugin = {
      id: newId(),
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      repo_id: repoId,
      clone_url: cloneUrl,
      install_path: installDir,
      status: "active",
      manifest_json: JSON.stringify(manifest),
      installed_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO installed_plugins (id, name, version, description, author, repo_id, clone_url, install_path, status, manifest_json, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plugin.id, plugin.name, plugin.version, plugin.description, plugin.author,
        plugin.repo_id, plugin.clone_url, plugin.install_path, plugin.status,
        plugin.manifest_json, plugin.installed_at, plugin.updated_at,
      );

    return plugin;
  }

  /** Install from a local archive file (.zip, .tar.gz, .tar) */
  async installFromFile(filePath: string): Promise<InstalledPlugin> {
    const tempDir = resolve(PLUGINS_DIR, `.tmp-file-${Date.now()}`);
    await extractArchive(filePath, tempDir);
    return this.finalizeInstall(tempDir, "", "");
  }

  /** Install from a URL pointing to an archive (.zip, .tar.gz) */
  async installFromUrl(url: string, token?: string): Promise<InstalledPlugin> {
    // Determine extension from URL
    const ext = url.match(/\.(zip|tar\.gz|tgz|tar)(\?.*)?$/i)?.[1] ?? "zip";
    const tempFile = resolve(PLUGINS_DIR, `.tmp-download-${Date.now()}.${ext}`);
    await mkdir(resolve(PLUGINS_DIR), { recursive: true });

    await downloadFile(url, tempFile, token);

    const tempDir = resolve(PLUGINS_DIR, `.tmp-url-${Date.now()}`);
    try {
      await extractArchive(tempFile, tempDir);
    } finally {
      await rm(tempFile, { force: true }).catch(() => {});
    }

    return this.finalizeInstall(tempDir, "", url);
  }

  /** Common finalization: validate, move to install dir, save to DB */
  private async finalizeInstall(
    tempDir: string,
    repoId: string,
    sourceUrl: string,
  ): Promise<InstalledPlugin> {
    let manifest: PluginManifest;
    try {
      manifest = await readManifest(tempDir);
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true });
      throw err;
    }

    const existing = this.db
      .prepare("SELECT id FROM installed_plugins WHERE name = ?")
      .get(manifest.name);
    if (existing) {
      await rm(tempDir, { recursive: true, force: true });
      throw new Error(`Plugin "${manifest.name}" is already installed. Use update instead.`);
    }

    const installDir = resolve(PLUGINS_DIR, manifest.name);
    await rm(installDir, { recursive: true, force: true });
    await mkdir(resolve(PLUGINS_DIR), { recursive: true });

    const { rename } = await import("node:fs/promises");
    await rename(tempDir, installDir);

    const now = isoNow();
    const plugin: InstalledPlugin = {
      id: newId(),
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      repo_id: repoId,
      clone_url: sourceUrl,
      install_path: installDir,
      status: "active",
      manifest_json: JSON.stringify(manifest),
      installed_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO installed_plugins (id, name, version, description, author, repo_id, clone_url, install_path, status, manifest_json, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plugin.id, plugin.name, plugin.version, plugin.description, plugin.author,
        plugin.repo_id, plugin.clone_url, plugin.install_path, plugin.status,
        plugin.manifest_json, plugin.installed_at, plugin.updated_at,
      );

    return plugin;
  }

  async uninstall(name: string): Promise<boolean> {
    const plugin = this.db
      .prepare("SELECT * FROM installed_plugins WHERE name = ?")
      .get(name) as InstalledPlugin | undefined;
    if (!plugin) return false;

    // Remove files
    await rm(plugin.install_path, { recursive: true, force: true });

    // Remove from database
    this.db.prepare("DELETE FROM installed_plugins WHERE id = ?").run(plugin.id);

    return true;
  }

  async update(name: string): Promise<InstalledPlugin> {
    const existing = this.db
      .prepare("SELECT * FROM installed_plugins WHERE name = ?")
      .get(name) as InstalledPlugin | undefined;
    if (!existing) throw new Error(`Plugin not found: ${name}`);
    if (!existing.clone_url) throw new Error(`No clone URL for plugin: ${name}`);

    // Get token
    let token = "";
    if (existing.repo_id) {
      const repo = this.db.prepare("SELECT token FROM plugin_repos WHERE id = ?").get(existing.repo_id) as { token: string } | undefined;
      if (repo) token = repo.token;
    }

    // Clone fresh copy
    const tempDir = resolve("data", "plugins", `.tmp-update-${Date.now()}`);
    await clonePlugin(existing.clone_url, tempDir, token || undefined);

    let manifest: PluginManifest;
    try {
      manifest = await readManifest(tempDir);
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true });
      throw err;
    }

    // Replace install directory
    await rm(existing.install_path, { recursive: true, force: true });
    const { rename } = await import("node:fs/promises");
    await rename(tempDir, existing.install_path);

    // Update database
    const now = isoNow();
    this.db
      .prepare(
        `UPDATE installed_plugins SET version=?, description=?, author=?, manifest_json=?, updated_at=?
         WHERE id=?`,
      )
      .run(manifest.version, manifest.description, manifest.author, JSON.stringify(manifest), now, existing.id);

    return { ...existing, version: manifest.version, description: manifest.description, manifest_json: JSON.stringify(manifest), updated_at: now };
  }

  // ── Status Management ────────────────────────────────────

  setStatus(name: string, status: "active" | "disabled"): boolean {
    const existing = this.db.prepare("SELECT id FROM installed_plugins WHERE name = ?").get(name);
    if (!existing) return false;
    this.db.prepare("UPDATE installed_plugins SET status = ?, updated_at = ? WHERE name = ?").run(status, isoNow(), name);
    return true;
  }

  // ── Queries ──────────────────────────────────────────────

  listInstalled(): InstalledPlugin[] {
    return this.db
      .prepare("SELECT * FROM installed_plugins ORDER BY name")
      .all() as InstalledPlugin[];
  }

  listActive(): InstalledPlugin[] {
    return this.db
      .prepare("SELECT * FROM installed_plugins WHERE status = 'active' ORDER BY name")
      .all() as InstalledPlugin[];
  }

  getInstalledByName(name: string): InstalledPlugin | undefined {
    return this.db
      .prepare("SELECT * FROM installed_plugins WHERE name = ?")
      .get(name) as InstalledPlugin | undefined;
  }

  /** Read the frontend descriptor for an installed plugin */
  async getFrontendDescriptor(name: string): Promise<PluginFrontendDescriptor | null> {
    const plugin = this.getInstalledByName(name);
    if (!plugin || plugin.status !== "active") return null;

    const manifest = JSON.parse(plugin.manifest_json) as PluginManifest;
    if (!manifest.frontend?.descriptor) return null;

    const descriptorPath = join(plugin.install_path, manifest.frontend.descriptor);
    try {
      const content = await readFile(descriptorPath, "utf-8");
      return JSON.parse(content) as PluginFrontendDescriptor;
    } catch {
      return null;
    }
  }

  /** Get manifest for an installed plugin */
  getManifest(name: string): PluginManifest | null {
    const plugin = this.getInstalledByName(name);
    if (!plugin) return null;
    try {
      return JSON.parse(plugin.manifest_json) as PluginManifest;
    } catch {
      return null;
    }
  }
}
