/**
 * The extension ↔ kernel boundary gate.
 *
 * Extensions may import the kernel only through `@kernl/extension-sdk`. Two
 * things are checked, because either one alone lets the problem back in:
 *
 *   1. Source: no `…/src/…` import in an extension's TypeScript, type-only
 *      imports included — those are what tie an extension to kernel internals
 *      that can move under it.
 *   2. Bundle: bun marks every file it inlines with a `// <path>` comment. A
 *      kernel file outside `src/sdk/` in a `backend/entry.js` is a copy of the
 *      kernel travelling with the extension — the duplicated-state bug this
 *      gate exists for. It also catches what arrives transitively.
 *
 * What is still allowed lives in a baseline, per extension, and the baseline
 * can only shrink: an entry that is no longer needed fails the gate until it
 * is deleted, so the list never fills with dead weight.
 *
 * Usage:
 *   bun scripts/check-extension-boundary.ts [--root <assets/extensions>]
 *       [--baseline <file>]... [--write-baseline] [--source-only]
 *
 * Several --baseline files are merged. With --write-baseline the LAST one is
 * rewritten, holding only the extensions no earlier baseline already covers —
 * which is how a separate repo keeps its own list next to the kernel's.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const KERNEL_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_ROOT = join(KERNEL_ROOT, "assets/extensions");
const DEFAULT_BASELINE = join(KERNEL_ROOT, "scripts/extension-boundary-baseline.json");

export interface BaselineEntry {
  source?: string[];
  bundle?: string[];
}
export type Baseline = Record<string, BaselineEntry>;

export interface ExtensionFindings {
  slug: string;
  source: string[];
  bundle: string[];
  /** A bundle exists but carries no origin comments, so it cannot be inspected. */
  opaqueBundle: boolean;
}

// ── Scanning ────────────────────────────────────────────────────────────

const STATIC_SRC_IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;'"]*?\bfrom\s+["']((?:\.\.\/)+src\/[^"']+)["']/g;
const BARE_SRC_IMPORT = /(?:^|\n)\s*import\s+["']((?:\.\.\/)+src\/[^"']+)["']/g;
const DYNAMIC_SRC_IMPORT = /\b(?:import|require)\(\s*["']((?:\.\.\/)+src\/[^"']+)["']\s*\)/g;

/** Kernel paths a source file imports, normalised to `src/…` and de-duplicated. */
export function sourceViolations(source: string): string[] {
  const found = new Set<string>();
  for (const re of [STATIC_SRC_IMPORT, BARE_SRC_IMPORT, DYNAMIC_SRC_IMPORT]) {
    for (const m of source.matchAll(re)) found.add(m[1].replace(/^(?:\.\.\/)+/, ""));
  }
  return [...found].sort();
}

/**
 * Kernel files inlined into a bundle, as `src/…` paths relative to the kernel
 * root. `buildCwd` is the directory bun ran in: its origin comments are
 * relative to it.
 */
export function bundleViolations(
  bundle: string,
  buildCwd: string,
  kernelRoot = KERNEL_ROOT,
): { files: string[]; sawOrigins: boolean } {
  const files = new Set<string>();
  let sawOrigins = false;
  for (const m of bundle.matchAll(/^\/\/ (\S+\.(?:ts|tsx|js|mjs|cjs|json))$/gm)) {
    sawOrigins = true;
    const rel = relative(kernelRoot, resolve(buildCwd, m[1])).split("\\").join("/");
    if (rel.startsWith("src/") && !rel.startsWith("src/sdk/")) files.add(rel);
  }
  return { files: [...files].sort(), sawOrigins };
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "frontend" || name === "backend") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/**
 * Extensions (directories holding an extension.json) plus shared `_lib`
 * directories, which are backend code compiled into the extensions that
 * import them. `_shared` and `_types` are frontend-only and skipped.
 */
export function collectUnits(root: string): Array<{ slug: string; dir: string }> {
  const units: Array<{ slug: string; dir: string }> = [];
  (function walk(dir: string, depth: number): void {
    if (depth < 0) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (!statSync(path).isDirectory() || name === "node_modules") continue;
      if (name === "_lib") {
        units.push({ slug: relative(root, path).split("\\").join("/"), dir: path });
        continue;
      }
      if (name.startsWith("_")) continue;
      if (existsSync(join(path, "extension.json"))) {
        units.push({ slug: relative(root, path).split("\\").join("/"), dir: path });
        continue;
      }
      walk(path, depth - 1);
    }
  })(root, 4);
  return units.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function scan(root: string, opts: { sourceOnly?: boolean; buildCwd?: string } = {}): ExtensionFindings[] {
  const buildCwd = opts.buildCwd ?? process.cwd();
  return collectUnits(root).map(({ slug, dir }) => {
    const source = new Set<string>();
    for (const file of tsFiles(dir)) {
      for (const v of sourceViolations(readFileSync(file, "utf-8"))) source.add(v);
    }
    let bundle: string[] = [];
    let opaqueBundle = false;
    const entry = join(dir, "backend/entry.js");
    if (!opts.sourceOnly && existsSync(entry)) {
      const result = bundleViolations(readFileSync(entry, "utf-8"), buildCwd);
      bundle = result.files;
      opaqueBundle = !result.sawOrigins;
    }
    return { slug, source: [...source].sort(), bundle, opaqueBundle };
  });
}

// ── Comparing against the baseline ──────────────────────────────────────

export function mergeBaselines(baselines: Baseline[]): Baseline {
  const merged: Baseline = {};
  for (const b of baselines) {
    for (const [slug, entry] of Object.entries(b)) {
      const into = (merged[slug] ??= {});
      into.source = [...new Set([...(into.source ?? []), ...(entry.source ?? [])])];
      into.bundle = [...new Set([...(into.bundle ?? []), ...(entry.bundle ?? [])])];
    }
  }
  return merged;
}

/** Human-readable problems; an empty list means the gate passes. */
export function compare(findings: ExtensionFindings[], baseline: Baseline, opts: { sourceOnly?: boolean } = {}): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const f of findings) {
    seen.add(f.slug);
    const allowed = baseline[f.slug] ?? {};

    if (f.opaqueBundle) {
      problems.push(`${f.slug}: backend/entry.js has no origin comments — the gate cannot inspect it (minified?)`);
    }

    const kinds: Array<["source" | "bundle", string[]]> = opts.sourceOnly
      ? [["source", f.source]]
      : [["source", f.source], ["bundle", f.bundle]];
    for (const [kind, current] of kinds) {
      const allowedSet = new Set(allowed[kind] ?? []);
      const currentSet = new Set(current);
      for (const entry of current) {
        if (allowedSet.has(entry)) continue;
        problems.push(
          kind === "source"
            ? `${f.slug}: imports ${entry} — import it from "@kernl/extension-sdk", or it is not part of SDK v1`
            : `${f.slug}: bundle carries kernel file ${entry} — something imports kernel runtime code outside the SDK`,
        );
      }
      for (const entry of allowedSet) {
        if (currentSet.has(entry)) continue;
        problems.push(`${f.slug}: no longer needs ${kind} baseline entry ${entry} — remove it from the baseline`);
      }
    }
  }

  for (const slug of Object.keys(baseline)) {
    if (!seen.has(slug)) problems.push(`${slug}: baseline entry for an extension that does not exist — remove it`);
  }
  return problems;
}

/** Baseline content for the findings, minus slugs covered by `covered`. */
export function baselineFor(findings: ExtensionFindings[], covered: Baseline = {}, opts: { sourceOnly?: boolean } = {}): Baseline {
  const out: Baseline = {};
  for (const f of findings) {
    if (covered[f.slug]) continue;
    const entry: BaselineEntry = {};
    if (f.source.length) entry.source = f.source;
    if (!opts.sourceOnly && f.bundle.length) entry.bundle = f.bundle;
    if (entry.source || entry.bundle) out[f.slug] = entry;
  }
  return out;
}

// ── Entry points ────────────────────────────────────────────────────────

export interface CheckOptions {
  root?: string;
  baselines?: string[];
  writeBaseline?: boolean;
  sourceOnly?: boolean;
  buildCwd?: string;
}

function readBaseline(path: string): Baseline {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as Baseline;
}

/** Run the gate. Returns the problems found (empty when it passes). */
export function checkExtensionBoundary(opts: CheckOptions = {}): string[] {
  const root = resolve(opts.root ?? DEFAULT_ROOT);
  const baselinePaths = (opts.baselines?.length ? opts.baselines : [DEFAULT_BASELINE]).map((p) => resolve(p));
  const findings = scan(root, { sourceOnly: opts.sourceOnly, buildCwd: opts.buildCwd });

  if (opts.writeBaseline) {
    const target = baselinePaths[baselinePaths.length - 1];
    const covered = mergeBaselines(baselinePaths.slice(0, -1).map(readBaseline));
    const next = baselineFor(findings, covered, { sourceOnly: opts.sourceOnly });
    writeFileSync(target, JSON.stringify(next, null, 2) + "\n", "utf-8");
    console.log(`[extension-boundary] wrote ${Object.keys(next).length} baseline entries to ${target}`);
  }

  const baseline = mergeBaselines(baselinePaths.map(readBaseline));
  // A baseline can list extensions from another tree (the paid repo's list,
  // checked in the kernel's own tree): only judge slugs present here.
  const present = new Set(findings.map((f) => f.slug));
  const scoped = Object.fromEntries(Object.entries(baseline).filter(([slug]) => present.has(slug)));
  return compare(findings, scoped, { sourceOnly: opts.sourceOnly });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opts: CheckOptions = { baselines: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--root") opts.root = args[++i];
    else if (a === "--baseline") opts.baselines!.push(args[++i]);
    else if (a === "--write-baseline") opts.writeBaseline = true;
    else if (a === "--source-only") opts.sourceOnly = true;
    else {
      console.error(`[extension-boundary] unknown argument: ${a}`);
      process.exit(2);
    }
  }
  const problems = checkExtensionBoundary(opts);
  if (problems.length) {
    console.error(`[extension-boundary] ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("[extension-boundary] clean");
}
