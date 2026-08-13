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

import { readdirSync, existsSync, statSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

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
/**
 * A frontend bundle that changed must ship a new version.
 *
 * The dashboard loads extension pages from
 * `/ext-assets/<slug>/<entry>?v=<version>`, and the kernel answers that URL
 * with `Cache-Control: public, max-age=31536000, immutable`. The version IS
 * the cache key: rebuild the bundle without touching it and every browser
 * that has already loaded the page keeps running the old code forever, with
 * no error and nothing in any log to say so. It has bitten this repo twice in
 * one session — a redesigned TV page and a rebuilt cinema page both looked
 * like "the change did nothing".
 *
 * So the build refuses. The lockfile records the hash each version shipped;
 * a differing hash under an unchanged version is the mistake, and the fix is
 * one line in extension.json.
 */
const LOCKFILE = resolve(EXT_DIR, ".frontend-versions.json");

interface LockEntry { version: string; sha256: string }

function readLock(): Record<string, LockEntry> {
  if (!existsSync(LOCKFILE)) return {};
  try {
    return JSON.parse(readFileSync(LOCKFILE, "utf-8")) as Record<string, LockEntry>;
  } catch {
    // A corrupt lockfile must not block a build; it re-records below.
    console.warn("[build-extensions] frontend-versions lockfile unreadable — re-recording");
    return {};
  }
}

function manifestVersion(extDir: string): string {
  try {
    const m = JSON.parse(readFileSync(resolve(extDir, "extension.json"), "utf-8")) as { version?: string };
    return m.version ?? "";
  } catch {
    return "";
  }
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
}

/**
 * Compare every built bundle against the version it was last recorded under.
 * Returns the number of extensions that changed without a version bump.
 */
function checkFrontendVersions(frontendDirs: string[]): number {
  const lock = readLock();
  const next: Record<string, LockEntry> = { ...lock };
  const offenders: string[] = [];

  for (const extDir of frontendDirs) {
    const slug = extDir.slice(EXT_DIR.length + 1);
    const outfile = resolve(extDir, "frontend/entry.js");
    if (!existsSync(outfile)) continue;

    const version = manifestVersion(extDir);
    if (!version) continue;                       // nothing to key a cache on
    const hash = sha256(outfile);
    const prev = lock[slug];

    if (prev && prev.sha256 !== hash && prev.version === version) {
      offenders.push(
        `  ${slug}\n` +
        `    bundle changed but version is still ${version}\n` +
        `    → bump "version" in assets/extensions/${slug}/extension.json`,
      );
      continue;                                    // do not record the mistake
    }
    next[slug] = { version, sha256: hash };
  }

  writeFileSync(LOCKFILE, JSON.stringify(next, null, 2) + "\n");

  if (offenders.length > 0) {
    console.error(
      `\n[build-extensions] ${offenders.length} frontend bundle(s) changed without a version bump.\n` +
      `Browsers cache these immutably by version, so the change would reach nobody:\n\n` +
      offenders.join("\n\n") + "\n",
    );
  }
  return offenders.length;
}

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
    const msg = `frontend: dashboard/node_modules missing — ${frontendDirs.length} frontend bundle(s) cannot be built (run \`bun install\` in services/dashboard)`;
    // Locally this is a warning: someone building only the backend should not
    // be forced to install the dashboard's toolchain.
    //
    // In CI it is fatal. Skipping here produced a green release whose .deb and
    // .rpm carried no extension pages at all — every page 404'd on install,
    // and nothing in the build said so. A packaging job that cannot build what
    // it is supposed to package has failed, however cleanly it exits.
    if (process.env.CI) {
      console.error(`[build-extensions] ${msg}`);
      process.exit(1);
    }
    console.warn(`[build-extensions] ${msg}`);
    return;
  }

  let built = 0;
  let fresh = 0;
  for (const extDir of frontendDirs) {
    const slug = extDir.slice(EXT_DIR.length + 1);
    const outfile = resolve(extDir, "frontend/entry.js");
    if (existsSync(outfile)) {
      // `_shared/` counts as source. Almost every page imports from it —
      // KernlPlayer, the Panel/Badge components, sanitize, i18n — so a change
      // there changes the bundle just as surely as editing the page itself.
      //
      // Comparing against frontend/src alone declared an extension whose own
      // files had not moved "fresh", and never rebuilt it. When the shared
      // player changed, tv and torrents kept shipping the previous one — and
      // nothing noticed, because the version guard below hashes whatever is on
      // disk: an artefact that was never regenerated still matches its own
      // recorded hash and reports no drift. Measured across 29 bundles, the
      // two that had not rebuilt were exactly the two whose own sources were
      // untouched while `_shared/media/KernlPlayer.svelte` moved.
      const srcMtime = Math.max(
        newestMtime(resolve(extDir, "frontend/src")),
        newestMtime(resolve(EXT_DIR, "_shared")),
      );
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

  // Checked for every extension, not only the ones rebuilt this run: a bundle
  // can be left changed by an interrupted build or an edit to entry.js itself.
  if (checkFrontendVersions(frontendDirs) > 0) process.exitCode = 1;
}

/**
 * Record, in each extension's manifest, the npm packages its built backend
 * imports and the exact version this build resolved.
 *
 * Everything in EXTERNALS is deliberately left unbundled and resolved at
 * runtime, which only works if the package is actually present. It was not:
 * a native install shipped a node_modules pruned to the kernel's own needs,
 * so 50 of 79 extensions failed to load on `Cannot find package 'uuid'`.
 * Docker hid it because /app/node_modules is a full install.
 *
 * Deriving this from the built artifact rather than maintaining it by hand is
 * the point — an extension that starts importing something new cannot quietly
 * ship broken, because the manifest is regenerated from the code every build.
 *
 * Versions are exact. With ranges, two people enabling the same channel end up
 * on different releases and a bug report stops being reproducible.
 */
function recordBackendPackages(): void {
  const VALID = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
  const external = new Set(EXTERNALS);
  let written = 0;

  // Every directory carrying a manifest. Deliberately not collectExtensionDirs
  // — that one skips anything with an extension.json, because it hunts for
  // wrappers to build. Here the manifest is exactly what we are looking for.
  const manifestDirs: string[] = [];
  (function walk(dir: string, depth = 4): void {
    if (depth < 0) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith("_") || e.name === "node_modules") continue;
      const sub = resolve(dir, e.name);
      if (existsSync(resolve(sub, "extension.json"))) manifestDirs.push(sub);
      else walk(sub, depth - 1);
    }
  })(EXT_DIR);

  for (const extDir of manifestDirs) {
    const manifestPath = resolve(extDir, "extension.json");
    const entry = resolve(extDir, "backend/entry.js");
    if (!existsSync(manifestPath) || !existsSync(entry)) continue;

    const src = readFileSync(entry, "utf-8");
    const packages: Record<string, string> = {};
    // These bundles embed SQL, and `FROM communications` matches an import
    // regex just as well as a real one — hence the name validation and the
    // EXTERNALS membership test rather than trusting the match.
    for (const m of src.matchAll(/(?:\bfrom|\brequire\()\s*["']([^"'\n]+)["']/g)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!VALID.test(name) || !external.has(name)) continue;
      const pj = resolve(ROOT, "node_modules", name, "package.json");
      if (!existsSync(pj)) {
        console.warn(`[build-extensions] ${name} imported but not installed — not recorded`);
        continue;
      }
      packages[name] = JSON.parse(readFileSync(pj, "utf-8")).version;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!manifest.backend) continue;

    const sorted = Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)));
    const before = JSON.stringify(manifest.backend.packages ?? {});
    if (JSON.stringify(sorted) === before) continue;

    if (Object.keys(sorted).length) manifest.backend.packages = sorted;
    else delete manifest.backend.packages;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    written++;
  }
  console.log(`[build-extensions] manifests updated with backend.packages: ${written}`);
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

  // Must run after the backends are built: it reads the emitted entry.js.
  recordBackendPackages();

  // Keep TypeScript happy with a harmless export so `bun run` doesn't treat
  // this as a "no-output" script in certain configurations.
  writeFileSync(resolve(EXT_DIR, ".last-build"), new Date().toISOString(), "utf-8");
}

main();
