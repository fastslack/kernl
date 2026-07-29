#!/usr/bin/env bun
/**
 * Real-model demo of the unified brain: seeds a few rows across tasks /
 * notes / contacts, indexes them with the ACTUAL local MiniLM embeddings
 * (not the test mock), and runs a cross-module recall.
 *
 * Proves the end-to-end embed → index → recall path with the real model.
 *
 *   bun scripts/demo-brain.ts
 */

import { Database } from "bun:sqlite";
import { LocalEmbeddings } from "../src/core/embeddings/local.js";
import { BrainService } from "../src/modules/brain/service.js";
import { BrainIndexer } from "../src/modules/brain/indexer.js";

const db = new Database(":memory:");
db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, tags TEXT, updated_at TEXT, deleted_at TEXT)");
db.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, body TEXT, tags TEXT, updated_at TEXT)");
db.exec("CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, company TEXT, relationship TEXT, notes TEXT, updated_at TEXT)");

db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run(
  "t1", "Empacar para la mudanza", "comprar cajas y cinta, embalar la cocina", "hogar", "2026-06-01T10:00:00Z", null);
db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run(
  "t2", "Renovar el seguro del auto", "llamar a la aseguradora antes del vencimiento", "auto", "2026-06-02T10:00:00Z", null);
db.prepare("INSERT INTO notes VALUES (?,?,?,?,?)").run(
  "n1", "Departamento nuevo", "la inmobiliaria pide deposito y garantia para el alquiler", "mudanza", "2026-06-01T11:00:00Z");
db.prepare("INSERT INTO notes VALUES (?,?,?,?,?)").run(
  "n2", "Receta de pan", "harina, agua, sal y levadura", "cocina", "2026-06-01T09:00:00Z");
db.prepare("INSERT INTO contacts VALUES (?,?,?,?,?,?)").run(
  "c1", "Marcela Ruiz", "Inmobiliaria Centro", "agente", "nos muestra departamentos en alquiler", "2026-06-01T12:00:00Z");

async function main() {
  console.log("Loading real MiniLM embeddings (first run downloads the ONNX model)…");
  const embeddings = new LocalEmbeddings();
  const ok = await embeddings.available();
  console.log(`embeddings: ${embeddings.model} dim=${embeddings.dim} available=${ok}\n`);

  const svc = new BrainService(db, embeddings);
  const indexer = new BrainIndexer(db, svc);

  const res = await indexer.indexAll();
  console.log(`Indexed ${res.indexed} items across modules. Coverage:`, svc.stats().byKind, "\n");

  for (const query of ["alquilar un departamento y mudarme", "cocinar algo rico"]) {
    console.log(`🔎 recall("${query}")`);
    const hits = await svc.recall({ query, minSimilarity: 0.1, limit: 4, resolveRows: false });
    for (const h of hits) {
      console.log(`   [${h.item.kind.padEnd(7)}] sim=${h.similarity.toFixed(3)}  ${h.item.text.slice(0, 60)}`);
    }
    console.log();
  }

  // Demonstrate the autoaprendizaje loop: ignore the top hit, see it drop.
  const before = await svc.recall({ query: "mudanza", minSimilarity: 0.1, limit: 3 });
  if (before.length >= 2) {
    console.log(`autoaprendizaje: ignoring top hit "${before[0].item.text.slice(0, 40)}"…`);
    svc.reinforce(before[0].item.id, "ignore");
    svc.reinforce(before[1].item.id, "open");
    const after = await svc.recall({ query: "mudanza", minSimilarity: 0.1, limit: 3 });
    console.log(`   new top: "${after[0].item.text.slice(0, 40)}" (weight ${after[0].item.weight.toFixed(2)})\n`);
  }

  db.close();
  console.log("✅ demo complete");
}

main().catch((e) => {
  console.error("demo failed:", e);
  process.exit(1);
});
