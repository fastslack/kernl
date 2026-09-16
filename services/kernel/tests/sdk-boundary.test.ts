import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * `src/sdk/` is copied into every extension bundle. A runtime import that
 * leaves it would drag kernel code — and kernel state — back into those
 * bundles, which is the problem the SDK exists to remove. Type-only imports
 * are erased at build and stay allowed.
 */

const SDK_DIR = resolve(import.meta.dir, "../src/sdk");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

interface Violation {
  file: string;
  specifier: string;
}

export function runtimeImportsLeavingSdk(file: string, source: string): Violation[] {
  const found: Violation[] = [];
  const check = (specifier: string, typeOnly: boolean) => {
    if (typeOnly || !specifier.startsWith(".")) return;
    const target = resolve(dirname(file), specifier);
    if (target === SDK_DIR || target.startsWith(SDK_DIR + sep)) return;
    found.push({ file: relative(SDK_DIR, file), specifier });
  };

  // import … from "x" / export … from "x" (possibly spanning lines)
  for (const m of source.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?[^;'"]*?\bfrom\s+["']([^"']+)["']/g)) {
    check(m[3], Boolean(m[2]));
  }
  // side-effect imports: import "x"
  for (const m of source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
    check(m[1], false);
  }
  // dynamic import("x"), unless it is a `typeof import("x")` type position
  for (const m of source.matchAll(/(typeof\s+)?\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    check(m[2], Boolean(m[1]));
  }
  return found;
}

describe("extension SDK boundary", () => {
  it("has no runtime import that leaves src/sdk", () => {
    const violations = sourceFiles(SDK_DIR).flatMap((file) =>
      runtimeImportsLeavingSdk(file, readFileSync(file, "utf-8")),
    );

    expect(violations).toEqual([]);
  });

  it("flags a runtime import into the kernel and lets a type import through", () => {
    const file = join(SDK_DIR, "example.ts");
    const source = [
      `import type { SqliteDb } from "../core/db/sqlite.js";`,
      `import { log } from "../core/logger.js";`,
      `import { newId } from "./helpers.js";`,
      `type T = typeof import("../core/config.js");`,
    ].join("\n");

    expect(runtimeImportsLeavingSdk(file, source)).toEqual([
      { file: "example.ts", specifier: "../core/logger.js" },
    ]);
  });
});
