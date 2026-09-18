import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import {
  sourceViolations,
  bundleViolations,
  compare,
  baselineFor,
  mergeBaselines,
  type ExtensionFindings,
} from "../scripts/check-extension-boundary.js";

const KERNEL_ROOT = resolve(import.meta.dirname, "..");

function findings(partial: Partial<ExtensionFindings> & { slug: string }): ExtensionFindings {
  return { source: [], bundle: [], opaqueBundle: false, ...partial };
}

describe("extension SDK gate — source", () => {
  it("reports kernel imports, type-only included, and ignores the SDK", () => {
    const source = [
      `import { newId } from "@kernl/extension-sdk";`,
      `import type { AgentService } from "../../../../src/modules/agents/service.js";`,
      `import { log } from "../../../../src/core/logger.js";`,
      `export { thing } from "../../../src/core/helpers.js";`,
      `const late = await import("../../../../src/core/llm/client.js");`,
      `import { local } from "./local.js";`,
    ].join("\n");

    expect(sourceViolations(source)).toEqual([
      "src/core/helpers.js",
      "src/core/llm/client.js",
      "src/core/logger.js",
      "src/modules/agents/service.js",
    ]);
  });
});

describe("extension SDK gate — bundle", () => {
  it("accepts SDK files and flags any other kernel file", () => {
    const bundle = [
      `// src/sdk/helpers.ts`,
      `function newId() {}`,
      `// src/core/logger.ts`,
      `let threshold = 1;`,
      `// assets/extensions/people/comms/_module/service.ts`,
      `// node_modules/uuid/dist/esm/v4.js`,
    ].join("\n");

    expect(bundleViolations(bundle, KERNEL_ROOT, KERNEL_ROOT)).toEqual({
      files: ["src/core/logger.ts"],
      sawOrigins: true,
    });
  });

  it("resolves origin comments against the directory bun ran in", () => {
    const bundle = `// services/kernel/src/core/request-context.ts\n`;

    expect(bundleViolations(bundle, resolve(KERNEL_ROOT, "../.."), KERNEL_ROOT).files).toEqual([
      "src/core/request-context.ts",
    ]);
  });

  it("notices a bundle it cannot inspect", () => {
    expect(bundleViolations("var a=1;", KERNEL_ROOT, KERNEL_ROOT).sawOrigins).toBe(false);
  });
});

describe("extension SDK gate — baseline", () => {
  it("passes when every finding is in the baseline", () => {
    const current = [findings({ slug: "agents/agent-advanced", source: ["src/modules/agents/i18n.js"] })];
    const baseline = { "agents/agent-advanced": { source: ["src/modules/agents/i18n.js"] } };

    expect(compare(current, baseline)).toEqual([]);
  });

  it("fails on a new violation", () => {
    const current = [findings({ slug: "people/comms", bundle: ["src/server.ts"] })];

    expect(compare(current, {})).toEqual([
      "people/comms: bundle carries kernel file src/server.ts — something imports kernel runtime code outside the SDK",
    ]);
  });

  it("fails on a baseline entry that is no longer needed", () => {
    const current = [findings({ slug: "home/life" })];
    const baseline = { "home/life": { source: ["src/modules/dashboard/life-queries.js"] } };

    expect(compare(current, baseline)).toEqual([
      "home/life: no longer needs source baseline entry src/modules/dashboard/life-queries.js — remove it from the baseline",
    ]);
  });

  it("fails on an opaque bundle", () => {
    expect(compare([findings({ slug: "x/y", opaqueBundle: true })], {})).toEqual([
      "x/y: backend/entry.js has no origin comments — the gate cannot inspect it (minified?)",
    ]);
  });

  it("writes only what no earlier baseline covers", () => {
    const current = [
      findings({ slug: "core/one", source: ["src/modules/a.js"] }),
      findings({ slug: "paid/two", bundle: ["src/core/b.ts"] }),
      findings({ slug: "clean/three" }),
    ];
    const covered = mergeBaselines([{ "core/one": { source: ["src/modules/a.js"] } }]);

    expect(baselineFor(current, covered)).toEqual({ "paid/two": { bundle: ["src/core/b.ts"] } });
  });
});
