/**
 * `store:auto-update` builtin handler (Task 5) — the cron wiring around the
 * Task-4 `runStoreUpdates` engine.
 *
 * Covers just the handler's own responsibilities (the engine itself is
 * exhaustively covered in tests/store-auto-update.test.ts):
 *   - `config.store.autoUpdate === false` → "auto-update disabled", no
 *     fetch, no notification (verifies the config gate).
 *   - `config.store.autoUpdate === true` with one pending update available →
 *     the notifier fires once with the from→to line + reload reminder, and
 *     the returned run-history summary counts the update.
 *
 * Exercises the handler through `createBuiltinHandlers()` (the same seam the
 * scheduler uses), with a real in-memory `ExtensionService` + a stubbed
 * global `fetch` standing in for the store HTTP API — mirrors the fixture
 * style already used by tests/store-auto-update.test.ts.
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
import { createBuiltinHandlers, type BuiltinHandlerContext } from "../src/modules/agents/builtin-handlers.js";

const baseManifest = {
  $schema: "kernl://extension/v1",
  id: "com.kernl.test.trading",
  slug: "trading",
  name: "Trading Suite",
  version: "1.0.0",
  type: "module",
  description: "A test extension used to exercise the store auto-update cron.",
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

function makeFakeFetch(catalogItems: unknown[], bundlePath: string, onCall?: (url: string) => void): typeof fetch {
  return (async (input: string | URL) => {
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

/** Records every notification instead of sending it. */
function recordingNotifier() {
  const sent: Array<{ title: string; body: string }> = [];
  return {
    sent,
    notifier: {
      async send(n: { title: string; body: string }) { sent.push(n); return true; },
      async broadcast() { return true; },
      getRegistry() { return null; },
    },
  };
}

let workRoot: string;
let db: Database;
let service: ExtensionService;
let extensionsDir: string;
let originalFetch: typeof fetch;

beforeEach(async () => {
  workRoot = await makeTempDir("store-auto-update-cron-test");
  extensionsDir = join(workRoot, "data", "extensions");
  db = new Database(":memory:");
  runMigrations(db, "extensions", extensionsMigrations);
  service = makeService(db, extensionsDir);
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  db.close();
  await rm(workRoot, { recursive: true, force: true }).catch(() => {});
});

describe("store:auto-update builtin handler", () => {
  it("is disabled by config.store.autoUpdate=false — no fetch, no notification", async () => {
    let fetchCalled = false;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      return originalFetch(...args);
    }) as typeof fetch;

    const { notifier, sent } = recordingNotifier();
    const ctx = {
      db: db as unknown as never,
      notifier,
      config: { store: { autoUpdate: false } },
      services: {
        getExtensionService: () => service,
        licenseHas: () => true,
        licenseJwt: () => "jwt-token",
      },
    } as unknown as BuiltinHandlerContext;

    const handlers = createBuiltinHandlers(ctx);
    const result = await handlers.get("store:auto-update")!();

    expect(result).toBe("auto-update disabled");
    expect(sent).toHaveLength(0);
    expect(fetchCalled).toBe(false);
  });

  it("applies a pending update, notifies, and counts it in the summary", async () => {
    const v1 = await buildBundle(workRoot, "trading-v1", baseManifest, "export const V = 1;\n");
    await service.installFromBundle(v1, { type: "file", filename: v1 });

    const v2Manifest = { ...baseManifest, version: "1.1.0", name: "Trading Suite Pro" };
    const v2 = await buildBundle(workRoot, "trading-v2", v2Manifest, "export const V = 2;\n");

    const catalog = [{ slug: "trading", name: "Trading Suite", feature: "pro:trading", version: "1.1.0", type: "extension" }];
    globalThis.fetch = makeFakeFetch(catalog, v2);

    const { notifier, sent } = recordingNotifier();
    const ctx = {
      db: db as unknown as never,
      notifier,
      config: { store: { autoUpdate: true } },
      services: {
        getExtensionService: () => service,
        licenseHas: () => true,
        licenseJwt: () => "jwt-token",
      },
    } as unknown as BuiltinHandlerContext;

    const handlers = createBuiltinHandlers(ctx);
    const result = await handlers.get("store:auto-update")!();

    expect(result).toContain("checked 1");
    expect(result).toContain("updated 1");

    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe("Extensions updated");
    expect(sent[0].body).toContain("trading: 1.0.0 → 1.1.0");
    expect(sent[0].body).toContain("Reload the kernel to activate.");

    const stored = service.getBySlug("trading")!;
    expect(stored.version).toBe("1.1.0");
  });
});
