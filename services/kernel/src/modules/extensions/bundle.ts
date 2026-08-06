/**
 * .kernlext Bundle Format — pack / unpack / verify
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
 * Container: gzipped tar (.kernlext = .tar.gz by another name).
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
 * Create a .kernlext bundle from `sourceDir`.
 *
 * Requires `sourceDir/extension.json` to exist and be valid. The manifest's
 * `integrity.sha256` is (re)computed and written before packing, so the
 * bundle is self-describing and verifiable offline.
 *
 * `outPath` should end in `.kernlext`.
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
  await execFileAsync("tar", [
    "--create",
    "--gzip",
    "--file", outPath,
    "-C", sourceDir,
    ".",
  ], { timeout: 60_000 });

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
 * Extract a .kernlext bundle into `targetDir` and verify its integrity.
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
    const { stdout: listing } = await execFileAsync(
      "tar",
      ["--list", "--gzip", "--file", bundlePath],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
    for (const raw of listing.split("\n")) {
      const member = raw.trim();
      if (!member) continue;
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
    await execFileAsync("tar", [
      "--extract",
      "--gzip",
      "--no-overwrite-dir",
      "--file", bundlePath,
      "-C", targetDir,
    ], { timeout: 60_000 });
  } catch (err) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Failed to extract bundle ${bundlePath}: ${err}`);
  }

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
 * Read the manifest from a .kernlext bundle WITHOUT extracting the whole
 * thing. Useful for listing/validating a bundle before committing to an
 * install. Uses `tar --extract --to-stdout` against a single entry.
 */
export async function peekManifest(bundlePath: string): Promise<ExtensionManifest> {
  const { stdout } = await execFileAsync(
    "tar",
    ["--extract", "--gzip", "--file", bundlePath, "--to-stdout", `./${MANIFEST_FILE}`],
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
