/**
 * pack-agent-bundle.ts — empaqueta un directorio de agentes como .kernlext
 *
 * Convención:
 *   assets/bundles/<slug>/    (public bundles, tracked in git, ships with kernel)
 *   assets/personal/<slug>/   (instance-specific, gitignored)
 *     extension.json          (manifest con type='agent-bundle' u 'office')
 *     agents/*.json           (uno por agente)
 *     office.json             (definicion de la oficina, opcional)
 *     chains/*.json           (opcionales)
 *     README.md               (opcional)
 *
 * USO:
 *   bun run scripts/pack-agent-bundle.ts <slug> [output-dir]
 *
 * EJEMPLO:
 *   bun run scripts/pack-agent-bundle.ts agents-system
 *   → dist/extensions/agents-system-1.0.0.kernlext
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { packBundle } from "../src/modules/extensions/bundle.js";

async function main() {
  const slug = process.argv[2];
  const outDir = process.argv[3] ?? "dist/extensions";
  if (!slug) {
    console.error("Usage: bun run scripts/pack-agent-bundle.ts <slug> [output-dir]");
    process.exit(1);
  }

  const kernelRoot = resolve(dirname(process.argv[1] ?? ""), "..");
  // Look in both the public directory and the personal (gitignored) one.
  // The first hit wins; the caller can override with the full path as slug.
  const bundleDir = [
    resolve(kernelRoot, "assets/bundles", slug),
    resolve(kernelRoot, "assets/personal", slug),
  ].find((p) => existsSync(p));
  if (!bundleDir) {
    console.error(`Not found: assets/bundles/${slug} or assets/personal/${slug}`);
    process.exit(2);
  }

  const manifestPath = resolve(bundleDir, "extension.json");
  if (!existsSync(manifestPath)) {
    console.error(`Manifest missing: ${manifestPath}`);
    process.exit(2);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    slug?: string;
    version?: string;
    type?: string;
    agents?: string[];
    flows?: string[];
    office?: string;
    chains?: string[];
  };
  if (manifest.type !== "agent-bundle" && manifest.type !== "office") {
    console.error(`Expected type='agent-bundle' or 'office' in manifest, got '${manifest.type}'`);
    process.exit(3);
  }
  if (manifest.slug !== slug) {
    console.error(`Manifest slug='${manifest.slug}' does not match dir slug='${slug}'`);
    process.exit(3);
  }

  const version = manifest.version ?? "1.0.0";

  console.log(`📦 Packaging agent-bundle: ${slug}`);
  console.log(`   Source: ${bundleDir}`);

  // Validate referenced files exist and parse.
  const allRefs = [
    ...(manifest.agents ?? []),
    ...(manifest.flows ?? []),
    ...(manifest.chains ?? []),
    ...(manifest.office ? [manifest.office] : []),
  ];
  for (const rel of allRefs) {
    const abs = resolve(bundleDir, rel);
    if (!existsSync(abs)) {
      console.error(`   ✗ Missing referenced file: ${rel}`);
      process.exit(4);
    }
    try {
      JSON.parse(readFileSync(abs, "utf-8"));
    } catch (err) {
      console.error(`   ✗ Invalid JSON in ${rel}: ${String(err)}`);
      process.exit(4);
    }
  }
  console.log(`   ${manifest.agents?.length ?? 0} agent(s), ${manifest.flows?.length ?? 0} flow(s) — all valid`);

  // Pack directly from the bundle dir (no staging — manifest + json files
  // are already in the canonical layout the installer reads).
  const outPath = resolve(kernelRoot, outDir, `${slug}-${version}.kernlext`);
  mkdirSync(dirname(outPath), { recursive: true });
  const result = await packBundle(bundleDir, outPath);

  const kb = Math.round(result.sizeBytes / 1024);
  console.log("");
  console.log(`✅ Packaged: ${outPath}`);
  console.log(`   sha256: ${result.sha256}`);
  console.log(`   size:   ${kb} KB`);
  console.log("");
  console.log("Install with:");
  console.log(`  BUNDLE=$(base64 -w0 ${outPath})`);
  console.log(`  curl -sS -X POST http://localhost:3087/api/extensions/upload \\`);
  console.log(`    -H 'Content-Type: application/json' \\`);
  console.log(`    -d "$(jq -cn --arg b64 "\\$BUNDLE" '{filename:"${slug}-${version}.kernlext", base64:\\$b64}')"`);
}

main().catch((err) => { console.error(err); process.exit(1); });
