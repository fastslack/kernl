/**
 * End-to-end smoke test for path C — subscribe a public skills repo,
 * discover its items, install one, verify the receipt.
 *
 * Repo under test: https://github.com/coreyhaines31/marketingskills
 *   - Several top-level subfolders, each with a SKILL.md (Claude Code style)
 *
 * Run:  bun scripts/demo-catalog-repos.ts
 *
 * Network is required (git clone). Skips with a clear message when the host
 * has no `git` binary or the clone times out.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { Identity } from "../src/core/attestation.js";
import { extensionsMigrations } from "../src/modules/extensions/migrations.js";
import { marketplaceMigrations } from "../src/modules/marketplace/migrations.js";
import { ExtensionService } from "../src/modules/extensions/service.js";
import { CatalogRegistry } from "../src/modules/marketplace/catalog/registry.js";
import { BundledProvider } from "../src/modules/marketplace/catalog/bundled-provider.js";
import { CatalogReposService } from "../src/modules/marketplace/catalog-repos-service.js";
import type { InstallerDeps } from "../src/modules/extensions/installer.js";

function bar(t: string): void {
  console.log("\n" + "─".repeat(72));
  console.log("  " + t);
  console.log("─".repeat(72));
}

async function main(): Promise<void> {
  bar("Phase 1 — bootstrap");

  const db = new Database(":memory:");
  runMigrations(db, "extensions", extensionsMigrations);
  runMigrations(db, "marketplace", marketplaceMigrations);

  const installRoot = mkdtempSync(`${tmpdir()}/mtw-repos-demo-install-`);
  const cacheRoot = mkdtempSync(`${tmpdir()}/mtw-repos-demo-cache-`);
  const identity = Identity.generate();
  console.log(`  identity: ${identity.serverId().slice(0, 30)}…`);
  console.log(`  installRoot: ${installRoot}`);
  console.log(`  cacheRoot:   ${cacheRoot}`);

  const installerDeps: InstallerDeps = {
    db,
    skillRegistry: { install: async () => "from-catalog-repo", enableSkill: async () => true },
    agentsFacade: null,
    notificationRegistry: null,
    themeSubsystem: null,
    sandboxDriverRegistry: null,
  };
  const extService = new ExtensionService(db, {
    extensionsDir: installRoot,
    installerDeps,
    identity,
  });
  const registry = new CatalogRegistry({ extensionService: extService });
  registry.registerProvider(new BundledProvider({ rootDir: resolve(process.cwd()) }));
  const repos = new CatalogReposService(db, registry, cacheRoot);
  console.log("  catalog ready (1 bundled provider)");

  bar("Phase 2 — subscribe to coreyhaines31/marketingskills");

  let row: Awaited<ReturnType<typeof repos.add>>;
  try {
    row = await repos.add({
      url: "https://github.com/coreyhaines31/marketingskills",
      name: "marketingskills",
    });
  } catch (err) {
    console.log(`  ! repo subscription failed: ${err}`);
    console.log("    (this script needs network + git installed)");
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`  repo persisted: id=${row.id.slice(0, 8)}…`);
  console.log(`  items_found:    ${row.items_found}`);
  console.log(`  last_synced_at: ${row.last_synced_at}`);

  bar("Phase 3 — list discovered items");

  const items = await registry.browse();
  const fromRepo = items.filter((i) => i.origin.provider.startsWith("git:"));
  console.log(`  total catalog items: ${items.length}`);
  console.log(`  from this repo:      ${fromRepo.length}`);
  for (const i of fromRepo.slice(0, 8)) {
    console.log(`    - ${i.slug.padEnd(30)} type=${i.manifest.type.padEnd(10)} ${(i.manifest.description ?? "").slice(0, 60)}`);
  }
  if (fromRepo.length === 0) {
    console.log("  ! repo cloned but no SKILL.md / SKILL.json / extension.json found");
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
    process.exit(1);
  }

  bar("Phase 4 — install the first discovered item");

  const target = fromRepo[0];
  console.log(`  installing: ${target.slug}`);
  let installed: Awaited<ReturnType<typeof registry.install>>;
  try {
    installed = await registry.install(target.slug);
  } catch (err) {
    console.log(`  ! install failed: ${err}`);
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`  → status: ${installed.status}`);
  console.log(`  → install_path: ${installed.install_path}`);

  const receipt = extService.getReceipt(installed.id);
  if (!receipt) {
    console.log("  ! receipt missing");
    process.exit(1);
  }
  console.log(`  receipt.install_id    = ${receipt.install_id}`);
  console.log(`  receipt.source.type   = ${receipt.source.type}`);
  if (receipt.source.type === "git") {
    console.log(`  receipt.source.url    = ${(receipt.source as { url: string }).url}`);
    console.log(`  receipt.source.ref    = ${(receipt.source as { ref?: string }).ref ?? "(default)"}`);
  }
  console.log(`  receipt.kernel_id     = ${receipt.kernel_identity.slice(0, 30)}…`);
  console.log(`  receipt signed:       ${!!receipt.signature}`);

  bar("Phase 5 — sync round-trip + cleanup");

  const syncResult = await repos.sync(row.id);
  console.log(`  sync: items=${syncResult.items}  commit=${syncResult.commit_sha?.slice(0, 8) ?? "?"}`);

  const removed = await repos.remove(row.id);
  console.log(`  remove: ${removed ? "ok" : "FAILED"}`);

  rmSync(installRoot, { recursive: true, force: true });
  rmSync(cacheRoot, { recursive: true, force: true });

  console.log("\n✓ All phases passed.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
