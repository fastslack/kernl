/**
 * build-ext-frontend.mjs — compile one extension's frontend page bundle.
 *
 * USAGE:
 *   bun scripts/build-ext-frontend.mjs <extensionDir>
 *
 * Expects `<extensionDir>/frontend/src/index.ts` (which must export
 * `mount(target, ctx)` per assets/extensions/_types/ext-page.d.ts) and emits
 * a fully self-contained ES module at `<extensionDir>/frontend/entry.js`
 * (Svelte runtime bundled in, no import maps, no externals).
 *
 * Runs from services/dashboard so vite + @sveltejs/vite-plugin-svelte + svelte
 * resolve from THIS package's node_modules — the kernel has none of them.
 */

import { resolve, isAbsolute, dirname, basename } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const rawDir = process.argv[2];
if (!rawDir) {
  console.error("Usage: bun scripts/build-ext-frontend.mjs <extensionDir>");
  process.exit(1);
}
const extDir = isAbsolute(rawDir) ? rawDir : resolve(process.cwd(), rawDir);
const entry = resolve(extDir, "frontend/src/index.ts");
if (!existsSync(entry)) {
  console.error(`[build-ext-frontend] entry not found: ${entry}`);
  process.exit(2);
}

/**
 * Extension sources live under services/kernel (no node_modules with svelte),
 * so rollup's importer-relative resolution can't find the Svelte runtime.
 * Resolve `svelte` and all its subpaths (svelte/internal, svelte/store, …)
 * against THIS package via import.meta.resolve, which honors the exports map.
 */
/**
 * `$shared/…` — shared frontend source library for extension pages, living at
 * `assets/extensions/_shared/` (components, utils, sanitize, the ExtPageContext
 * type). Resolved by walking up from the extension dir to the nearest ancestor
 * named `extensions`. Bare specifiers try `.ts` / `.js` completions so page
 * sources can write `$shared/utils` or `$shared/utils.js` alike.
 */
function findSharedRoot(fromDir) {
  let p = fromDir;
  while (dirname(p) !== p) {
    if (basename(p) === "extensions") return resolve(p, "_shared");
    p = dirname(p);
  }
  return null;
}
const sharedRoot = findSharedRoot(extDir);
const resolveSharedAlias = {
  name: "resolve-shared-ext-lib",
  resolveId(source) {
    if (!source.startsWith("$shared/") || !sharedRoot) return null;
    const rest = source.slice("$shared/".length);
    const base = resolve(sharedRoot, rest);
    for (const cand of [base, base + ".ts", base + ".js", base.replace(/\.js$/, ".ts")]) {
      if (existsSync(cand)) return cand;
    }
    return null;
  },
};

const resolveSvelteFromDashboard = {
  name: "resolve-svelte-from-dashboard",
  resolveId(source) {
    if (source === "svelte" || source.startsWith("svelte/")) {
      try {
        const resolved = fileURLToPath(import.meta.resolve(source));
        // import.meta.resolve uses NODE conditions, so the bare "svelte"
        // specifier maps to the SSR runtime (runtime/ssr.js) where onMount &
        // friends are NO-OPS — rollup then treeshakes every mount callback
        // out of the page bundle. Force the browser/client runtime instead.
        return resolved.replace(/([\\/])runtime[\\/]ssr\.js$/, "$1runtime$1index.js");
      } catch {
        return null;
      }
    }
    // Bare npm specifiers used by _shared/ sources (e.g. isomorphic-dompurify
    // in sanitize.ts) can't resolve importer-relative — the kernel tree has no
    // frontend node_modules — so fall back to THIS package's resolution.
    const bare = !source.startsWith(".") && !source.startsWith("/") &&
      !source.startsWith("$") && !source.startsWith("\0");
    if (bare) {
      try {
        const url = import.meta.resolve(source);
        if (url.startsWith("file:")) return fileURLToPath(url);
      } catch {
        return null;
      }
    }
    return null;
  },
};

await build({
  configFile: false,
  // Root is the extension dir (frontend/'s parent) so outDir sits INSIDE
  // root — vite refuses outDir === root / parent-of-root combinations.
  root: extDir,
  logLevel: "warn",
  plugins: [
    resolveSharedAlias,
    resolveSvelteFromDashboard,
    svelte({
      preprocess: vitePreprocess(),
      emitCss: false,
      compilerOptions: { dev: false },
    }),
  ],
  build: {
    lib: {
      entry,
      formats: ["es"],
      fileName: () => "entry.js",
    },
    outDir: resolve(extDir, "frontend"),
    emptyOutDir: false,
    minify: true,
    sourcemap: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});

console.log(`[build-ext-frontend] built ${resolve(extDir, "frontend/entry.js")}`);
