/**
 * On-demand package provisioning for bundled extensions.
 *
 * The native payload deliberately omits a handful of heavy SDKs
 * (`packaging/stage-payload.sh`, ON_DEMAND), so the bundled extensions that
 * declare one land in `installed` instead of `active`. Two things make that
 * recoverable, and both are covered here:
 *
 *   • `refreshFromDirectory` must not drag a materialized extension back to
 *     the read-only bundle. It used to, which is why enabling Cinema on a
 *     native install worked right up until the first restart and then landed
 *     in `error`.
 *
 *   • `promoteIfUnblocked` is what turns a parked row into an active one once
 *     the packages are on disk — at boot, before anything loads, so the
 *     extension comes up wired like any other.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ModuleRegistry } from "../src/core/module-registry.js";
import type { ModuleContext } from "../src/core/types.js";
import { EventBus } from "../src/core/event-bus.js";
import { createExtensionsModule } from "../src/modules/extensions/index.js";
import { makeTempDir } from "../src/modules/extensions/bundle.js";
import type { ExtensionService } from "../src/modules/extensions/service.js";

const SDK = "@example/heavy-sdk";

function manifestFor(opts: { packages?: boolean; requiresActivation?: boolean }) {
  return {
    $schema: "kernl://extension/v1",
    id: "com.kernl.test.parked",
    slug: "parked",
    name: "Parked",
    version: "1.0.0",
    type: "module",
    description: "Bundled extension that declares an on-demand package.",
    author: "Test Suite",
    license: "MIT",
    category: "utility",
    ...(opts.requiresActivation ? { requires_activation: true } : {}),
    backend: {
      entry: "backend/entry.js",
      ...(opts.packages ? { packages: { [SDK]: "1.0.0" } } : {}),
    },
  };
}

function fakeCtx(sqlite: Database): ModuleContext {
  return {
    sqlite: sqlite as unknown as ModuleContext["sqlite"],
    neo4j: { available: false } as unknown as ModuleContext["neo4j"],
    graph: null,
    events: new EventBus(),
    config: {} as ModuleContext["config"],
    systemRegistry: {} as ModuleContext["systemRegistry"],
    notifier: {} as ModuleContext["notifier"],
    license: {
      isPro: () => false,
      has: () => false,
      jwt: () => null,
      status: () => ({ status: "none" as const }),
      sku: () => null,
      set: async () => ({ status: "none" as const }),
      clear: async () => {},
      refresh: async () => ({ status: "none" as const }),
    },
  };
}

let workRoot: string;
let bundleDir: string;
let service: ExtensionService;

/** Write a manifest + entry into `dir`, creating it if needed. */
async function writeExtensionDir(dir: string, manifest: unknown): Promise<void> {
  await mkdir(join(dir, "backend"), { recursive: true });
  await writeFile(join(dir, "extension.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, "backend/entry.js"), "export function createModule() { return {}; }");
}

/** Make `pkg` resolvable from `dir` by planting a minimal node_modules entry. */
async function plantPackage(dir: string, pkg: string): Promise<void> {
  const pkgDir = join(dir, "node_modules", pkg);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0" }));
}

beforeEach(async () => {
  workRoot = await makeTempDir("extprov");
  // Stands in for assets/extensions/<slug> — the read-only shipped bundle.
  bundleDir = join(workRoot, "bundle", "parked");

  const sqlite = new Database(":memory:");
  const extensionsModule = createExtensionsModule({ dataPath: join(workRoot, "data") });
  const registry = new ModuleRegistry();
  registry.register(extensionsModule);
  await registry.initializeAll(fakeCtx(sqlite));
  service = extensionsModule.service;
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true }).catch(() => {});
});

describe("bundled extension with unresolvable packages", () => {
  it("installs as `installed`, not `active`", async () => {
    await writeExtensionDir(bundleDir, manifestFor({ packages: true }));
    const row = await service.installFromDirectory(bundleDir, { type: "bundled" });
    expect(row.status).toBe("installed");
  });

  it("installs as `active` when it declares no packages", async () => {
    await writeExtensionDir(bundleDir, manifestFor({}));
    const row = await service.installFromDirectory(bundleDir, { type: "bundled" });
    expect(row.status).toBe("active");
  });

  it("is reported by pendingPackageInstalls()", async () => {
    await writeExtensionDir(bundleDir, manifestFor({ packages: true }));
    await service.installFromDirectory(bundleDir, { type: "bundled" });
    expect(service.pendingPackageInstalls().map((r) => r.slug)).toEqual(["parked"]);
  });

  it("is NOT reported when it declares requires_activation (ask me first)", async () => {
    await writeExtensionDir(bundleDir, manifestFor({ packages: true, requiresActivation: true }));
    await service.installFromDirectory(bundleDir, { type: "bundled" });
    expect(service.pendingPackageInstalls()).toEqual([]);
  });
});

describe("promoteIfUnblocked", () => {
  it("promotes once the packages resolve from the install path", async () => {
    await writeExtensionDir(bundleDir, manifestFor({ packages: true }));
    const row = await service.installFromDirectory(bundleDir, { type: "bundled" });
    expect(row.status).toBe("installed");

    await plantPackage(bundleDir, SDK);

    expect(service.promoteIfUnblocked(row.id)).toBe(true);
    expect(service.get(row.id)?.status).toBe("active");
  });

  it("leaves the row alone while the packages are still missing", async () => {
    await writeExtensionDir(bundleDir, manifestFor({ packages: true }));
    const row = await service.installFromDirectory(bundleDir, { type: "bundled" });

    expect(service.promoteIfUnblocked(row.id)).toBe(false);
    expect(service.get(row.id)?.status).toBe("installed");
  });

  it("never revives an extension the user disabled", async () => {
    await writeExtensionDir(bundleDir, manifestFor({ packages: true }));
    const row = await service.installFromDirectory(bundleDir, { type: "bundled" });
    await plantPackage(bundleDir, SDK);
    await service.disable(row.id);

    expect(service.promoteIfUnblocked(row.id)).toBe(false);
    expect(service.get(row.id)?.status).toBe("disabled");
  });

  it("respects requires_activation even when everything resolves", async () => {
    await writeExtensionDir(bundleDir, manifestFor({ packages: true, requiresActivation: true }));
    const row = await service.installFromDirectory(bundleDir, { type: "bundled" });
    await plantPackage(bundleDir, SDK);

    expect(service.promoteIfUnblocked(row.id)).toBe(false);
    expect(service.get(row.id)?.status).toBe("installed");
  });
});

describe("refreshFromDirectory and materialized extensions", () => {
  it("keeps install_path pointing at the writable copy once materialized", async () => {
    await writeExtensionDir(bundleDir, manifestFor({ packages: true }));
    const row = await service.installFromDirectory(bundleDir, { type: "bundled" });

    // Stand in for what ensureExtensionPackages does: copy out of the
    // read-only bundle into <data>/extensions/<slug>, with node_modules.
    const materialized = join(service.extensionsDir, "parked");
    await writeExtensionDir(materialized, manifestFor({ packages: true }));
    await plantPackage(materialized, SDK);
    service.setInstallPath(row.id, materialized);

    // Next boot: the seeder re-reads the shipped bundle for manifest edits.
    await service.refreshFromDirectory(row.id, bundleDir);

    expect(service.get(row.id)?.install_path).toBe(materialized);
    // And because the path survived, the packages still resolve → promotable.
    expect(service.promoteIfUnblocked(row.id)).toBe(true);
  });

  it("refreshes the materialized code when the shipped version moves", async () => {
    await writeExtensionDir(bundleDir, manifestFor({ packages: true }));
    const row = await service.installFromDirectory(bundleDir, { type: "bundled" });

    const materialized = join(service.extensionsDir, "parked");
    await writeExtensionDir(materialized, manifestFor({ packages: true }));
    await plantPackage(materialized, SDK);
    await writeFile(join(materialized, "package.json"), JSON.stringify({ name: "kernl-ext-parked" }));
    service.setInstallPath(row.id, materialized);

    // Kernel upgrade: the shipped bundle carries new code at a new version.
    await writeExtensionDir(bundleDir, { ...manifestFor({ packages: true }), version: "2.0.0" });
    await writeFile(join(bundleDir, "backend/entry.js"), "// v2\nexport function createModule() { return {}; }");
    await service.refreshFromDirectory(row.id, bundleDir);

    expect(service.get(row.id)?.install_path).toBe(materialized);
    expect(service.get(row.id)?.version).toBe("2.0.0");
    // New code arrived...
    expect(await readFile(join(materialized, "backend/entry.js"), "utf-8")).toContain("// v2");
    // ...and the things that make it runnable survived.
    expect(existsSync(join(materialized, "node_modules", SDK, "package.json"))).toBe(true);
    expect(JSON.parse(await readFile(join(materialized, "package.json"), "utf-8")).name).toBe(
      "kernl-ext-parked",
    );
  });

  it("still repoints a non-materialized extension at the shipped bundle", async () => {
    await writeExtensionDir(bundleDir, manifestFor({}));
    const row = await service.installFromDirectory(bundleDir, { type: "bundled" });

    const movedBundle = join(workRoot, "bundle2", "parked");
    await writeExtensionDir(movedBundle, { ...manifestFor({}), version: "1.1.0" });
    await service.refreshFromDirectory(row.id, movedBundle);

    expect(service.get(row.id)?.install_path).toBe(movedBundle);
    expect(service.get(row.id)?.version).toBe("1.1.0");
  });

  it("propagates manifest edits from disk without touching status", async () => {
    await writeExtensionDir(bundleDir, manifestFor({}));
    const row = await service.installFromDirectory(bundleDir, { type: "bundled" });
    expect(service.get(row.id)?.status).toBe("active");

    await writeExtensionDir(bundleDir, { ...manifestFor({}), version: "2.0.0" });
    const changed = await service.refreshFromDirectory(row.id, bundleDir);

    expect(changed).toBe(true);
    expect(service.get(row.id)?.version).toBe("2.0.0");
    expect(service.get(row.id)?.status).toBe("active");
  });
});
