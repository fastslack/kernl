/**
 * Characterization tests for ExtensionService's three install paths —
 * installFromBundle (applyInstall), installFromDirectory and
 * installFromManifest: the row they persist/return, and the rollback each one
 * performs when dispatchInstall fails (row deleted; applyInstall also removes
 * the extracted dir, the other two leave the files alone).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { extensionsMigrations } from "../src/modules/extensions/migrations.js";
import { ExtensionService } from "../src/modules/extensions/service.js";
import { packBundle, makeTempDir } from "../src/modules/extensions/bundle.js";
import type { InstallerDeps } from "../src/modules/extensions/installer.js";
import type { ExtensionManifest, InstalledExtension } from "../src/modules/extensions/types.js";

const baseManifest = {
  $schema: "kernl://extension/v1",
  id: "com.kernl.test.gadget",
  slug: "gadget",
  name: "Gadget",
  version: "1.0.0",
  type: "module",
  description: "A test extension used to exercise the install paths.",
  author: "Test Suite",
  license: "MIT",
  category: "utility",
  sdk: 1,
  permissions: ["network"],
  backend: { entry: "backend/index.js" },
};

const badMigrations = { "001.sql": "THIS IS NOT VALID SQL AT ALL;" };
const withBadMigrations = { ...baseManifest, backend: { entry: "backend/index.js", migrations: "migrations" } };

async function writeExtensionDir(dir: string, manifest: Record<string, unknown>, migrations?: Record<string, string>): Promise<void> {
  await mkdir(join(dir, "backend"), { recursive: true });
  await writeFile(join(dir, "extension.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, "backend/index.js"), "export function createModule() { return { name: 'gadget' }; }\n");
  if (migrations) {
    await mkdir(join(dir, "migrations"), { recursive: true });
    for (const [file, sql] of Object.entries(migrations)) await writeFile(join(dir, "migrations", file), sql);
  }
}

let workRoot: string;
let db: Database;
let service: ExtensionService;
let extensionsDir: string;

beforeEach(async () => {
  workRoot = await makeTempDir("ext-install-paths-test");
  extensionsDir = join(workRoot, "data", "extensions");
  db = new Database(":memory:");
  runMigrations(db, "extensions", extensionsMigrations);
  const deps: InstallerDeps = {
    db,
    skillRegistry: null,
    agentsFacade: null,
    notificationRegistry: null,
    themeSubsystem: null,
    sandboxDriverRegistry: null,
    llmProviderRegistry: null,
  };
  service = new ExtensionService(db, { extensionsDir, installerDeps: deps });
});

afterEach(async () => {
  db.close();
  await rm(workRoot, { recursive: true, force: true }).catch(() => {});
});

function expectFreshRow(row: InstalledExtension, installPath: string, source: unknown): void {
  expect(Object.keys(row)).toEqual([
    "id", "slug", "name", "version", "type", "status", "manifest_json", "source_json",
    "install_path", "granted_permissions_json", "settings_json", "error",
    "installed_at", "updated_at", "last_loaded_at", "install_receipt_json",
  ]);
  expect(row).toMatchObject({
    id: baseManifest.id,
    slug: "gadget",
    name: "Gadget",
    version: "1.0.0",
    type: "module",
    source_json: JSON.stringify(source),
    install_path: installPath,
    granted_permissions_json: JSON.stringify(["network"]),
    settings_json: "{}",
    error: "",
    last_loaded_at: null,
  });
  expect(row.status).not.toBe("installed_pending");
  expect(row.installed_at).toBe(row.updated_at);
  expect((JSON.parse(row.manifest_json) as ExtensionManifest).id).toBe(baseManifest.id);
  const stored = service.get(row.id)!;
  expect(stored.status).toBe(row.status);
  expect(stored.source_json).toBe(row.source_json);
  expect(stored.install_path).toBe(row.install_path);
  expect(stored.granted_permissions_json).toBe(row.granted_permissions_json);
  expect(stored.installed_at).toBe(row.installed_at);
}

describe("installFromBundle (applyInstall)", () => {
  it("persists and returns the fresh row", async () => {
    const staging = join(workRoot, "src");
    await writeExtensionDir(staging, baseManifest);
    const bundle = join(workRoot, "gadget.kernlext");
    await packBundle(staging, bundle);
    const source = { type: "file", filename: bundle } as const;

    const row = await service.installFromBundle(bundle, source);
    expectFreshRow(row, join(extensionsDir, "gadget"), source);
    expect(row.status).toBe("active");
  });

  it("on dispatch failure deletes the row AND the extracted dir", async () => {
    const staging = join(workRoot, "src-bad");
    await writeExtensionDir(staging, withBadMigrations, badMigrations);
    const bundle = join(workRoot, "gadget-bad.kernlext");
    await packBundle(staging, bundle);

    await expect(service.installFromBundle(bundle, { type: "file", filename: bundle })).rejects.toThrow();
    expect(service.get(baseManifest.id)).toBeNull();
    expect(existsSync(join(extensionsDir, "gadget"))).toBe(false);
  });
});

describe("installFromDirectory", () => {
  it("persists and returns the fresh row pointing at the source dir", async () => {
    const dir = join(workRoot, "bundled", "gadget");
    await writeExtensionDir(dir, baseManifest);
    const row = await service.installFromDirectory(dir);
    expectFreshRow(row, dir, { type: "local", path: dir });
    expect(row.status).toBe("active");
  });

  it("on dispatch failure deletes the row but leaves the source dir", async () => {
    const dir = join(workRoot, "bundled", "gadget");
    await writeExtensionDir(dir, withBadMigrations, badMigrations);
    await expect(service.installFromDirectory(dir, { type: "bundled" })).rejects.toThrow();
    expect(service.get(baseManifest.id)).toBeNull();
    expect(existsSync(join(dir, "extension.json"))).toBe(true);
  });

  it("refuses a duplicate", async () => {
    const dir = join(workRoot, "bundled", "gadget");
    await writeExtensionDir(dir, baseManifest);
    await service.installFromDirectory(dir);
    await expect(service.installFromDirectory(dir)).rejects.toThrow(`Extension already installed: ${baseManifest.id}`);
  });
});

describe("installFromManifest", () => {
  it("stages extension.json and persists the fresh row", async () => {
    const source = { type: "file", filename: "remote" } as const;
    const manifest = { ...baseManifest, backend: undefined } as unknown as ExtensionManifest;
    const row = await service.installFromManifest(manifest, source);
    const installPath = join(extensionsDir, "gadget");
    expectFreshRow(row, installPath, source);
    expect(existsSync(join(installPath, "extension.json"))).toBe(true);
  });

  it("on dispatch failure deletes the row but leaves the staged files", async () => {
    const installPath = join(extensionsDir, "gadget");
    await writeExtensionDir(installPath, withBadMigrations, badMigrations);
    await expect(
      service.installFromManifest(withBadMigrations as unknown as ExtensionManifest, { type: "file", filename: "remote" }),
    ).rejects.toThrow();
    expect(service.get(baseManifest.id)).toBeNull();
    expect(existsSync(join(installPath, "extension.json"))).toBe(true);
  });

  it("refuses a duplicate", async () => {
    const manifest = { ...baseManifest, backend: undefined } as unknown as ExtensionManifest;
    await service.installFromManifest(manifest, { type: "file", filename: "remote" });
    await expect(service.installFromManifest(manifest, { type: "file", filename: "remote" }))
      .rejects.toThrow(`Extension already installed: ${baseManifest.id}`);
  });
});
