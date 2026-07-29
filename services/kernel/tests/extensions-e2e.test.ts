/**
 * End-to-end smoke test for the unified extensions pipeline.
 *
 * Builds a synthetic .kernlext, installs it, loads it dynamically, and
 * verifies the KernelModule's tool becomes callable through the
 * ModuleRegistry — exactly as a real bundled extension would behave.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ModuleRegistry } from "../src/core/module-registry.js";
import type { ModuleContext } from "../src/core/types.js";
import { EventBus } from "../src/core/event-bus.js";
import {
  createExtensionsModule,
  loadActiveExtensions,
} from "../src/modules/extensions/index.js";
import {
  packBundle,
  makeTempDir,
} from "../src/modules/extensions/bundle.js";

const extensionManifest = {
  $schema: "kernl://extension/v1",
  id: "com.kernl.test.hello",
  slug: "hello",
  name: "Hello PoC",
  version: "0.1.0",
  type: "module",
  description: "A trivial extension used to validate the install+load pipeline.",
  author: "Test Suite",
  license: "MIT",
  category: "utility",
  backend: { entry: "backend/index.js" },
};

const BACKEND_SOURCE = `
export function createModule() {
  let tools = [];
  return {
    name: "hello-poc",
    async initialize() {
      tools = [{
        name: "hello_say_hi",
        description: "Returns a greeting.",
        inputSchema: { _def: { typeName: "ZodObject" } },
        handler: async () => ({
          content: [{ type: "text", text: "hi from the PoC extension" }],
        }),
      }];
    },
    getTools() { return tools; },
    async shutdown() {},
  };
}
`;

let workRoot: string;
let bundlePath: string;

beforeAll(async () => {
  workRoot = await makeTempDir("extpoc");
  const staging = join(workRoot, "src");
  await mkdir(join(staging, "backend"), { recursive: true });
  await writeFile(
    join(staging, "extension.json"),
    JSON.stringify(extensionManifest, null, 2),
  );
  await writeFile(join(staging, "backend/index.js"), BACKEND_SOURCE);

  bundlePath = join(workRoot, "hello.kernlext");
  await packBundle(staging, bundlePath);
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true }).catch(() => {});
});

describe("E2E: extension pack → install → load → invoke", () => {
  it("bundles, installs, loads, and exposes the tool", async () => {
    // ── Fake ModuleContext ─────────────────────────────────────────
    const sqlite = new Database(":memory:") as unknown as ModuleContext["sqlite"];
    const events = new EventBus();

    const ctx: ModuleContext = {
      sqlite,
      neo4j: { available: false } as unknown as ModuleContext["neo4j"],
      graph: null,
      events,
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

    // ── Bootstrap: extensions module ───────────────────────────────
    const extensionsModule = createExtensionsModule({
      dataPath: join(workRoot, "data"),
    });

    const registry = new ModuleRegistry();
    registry.register(extensionsModule);
    await registry.initializeAll(ctx);

    // ── Install from bundle ────────────────────────────────────────
    const row = await extensionsModule.service.installFromBundle(bundlePath, {
      type: "file",
      filename: bundlePath,
    });
    expect(row.status).toBe("active");
    expect(row.slug).toBe("hello");

    // ── Load dynamically ───────────────────────────────────────────
    const result = await loadActiveExtensions(
      extensionsModule.service,
      registry,
      ctx,
    );
    expect(result.loaded).toContain("hello");
    expect(result.failed).toEqual([]);

    // ── Verify tool is reachable through the registry ──────────────
    const allTools = registry.getAllTools();
    const hello = allTools.find((t) => t.name === "hello_say_hi");
    expect(hello).toBeDefined();

    const r = await hello!.handler({});
    expect(r.content[0].text).toContain("hi from the PoC extension");

    // ── Uninstall round-trip ───────────────────────────────────────
    await extensionsModule.service.uninstall(row.id);
    expect(extensionsModule.service.get(row.id)).toBeNull();
  });
});
