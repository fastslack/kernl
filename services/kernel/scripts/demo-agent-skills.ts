/**
 * End-to-end smoke for agent.skills_json:
 *   1. Bootstrap mini DB with extensions + agents migrations.
 *   2. Subscribe to coreyhaines31/marketingskills (live clone).
 *   3. Install 2 skills via the catalog (ab-testing, copywriting).
 *   4. Create a test agent + attach those 2 skills.
 *   5. Use SkillBodyResolver.buildPromptIndex() to confirm the system_prompt
 *      injection works (one-line entries + trigger pattern).
 *   6. Resolve a single skill body via the resolver to confirm the
 *      kernel_skill_load tool path works.
 *
 * Run:  bun scripts/demo-agent-skills.ts
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { Identity } from "../src/core/attestation.js";
import { extensionsMigrations } from "../src/modules/extensions/migrations.js";
import { marketplaceMigrations } from "../src/modules/marketplace/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { ExtensionService } from "../src/modules/extensions/service.js";
import { CatalogRegistry } from "../src/modules/marketplace/catalog/registry.js";
import { BundledProvider } from "../src/modules/marketplace/catalog/bundled-provider.js";
import { CatalogReposService } from "../src/modules/marketplace/catalog-repos-service.js";
import { SkillBodyResolver } from "../src/modules/agents/skill-resolver.js";
import { newId, isoNow } from "../src/core/helpers.js";
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
  runMigrations(db, "agents", agentsMigrations);

  const installRoot = mkdtempSync(`${tmpdir()}/mtw-skills-install-`);
  const cacheRoot = mkdtempSync(`${tmpdir()}/mtw-skills-cache-`);
  const identity = Identity.generate();
  console.log(`  identity: ${identity.serverId().slice(0, 30)}…`);

  const installerDeps: InstallerDeps = {
    db,
    skillRegistry: { install: async () => "from-skills-demo", enableSkill: async () => true },
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

  bar("Phase 2 — subscribe + install 2 skills");
  await repos.add({
    url: "https://github.com/coreyhaines31/marketingskills",
    name: "marketingskills",
  });

  const items = await registry.browse({ type: "skill" });
  const fromGit = items.filter((i) => i.origin.provider.startsWith("git:"));
  console.log(`  ${fromGit.length} skill(s) discovered from repo`);
  if (fromGit.length === 0) {
    console.log("  ! repo failed to clone");
    process.exit(1);
  }

  const targetSlugs = ["ab-testing", "copywriting"];
  const installed: string[] = [];
  for (const slug of targetSlugs) {
    const item = fromGit.find((i) => i.slug === slug);
    if (!item) { console.log(`  ! ${slug} not in repo`); continue; }
    try {
      const row = await registry.install(item.slug);
      installed.push(row.slug);
      console.log(`  ✓ installed ${row.slug}  status=${row.status}`);
    } catch (err) {
      console.log(`  ! install ${slug} failed: ${err}`);
    }
  }

  bar("Phase 3 — create agent + attach skills");
  const now = isoNow();
  const agentId = newId();
  db.prepare(
    `INSERT INTO agents
       (id, name, description, system_prompt, goal_template, allowed_tools, denied_tools,
        provider, model, max_iterations, timeout_ms, active, max_tokens, max_errors,
        variables, show_on_dashboard, builtin_handler, rank_id, created_at, updated_at,
        skills_json)
     VALUES (?, ?, ?, ?, ?, '[]', '[]', '', '', 10, 60000, 1, 50000, 3, '{}', 0, '', '', ?, ?, ?)`,
  ).run(
    agentId,
    "Marketing Strategist",
    "Plans growth experiments + writes copy",
    "You are a marketing strategist. Use procedural skills when relevant.",
    "{{request}}",
    now, now,
    JSON.stringify(installed),
  );
  console.log(`  ✓ agent created: ${agentId.slice(0, 8)}… with ${installed.length} skills`);

  bar("Phase 4 — verify SkillBodyResolver index injection");
  const resolver = new SkillBodyResolver(db);
  const indexBlock = resolver.buildPromptIndex(installed);
  console.log(`  prompt index (${indexBlock.length} chars):`);
  console.log("  " + indexBlock.split("\n").map(l => `  ${l}`).join("\n  "));
  if (!indexBlock.includes("Available skills")) {
    console.log("  ! prompt index missing header");
    process.exit(1);
  }
  for (const slug of installed) {
    if (!indexBlock.includes(slug)) {
      console.log(`  ! slug ${slug} not in index block`);
      process.exit(1);
    }
  }

  bar("Phase 5 — verify on-demand body load (kernel_skill_load path)");
  for (const slug of installed) {
    const r = resolver.resolve(slug);
    if (!r) {
      console.log(`  ! resolver.resolve(${slug}) returned null`);
      process.exit(1);
    }
    console.log(`  ✓ ${r.slug.padEnd(15)} body=${r.body.length} chars  desc=${r.tokens_estimate} tok-est`);
  }

  bar("Phase 6 — cleanup");
  rmSync(installRoot, { recursive: true, force: true });
  rmSync(cacheRoot, { recursive: true, force: true });
  console.log("\n✓ All phases passed.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
