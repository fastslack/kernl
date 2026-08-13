/**
 * .kernl Bundle Format — pack / unpack / verify
 *
 * Layout (tarball root — NO wrapper directory):
 *   extension.json           ← manifest, required
 *   backend/index.js         ← optional
 *   frontend/descriptor.json ← optional
 *   migrations/*.sql         ← optional
 *   agents/*.json            ← optional
 *   skills/*.{md,json}       ← optional
 *   flows/*.json             ← optional
 *   assets/*                 ← optional (locales, images)
 *
 * Container: gzipped tar (.kernl = .tar.gz by another name).
 *
 * Integrity: the manifest's `integrity.sha256` field holds a canonical digest
 * over every file in the bundle, computed as:
 *   sha256( concat_for_each_file_sorted_by_path(
 *     relPath + "\0" + fileSha256Hex + "\n"
 *   ) )
 * extension.json contributes too, hashed as canonical JSON with its own
 * `integrity` block removed — that block holds the digest, so it cannot be an
 * input to it, but every other field must be. This is stable across tar
 * implementations and cheap to verify.
 */

import {
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
  stat,
  chmod,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import {
  extensionManifestSchema,
  validateManifest,
  checkTypeConsistency,
  type ExtensionManifest,
} from "./schema.js";

const execFileAsync = promisify(execFile);

// ── File naming ───────────────────────────────────────────────────────

/**
 * Canonical suffix for a packaged extension.
 *
 * Nothing in the kernel validates a bundle by its file name — the format is a
 * gzipped tar and the installer reads the manifest inside it, so any suffix
 * works and always has. This constant exists so that everything Kernl *emits*
 * agrees on one spelling, which `.kernlext` and `.kernl` did not: the packer,
 * the store and the marketplace wrote `.kernlext` while the signature module
 * documented the format as `.kernl`.
 */
export const BUNDLE_EXT = ".kernl";

/**
 * The name bundles were emitted under before `.kernl` became canonical.
 *
 * Kept because bundles already in circulation carry it, and because nothing
 * ever rejected a file by suffix they keep installing untouched. Producers must
 * not use this; it is here so that UI file pickers and documentation can list
 * what a user might legitimately still have on disk.
 */
export const LEGACY_BUNDLE_EXT = ".kernlext";

/** Every suffix a user might reasonably hand us, canonical first. */
export const BUNDLE_EXTS = [BUNDLE_EXT, LEGACY_BUNDLE_EXT, ".tar.gz", ".tgz"] as const;

/**
 * Conventional file name for a bundle. `version` is included by the packer so
 * a directory of builds is self-describing; the store omits it because the
 * slug alone identifies what was downloaded.
 */
export function bundleFileName(slug: string, version?: string): string {
  return version ? `${slug}-${version}${BUNDLE_EXT}` : `${slug}${BUNDLE_EXT}`;
}

// ── tar, portably ─────────────────────────────────────────────────────

/**
 * Run `tar` with flags every implementation understands.
 *
 * Kernl runs on three different tars and they do NOT agree on options:
 *
 *   · GNU tar      — Linux hosts and the Debian-based kernel image
 *   · bsdtar       — /usr/bin/tar on macOS (libarchive)
 *   · busybox tar  — Alpine-based images
 *
 * Only the short POSIX flags (-c -x -t -z -f -C -O) exist in all three, so
 * that is all this uses. The GNU long forms this replaced (`--extract`,
 * `--list`, `--to-stdout`) are absent or unreliable on busybox, and
 * `--no-overwrite-dir` — see unpackBundle — is GNU-only outright, which made
 * installing ANY .kernl bundle fail on a native macOS install.
 *
 * `-f` must be followed by the archive path, and `-C` by the directory, so
 * the flag cluster stays split rather than merged into one `-xzf`.
 */
function tarArgs(mode: "c" | "x" | "t", archive: string, rest: string[] = []): string[] {
  return [`-${mode}`, "-z", "-f", archive, ...rest];
}

/** Every member path in an archive, trimmed, in archive order. */
async function listMembers(archive: string): Promise<string[]> {
  const { stdout } = await execFileAsync("tar", tarArgs("t", archive), {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

// ── Manifest I/O ──────────────────────────────────────────────────────

const MANIFEST_FILE = "extension.json";

export async function readManifest(dir: string): Promise<ExtensionManifest> {
  const raw = await readFile(join(dir, MANIFEST_FILE), "utf-8");
  const json: unknown = JSON.parse(raw);
  const result = validateManifest(json);
  if (!result.ok) {
    throw new Error(`Invalid ${MANIFEST_FILE}:\n  ${result.errors.join("\n  ")}`);
  }
  const typeErrors = checkTypeConsistency(result.manifest);
  if (typeErrors.length) {
    throw new Error(
      `Manifest type inconsistency:\n  ${typeErrors.join("\n  ")}`,
    );
  }
  return result.manifest;
}

async function writeManifest(
  dir: string,
  manifest: ExtensionManifest,
): Promise<void> {
  const serialized = JSON.stringify(manifest, null, 2);
  await writeFile(join(dir, MANIFEST_FILE), serialized, "utf-8");
}

// ── File enumeration + hashing ────────────────────────────────────────

/** Recursively list all file paths under `dir`, relative, POSIX slashes, sorted. */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (abs: string): Promise<void> => {
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const absChild = join(abs, entry.name);
      if (entry.isDirectory()) {
        await walk(absChild);
      } else if (entry.isFile()) {
        const rel = relative(dir, absChild).split(sep).join("/");
        out.push(rel);
      }
    }
  };
  await walk(dir);
  out.sort();
  return out;
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  h.update(await readFile(path));
  return h.digest("hex");
}

/**
 * Compute the canonical integrity hash for a bundle directory.
 * Excludes extension.json from the digest (the hash is stored inside it).
 */
/**
 * Deterministic JSON: object keys sorted at every depth.
 *
 * The manifest has to hash identically no matter what order a packer, an
 * editor, or a JSON library happened to write its keys in, or the digest would
 * depend on formatting rather than content.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Hash of the manifest with its own `integrity` block removed.
 *
 * `integrity` holds the digest, so it cannot be an input to the digest. Every
 * other field — permissions, pricing, id, entry points — must be, or it sits
 * outside the signature.
 */
async function sha256ManifestSansIntegrity(path: string): Promise<string> {
  const raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  const { integrity: _dropped, ...rest } = raw;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

export async function computeBundleSha256(dir: string): Promise<string> {
  const files = await listFiles(dir);
  const digest = createHash("sha256");
  for (const rel of files) {
    if (rel === MANIFEST_FILE) continue;
    const fileHash = await sha256File(join(dir, rel));
    digest.update(`${rel}\0${fileHash}\n`);
  }
  // The manifest itself, minus `integrity`. Leaving it out made the signature
  // cover only the payload: anyone could rewrite permissions, pricing, id or
  // `backend.entry` in a signed bundle and it still verified as authentic,
  // which is precisely what the signature exists to prevent.
  const manifestHash = await sha256ManifestSansIntegrity(join(dir, MANIFEST_FILE));
  digest.update(`${MANIFEST_FILE}\0${manifestHash}\n`);
  return digest.digest("hex");
}

// ── Pack ──────────────────────────────────────────────────────────────

export interface PackResult {
  bundlePath: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Create a .kernl bundle from `sourceDir`.
 *
 * Requires `sourceDir/extension.json` to exist and be valid. The manifest's
 * `integrity.sha256` is (re)computed and written before packing, so the
 * bundle is self-describing and verifiable offline.
 *
 * `outPath` should end in `.kernl`.
 */
export async function packBundle(
  sourceDir: string,
  outPath: string,
): Promise<PackResult> {
  const manifest = await readManifest(sourceDir);

  const sha256 = await computeBundleSha256(sourceDir);
  const stamped: ExtensionManifest = {
    ...manifest,
    integrity: {
      ...(manifest.integrity ?? {}),
      sha256,
    },
  };

  // Re-validate the stamped manifest — paranoia.
  extensionManifestSchema.parse(stamped);

  // Write the stamped manifest back to the source directory before packing
  // so the tarball contains it. Overwriting is intentional: callers should
  // operate on a staging copy, not the original working tree.
  await writeManifest(sourceDir, stamped);

  // Build the tarball. `-C sourceDir .` packs the directory contents
  // (not the directory itself) — no wrapper folder inside.
  await execFileAsync(
    "tar",
    tarArgs("c", outPath, ["-C", sourceDir, "."]),
    { timeout: 60_000 },
  );

  const { size } = await stat(outPath);
  return { bundlePath: outPath, sha256, sizeBytes: size };
}

// ── Unpack ────────────────────────────────────────────────────────────

export interface UnpackResult {
  targetDir: string;
  manifest: ExtensionManifest;
  integrityOk: boolean;
  computedSha256: string;
  expectedSha256: string | null;
}

/**
 * Extract a .kernl bundle into `targetDir` and verify its integrity.
 *
 * `strict=true` throws on any integrity failure; `strict=false` returns a
 * result with `integrityOk=false` so the caller can decide.
 */
export async function unpackBundle(
  bundlePath: string,
  targetDir: string,
  strict = true,
): Promise<UnpackResult> {
  await mkdir(targetDir, { recursive: true });

  try {
    // Zip-slip hardening: list the archive members first and reject any that
    // are absolute or escape `targetDir` via `..`, BEFORE writing anything.
    // (Extraction otherwise runs before the integrity check, so a crafted
    // bundle could drop files outside the install dir.)
    for (const member of await listMembers(bundlePath)) {
      const normalized = member.replace(/\\/g, "/");
      const isAbsolute = normalized.startsWith("/");
      const escapes = normalized.split("/").some((seg) => seg === "..");
      if (isAbsolute || escapes) {
        await rm(targetDir, { recursive: true, force: true }).catch(() => {});
        throw new Error(`Unsafe path in bundle ${bundlePath}: ${member}`);
      }
    }

    // No --no-absolute-filenames here: that flag is busybox-only and GNU tar
    // (used on the host and in the container) rejects it. Absolute and
    // `..`-escaping members are already rejected by the listing check above,
    // and GNU tar strips leading "/" by default anyway.
    await execFileAsync(
      "tar",
      tarArgs("x", bundlePath, ["-C", targetDir]),
      { timeout: 60_000 },
    );
  } catch (err) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Failed to extract bundle ${bundlePath}: ${err}`);
  }

  // `--no-overwrite-dir` used to sit on the extract above to stop tar applying
  // the archive's `./` entry — whose mode is whatever the packer's staging dir
  // happened to have — to the install directory. The flag is GNU-only, so the
  // intent is stated directly instead: the extension directory is read by the
  // kernel and served over /ext-assets, and 0755 is what that needs.
  await chmod(targetDir, 0o755).catch(() => {
    /* Best-effort: a filesystem that refuses chmod (some mounts, Windows) is
       not a reason to fail an otherwise good install. */
  });

  const manifest = await readManifest(targetDir);
  const expected = manifest.integrity?.sha256 ?? null;
  const computed = await computeBundleSha256(targetDir);
  const integrityOk = expected !== null && expected === computed;

  if (strict && !integrityOk) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `Bundle integrity check failed: expected=${expected ?? "<missing>"} ` +
      `computed=${computed}`,
    );
  }

  return { targetDir, manifest, integrityOk, computedSha256: computed, expectedSha256: expected };
}

// ── Peek (read manifest without full extraction) ──────────────────────

/**
 * Read the manifest from a .kernl bundle WITHOUT extracting the whole
 * thing. Useful for listing/validating a bundle before committing to an
 * install. Extracts a single entry to stdout with `-O`.
 *
 * The member name is resolved from the listing rather than hardcoded to
 * `./extension.json`. packBundle always writes the `./` prefix, but a bundle
 * packed by another tool may store a bare `extension.json`, and naming a
 * member that is not in the archive makes tar exit non-zero — so hardcoding
 * either spelling rejects half the valid bundles in the world.
 */
export async function peekManifest(bundlePath: string): Promise<ExtensionManifest> {
  const members = await listMembers(bundlePath);
  const entry = members.find(
    (m) => m === MANIFEST_FILE || m === `./${MANIFEST_FILE}`,
  );
  if (!entry) {
    throw new Error(`Bundle ${bundlePath} has no ${MANIFEST_FILE} at its root`);
  }
  const { stdout } = await execFileAsync(
    "tar",
    tarArgs("x", bundlePath, ["-O", entry]),
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const json: unknown = JSON.parse(stdout);
  const result = validateManifest(json);
  if (!result.ok) {
    throw new Error(`Invalid manifest in bundle: ${result.errors.join("; ")}`);
  }
  return result.manifest;
}

// ── Utilities ─────────────────────────────────────────────────────────

/**
 * Returns a fresh, empty, unique temporary directory. Callers are
 * responsible for cleaning it up.
 */
export async function makeTempDir(prefix: string): Promise<string> {
  const base = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(base, { recursive: true });
  return base;
}
