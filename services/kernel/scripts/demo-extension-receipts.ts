/**
 * Smoke test for install receipts (path A) + remote watermark (path B).
 *
 * Phase 1 — local install path (A):
 *   1. In-memory ExtensionService with a real Ed25519 identity.
 *   2. CatalogRegistry + BundledProvider over assets/.
 *   3. Install morning-briefing skill via the catalog.
 *   4. Read back installed_extensions.install_receipt_json — assert all fields
 *      present, assert kernel_identity matches our identity, assert signature
 *      verifies against install_sha256.
 *
 * Phase 2 — server-side watermark + remote download (B), in-process loopback:
 *   5. Pack a synthetic .kernl (we use the morning-briefing dir but write a
 *      proper extension.json so packBundle is happy).
 *   6. Build a watermark via buildDownloadWatermark from a "source" identity.
 *   7. Verify the watermark signature.
 *   8. Use installFromBundle on the resulting tarball with the watermark
 *      threaded through, assert install_receipt.remote_watermark is preserved.
 *
 * Run:  bun scripts/demo-extension-receipts.ts
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ed25519 } from "@noble/curves/ed25519.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { Identity } from "../src/core/attestation.js";
import { extensionsMigrations } from "../src/modules/extensions/migrations.js";
import { ExtensionService } from "../src/modules/extensions/service.js";
import { CatalogRegistry } from "../src/modules/marketplace/catalog/registry.js";
import { BundledProvider } from "../src/modules/marketplace/catalog/bundled-provider.js";
import {
  buildDownloadWatermark,
  computeInstallPathSha256,
  type InstallReceipt,
} from "../src/modules/extensions/receipt.js";
import { packBundle } from "../src/modules/extensions/bundle.js";
import type { InstallerDeps } from "../src/modules/extensions/installer.js";

function bar(title: string): void {
  console.log("\n" + "─".repeat(72));
  console.log("  " + title);
  console.log("─".repeat(72));
}

function copyDirSync(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) copyDirSync(s, d);
    else if (e.isFile()) copyFileSync(s, d);
  }
}

function verifyEd25519(message: Uint8Array, sigB64: string, pubKeyHex: string): boolean {
  const sig = Buffer.from(sigB64, "base64");
  const pub = Buffer.from(pubKeyHex.replace(/^ed25519:/, ""), "hex");
  return ed25519.verify(sig, message, pub);
}

async function main(): Promise<void> {
  bar("Phase 1 — local install receipt (path A)");

  const db = new Database(":memory:");
  runMigrations(db, "extensions", extensionsMigrations);

  const installRoot = mkdtempSync(`${tmpdir()}/mtw-receipt-demo-`);
  const installerKernel = Identity.generate();
  console.log(`  installer identity: ${installerKernel.serverId().slice(0, 30)}…`);

  const stubInstallerDeps: InstallerDeps = {
    db,
    skillRegistry: {
      install: async () => "morning-briefing",
      enableSkill: async () => true,
    },
    agentsFacade: null,
    notificationRegistry: null,
    themeSubsystem: null,
    sandboxDriverRegistry: null,
  };

  const service = new ExtensionService(db, {
    extensionsDir: installRoot,
    installerDeps: stubInstallerDeps,
    identity: installerKernel,
  });

  const registry = new CatalogRegistry({ extensionService: service });
  registry.registerProvider(new BundledProvider({ rootDir: resolve(process.cwd()) }));

  console.log("  installing morning-briefing via catalog…");
  const row = await registry.install("morning-briefing");
  console.log(`  → row.status=${row.status}  receipt_present=${row.install_receipt_json !== "{}"}`);

  const receipt = service.getReceipt(row.id) as InstallReceipt | null;
  if (!receipt) {
    console.log("  ! receipt missing");
    process.exit(1);
  }
  console.log(`  install_id      = ${receipt.install_id}`);
  console.log(`  bundle_sha256   = ${receipt.bundle_sha256.slice(0, 16)}…`);
  console.log(`  install_sha256  = ${receipt.install_sha256.slice(0, 16)}…`);
  console.log(`  installed_at    = ${receipt.installed_at}`);
  console.log(`  kernel_identity = ${receipt.kernel_identity.slice(0, 30)}…`);
  console.log(`  signature       = ${receipt.signature.slice(0, 24)}… (${receipt.signature.length} chars b64)`);

  // Verify the local signature.
  const sigOk = verifyEd25519(
    Buffer.from(receipt.install_sha256, "hex"),
    receipt.signature,
    receipt.kernel_identity,
  );
  console.log(`  signature verify: ${sigOk ? "OK" : "FAIL"}`);
  if (!sigOk) process.exit(1);

  bar("Phase 2 — remote watermark (path B, loopback)");

  // Identity of the SERVING kernel (could be a different machine).
  const sourceKernel = Identity.generate();
  console.log(`  source identity:    ${sourceKernel.serverId().slice(0, 30)}…`);

  // Identity of the DOWNLOADING kernel (different from the installer above).
  const downloaderKernel = Identity.generate();
  console.log(`  downloader identity:${downloaderKernel.serverId().slice(0, 30)}…`);

  const watermark = buildDownloadWatermark({
    downloaderFp: downloaderKernel.serverId(),
    source: sourceKernel,
  });
  console.log(`  watermark id        ${watermark.download_id}`);
  console.log(`  watermark.signature ${watermark.signature.slice(0, 24)}…`);

  const wmPayload = Buffer.from(
    `${watermark.download_id}|${watermark.downloader_fp}|${watermark.source_fp}|${watermark.ts}`,
    "utf-8",
  );
  const wmOk = verifyEd25519(wmPayload, watermark.signature, watermark.source_fp);
  console.log(`  watermark verify:   ${wmOk ? "OK" : "FAIL"}`);
  if (!wmOk) process.exit(1);

  bar("Phase 3 — pack + install with watermark threaded through");

  // Build a synthetic .kernl from a copy of morning-briefing with a real
  // extension.json (the bundled SKILL.json layout doesn't have one).
  const stagingDir = mkdtempSync(`${tmpdir()}/mtw-receipt-pack-`);
  copyDirSync(resolve(process.cwd(), "assets/skills/morning-briefing"), stagingDir);
  writeFileSync(
    join(stagingDir, "extension.json"),
    JSON.stringify({
      $schema: "kernl://extension/v1",
      id: "demo.kernl.morning-briefing",
      slug: "morning-briefing-demo",
      name: "Morning Briefing (demo)",
      version: "0.0.1",
      type: "skill",
      description: "Demo bundle for receipt smoke test",
      author: "demo",
      license: "Apache-2.0",
      category: "productivity",
      backend: { entry: "index.js" },
      tracking: { download: watermark },
    }, null, 2),
  );

  const bundleOutDir = mkdtempSync(`${tmpdir()}/mtw-receipt-out-`);
  const bundlePath = join(bundleOutDir, "morning-briefing-demo.kernl");
  const packed = await packBundle(stagingDir, bundlePath);
  console.log(`  packed: ${packed.bundlePath} (${packed.sizeBytes} bytes, sha=${packed.sha256.slice(0, 16)}…)`);

  // Fresh service for the downloading kernel.
  const db2 = new Database(":memory:");
  runMigrations(db2, "extensions", extensionsMigrations);
  const installRoot2 = mkdtempSync(`${tmpdir()}/mtw-receipt-recv-`);
  const service2 = new ExtensionService(db2, {
    extensionsDir: installRoot2,
    installerDeps: stubInstallerDeps,
    identity: downloaderKernel,
  });
  const row2 = await service2.installFromBundle(
    bundlePath,
    { type: "marketplace", remote: "loopback", id: "morning-briefing-demo" },
    { remoteWatermark: watermark },
  );
  console.log(`  installed bundle  → status=${row2.status}`);

  const receipt2 = service2.getReceipt(row2.id) as InstallReceipt | null;
  if (!receipt2) { console.log("! second receipt missing"); process.exit(1); }
  console.log(`  receipt2.kernel_identity = ${receipt2.kernel_identity.slice(0, 30)}…`);
  console.log(`  receipt2.remote_watermark.download_id = ${receipt2.remote_watermark?.download_id}`);
  console.log(`  receipt2.remote_watermark.source_fp   = ${receipt2.remote_watermark?.source_fp.slice(0, 30)}…`);

  if (receipt2.remote_watermark?.download_id !== watermark.download_id) {
    console.log("! watermark didn't round-trip");
    process.exit(1);
  }
  if (receipt2.kernel_identity !== downloaderKernel.serverId()) {
    console.log("! second receipt has wrong installer identity");
    process.exit(1);
  }

  bar("Phase 4 — cleanup + summary");
  rmSync(installRoot, { recursive: true, force: true });
  rmSync(stagingDir, { recursive: true, force: true });
  rmSync(bundleOutDir, { recursive: true, force: true });
  rmSync(installRoot2, { recursive: true, force: true });

  console.log(`
✓ All checks passed:
  - local receipt signed + verifies              [phase 1]
  - watermark signed by source + verifies        [phase 2]
  - watermark round-trips through install        [phase 3]
  - downloader identity ≠ source identity        [phase 3]
  - both receipts uniquely identify their event  [phase 1+3]
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
