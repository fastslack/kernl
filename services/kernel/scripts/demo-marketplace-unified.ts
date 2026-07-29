/**
 * Smoke-test for the unified marketplace catalog.
 *
 * Walks through the whole pipeline end-to-end:
 *   1. Bring up an in-memory ExtensionService.
 *   2. Wire the BundledProvider + CatalogRegistry over assets/{bundles,skills,plugins,extensions}.
 *   3. Browse — should see entries from every asset directory, normalized to
 *      ExtensionManifest, with status='available'.
 *   4. Install one bundled skill (morning-briefing) — should land in
 *      installed_extensions and dispatch through the skill handler.
 *   5. Install one legacy plugin (echo-test) — should land as type='module'.
 *   6. Re-browse — both items now show status='active' (or installed/error
 *      depending on whether the skill registry was wired).
 *
 * Run:  bun scripts/demo-marketplace-unified.ts
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { extensionsMigrations } from "../src/modules/extensions/migrations.js";
import { ExtensionService } from "../src/modules/extensions/service.js";
import { CatalogRegistry } from "../src/modules/marketplace/catalog/registry.js";
import { BundledProvider } from "../src/modules/marketplace/catalog/bundled-provider.js";
import type { InstallerDeps } from "../src/modules/extensions/installer.js";

function bar(title: string): void {
  console.log("\n" + "─".repeat(72));
  console.log("  " + title);
  console.log("─".repeat(72));
}

async function main(): Promise<void> {
  bar("1. Setup — in-memory ExtensionService + CatalogRegistry");

  const db = new Database(":memory:");
  runMigrations(db, "extensions", extensionsMigrations);

  // Minimal installer deps — skills/agents subsystems return null so the
  // dispatcher will warn but not throw. The smoke test cares about the
  // marketplace flow, not whether the skill runtime actually loaded the JS.
  const installerDeps: InstallerDeps = {
    db,
    skillRegistry: {
      install: async () => {
        console.log("  · skillRegistry.install() called (stubbed)");
        return "morning-briefing";
      },
      enableSkill: async () => {
        console.log("  · skillRegistry.enableSkill() called (stubbed)");
        return true;
      },
    },
    agentsFacade: null,
    notificationRegistry: null,
    themeSubsystem: null,
    sandboxDriverRegistry: null,
  };

  const installRoot = mkdtempSync(`${tmpdir()}/mtw-marketplace-demo-`);
  const service = new ExtensionService(db, {
    extensionsDir: installRoot,
    installerDeps,
  });

  const registry = new CatalogRegistry({ extensionService: service });
  registry.registerProvider(new BundledProvider({ rootDir: resolve(process.cwd()) }));

  bar("2. Browse — pre-install");
  const before = await registry.browse();
  console.log(`  total: ${before.length}`);
  const byType: Record<string, number> = {};
  for (const i of before) byType[i.manifest.type] = (byType[i.manifest.type] ?? 0) + 1;
  for (const [t, n] of Object.entries(byType)) console.log(`  ${t}: ${n}`);

  // Show the first three skills + first three plugins(modules) so we can
  // eyeball what the marketplace UI will render.
  console.log("\n  skills (first 3):");
  for (const i of before.filter((x) => x.manifest.type === "skill").slice(0, 3)) {
    console.log(`    - ${i.slug}  (${i.manifest.name})  status=${i.status}`);
  }
  const modules = before.filter((x) => x.manifest.type === "module");
  console.log(`\n  modules (first 3 of ${modules.length}):`);
  for (const i of modules.slice(0, 3)) {
    console.log(`    - ${i.slug}  (${i.manifest.name})  status=${i.status}`);
  }

  bar("3. Install — bundled skill 'morning-briefing'");
  const skillItem = await registry.getItem("morning-briefing");
  if (!skillItem) {
    console.log("  ! morning-briefing not found in catalog — assets/skills/morning-briefing missing?");
  } else {
    try {
      const row = await registry.install("morning-briefing");
      console.log(`  installed: ${row.slug}  type=${row.type}  status=${row.status}`);
      console.log(`  install_path: ${row.install_path}`);
    } catch (err) {
      console.log(`  ! install failed: ${err}`);
    }
  }

  bar("4. Install — bundled plugin 'echo-test' (legacy plugin manifest.json)");
  const pluginItem = await registry.getItem("echo-test");
  if (!pluginItem) {
    console.log("  ! echo-test not found — assets/plugins/echo-test missing?");
  } else {
    try {
      const row = await registry.install("echo-test");
      console.log(`  installed: ${row.slug}  type=${row.type}  status=${row.status}`);
      console.log(`  install_path: ${row.install_path}`);
    } catch (err) {
      console.log(`  ! install failed: ${err}`);
    }
  }

  bar("5. Browse — post-install");
  const after = await registry.browse();
  const interesting = after.filter((i) =>
    ["morning-briefing", "echo-test"].includes(i.slug),
  );
  for (const i of interesting) {
    console.log(`  ${i.slug}  type=${i.manifest.type}  status=${i.status}  installed_id=${i.installed_id ?? "(none)"}`);
  }

  bar("6. Verify — installed_extensions table");
  const rows = service.list();
  console.log(`  ${rows.length} row(s) in installed_extensions`);
  for (const r of rows) {
    console.log(`    - ${r.slug}  type=${r.type}  status=${r.status}`);
  }

  console.log("\n✓ marketplace catalog smoke-test complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
