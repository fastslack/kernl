#!/usr/bin/env bun
/**
 * Miniature REAL-CASE demo of the unified brain (project pattern:
 * validate with a miniature real demo, not synthetic data).
 *
 * Opens the LIVE kernel.db READ-ONLY, samples a few recent rows from each
 * source module, indexes them with the REAL MiniLM embeddings into an
 * in-memory brain (nothing is written to the live DB), then proves
 * cross-module recall by seeding queries from real items.
 *
 *   bun scripts/demo-brain-real.ts
 *
 * Safe: read-only on kernel.db, all brain state in :memory:.
 */

import { Database } from "bun:sqlite";
import { LocalEmbeddings } from "../src/core/embeddings/local.js";
import { BrainService } from "../src/modules/brain/service.js";
import { textProfile, DEFAULT_SOURCES } from "../src/modules/brain/indexer.js";

const SAMPLE_PER_SOURCE = 50;

const live = new Database("data/kernel.db", { readonly: true });
live.run("PRAGMA busy_timeout = 8000");
const mem = new Database(":memory:");

function tableExists(db: Database, t: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function cols(db: Database, t: string): Set<string> {
  return new Set((db.prepare("SELECT name FROM pragma_table_info(?)").all(t) as Array<{ name: string }>).map((r) => r.name));
}
function trunc(s: string, n = 68): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

async function main() {
  console.log("Loading real MiniLM embeddings…");
  const emb = new LocalEmbeddings();
  await emb.available();
  const svc = new BrainService(mem, emb);
  console.log(`embeddings: ${emb.model} dim=${emb.dim}\n`);

  const seeds: Array<{ kind: string; text: string }> = [];

  for (const src of DEFAULT_SOURCES) {
    if (!tableExists(live, src.table)) {
      console.log(`  · ${src.table}: (ausente — skip)`);
      continue;
    }
    const have = cols(live, src.table);
    const tsCol = have.has(src.tsCol ?? "updated_at") ? (src.tsCol ?? "updated_at") : null;
    const textCols = src.textCols.filter((c) => have.has(c));
    if (!tsCol || textCols.length === 0) {
      console.log(`  · ${src.table}: (columnas faltantes — skip)`);
      continue;
    }
    const softFilter = src.softDeleteCol && have.has(src.softDeleteCol)
      ? `AND (${src.softDeleteCol} IS NULL OR ${src.softDeleteCol} = '')`
      : "";
    const rows = live
      .prepare(`SELECT id, ${textCols.join(", ")} FROM ${src.table} WHERE 1=1 ${softFilter} ORDER BY ${tsCol} DESC LIMIT ${SAMPLE_PER_SOURCE}`)
      .all() as Array<Record<string, unknown>>;

    const profiles = rows.map((r) => ({ id: String(r.id), text: textProfile(r, textCols) })).filter((p) => p.text);
    if (profiles.length === 0) {
      console.log(`  · ${src.kind}: 0 con texto`);
      continue;
    }
    const vecs = await svc.embed(profiles.map((p) => p.text));
    profiles.forEach((p, i) =>
      svc.upsert({ kind: src.kind, sourceTable: src.table, sourceId: p.id, text: p.text, embedding: vecs[i] }),
    );
    console.log(`  · ${src.kind.padEnd(8)}: indexados ${profiles.length}`);
    // Keep one mid-list item as a seed query.
    seeds.push({ kind: src.kind, text: profiles[Math.floor(profiles.length / 2)].text });
  }

  const stats = svc.stats();
  console.log(`\nTotal indexado: ${stats.total} items reales →`, stats.byKind, "\n");
  console.log("═".repeat(72));
  console.log("RECALL CRUZADO — semilla = un item real, resultado = vecinos de TODOS los módulos");
  console.log("═".repeat(72));

  const allKinds = Object.keys(stats.byKind);
  for (const seed of seeds.slice(0, 4)) {
    console.log(`\n🌱 [${seed.kind}] "${trunc(seed.text)}"`);
    // Cross-module: exclude the seed's own kind so we see what OTHER modules
    // relate to it — the actual "hace un uno" payoff.
    const otherKinds = allKinds.filter((k) => k !== seed.kind);
    const hits = await svc.recall({ query: seed.text, kinds: otherKinds, minSimilarity: 0.2, limit: 4, resolveRows: false });
    if (hits.length === 0) {
      console.log(`   (sin vecinos cross-módulo sobre el umbral)`);
      continue;
    }
    for (const h of hits) {
      console.log(`   ↔ [${h.item.kind.padEnd(8)}] sim=${h.similarity.toFixed(3)}  ${trunc(h.item.text)}`);
    }
    console.log(`   → ${new Set(hits.map((h) => h.item.kind)).size} módulo(s) distintos al de la semilla`);
  }

  live.close();
  mem.close();
  console.log("\n✅ demo real completo (DB viva nunca fue modificada)");
}

main().catch((e) => {
  console.error("demo failed:", e);
  process.exit(1);
});
