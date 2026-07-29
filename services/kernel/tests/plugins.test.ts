import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { pluginsMigrations } from "../assets/extensions/system/plugins/_module/migrations/001_plugins.js";
import { PluginManagerService } from "../assets/extensions/system/plugins/_module/service.js";
// graph driver mocked as null in tests
import { validateManifest, extractArchive, readManifest } from "../assets/extensions/system/plugins/_module/git-client.js";
import type { PluginManifest } from "../assets/extensions/system/plugins/_module/types.js";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const mockConfig = {
  sqlite: { path: ":memory:" },
  neo4j: { uri: "", user: "", password: "" },
  dashboard: { enabled: false, port: 3086, refreshIntervalMs: 30000 },
} as any;

// ── Manifest Validation ────────────────────────────────────

describe("validateManifest", () => {
  const validManifest: PluginManifest = {
    name: "my-plugin",
    version: "1.0.0",
    description: "A test plugin",
    author: "tester",
  };

  it("accepts a valid manifest", () => {
    expect(() => validateManifest(validManifest)).not.toThrow();
  });

  it("rejects missing name", () => {
    expect(() => validateManifest({ ...validManifest, name: "" })).toThrow("name");
  });

  it("rejects invalid name characters", () => {
    expect(() => validateManifest({ ...validManifest, name: "My Plugin!" })).toThrow("lowercase");
  });

  it("accepts hyphens in name", () => {
    expect(() => validateManifest({ ...validManifest, name: "my-cool-plugin" })).not.toThrow();
  });

  it("rejects missing version", () => {
    expect(() => validateManifest({ ...validManifest, version: "" })).toThrow("version");
  });

  it("rejects missing description", () => {
    expect(() => validateManifest({ ...validManifest, description: "" })).toThrow("description");
  });

  it("rejects missing author", () => {
    expect(() => validateManifest({ ...validManifest, author: "" })).toThrow("author");
  });

  it("rejects backend without entry", () => {
    expect(() =>
      validateManifest({ ...validManifest, backend: { entry: "" } }),
    ).toThrow("backend.entry");
  });

  it("accepts backend with entry", () => {
    expect(() =>
      validateManifest({ ...validManifest, backend: { entry: "backend/index.js" } }),
    ).not.toThrow();
  });

  it("accepts manifest with frontend", () => {
    expect(() =>
      validateManifest({
        ...validManifest,
        frontend: {
          nav: { group: "dashboard", label: "My Plugin", icon: "🔌" },
          descriptor: "frontend/descriptor.json",
        },
      }),
    ).not.toThrow();
  });
});

// ── Service Tests ──────────────────────────────────────────

describe("PluginManagerService", () => {
  let db: Database;
  let service: PluginManagerService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "plugins", pluginsMigrations);
    service = new PluginManagerService(db, () => null, mockConfig);
  });
  afterEach(() => db.close());

  // ── Repo Management ──────────────────────────────────

  it("adds a repository", () => {
    const repo = service.addRepo({
      name: "Test Repo",
      url: "https://gitlab.com/test/plugins",
      type: "gitlab",
    });
    expect(repo.id).toBeTruthy();
    expect(repo.name).toBe("Test Repo");
    expect(repo.url).toBe("https://gitlab.com/test/plugins");
    expect(repo.type).toBe("gitlab");
    expect(repo.last_synced_at).toBe("");
  });

  it("lists repositories", () => {
    service.addRepo({ name: "A", url: "https://gitlab.com/a" });
    service.addRepo({ name: "B", url: "https://github.com/b" });
    const repos = service.listRepos();
    expect(repos).toHaveLength(2);
  });

  it("removes a repository and cascades to registry", () => {
    const repo = service.addRepo({ name: "X", url: "https://gitlab.com/x" });

    // Manually insert a registry entry
    db.prepare(
      "INSERT INTO plugin_registry (id, repo_id, plugin_name, description) VALUES (?, ?, ?, ?)",
    ).run("reg-1", repo.id, "test-plugin", "desc");

    expect(service.removeRepo(repo.id)).toBe(true);
    expect(service.listRepos()).toHaveLength(0);

    // Registry entries should be cascade deleted
    const remaining = db
      .prepare("SELECT * FROM plugin_registry WHERE repo_id = ?")
      .all(repo.id);
    expect(remaining).toHaveLength(0);
  });

  it("rejects removing non-existent repo", () => {
    expect(service.removeRepo("nonexistent")).toBe(false);
  });

  // ── Browse Plugins ───────────────────────────────────

  it("browses all plugins from registry", () => {
    const repo = service.addRepo({ name: "R", url: "https://gitlab.com/r" });

    db.prepare(
      "INSERT INTO plugin_registry (id, repo_id, plugin_name, description, stars) VALUES (?, ?, ?, ?, ?)",
    ).run("p1", repo.id, "weather-plugin", "Weather data", 5);
    db.prepare(
      "INSERT INTO plugin_registry (id, repo_id, plugin_name, description, stars) VALUES (?, ?, ?, ?, ?)",
    ).run("p2", repo.id, "stock-plugin", "Stock data", 12);

    const plugins = service.browsePlugins();
    expect(plugins).toHaveLength(2);
    // Should be ordered by stars DESC
    expect(plugins[0].plugin_name).toBe("stock-plugin");
  });

  it("browses plugins filtered by repo", () => {
    const r1 = service.addRepo({ name: "R1", url: "https://gitlab.com/r1" });
    const r2 = service.addRepo({ name: "R2", url: "https://gitlab.com/r2" });

    db.prepare(
      "INSERT INTO plugin_registry (id, repo_id, plugin_name, description) VALUES (?, ?, ?, ?)",
    ).run("p1", r1.id, "from-r1", "");
    db.prepare(
      "INSERT INTO plugin_registry (id, repo_id, plugin_name, description) VALUES (?, ?, ?, ?)",
    ).run("p2", r2.id, "from-r2", "");

    expect(service.browsePlugins(r1.id)).toHaveLength(1);
    expect(service.browsePlugins(r1.id)[0].plugin_name).toBe("from-r1");
  });

  // ── Install (without network) ────────────────────────

  it("rejects install without clone_url or registry_id", async () => {
    await expect(service.install({})).rejects.toThrow("No clone_url or registry_id");
  });

  it("rejects install with non-existent registry_id", async () => {
    await expect(service.install({ registry_id: "bad-id" })).rejects.toThrow("Registry entry not found");
  });

  // ── Status Management ────────────────────────────────

  it("enables and disables a plugin", () => {
    // Manually insert an installed plugin
    db.prepare(
      `INSERT INTO installed_plugins (id, name, version, description, author, repo_id, clone_url, install_path, status, manifest_json, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("p1", "test-plugin", "1.0.0", "Test", "author", "", "", "/tmp/test", "active", "{}", new Date().toISOString(), new Date().toISOString());

    expect(service.setStatus("test-plugin", "disabled")).toBe(true);
    expect(service.getInstalledByName("test-plugin")?.status).toBe("disabled");

    expect(service.setStatus("test-plugin", "active")).toBe(true);
    expect(service.getInstalledByName("test-plugin")?.status).toBe("active");
  });

  it("rejects status change for non-existent plugin", () => {
    expect(service.setStatus("nonexistent", "disabled")).toBe(false);
  });

  // ── List ─────────────────────────────────────────────

  it("lists installed plugins", () => {
    db.prepare(
      `INSERT INTO installed_plugins (id, name, version, description, author, repo_id, clone_url, install_path, status, manifest_json, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("p1", "plugin-a", "1.0.0", "", "", "", "", "/tmp/a", "active", "{}", new Date().toISOString(), new Date().toISOString());
    db.prepare(
      `INSERT INTO installed_plugins (id, name, version, description, author, repo_id, clone_url, install_path, status, manifest_json, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("p2", "plugin-b", "2.0.0", "", "", "", "", "/tmp/b", "disabled", "{}", new Date().toISOString(), new Date().toISOString());

    expect(service.listInstalled()).toHaveLength(2);
    expect(service.listActive()).toHaveLength(1);
    expect(service.listActive()[0].name).toBe("plugin-a");
  });

  // ── Manifest Retrieval ───────────────────────────────

  it("retrieves manifest for installed plugin", () => {
    const manifest = { name: "test-plugin", version: "1.0.0", description: "Test", author: "me" };
    db.prepare(
      `INSERT INTO installed_plugins (id, name, version, description, author, repo_id, clone_url, install_path, status, manifest_json, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("p1", "test-plugin", "1.0.0", "Test", "me", "", "", "/tmp/test", "active", JSON.stringify(manifest), new Date().toISOString(), new Date().toISOString());

    const result = service.getManifest("test-plugin");
    expect(result).toBeTruthy();
    expect(result!.name).toBe("test-plugin");
    expect(result!.version).toBe("1.0.0");
  });

  it("returns null for non-existent plugin manifest", () => {
    expect(service.getManifest("nonexistent")).toBeNull();
  });
});

// ── Archive Extraction Tests ───────────────────────────────

describe("Archive extraction", () => {
  const testDir = resolve("/tmp", `plugin-test-${Date.now()}`);
  const pluginDir = join(testDir, "my-test-plugin");
  const extractDir = join(testDir, "extracted");

  beforeEach(() => {
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "my-test-plugin",
        version: "1.0.0",
        description: "A test plugin for archive extraction",
        author: "tester",
      }),
    );
    writeFileSync(join(pluginDir, "README.md"), "# Test Plugin");
    mkdirSync(join(pluginDir, "backend"), { recursive: true });
    writeFileSync(join(pluginDir, "backend", "index.js"), "export function createModule() {}");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("extracts a .tar.gz archive", async () => {
    const archivePath = join(testDir, "plugin.tar.gz");
    execFileSync("tar", ["-czf", archivePath, "-C", testDir, "my-test-plugin"]);

    await extractArchive(archivePath, extractDir);

    const manifest = await readManifest(extractDir);
    expect(manifest.name).toBe("my-test-plugin");
    expect(manifest.version).toBe("1.0.0");
    expect(existsSync(join(extractDir, "backend", "index.js"))).toBe(true);
  });

  it("extracts a .zip archive", async () => {
    const archivePath = join(testDir, "plugin.zip");
    execFileSync("zip", ["-r", archivePath, "my-test-plugin"], { cwd: testDir });

    const zipExtractDir = join(testDir, "zip-extracted");
    await extractArchive(archivePath, zipExtractDir);

    const manifest = await readManifest(zipExtractDir);
    expect(manifest.name).toBe("my-test-plugin");
    expect(existsSync(join(zipExtractDir, "backend", "index.js"))).toBe(true);
  });

  it("rejects unsupported format", async () => {
    const fakePath = join(testDir, "plugin.rar");
    writeFileSync(fakePath, "fake");
    await expect(extractArchive(fakePath, extractDir)).rejects.toThrow("Unsupported archive format");
  });

  it("installs plugin from local archive via service", async () => {
    const db = new (await import("bun:sqlite")).Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "plugins", pluginsMigrations);
    const svc = new PluginManagerService(db, () => null, mockConfig);

    const archivePath = join(testDir, "install-test.tar.gz");
    execFileSync("tar", ["-czf", archivePath, "-C", testDir, "my-test-plugin"]);

    const plugin = await svc.installFromFile(archivePath);
    expect(plugin.name).toBe("my-test-plugin");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.status).toBe("active");
    expect(existsSync(plugin.install_path)).toBe(true);

    // Cleanup
    rmSync(plugin.install_path, { recursive: true, force: true });
    db.close();
  });
});
