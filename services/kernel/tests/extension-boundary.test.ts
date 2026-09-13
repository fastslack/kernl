import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "../src");

// Value imports only. `import type` / `export type` are erased at build time,
// so they never pull extension code into the kernel bundle.
const VALUE_IMPORT_FROM_EXTENSION =
  /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+["'][^"']*\/assets\/extensions\/[^"']*["']/gm;

describe("kernel ↔ extension boundary", () => {
  it("src/ never imports extension code at runtime", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SRC, { recursive: true }) as string[]) {
      if (!file.endsWith(".ts")) continue;
      const text = readFileSync(join(SRC, file), "utf-8");
      for (const match of text.matchAll(VALUE_IMPORT_FROM_EXTENSION)) {
        const specifier = match[0].slice(match[0].lastIndexOf("from")).trim();
        offenders.push(`${file}: ${specifier}`);
      }
    }
    // An extension reaches the dashboard through its descriptor (channels,
    // routes, RPC slices), never through a kernel import of its source.
    expect(offenders).toEqual([]);
  });
});
