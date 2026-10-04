import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Two places read the packages a built extension needs straight from its
// bundle: build-extensions.ts (→ manifest backend.packages, what the kernel
// installs on demand) and packaging/stage-payload.sh (→ node_modules of the
// native packages). A package an extension only loads with `await import()`
// was invisible to both, so the WhatsApp channel shipped without
// @matware/mtw-request-ts-client and every native install failed to link.
const sources = {
  "scripts/build-extensions.ts": readFileSync(resolve(import.meta.dirname, "../scripts/build-extensions.ts"), "utf-8"),
  "packaging/stage-payload.sh": readFileSync(resolve(import.meta.dirname, "../../../packaging/stage-payload.sh"), "utf-8"),
};

function scanRegex(text: string): RegExp {
  const m = text.match(/matchAll\((\/\(\?:\\bfrom[^\n]*?\/g)\)/);
  if (!m) throw new Error("import scan regex not found");
  // stage-payload.sh embeds it in a double-quoted shell string: undo the \" escapes.
  const lit = m[1].replace(/\\"/g, '"');
  return new Function(`return ${lit};`)() as RegExp;
}

const bundle = `
import { a } from "pkg-static";
const b = require("pkg-require");
const { c } = await import("@scope/pkg-dynamic");
`;

describe("bundle import scanners", () => {
  for (const [name, text] of Object.entries(sources)) {
    it(`${name} sees static, require and dynamic imports`, () => {
      const found = [...bundle.matchAll(scanRegex(text))].map((m) => m[1]).sort();
      expect(found).toEqual(["@scope/pkg-dynamic", "pkg-require", "pkg-static"]);
    });
  }
});
