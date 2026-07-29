/**
 * Build every in-tree extension that has a `_wrapper/entry.ts` into its
 * matching `backend/entry.js`.
 *
 * Convention: an extension lives at `assets/extensions/<slug>/` and, when it
 * needs a compiled backend, provides a wrapper at `_wrapper/entry.ts` that
 * re-exports `createModule`. The wrapper is what bun builds; the resulting
 * bundle is what the extension loader imports at runtime.
 *
 * Idempotent + incremental-ish: always rebuilds, no dependency tracking.
 * Cheap (<1s per extension) so don't over-engineer.
 */

import { readdirSync, existsSync, statSync, writeFileSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const EXT_DIR = resolve(ROOT, "assets/extensions");

// Dependencies that must not be bundled — they're resolved from the host
// process' node_modules at runtime.
const EXTERNALS = [
  "better-sqlite3", "neo4j-driver", "@modelcontextprotocol/sdk",
  "@huggingface/transformers", "@anthropic-ai/claude-agent-sdk",
  "@anthropic-ai/sdk", "openai", "ccxt", "cron-parser", "jimp", "ws",
  "nodemailer", "imapflow", "zod", "uuid", "link-preview-js", "grammy",
  "discord.js", "@slack/bolt", "elevenlabs", "dotenv",
  "@matware/mtw-request-ts-client", "@msgpack/msgpack",
  // filesystem-commander deps
  "ssh2-sftp-client", "@aws-sdk/client-s3", "@aws-sdk/lib-storage",
  "webdav", "yauzl", "archiver", "tar-stream", "file-type",
];

/**
 * Walk EXT_DIR collecting every directory that holds a `_wrapper/entry.ts`
 * (i.e. an extension that needs a backend bundle). Layout convention is
 * `<type>/[<category>/]<slug>/`, so wrappers can live at depth 1-3.
 *
 * Stop descending the moment we see an `extension.json` — that's a bare
 * stub (suite / built_in type) without a backend bundle to compile.
 */
function collectExtensionDirs(root: string, depthRemaining = 3): string[] {
  const out: string[] = [];
  if (depthRemaining <= 0) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(root).filter((n) => {
      try { return statSync(resolve(root, n)).isDirectory(); } catch { return false; }
    });
  } catch {
    return out;
  }
  for (const name of entries) {
    const dir = resolve(root, name);
    if (existsSync(resolve(dir, "_wrapper/entry.ts"))) {
      out.push(dir);
      continue;
    }
    if (existsSync(resolve(dir, "extension.json"))) continue; // bare extension, no wrapper
    out.push(...collectExtensionDirs(dir, depthRemaining - 1));
  }
  return out;
}

/**
 * Walk EXT_DIR collecting every directory that holds a `frontend/src/index.ts`
 * (i.e. an extension that ships a compiled frontend page bundle). Same layout
 * convention as collectExtensionDirs, but keeps descending past extensions
 * that have an `extension.json` without a wrapper — a bare suite could still
 * ship a frontend bundle.
 */
function collectFrontendDirs(root: string, depthRemaining = 3): string[] {
  const out: string[] = [];
  if (depthRemaining <= 0) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(root).filter((n) => {
      try { return statSync(resolve(root, n)).isDirectory(); } catch { return false; }
    });
  } catch {
    return out;
  }
  for (const name of entries) {
    const dir = resolve(root, name);
    if (existsSync(resolve(dir, "frontend/src/index.ts"))) {
      out.push(dir);
      continue;
    }
    if (existsSync(resolve(dir, "extension.json"))) continue; // extension without frontend bundle
    out.push(...collectFrontendDirs(dir, depthRemaining - 1));
  }
  return out;
}

/** Newest mtime (ms) of any file under `dir`, recursively. 0 when empty/missing. */
function newestMtime(dir: string): number {
  let newest = 0;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const name of entries) {
    const p = resolve(dir, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) newest = Math.max(newest, newestMtime(p));
      else newest = Math.max(newest, st.mtimeMs);
    } catch { /* ignore */ }
  }
  return newest;
}

/**
 * Build frontend page bundles (`frontend/src/index.ts` → `frontend/entry.js`)
 * by shelling out to the dashboard's vite-based builder. Skips (with a warn)
 * when services/dashboard/node_modules is missing; skips incrementally when
 * entry.js is newer than every file under frontend/src/.
 */
function buildFrontends(): void {
  const frontendDirs = collectFrontendDirs(EXT_DIR);
  if (frontendDirs.length === 0) return;

  // The vite-based builder lives in the dashboard package. When this script
  // runs outside the canonical repo layout (e.g. an overlay build
  // workspace, where ../dashboard does not exist), KERNEL_DASHBOARD_DIR
  // points at the real dashboard checkout.
  const dashboardDir = process.env.KERNEL_DASHBOARD_DIR
    ? resolve(process.env.KERNEL_DASHBOARD_DIR)
    : resolve(ROOT, "../dashboard");
  const builder = resolve(dashboardDir, "scripts/build-ext-frontend.mjs");
  if (!existsSync(resolve(dashboardDir, "node_modules"))) {
    console.warn(`[build-extensions] frontend: dashboard/node_modules missing — skipping ${frontendDirs.length} frontend bundle(s) (run \`bun install\` in services/dashboard)`);
    return;
  }

  let built = 0;
  let fresh = 0;
  for (const extDir of frontendDirs) {
    const slug = extDir.slice(EXT_DIR.length + 1);
    const outfile = resolve(extDir, "frontend/entry.js");
    if (existsSync(outfile)) {
      const srcMtime = newestMtime(resolve(extDir, "frontend/src"));
      if (statSync(outfile).mtimeMs >= srcMtime) { fresh++; continue; }
    }
    try {
      execFileSync("bun", [builder, extDir], { stdio: ["ignore", "inherit", "inherit"], cwd: dashboardDir });
      const size = statSync(outfile).size;
      console.log(`[build-extensions] frontend ${slug} → ${Math.round(size / 1024)} KB`);
      built++;
    } catch (err) {
      console.error(`[build-extensions] frontend ${slug} FAILED:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  }
  console.log(`[build-extensions] frontend built=${built} fresh=${fresh}`);
}

function main(): void {
  if (!existsSync(EXT_DIR)) {
    console.log("[build-extensions] No assets/extensions/ dir — skipping");
    return;
  }

  const extensionDirs = collectExtensionDirs(EXT_DIR);

  let built = 0;
  let skipped = 0;
  for (const extDir of extensionDirs) {
    const slug = extDir.slice(EXT_DIR.length + 1); // may be "<cat>/<name>" or "<name>"
    const wrapper = resolve(extDir, "_wrapper/entry.ts");
    if (!existsSync(wrapper)) {
      skipped++;
      continue;
    }
    const outfile = resolve(extDir, "backend/entry.js");

    const args = [
      "build", wrapper,
      "--outfile", outfile,
      "--target", "bun",
      "--format", "esm",
      ...EXTERNALS.flatMap((e) => ["--external", e]),
    ];
    try {
      execFileSync("bun", args, { stdio: ["ignore", "pipe", "pipe"] });
      // Data assets (e.g. api-registry's seed/apis.json) are resolved via
      // __dirname at runtime, which points at backend/ once bundled — copy
      // them next to the bundle so the built extension stays self-contained.
      const seedDir = resolve(extDir, "_module/seed");
      if (existsSync(seedDir)) cpSync(seedDir, resolve(extDir, "backend/seed"), { recursive: true });
      const size = statSync(outfile).size;
      console.log(`[build-extensions] ${slug} → ${Math.round(size / 1024)} KB`);
      built++;
    } catch (err) {
      console.error(`[build-extensions] ${slug} FAILED:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  }
  console.log(`[build-extensions] built=${built} skipped=${skipped}`);

  // Frontend page bundles (D2 — frontend/src/index.ts → frontend/entry.js).
  buildFrontends();

  // Keep TypeScript happy with a harmless export so `bun run` doesn't treat
  // this as a "no-output" script in certain configurations.
  writeFileSync(resolve(EXT_DIR, ".last-build"), new Date().toISOString(), "utf-8");
}

main();
