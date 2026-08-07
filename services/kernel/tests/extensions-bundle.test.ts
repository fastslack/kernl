import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  packBundle,
  unpackBundle,
  peekManifest,
  computeBundleSha256,
  makeTempDir,
  BUNDLE_EXT,
  LEGACY_BUNDLE_EXT,
  bundleFileName,
} from "../src/modules/extensions/bundle.js";

const minimalManifest = {
  $schema: "kernl://extension/v1",
  id: "com.example.sample",
  slug: "sample",
  name: "Sample Extension",
  version: "0.1.0",
  type: "module",
  description: "A sample extension for bundle tests.",
  author: "Test Suite",
  license: "MIT",
  category: "utility",
  backend: { entry: "backend/index.js" },
};

let staging: string;
let workRoot: string;

beforeAll(async () => {
  workRoot = await makeTempDir("kernlext-test");
  staging = join(workRoot, "src");
  await mkdir(join(staging, "backend"), { recursive: true });
  await writeFile(
    join(staging, "extension.json"),
    JSON.stringify(minimalManifest, null, 2),
  );
  await writeFile(
    join(staging, "backend/index.js"),
    "export function createModule() { return { name: 'sample' }; }\n",
  );
  await writeFile(join(staging, "README.md"), "# Sample\n");
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true }).catch(() => {});
});

describe("bundle pack/unpack", () => {
  it("packs a valid source dir and stamps sha256", async () => {
    const bundlePath = join(workRoot, "sample.kernlext");
    const { sha256, sizeBytes } = await packBundle(staging, bundlePath);
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sizeBytes).toBeGreaterThan(0);

    const manifestAfter = JSON.parse(
      await readFile(join(staging, "extension.json"), "utf-8"),
    );
    expect(manifestAfter.integrity.sha256).toBe(sha256);
  });

  it("peeks manifest without full extraction", async () => {
    const bundlePath = join(workRoot, "sample.kernlext");
    const m = await peekManifest(bundlePath);
    expect(m.id).toBe("com.example.sample");
    expect(m.version).toBe("0.1.0");
  });

  it("unpacks and verifies integrity (strict)", async () => {
    const bundlePath = join(workRoot, "sample.kernlext");
    const extractDir = join(workRoot, "extracted");
    const r = await unpackBundle(bundlePath, extractDir, true);
    expect(r.integrityOk).toBe(true);
    expect(r.manifest.id).toBe("com.example.sample");
    expect(r.computedSha256).toBe(r.expectedSha256);
  });

  it("detects tampered bundle in strict mode", async () => {
    const bundlePath = join(workRoot, "sample.kernlext");
    const extractDir = join(workRoot, "extracted-tampered");
    await unpackBundle(bundlePath, extractDir, false);

    // Tamper with a non-manifest file so the sha256 mismatches.
    await writeFile(
      join(extractDir, "backend/index.js"),
      "export function createModule() { return { name: 'tampered' }; }\n",
    );
    const computed = await computeBundleSha256(extractDir);
    const manifest = JSON.parse(
      await readFile(join(extractDir, "extension.json"), "utf-8"),
    );
    expect(computed).not.toBe(manifest.integrity.sha256);
  });

  it("rejects a bundle with invalid manifest at unpack time", async () => {
    const badStaging = join(workRoot, "bad-src");
    await mkdir(badStaging, { recursive: true });
    await writeFile(
      join(badStaging, "extension.json"),
      JSON.stringify({ name: "missing-fields" }),
    );
    await expect(
      packBundle(badStaging, join(workRoot, "bad.kernlext")),
    ).rejects.toThrow(/Invalid extension\.json/);
  });
});

// ── Portability ───────────────────────────────────────────────────────
// Kernl runs on GNU tar (Linux hosts, the Debian kernel image), bsdtar
// (/usr/bin/tar on macOS) and busybox tar (Alpine images). They do not agree
// on options, and a GNU-only flag here breaks extension installs on an entire
// platform — which is exactly what `--no-overwrite-dir` did on macOS.
describe("bundle tar portability", () => {
  it("uses no GNU-only tar flags", async () => {
    const src = await readFile(
      new URL("../src/modules/extensions/bundle.ts", import.meta.url),
      "utf-8",
    );
    // Strip comments so the explanatory prose naming these flags does not
    // trip the scan — only real arguments count.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const gnuOnly = [
      "--no-overwrite-dir",
      "--no-absolute-filenames",
      "--wildcards",
      "--warning",
      "--transform",
      "--anchored",
    ];
    for (const flag of gnuOnly) {
      expect(code, `bundle.ts must not pass ${flag} — it is not portable`).not.toContain(flag);
    }
  });

  it("peeks a manifest stored without the ./ prefix", async () => {
    // packBundle writes `./extension.json`, but a bundle produced by another
    // tool may store a bare `extension.json`. Naming a member that is not in
    // the archive makes tar exit non-zero, so hardcoding either spelling
    // rejects half the valid bundles in the world.
    const flatDir = join(workRoot, "flat");
    await mkdir(join(flatDir, "backend"), { recursive: true });
    await writeFile(
      join(flatDir, "extension.json"),
      JSON.stringify(minimalManifest, null, 2),
    );
    await writeFile(join(flatDir, "backend/index.js"), "export default {};\n");

    const flatBundle = join(workRoot, "flat.kernlext");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("tar", [
      "-c", "-z", "-f", flatBundle, "-C", flatDir, "extension.json", "backend",
    ]);

    const manifest = await peekManifest(flatBundle);
    expect(manifest.slug).toBe("sample");
  });

  it("leaves the install directory readable (0755)", async () => {
    const bundlePath = join(workRoot, "perms.kernlext");
    await packBundle(staging, bundlePath);
    const target = join(workRoot, "perms-out");
    await unpackBundle(bundlePath, target);
    const { stat } = await import("node:fs/promises");
    // `--no-overwrite-dir` used to guard this; the chmod that replaced it must
    // keep the directory servable over /ext-assets.
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  });
});

// ── File naming ───────────────────────────────────────────────────────
describe("bundle file naming", () => {
  it("emits the canonical .kernl suffix", () => {
    expect(BUNDLE_EXT).toBe(".kernl");
    expect(bundleFileName("notes")).toBe("notes.kernl");
    expect(bundleFileName("notes", "1.2.0")).toBe("notes-1.2.0.kernl");
  });

  it("still reads a bundle named with the legacy .kernlext suffix", async () => {
    // The rename to .kernl is cosmetic on purpose: the format is a gzipped tar
    // and nothing has ever validated a bundle by its file name. Bundles already
    // in circulation carry .kernlext, and they must keep installing untouched —
    // which is what the install path does through peek + unpack.
    const legacyPath = join(workRoot, `legacy${LEGACY_BUNDLE_EXT}`);
    await packBundle(staging, legacyPath);

    expect((await peekManifest(legacyPath)).slug).toBe("sample");

    const target = join(workRoot, "legacy-out");
    const result = await unpackBundle(legacyPath, target);
    expect(result.integrityOk).toBe(true);
    expect(result.manifest.slug).toBe("sample");
  });

  it("reads a bundle with no recognised suffix at all", async () => {
    // Stronger version of the same claim: the suffix is decoration. Someone who
    // renames a download to `whatever` must not be locked out of their own file.
    const oddPath = join(workRoot, "no-suffix-at-all");
    await packBundle(staging, oddPath);
    expect((await peekManifest(oddPath)).slug).toBe("sample");
  });
});
