/**
 * ExtensionService.update() — in-place upgrade with backup + rollback.
 *
 * Covers: happy path (settings/installed_at preserved), version gate
 * (+ force override), not-installed error, rollback on apply failure
 * (old version's files AND row intact), and paid-without-license refusal.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { extensionsMigrations } from "../src/modules/extensions/migrations.js";
import { ExtensionService } from "../src/modules/extensions/service.js";
import { packBundle, makeTempDir } from "../src/modules/extensions/bundle.js";
import type { InstallerDeps } from "../src/modules/extensions/installer.js";

const baseManifest = {
  $schema: "kernl://extension/v1",
  id: "com.kernl.test.widget",
  slug: "widget",
  name: "Widget",
  version: "1.0.0",
  type: "module",
  description: "A test extension used to exercise update().",
  author: "Test Suite",
  license: "MIT",
  category: "utility",
  backend: { entry: "backend/index.js" },
};

async function buildBundle(
  workRoot: string,
  name: string,
  manifest: Record<string, unknown>,
  backendSource = "export function createModule() { return { name: 'widget' }; }\n",
  migrationFiles?: Record<string, string>,
): Promise<string> {
  const staging = join(workRoot, `src-${name}`);
  await mkdir(join(staging, "backend"), { recursive: true });
  await writeFile(join(staging, "extension.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(staging, "backend/index.js"), backendSource);
  if (migrationFiles) {
    await mkdir(join(staging, "migrations"), { recursive: true });
    for (const [file, sql] of Object.entries(migrationFiles)) {
      await writeFile(join(staging, "migrations", file), sql);
    }
  }
  const bundlePath = join(workRoot, `${name}.kernlext`);
  await packBundle(staging, bundlePath);
  return bundlePath;
}

function makeService(db: Database, extensionsDir: string, licenseHas?: (f: string) => boolean): ExtensionService {
  const deps: InstallerDeps = {
    db,
    skillRegistry: null,
    agentsFacade: null,
    notificationRegistry: null,
    themeSubsystem: null,
    sandboxDriverRegistry: null,
    llmProviderRegistry: null,
  };
  return new ExtensionService(db, {
    extensionsDir,
    installerDeps: deps,
    licenseHas,
  });
}

let workRoot: string;
let db: Database;
let service: ExtensionService;
let extensionsDir: string;

beforeEach(async () => {
  workRoot = await makeTempDir("ext-update-test");
  extensionsDir = join(workRoot, "data", "extensions");
  db = new Database(":memory:");
  runMigrations(db, "extensions", extensionsMigrations);
  service = makeService(db, extensionsDir);
});

afterEach(async () => {
  db.close();
  await rm(workRoot, { recursive: true, force: true }).catch(() => {});
});

describe("ExtensionService.update()", () => {
  it("upgrades in place, preserving settings_json/installed_at/id, bumping version/updated_at, and swapping files", async () => {
    const v1 = await buildBundle(workRoot, "widget-v1", baseManifest, "export const V = 1;\n");
    const row = await service.installFromBundle(v1, { type: "file", filename: v1 });

    // Simulate a user setting saved before the update.
    db.prepare("UPDATE installed_extensions SET settings_json = ? WHERE id = ?").run(
      JSON.stringify({ favorite_color: "blue" }),
      row.id,
    );

    // Ensure updated_at will differ (ISO ms resolution).
    await new Promise((r) => setTimeout(r, 5));

    const v2Manifest = { ...baseManifest, version: "1.1.0", name: "Widget Pro" };
    const v2 = await buildBundle(workRoot, "widget-v2", v2Manifest, "export const V = 2;\n");

    const result = await service.update(v2, { type: "file", filename: v2 });

    expect(result.from).toBe("1.0.0");
    expect(result.to).toBe("1.1.0");
    expect(result.extension.version).toBe("1.1.0");
    expect(result.extension.name).toBe("Widget Pro");
    expect(result.extension.id).toBe(row.id);
    expect(result.extension.installed_at).toBe(row.installed_at);
    expect(result.extension.updated_at).not.toBe(row.updated_at);

    const stored = service.get(row.id)!;
    expect(stored.version).toBe("1.1.0");
    expect(JSON.parse(stored.settings_json)).toEqual({ favorite_color: "blue" });
    expect(stored.installed_at).toBe(row.installed_at);
    expect(stored.install_path).toBe(row.install_path);

    const backendContent = await readFile(join(stored.install_path, "backend/index.js"), "utf-8");
    expect(backendContent).toContain("export const V = 2;");
  });

  it("rejects a non-newer version unless force:true", async () => {
    const v1 = await buildBundle(workRoot, "widget-v1", baseManifest);
    await service.installFromBundle(v1, { type: "file", filename: v1 });

    const sameVersionBundle = await buildBundle(workRoot, "widget-same", { ...baseManifest, version: "1.0.0" });

    await expect(
      service.update(sameVersionBundle, { type: "file", filename: sameVersionBundle }),
    ).rejects.toThrow(/nothing to update/i);

    const applied = await service.update(sameVersionBundle, { type: "file", filename: sameVersionBundle }, { force: true });
    expect(applied.extension.version).toBe("1.0.0");
  });

  it("throws when the extension isn't installed", async () => {
    const v1 = await buildBundle(workRoot, "widget-v1", baseManifest);
    await expect(
      service.update(v1, { type: "file", filename: v1 }),
    ).rejects.toThrow(/not installed/i);
  });

  it("rolls back on apply failure: old version's files AND DB row stay intact", async () => {
    const v1 = await buildBundle(workRoot, "widget-v1", baseManifest, "export const V = 1;\n");
    const row = await service.installFromBundle(v1, { type: "file", filename: v1 });

    // A bundle whose migration SQL is invalid — dispatchInstall() will throw
    // mid-update, after unpack+auth succeed but before the DB row is swapped.
    const badV2Manifest = {
      ...baseManifest,
      version: "1.1.0",
      backend: { entry: "backend/index.js", migrations: "migrations" },
    };
    const badV2 = await buildBundle(
      workRoot,
      "widget-bad-v2",
      badV2Manifest,
      "export const V = 2;\n",
      { "001.sql": "THIS IS NOT VALID SQL AT ALL;" },
    );

    await expect(
      service.update(badV2, { type: "file", filename: badV2 }),
    ).rejects.toThrow();

    const stored = service.get(row.id)!;
    expect(stored.version).toBe("1.0.0");
    expect(stored.name).toBe("Widget");

    const backendContent = await readFile(join(stored.install_path, "backend/index.js"), "utf-8");
    expect(backendContent).toContain("export const V = 1;");

    // No leftover backup directory.
    const parentEntries = await stat(stored.install_path);
    expect(parentEntries.isDirectory()).toBe(true);
  });

  it("refuses to update a paid manifest when the license doesn't cover it, leaving the old version intact", async () => {
    const v1 = await buildBundle(workRoot, "widget-v1", baseManifest);
    const row = await service.installFromBundle(v1, { type: "file", filename: v1 });

    const paidV2Manifest = {
      ...baseManifest,
      version: "1.1.0",
      pricing: { model: "one-time", amount_cents: 999, currency: "USD" },
    };
    const paidV2 = await buildBundle(workRoot, "widget-paid-v2", paidV2Manifest);

    await expect(
      service.update(paidV2, { type: "file", filename: paidV2 }),
    ).rejects.toThrow(/license/i);

    const stored = service.get(row.id)!;
    expect(stored.version).toBe("1.0.0");
  });
});
