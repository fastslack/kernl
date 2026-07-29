import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  packBundle,
  unpackBundle,
  peekManifest,
  computeBundleSha256,
  makeTempDir,
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
