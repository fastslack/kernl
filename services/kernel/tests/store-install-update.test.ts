/**
 * `installFromStore()` on an extension that is ALREADY installed.
 *
 * The dashboard's "Update to vX" button routes here — `acquire()` sees an owned
 * item and calls `/api/store/install`. That path went straight to
 * `installFromBundle`, which refuses outright when the slug exists
 * ("Extension already installed… Use update() to upgrade."), so the one button
 * a user has for updating a paid extension could not update anything.
 * `ExtensionService.update()` existed the whole time and nothing called it.
 *
 * The download had no timeout either, anywhere in the chain, so a stalled
 * store request left the button on "Installing…" forever with no error to show.
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
import { installFromStore } from "../src/modules/store/install.js";

const baseManifest = {
  $schema: "kernl://extension/v1",
  id: "com.kernl.test.livetv",
  slug: "livetv",
  name: "Live TV",
  version: "1.0.0",
  type: "module",
  description: "A test extension used to exercise the store update path.",
  author: "Test Suite",
  license: "Commercial",
  category: "leisure",
  backend: { entry: "backend/index.js" },
};

async function buildBundle(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  body = "export const V = 1;\n",
): Promise<string> {
  const staging = join(root, `src-${name}`);
  await mkdir(join(staging, "backend"), { recursive: true });
  await writeFile(join(staging, "extension.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(staging, "backend/index.js"), body);
  const out = join(root, `${name}.kernlext`);
  await packBundle(staging, out);
  return out;
}

function makeService(db: Database, extensionsDir: string): ExtensionService {
  const deps: InstallerDeps = {
    db,
    skillRegistry: null,
    agentsFacade: null,
    notificationRegistry: null,
    themeSubsystem: null,
    sandboxDriverRegistry: null,
    llmProviderRegistry: null,
  };
  return new ExtensionService(db, { extensionsDir, installerDeps: deps, licenseHas: () => true });
}

function fakeFetch(catalog: unknown[], bundlePath: string): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/store/catalog")) {
      return new Response(JSON.stringify({ items: catalog }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/store/download")) {
      return new Response(new Uint8Array(await readFile(bundlePath)), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const catalogFor = (version: string) => [
  { slug: "livetv", name: "Live TV", feature: "pro:livetv", version, type: "extension" },
];

let root: string;
let db: Database;
let service: ExtensionService;

beforeEach(async () => {
  root = await makeTempDir("store-install-update-test");
  db = new Database(":memory:");
  runMigrations(db, "extensions", extensionsMigrations);
  service = makeService(db, join(root, "data", "extensions"));
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("installFromStore() when the extension is already installed", () => {
  it("upgrades in place instead of refusing", async () => {
    const v1 = await buildBundle(root, "v1", baseManifest, "export const V = 1;\n");
    await service.installFromBundle(v1, { type: "file", filename: v1 });

    const v2 = await buildBundle(root, "v2", { ...baseManifest, version: "2.0.0" }, "export const V = 2;\n");
    const result = await installFromStore({
      storeUrl: "https://store.example",
      slug: "livetv",
      licenseJwt: "jwt",
      getExtensionService: () => service,
      fetchImpl: fakeFetch(catalogFor("2.0.0"), v2),
    });

    expect(result.kind).toBe("extension");
    expect(service.getBySlug("livetv")?.version).toBe("2.0.0");
  });

  it("still installs normally when it is not installed yet", async () => {
    const v1 = await buildBundle(root, "v1", baseManifest);
    await installFromStore({
      storeUrl: "https://store.example",
      slug: "livetv",
      licenseJwt: "jwt",
      getExtensionService: () => service,
      fetchImpl: fakeFetch(catalogFor("1.0.0"), v1),
    });
    expect(service.getBySlug("livetv")?.version).toBe("1.0.0");
  });

  it("says the version is already current rather than 'already installed'", async () => {
    // The old message told the user to "use update()", which is not something
    // a person clicking a button can do.
    const v1 = await buildBundle(root, "v1", baseManifest);
    await service.installFromBundle(v1, { type: "file", filename: v1 });

    const again = await buildBundle(root, "same", baseManifest);
    await expect(
      installFromStore({
        storeUrl: "https://store.example",
        slug: "livetv",
        licenseJwt: "jwt",
        getExtensionService: () => service,
        fetchImpl: fakeFetch(catalogFor("1.0.0"), again),
      }),
    ).rejects.toThrow(/already at/i);
  });

  it("gives up on a stalled download instead of hanging forever", async () => {
    // What left the button on "Installing…": with no timeout the promise never
    // settles, so the caller's `finally` never runs and the UI has nothing to
    // report.
    const stalling = (async (input: string | URL) => {
      if (String(input).includes("/store/catalog")) {
        return new Response(JSON.stringify({ items: catalogFor("2.0.0") }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Promise<Response>(() => {}); // never resolves
    }) as unknown as typeof fetch;

    await expect(
      installFromStore({
        storeUrl: "https://store.example",
        slug: "livetv",
        licenseJwt: "jwt",
        getExtensionService: () => service,
        fetchImpl: stalling,
        timeoutMs: 120,
      }),
    ).rejects.toThrow();
  });
});
