/**
 * Stage a `<name>-SKILL.md` skill into a folder of its own, with the files it
 * points at.
 *
 * A standard skill is a folder: installing copies the folder, so whatever the
 * SKILL.md links to (`references/x.md`, `templates/…`) travels with it. A
 * prefixed skill file shares its folder with other skills and leans on files
 * that live elsewhere in the repo — `escritos-civil-SKILL.md` names
 * `civil-CLAUDE.md` two folders up and `modelos/demanda-….md` beside it.
 * Copying the folder would ship the wrong things and miss the right ones, so
 * the skill is staged instead: its body becomes `SKILL.md`, and every `.md`
 * it names is copied in under the same relative path it was named by.
 *
 * A named path is looked up next to the file that names it, then in each
 * ancestor folder up to the repo root — that is how these repos write them
 * ("civil-CLAUDE.md" means the profile at the area's root). Files the copied
 * ones name are followed one more level; nothing outside the repo is read and
 * nothing is written outside the staging folder.
 */

import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";

export interface StageOptions {
  /** The clone root: lookups never climb above it. */
  repoRoot: string;
  /** Folder holding the skill file. */
  dir: string;
  /** The skill file's name inside `dir`, e.g. `plazos-SKILL.md`. */
  file: string;
  /** Destination folder; replaced if it exists. */
  outDir: string;
  /** How many reference hops to follow from the skill body. Default 2. */
  depth?: number;
  maxFiles?: number;
  maxBytes?: number;
}

/** Relative `.md` paths written in prose or links — never URLs or absolute paths. */
const MD_REF = /(?<![\w/:.@-])((?:[\w-]+\/)*[\w-][\w.-]*\.md)\b/g;

export function mdRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MD_REF)) out.add(m[1]!);
  return [...out];
}

function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The first `<folder>/<ref>` that exists, from `fromDir` up to `repoRoot`. */
export function resolveRef(ref: string, fromDir: string, repoRoot: string): string | null {
  const root = resolve(repoRoot);
  let dir = resolve(fromDir);
  while (within(root, dir)) {
    const cand = resolve(dir, ref);
    if (within(root, cand) && isFile(cand)) return cand;
    if (dir === root) break;
    dir = dirname(dir);
  }
  return null;
}

/** Stage the skill; returns the copied files' paths relative to `outDir` (SKILL.md excluded). */
export async function stageSkillFile(opts: StageOptions): Promise<string[]> {
  const depth = opts.depth ?? 2;
  const maxFiles = opts.maxFiles ?? 80;
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  const outDir = resolve(opts.outDir);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const body = await readFile(join(opts.dir, opts.file), "utf-8");
  await writeFile(join(outDir, "SKILL.md"), body, "utf-8");

  const copied: string[] = [];
  const seen = new Set<string>([resolve(opts.dir, opts.file)]);
  let bytes = Buffer.byteLength(body);
  let level: Array<{ text: string; fromDir: string }> = [{ text: body, fromDir: opts.dir }];

  for (let hop = 0; hop < depth && level.length > 0; hop++) {
    const next: typeof level = [];
    for (const { text, fromDir } of level) {
      for (const ref of mdRefs(text)) {
        if (copied.length >= maxFiles) return copied;
        const rel = normalize(ref);
        if (rel === "SKILL.md" || rel.startsWith("..")) continue;
        const dest = resolve(outDir, rel);
        if (!within(outDir, dest) || existsSync(dest)) continue;
        const src = resolveRef(rel, fromDir, opts.repoRoot);
        if (!src || seen.has(src)) continue;
        const size = statSync(src).size;
        if (bytes + size > maxBytes) continue;
        seen.add(src);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(src, dest);
        bytes += size;
        copied.push(rel);
        next.push({ text: await readFile(src, "utf-8"), fromDir: dirname(src) });
      }
    }
    level = next;
  }
  return copied;
}
