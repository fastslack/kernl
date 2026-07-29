/**
 * kernel_extensions_update tool — manual update from a local .kernlext bundle
 * path. Thin wrapper around ExtensionService.update(); this test exercises
 * the tool handler (schema parsing + text formatting), not the service logic
 * (covered by extension-update.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { extensionsMigrations } from "../src/modules/extensions/migrations.js";
import { ExtensionService } from "../src/modules/extensions/service.js";
import { extensionsTools } from "../src/modules/extensions/tools.js";
import { packBundle, makeTempDir } from "../src/modules/extensions/bundle.js";
import type { InstallerDeps } from "../src/modules/extensions/installer.js";

const baseManifest = {
  $schema: "kernl://extension/v1",
  id: "com.kernl.test.widget-tool",
  slug: "widget-tool",
  name: "Widget Tool",
  version: "1.0.0",
  type: "module",
  description: "A test extension used to exercise the update tool.",
  author: "Test Suite",
  license: "MIT",
  category: "utility",
  backend: { entry: "backend/index.js" },
};

async function buildBundle(
  workRoot: string,
  name: string,
  manifest: Record<string, unknown>,
  backendSource = "export function createModule() { return { name: 'widget-tool' }; }\n",
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
  return new ExtensionService(db, { extensionsDir, installerDeps: deps });
}

let workRoot: string;
let db: Database;
let service: ExtensionService;
let extensionsDir: string;

beforeEach(async () => {
  workRoot = await makeTempDir("ext-update-tool-test");
  extensionsDir = join(workRoot, "data", "extensions");
  db = new Database(":memory:");
  runMigrations(db, "extensions", extensionsMigrations);
  service = makeService(db, extensionsDir);
});

afterEach(async () => {
  db.close();
  await rm(workRoot, { recursive: true, force: true }).catch(() => {});
});

describe("kernel_extensions_update tool", () => {
  it("updates an installed extension from a v2 bundle path and reports from → to", async () => {
    const v1 = await buildBundle(workRoot, "widget-tool-v1", baseManifest, "export const V = 1;\n");
    await service.installFromBundle(v1, { type: "file", filename: v1 });

    const v2Manifest = { ...baseManifest, version: "1.1.0", name: "Widget Tool Pro" };
    const v2 = await buildBundle(workRoot, "widget-tool-v2", v2Manifest, "export const V = 2;\n");

    const tools = extensionsTools(service);
    const updateTool = tools.find((t) => t.name === "kernel_extensions_update");
    expect(updateTool).toBeDefined();

    const result = await updateTool!.handler({ bundle_path: v2 });

    expect(result.content[0]?.text).toContain("1.0.0 → 1.1.0");
    expect(result.content[0]?.text).toContain("widget-tool");

    const stored = service.getBySlug("widget-tool")!;
    expect(stored.version).toBe("1.1.0");
    expect(stored.name).toBe("Widget Tool Pro");
  });

  it("surfaces service errors as an error result instead of throwing", async () => {
    const v1 = await buildBundle(workRoot, "widget-tool-v1b", baseManifest);
    const tools = extensionsTools(service);
    const updateTool = tools.find((t) => t.name === "kernel_extensions_update")!;

    const result = await updateTool.handler({ bundle_path: v1 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not installed/i);
  });
});
