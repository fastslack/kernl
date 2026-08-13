/**
 * pack-extension.ts — empaqueta un módulo del kernel como .kernl
 *
 * Usa el packBundle() oficial del módulo extensions, así respeta el formato
 * canónico (integrity.sha256 incluido) y evoluciona automáticamente si el
 * formato del bundle cambia.
 *
 * USO:
 *   bun run scripts/pack-extension.ts <module-slug> [output-dir]
 *
 * EJEMPLO:
 *   bun run scripts/pack-extension.ts notes
 *   → dist/extensions/notes-1.0.0.kernl
 */

import { mkdirSync, writeFileSync, existsSync, cpSync, rmSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { packBundle, bundleFileName, BUNDLE_EXT } from "../src/modules/extensions/bundle.js";

async function main() {
  const slug = process.argv[2];
  const outDir = process.argv[3] ?? "dist/extensions";
  if (!slug) {
    console.error("Usage: bun run scripts/pack-extension.ts <module-slug> [output-dir]");
    process.exit(1);
  }

  const kernelRoot = resolve(dirname(process.argv[1] ?? ""), "..");
  const moduleDir = resolve(kernelRoot, "src/modules", slug);
  const entry = resolve(moduleDir, "index.ts");
  if (!existsSync(moduleDir)) { console.error(`Not found: ${moduleDir}`); process.exit(2); }
  if (!existsSync(entry)) { console.error(`Not found: ${entry}`); process.exit(2); }

  console.log(`📦 Packaging: ${slug}`);
  console.log(`   Source: ${moduleDir}`);

  // Staging dir
  const staging = resolve(tmpdir(), `kernl-stage-${randomBytes(4).toString("hex")}`);
  mkdirSync(staging, { recursive: true });
  mkdirSync(resolve(staging, "backend"), { recursive: true });

  try {
    // 1) Manifest — usar existente del módulo o generar uno mínimo
    const manifestSrc = resolve(moduleDir, "extension.json");
    let version = "1.0.0";
    let manifestJson: string;
    if (existsSync(manifestSrc)) {
      console.log(`   Manifest: ${manifestSrc}`);
      manifestJson = Buffer.from(execFileSync("cat", [manifestSrc])).toString("utf-8");
      try { version = String(JSON.parse(manifestJson).version ?? "1.0.0"); } catch {}
    } else {
      console.log(`   Manifest: auto-generated`);
      const displayName = slug.replace(/-/g, " ").replace(/^./, c => c.toUpperCase());
      const hasMigrations = existsSync(resolve(moduleDir, "migrations"));
      const manifest: Record<string, unknown> = {
        "$schema": "kernl://extension/v1",
        id: `com.kernl.${slug}`,
        slug,
        name: displayName,
        version,
        type: "module",
        description: `Auto-packaged from src/modules/${slug}`,
        author: "Kernl",
        license: "MIT",
        category: "feature",
        backend: hasMigrations
          ? { entry: "backend/entry.js", migrations: "backend/migrations" }
          : { entry: "backend/entry.js" },
      };
      manifestJson = JSON.stringify(manifest, null, 2);
    }
    writeFileSync(resolve(staging, "extension.json"), manifestJson, "utf-8");

    // 2) Build the backend bundle with Bun.
    //    El loader de extensions espera `createModule()` o `default` export.
    //    Los módulos del kernel exportan `create<SlugCamel>Module()` (ej.
    //    `createNotesModule`). Generamos un tmp entry wrapper que re-exporta
    //    la factory del módulo como `createModule`, y bundleamos eso.
    console.log(`   Bundling backend...`);
    // Los módulos del kernel exportan factories con naming variado. El pattern
    // base es `create<SlugCamel>Module` pero algunos usan variantes por
    // capitalización interna (devtools → createDevToolsModule, web-intel →
    // createWebIntelModule). El wrapper escanea TODOS los exports del módulo
    // y toma el primero que termina en "Module" y es función.
    const wrapperEntry = resolve(staging, "_entry-wrapper.ts");
    writeFileSync(
      wrapperEntry,
      [
        `import * as mod from ${JSON.stringify(entry)};`,
        `function findFactory(m: any): (() => any) | null {`,
        `  if (typeof m.createModule === "function") return m.createModule;`,
        `  if (typeof m.default === "function") return m.default;`,
        `  for (const [k, v] of Object.entries(m)) {`,
        `    if (typeof v === "function" && /^create.*Module$/.test(k)) return v as () => any;`,
        `  }`,
        `  return null;`,
        `}`,
        `const factory = findFactory(mod);`,
        `if (!factory) {`,
        `  throw new Error("Extension ${slug}: no factory export matching create<X>Module or createModule found");`,
        `}`,
        `export function createModule() { return factory(); }`,
        `export default createModule;`,
      ].join("\n"),
      "utf-8",
    );
    const externals = [
      "better-sqlite3", "neo4j-driver", "@modelcontextprotocol/sdk",
      "@huggingface/transformers", "@anthropic-ai/claude-agent-sdk",
      "@anthropic-ai/sdk", "openai", "ccxt", "cron-parser", "jimp", "ws",
      "nodemailer", "imapflow", "zod", "uuid", "link-preview-js", "grammy",
      "discord.js", "@slack/bolt", "elevenlabs", "dotenv",
      "@matware/mtw-request-ts-client", "@msgpack/msgpack",
    ];
    const bunArgs = [
      "build", wrapperEntry,
      "--outfile", resolve(staging, "backend/entry.js"),
      "--target", "bun",
      "--format", "esm",
      ...externals.flatMap(e => ["--external", e]),
    ];
    execFileSync("bun", bunArgs, { stdio: "inherit" });
    const bundleSize = statSync(resolve(staging, "backend/entry.js")).size;
    console.log(`   Bundle size: ${Math.round(bundleSize / 1024)} KB`);

    // 3) Migrations — convert TS exports to .sql files the installer can read raw.
    //    The installer (src/modules/extensions/installer.ts) loads each file as
    //    SQL directly, so we can't ship .ts. For each .ts migration file, we
    //    dynamically import() it, pick the exported Migration[] array, and
    //    write one .sql per version (001_xxx.sql, 002_xxx.sql, ...).
    const migDir = resolve(moduleDir, "migrations");
    if (existsSync(migDir)) {
      console.log(`   Processing migrations/`);
      const outMigDir = resolve(staging, "backend/migrations");
      mkdirSync(outMigDir, { recursive: true });

      const { readdirSync } = await import("node:fs");
      const migFiles = readdirSync(migDir).filter(f => /\.(sql|ts|js)$/.test(f)).sort();
      let written = 0;
      for (const f of migFiles) {
        const abs = resolve(migDir, f);
        if (f.endsWith(".sql")) {
          cpSync(abs, resolve(outMigDir, f));
          written++;
          continue;
        }
        // TS/JS — dynamic import and extract SQL array
        try {
          const mod = await import(abs);
          // Find the Migration[] export (usually named xxxMigrations)
          let arr: Array<{ version: number; sql: string }> | null = null;
          for (const [k, v] of Object.entries(mod)) {
            if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && "sql" in (v[0] as object) && "version" in (v[0] as object)) {
              arr = v as Array<{ version: number; sql: string }>;
              console.log(`     • ${f} → extracted ${arr.length} migrations from export "${k}"`);
              break;
            }
          }
          if (!arr) {
            console.warn(`     ⚠ ${f}: no Migration[] export found, skipping`);
            continue;
          }
          for (const m of arr) {
            const filename = `${String(m.version).padStart(3, "0")}_${f.replace(/\.(ts|js)$/, "")}.sql`;
            writeFileSync(resolve(outMigDir, filename), m.sql, "utf-8");
            written++;
          }
        } catch (err) {
          console.warn(`     ⚠ ${f}: import failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      console.log(`   Wrote ${written} migration file(s) as .sql`);
    }

    // 4) Frontend page bundle — compiled by `bun run build:extensions`
    //    (services/dashboard/scripts/build-ext-frontend.mjs). If the module
    //    ships one, include it so `frontend.pages` entries in the manifest
    //    resolve inside the installed bundle.
    const frontendEntry = resolve(moduleDir, "frontend/entry.js");
    if (existsSync(frontendEntry)) {
      console.log(`   Including frontend/entry.js`);
      mkdirSync(resolve(staging, "frontend"), { recursive: true });
      cpSync(frontendEntry, resolve(staging, "frontend/entry.js"));
    }

    // 5) README if present
    const readme = resolve(moduleDir, "README.md");
    if (existsSync(readme)) cpSync(readme, resolve(staging, "README.md"));

    // 6) Pack with the official packBundle (integrity.sha256 auto-stamped)
    const outPath = resolve(kernelRoot, outDir, bundleFileName(slug, version));
    mkdirSync(dirname(outPath), { recursive: true });
    const result = await packBundle(staging, outPath);

    console.log(``);
    console.log(`✅ Packaged: ${outPath}`);
    console.log(`   sha256: ${result.sha256}`);
    console.log(`   size:   ${Math.round(result.sizeBytes / 1024)} KB`);
    console.log(``);
    console.log(`Install with:`);
    console.log(`  BUNDLE=$(base64 -w0 ${outPath})`);
    console.log(`  curl -sS -X POST http://localhost:3086/api/extensions/upload \\`);
    console.log(`    -H 'Content-Type: application/json' \\`);
    console.log(`    -d "$(jq -cn --arg b64 "\\$BUNDLE" '{filename:"${bundleFileName(slug, version)}", base64:\\$b64}')"`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exit(1); });
