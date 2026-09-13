/**
 * Extension install / update / uninstall under Windows rules.
 *
 * Covers: archive members that could escape the target (drive-qualified and
 * backslash forms included), which tar gets spawned per platform, updates of
 * built-in extensions landing in the writable data dir, the boot re-seed not
 * reverting such an update, the per-slug lock, and a live folder Windows will
 * not let go of (moved beside, trashed, purged at next boot).
 *
 * Windows file locks cannot be produced on Linux, so they are simulated by
 * injecting the service's directory move/delete.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, writeFile, rm, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { extensionsMigrations } from "../src/modules/extensions/migrations.js";
import { ExtensionService, type ExtensionServiceOptions } from "../src/modules/extensions/service.js";
import { packBundle, makeTempDir, tarBinary, isUnsafeMember } from "../src/modules/extensions/bundle.js";
import type { InstallerDeps } from "../src/modules/extensions/installer.js";

const baseManifest = {
  $schema: "kernl://extension/v1",
  id: "com.kernl.test.widget",
  slug: "widget",
  name: "Widget",
  version: "1.0.0",
  type: "module",
  description: "A test extension used to exercise Windows update rules.",
  author: "Test Suite",
  license: "MIT",
  category: "utility",
  backend: { entry: "backend/index.js" },
};

async function writeSource(dir: string, manifest: Record<string, unknown>, backend: string): Promise<void> {
  await mkdir(join(dir, "backend"), { recursive: true });
  await writeFile(join(dir, "extension.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, "backend/index.js"), backend);
}

async function buildBundle(root: string, name: string, manifest: Record<string, unknown>, backend: string): Promise<string> {
  const staging = join(root, `src-${name}`);
  await writeSource(staging, manifest, backend);
  const bundlePath = join(root, `${name}.kernl`);
  await packBundle(staging, bundlePath);
  return bundlePath;
}

function lockError(code = "EPERM"): Error {
  return Object.assign(new Error(`${code}: operation not permitted (simulated lock)`), { code });
}

let workRoot: string;
let extensionsDir: string;
let db: Database;
let unregistered: string[];

function makeService(extra: Partial<ExtensionServiceOptions> = {}): ExtensionService {
  const deps: InstallerDeps = {
    db,
    skillRegistry: null,
    agentsFacade: null,
    notificationRegistry: null,
    themeSubsystem: null,
    sandboxDriverRegistry: null,
    llmProviderRegistry: null,
    moduleRegistry: {
      unregisterModule: async (name) => {
        unregistered.push(name);
        return true;
      },
    },
  };
  return new ExtensionService(db, { extensionsDir, installerDeps: deps, ...extra });
}

beforeEach(async () => {
  workRoot = await makeTempDir("ext-win-test");
  extensionsDir = join(workRoot, "data", "extensions");
  db = new Database(":memory:");
  runMigrations(db, "extensions", extensionsMigrations);
  unregistered = [];
});

afterEach(async () => {
  db.close();
  await rm(workRoot, { recursive: true, force: true }).catch(() => {});
});

describe("isUnsafeMember", () => {
  it("rejects absolute, drive-qualified and escaping members in either separator", () => {
    for (const m of ["/etc/passwd", "\\Windows\\x", "//host/share/x", "C:foo", "c:\\x", "D:/x", "..\\x", "a/../../b", "a\\..\\b", ".."]) {
      expect(isUnsafeMember(m)).toBe(true);
    }
  });

  it("accepts ordinary members, including names that merely start with dots", () => {
    for (const m of ["./", "./extension.json", "backend/index.js", "..hidden/file", "a/b..c/d"]) {
      expect(isUnsafeMember(m)).toBe(false);
    }
  });
});

describe("tarBinary", () => {
  it("uses System32's bsdtar by full path on Windows", () => {
    expect(tarBinary("win32", { SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\tar.exe");
    expect(tarBinary("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("uses tar from PATH elsewhere", () => {
    expect(tarBinary("linux", {})).toBe("tar");
    expect(tarBinary("darwin", {})).toBe("tar");
  });
});

describe("built-in extension updates", () => {
  let bundledDir: string;

  beforeEach(async () => {
    // Stands in for C:\Program Files\Kernl\assets\extensions\… — read-only in real life.
    bundledDir = join(workRoot, "app", "assets", "extensions", "widget");
    await writeSource(bundledDir, baseManifest, "export const V = 1;\n");
  });

  it("installs the update into the data dir and leaves the bundled copy untouched", async () => {
    const service = makeService();
    const row = await service.installFromDirectory(bundledDir, { type: "bundled" });
    const v2 = await buildBundle(workRoot, "widget-v2", { ...baseManifest, version: "1.1.0" }, "export const V = 2;\n");

    const r = await service.update(v2, { type: "file", filename: v2 });

    const target = join(extensionsDir, "widget");
    expect(r.extension.install_path).toBe(target);
    expect(service.get(row.id)!.install_path).toBe(target);
    expect(await readFile(join(target, "backend/index.js"), "utf-8")).toContain("V = 2");
    const bundled = JSON.parse(await readFile(join(bundledDir, "extension.json"), "utf-8"));
    expect(bundled.version).toBe("1.0.0");
    expect(await readFile(join(bundledDir, "backend/index.js"), "utf-8")).toContain("V = 1");
  });

  it("does not let the boot re-seed revert a newer update to the older bundled version", async () => {
    const service = makeService();
    const row = await service.installFromDirectory(bundledDir, { type: "bundled" });
    const v2 = await buildBundle(workRoot, "widget-v2", { ...baseManifest, version: "1.1.0" }, "export const V = 2;\n");
    await service.update(v2, { type: "file", filename: v2 });

    const changed = await service.refreshFromDirectory(row.id, bundledDir);

    expect(changed).toBe(false);
    const stored = service.get(row.id)!;
    expect(stored.version).toBe("1.1.0");
    expect(stored.install_path).toBe(join(extensionsDir, "widget"));
    expect(await readFile(join(stored.install_path, "backend/index.js"), "utf-8")).toContain("V = 2");
  });

  it("still ships a bundled version newer than the data-dir copy", async () => {
    const service = makeService();
    const row = await service.installFromDirectory(bundledDir, { type: "bundled" });
    const v2 = await buildBundle(workRoot, "widget-v2", { ...baseManifest, version: "1.1.0" }, "export const V = 2;\n");
    await service.update(v2, { type: "file", filename: v2 });

    // A kernel upgrade ships 2.0.0 in the bundle.
    await writeSource(bundledDir, { ...baseManifest, version: "2.0.0" }, "export const V = 3;\n");
    const changed = await service.refreshFromDirectory(row.id, bundledDir);

    expect(changed).toBe(true);
    const stored = service.get(row.id)!;
    expect(stored.version).toBe("2.0.0");
    expect(await readFile(join(stored.install_path, "backend/index.js"), "utf-8")).toContain("V = 3");
  });

  it("never deletes the bundled copy on uninstall", async () => {
    const service = makeService();
    const row = await service.installFromDirectory(bundledDir, { type: "bundled" });

    await service.uninstall(row.id);

    expect(service.get(row.id)).toBeNull();
    expect(existsSync(join(bundledDir, "extension.json"))).toBe(true);
  });
});

describe("per-slug lock", () => {
  it("refuses a second update of the same extension while the first is running", async () => {
    const slowRename = async (from: string, to: string) => {
      await new Promise((r) => setTimeout(r, 150));
      await rename(from, to);
    };
    const service = makeService({ renameDir: slowRename });
    const v1 = await buildBundle(workRoot, "widget-v1", baseManifest, "export const V = 1;\n");
    await service.installFromBundle(v1, { type: "file", filename: v1 });
    const v2 = await buildBundle(workRoot, "widget-v2", { ...baseManifest, version: "1.1.0" }, "export const V = 2;\n");

    const results = await Promise.allSettled([
      service.update(v2, { type: "file", filename: v2 }),
      service.update(v2, { type: "file", filename: v2 }),
    ]);

    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/already running/);
    expect(service.getBySlug("widget")!.version).toBe("1.1.0");
  });

  it("releases the lock after a failed update", async () => {
    const service = makeService();
    const v1 = await buildBundle(workRoot, "widget-v1", baseManifest, "export const V = 1;\n");
    await service.installFromBundle(v1, { type: "file", filename: v1 });
    const same = await buildBundle(workRoot, "widget-same", baseManifest, "export const V = 1;\n");

    await expect(service.update(same, { type: "file", filename: same })).rejects.toThrow(/nothing to update/);
    const v2 = await buildBundle(workRoot, "widget-v2", { ...baseManifest, version: "1.1.0" }, "export const V = 2;\n");
    const r = await service.update(v2, { type: "file", filename: v2 });
    expect(r.to).toBe("1.1.0");
  });
});

describe("folders Windows will not release", () => {
  it("unloads the module, installs beside the locked folder, and purges it at next boot", async () => {
    const liveDir = join(extensionsDir, "widget");
    const locked = new Set([liveDir]);
    const lockedRename = async (from: string, to: string) => {
      if (locked.has(from)) throw lockError("EPERM");
      await rename(from, to);
    };
    const lockedRemove = async (dir: string) => {
      if (locked.has(dir)) throw lockError("EBUSY");
      await rm(dir, { recursive: true, force: true });
    };
    const service = makeService({ platform: "win32", renameDir: lockedRename, removeDir: lockedRemove });
    const v1 = await buildBundle(workRoot, "widget-v1", baseManifest, "export const V = 1;\n");
    await service.installFromBundle(v1, { type: "file", filename: v1 });
    const v2 = await buildBundle(workRoot, "widget-v2", { ...baseManifest, version: "1.1.0" }, "export const V = 2;\n");

    const r = await service.update(v2, { type: "file", filename: v2 });

    expect(unregistered).toContain("ext:widget");
    expect(r.extension.install_path).not.toBe(liveDir);
    expect(basename(r.extension.install_path).startsWith("widget@1.1.0")).toBe(true);
    expect(await readFile(join(r.extension.install_path, "backend/index.js"), "utf-8")).toContain("V = 2");
    // Could be neither moved nor deleted: recorded for the next boot.
    expect(existsSync(liveDir)).toBe(true);
    const pending = JSON.parse(await readFile(join(extensionsDir, ".trash", "pending.json"), "utf-8"));
    expect(pending).toContain(liveDir);

    // Next boot: the process that held the folder is gone.
    locked.clear();
    await service.purgeTrash();
    expect(existsSync(liveDir)).toBe(false);
    expect(existsSync(r.extension.install_path)).toBe(true);
    expect(JSON.parse(await readFile(join(extensionsDir, ".trash", "pending.json"), "utf-8"))).toEqual([]);
  });

  it("lets a reinstall proceed after an uninstall left a locked folder behind", async () => {
    const liveDir = join(extensionsDir, "widget");
    const locked = new Set([liveDir]);
    const lockedRename = async (from: string, to: string) => {
      if (locked.has(from)) throw lockError("EPERM");
      await rename(from, to);
    };
    const lockedRemove = async (dir: string) => {
      if (locked.has(dir)) throw lockError("EBUSY");
      await rm(dir, { recursive: true, force: true });
    };
    const service = makeService({ platform: "win32", renameDir: lockedRename, removeDir: lockedRemove });
    const v1 = await buildBundle(workRoot, "widget-v1", baseManifest, "export const V = 1;\n");
    const row = await service.installFromBundle(v1, { type: "file", filename: v1 });

    await service.uninstall(row.id);
    expect(service.get(row.id)).toBeNull();

    const again = await service.installFromBundle(v1, { type: "file", filename: v1 });
    expect(again.install_path).not.toBe(liveDir);
    expect(await readFile(join(again.install_path, "backend/index.js"), "utf-8")).toContain("V = 1");
  });

  it("keeps POSIX behaviour: a failed move is an error, and nothing changes", async () => {
    const failingRename = async () => {
      throw lockError("EPERM");
    };
    const service = makeService({ platform: "linux", renameDir: failingRename });
    const v1 = await buildBundle(workRoot, "widget-v1", baseManifest, "export const V = 1;\n");
    const row = await service.installFromBundle(v1, { type: "file", filename: v1 });
    const v2 = await buildBundle(workRoot, "widget-v2", { ...baseManifest, version: "1.1.0" }, "export const V = 2;\n");

    await expect(service.update(v2, { type: "file", filename: v2 })).rejects.toThrow(/EPERM/);

    const stored = service.get(row.id)!;
    expect(stored.version).toBe("1.0.0");
    expect(stored.install_path).toBe(join(extensionsDir, "widget"));
    expect(unregistered).toHaveLength(0);
  });
});
