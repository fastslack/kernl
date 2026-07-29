/**
 * runStoreUpdates() — the store auto-update engine.
 *
 * Covers: newer store version gets downloaded + applied via
 * ExtensionService.update() (report.updated carries from/to); equal version
 * is skipped; a catalog item the license doesn't cover is left untouched;
 * and — the free-user path — licenseJwt()===null short-circuits before any
 * fetch happens at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { extensionsMigrations } from "../src/modules/extensions/migrations.js";
import { ExtensionService } from "../src/modules/extensions/service.js";
import { packBundle, makeTempDir } from "../src/modules/extensions/bundle.js";
import type { InstallerDeps } from "../src/modules/extensions/installer.js";
import { runStoreUpdates, type StoreUpdateDeps } from "../src/modules/store/auto-update.js";

// No `pricing` field here on purpose: that field drives ExtensionService's own
// bundle-signature entitlement check (unrelated, requires a real vendor
// signature). The store's paid-ness is a separate, catalog-level concept —
// gated by `deps.licenseHas(item.feature)` — which is what this suite tests.
const baseManifest = {
  $schema: "kernl://extension/v1",
  id: "com.kernl.test.trading",
  slug: "trading",
  name: "Trading Suite",
  version: "1.0.0",
  type: "module",
  description: "A test extension used to exercise the store auto-updater.",
  author: "Test Suite",
  license: "Commercial",
  category: "utility",
  backend: { entry: "backend/index.js" },
};

async function buildBundle(
  workRoot: string,
  name: string,
  manifest: Record<string, unknown>,
  backendSource = "export function createModule() { return { name: 'trading' }; }\n",
): Promise<string> {
  const staging = join(workRoot, `src-${name}`);
  await mkdir(join(staging, "backend"), { recursive: true });
  await writeFile(join(staging, "extension.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(staging, "backend/index.js"), backendSource);
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
  return new ExtensionService(db, { extensionsDir, installerDeps: deps, licenseHas });
}

/** A fetchImpl that serves /store/catalog from `catalogItems` and, for
 *  /store/download?slug=..., the bytes of `bundlePath` (read fresh each call). */
function makeFakeFetch(
  catalogItems: unknown[],
  bundlePath: string,
  onCall?: (url: string) => void,
): typeof fetch {
  return (async (input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    onCall?.(url);
    if (url.includes("/store/catalog")) {
      return new Response(JSON.stringify({ items: catalogItems }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/store/download")) {
      const bytes = await readFile(bundlePath);
      return new Response(new Uint8Array(bytes), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let workRoot: string;
let db: Database;
let service: ExtensionService;
let extensionsDir: string;

beforeEach(async () => {
  workRoot = await makeTempDir("store-auto-update-test");
  extensionsDir = join(workRoot, "data", "extensions");
  db = new Database(":memory:");
  runMigrations(db, "extensions", extensionsMigrations);
  service = makeService(db, extensionsDir, () => true);
});

afterEach(async () => {
  db.close();
  await rm(workRoot, { recursive: true, force: true }).catch(() => {});
});

describe("runStoreUpdates()", () => {
  it("applies a newer store version and reports from/to", async () => {
    const v1 = await buildBundle(workRoot, "trading-v1", baseManifest, "export const V = 1;\n");
    await service.installFromBundle(v1, { type: "file", filename: v1 });

    const v2Manifest = { ...baseManifest, version: "1.1.0", name: "Trading Suite Pro" };
    const v2 = await buildBundle(workRoot, "trading-v2", v2Manifest, "export const V = 2;\n");

    const catalog = [{ slug: "trading", name: "Trading Suite", feature: "pro:trading", version: "1.1.0", type: "extension" }];
    const fakeFetch = makeFakeFetch(catalog, v2);

    const deps: StoreUpdateDeps = {
      storeUrl: "https://store.example",
      getExtensionService: () => service,
      licenseHas: () => true,
      licenseJwt: () => "jwt-token",
      fetchImpl: fakeFetch,
    };

    const report = await runStoreUpdates(deps);

    expect(report.checked).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.errors).toBe(0);
    expect(report.updated).toHaveLength(1);
    expect(report.updated[0]).toMatchObject({ slug: "trading", from: "1.0.0", to: "1.1.0", ok: true });

    const stored = service.getBySlug("trading")!;
    expect(stored.version).toBe("1.1.0");
    const backendContent = await readFile(join(stored.install_path, "backend/index.js"), "utf-8");
    expect(backendContent).toContain("export const V = 2;");
  });

  it("skips an item whose store version equals the installed version", async () => {
    const v1 = await buildBundle(workRoot, "trading-v1", baseManifest);
    await service.installFromBundle(v1, { type: "file", filename: v1 });

    const catalog = [{ slug: "trading", name: "Trading Suite", feature: "pro:trading", version: "1.0.0", type: "extension" }];
    const fakeFetch = makeFakeFetch(catalog, v1);

    const deps: StoreUpdateDeps = {
      storeUrl: "https://store.example",
      getExtensionService: () => service,
      licenseHas: () => true,
      licenseJwt: () => "jwt-token",
      fetchImpl: fakeFetch,
    };

    const report = await runStoreUpdates(deps);

    expect(report.checked).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.errors).toBe(0);
    expect(report.updated).toHaveLength(0);

    const stored = service.getBySlug("trading")!;
    expect(stored.version).toBe("1.0.0");
  });

  it("leaves a catalog item untouched when the license doesn't cover its feature", async () => {
    const v1 = await buildBundle(workRoot, "trading-v1", baseManifest);
    await service.installFromBundle(v1, { type: "file", filename: v1 });

    const v2Manifest = { ...baseManifest, version: "1.1.0" };
    const v2 = await buildBundle(workRoot, "trading-v2", v2Manifest);

    const catalog = [{ slug: "trading", name: "Trading Suite", feature: "pro:trading", version: "1.1.0", type: "extension" }];
    const fakeFetch = makeFakeFetch(catalog, v2);

    const deps: StoreUpdateDeps = {
      storeUrl: "https://store.example",
      getExtensionService: () => service,
      licenseHas: () => false,
      licenseJwt: () => "jwt-token",
      fetchImpl: fakeFetch,
    };

    const report = await runStoreUpdates(deps);

    expect(report.checked).toBe(0);
    expect(report.updated).toHaveLength(0);
    expect(report.skipped).toBe(0);

    const stored = service.getBySlug("trading")!;
    expect(stored.version).toBe("1.0.0");
  });

  it("is a strict no-op with no fetch call at all when licenseJwt() is null", async () => {
    const v1 = await buildBundle(workRoot, "trading-v1", baseManifest);
    await service.installFromBundle(v1, { type: "file", filename: v1 });

    let fetchCalled = false;
    const catalog = [{ slug: "trading", name: "Trading Suite", feature: "pro:trading", version: "1.1.0", type: "extension" }];
    const fakeFetch = makeFakeFetch(catalog, v1, () => {
      fetchCalled = true;
    });

    const deps: StoreUpdateDeps = {
      storeUrl: "https://store.example",
      getExtensionService: () => service,
      licenseHas: () => true,
      licenseJwt: () => null,
      fetchImpl: fakeFetch,
    };

    const report = await runStoreUpdates(deps);

    expect(report).toEqual({ checked: 0, updated: [], skipped: 0, errors: 0 });
    expect(fetchCalled).toBe(false);
  });

  it("never throws and reports catalogError when the catalog fetch fails (store outage)", async () => {
    const v1 = await buildBundle(workRoot, "trading-v1", baseManifest);
    await service.installFromBundle(v1, { type: "file", filename: v1 });

    const failingFetch: typeof fetch = (async () => {
      return new Response("service unavailable", { status: 503 });
    }) as unknown as typeof fetch;

    const deps: StoreUpdateDeps = {
      storeUrl: "https://store.example",
      getExtensionService: () => service,
      licenseHas: () => true,
      licenseJwt: () => "jwt-token",
      fetchImpl: failingFetch,
    };

    const report = await runStoreUpdates(deps);

    expect(report.checked).toBe(0);
    expect(report.updated).toHaveLength(0);
    expect(report.skipped).toBe(0);
    expect(report.errors).toBeGreaterThanOrEqual(1);
    expect(report.catalogError).toBeTruthy();
    expect(report.catalogError).toContain("503");

    // The install itself is untouched — a catalog outage is a pure no-op on state.
    const stored = service.getBySlug("trading")!;
    expect(stored.version).toBe("1.0.0");
  });

  it("never throws when the catalog fetch itself rejects (network error)", async () => {
    const throwingFetch: typeof fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND store.example");
    }) as unknown as typeof fetch;

    const deps: StoreUpdateDeps = {
      storeUrl: "https://store.example",
      getExtensionService: () => service,
      licenseHas: () => true,
      licenseJwt: () => "jwt-token",
      fetchImpl: throwingFetch,
    };

    const report = await runStoreUpdates(deps);

    expect(report.errors).toBeGreaterThanOrEqual(1);
    expect(report.catalogError).toContain("ENOTFOUND");
  });
});
