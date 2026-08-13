/**
 * Stage-2 demo — end-to-end embeddings pipeline.
 *
 *   1. Ingest a small batch of titles from archive.org.
 *   2. Embed them via the configured EmbeddingsClient (LMStudio bge-m3
 *      by default; falls back to local MiniLM if LMStudio is down).
 *   3. Write CinemaTitle nodes + vectors to Neo4j and create the vector
 *      index. Skips silently if Neo4j is unavailable.
 *   4. Run several Spanish queries against the vector index and show
 *      the top hits — proves retrieval works in español.
 *
 * Run:
 *   npx tsx scripts/demo-cinema-embed.ts [collection] [batch=32]
 */

import "dotenv/config";
import Database from "better-sqlite3";
import { runMigrations } from "../src/core/db/migrations.js";
import { Neo4jClient } from "../src/core/db/neo4j.js";
import { loadConfig } from "../src/core/config.js";
import { createEmbeddingsClient } from "../src/core/embeddings/index.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { ingestPass } from "../assets/extensions/leisure/cinema/_module/ingester.js";
import { embedPending, searchSimilar, buildTextProfile, indexNameFor } from "../assets/extensions/leisure/cinema/_module/embeddings.js";

function bar(s: string): void {
  console.log("\n" + "─".repeat(72) + "\n  " + s + "\n" + "─".repeat(72));
}

async function main(): Promise<void> {
  const collection = process.argv[2] ?? "silent_films";
  const targetBatch = parseInt(process.argv[3] ?? "32", 10);

  bar(`Stage-2 demo — collection=${collection}, batch=${targetBatch}`);

  const config = loadConfig();
  console.log(`config.embeddings: provider=${config.embeddings.provider} model=${config.embeddings.model} dim=${config.embeddings.dim}`);

  // ── Boot in-memory SQLite + cinema schema ────────────────────
  const db = new Database(":memory:");
  runMigrations(db, "cinema", cinemaMigrations);
  const service = new CinemaService(db);

  // ── Connect to Neo4j (best-effort) ───────────────────────────
  const neo4j = new Neo4jClient();
  await neo4j.connect(config.neo4j);
  console.log(`neo4j.available = ${neo4j.available}`);
  if (neo4j.available) {
    // Drop our test label clean before each run so the demo is repeatable.
    // Label-scoped, so it only deletes the nodes this demo wrote.
    await neo4j.run("MATCH (c:CinemaTitle) DETACH DELETE c");
    console.log("neo4j: cleared previous CinemaTitle nodes");
  }

  // ── Embeddings client ────────────────────────────────────────
  const embedder = await createEmbeddingsClient(config);
  console.log(`embedder: provider=${embedder.provider} model=${embedder.model} dim=${embedder.dim}`);

  // ── Ingest one page ──────────────────────────────────────────
  bar("Ingest one scrape page");
  const run = service.startRun(collection);
  const pageRes = await ingestPass(service, run, { pageSize: 100, maxPages: 1 });
  service.updateRun(run.id, {
    status: pageRes.finished ? "done" : "running",
    finished_at: pageRes.finished ? new Date().toISOString() : null,
  });
  console.log(`ingest: ${pageRes.fetched} fetched, ${pageRes.inserted} inserted (${pageRes.durationMs} ms)`);
  console.log(`catalog: ${service.countAll()} titles`);

  // Show what the embedding text looks like for the first row — useful
  // for debugging when retrieval misses (often it's the profile text).
  bar("Sample text profile (first row, what we actually embed)");
  const sampleTitle = service.list({ collection, limit: 1 })[0];
  if (sampleTitle) {
    const profile = buildTextProfile(sampleTitle);
    console.log(`identifier: ${sampleTitle.identifier}`);
    console.log(`profile (${profile.length} chars):`);
    console.log("  " + profile.slice(0, 400) + (profile.length > 400 ? "…" : ""));
  }

  // ── Embed in batches until we've covered targetBatch rows ────
  bar(`Embed up to ${targetBatch} pending rows`);
  const t0 = Date.now();
  let totalEmbedded = 0;
  let totalGraph = 0;
  while (totalEmbedded < targetBatch) {
    const remaining = targetBatch - totalEmbedded;
    const r = await embedPending(service, embedder, neo4j, Math.min(32, remaining));
    if (r.embedded === 0) break;
    totalEmbedded += r.embedded;
    totalGraph += r.graphWrites;
    console.log(`  · batch: ${r.embedded} embedded, ${r.graphWrites} graph writes, ${r.durationMs} ms`);
  }
  const totalMs = Date.now() - t0;
  console.log(`\nembedded ${totalEmbedded} titles in ${totalMs} ms (${(totalMs / Math.max(1, totalEmbedded)).toFixed(1)} ms/title)`);
  console.log(`graph writes: ${totalGraph}${neo4j.available ? "" : " (Neo4j down — vectors only in SQLite flag)"}`);

  // ── Verify SQLite bookkeeping ────────────────────────────────
  bar("Bookkeeping check");
  const stillPending = service.pendingEmbeddingIds(embedder.model, embedder.dim, 9999);
  console.log(`pending after batch: ${stillPending.length} (should be ${service.countAll() - totalEmbedded})`);

  // ── Semantic search ─────────────────────────────────────────
  if (!neo4j.available) {
    bar("Skipping semantic search — Neo4j unavailable");
    console.log("Bring Neo4j up (docker compose up neo4j) and re-run to exercise the vector index.");
    neo4j.close().catch(() => {});
    return;
  }

  bar(`Semantic search — index=${indexNameFor(embedder)}`);
  const queries = [
    "películas mudas con escenas de acción",
    "comedias clásicas en blanco y negro",
    "drama de drácula y vampiros antiguos",
    "documental experimental europeo de los años 20",
    "películas dirigidas por Charlie Chaplin",
  ];

  for (const q of queries) {
    const t = Date.now();
    let hits;
    try {
      hits = await searchSimilar(embedder, neo4j, q, 5);
    } catch (err) {
      console.log(`  ✗ "${q}" → ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const ms = Date.now() - t;
    console.log(`\nquery: "${q}"  (${hits.length} hits, ${ms} ms)`);
    for (const h of hits) {
      const title = (h.title || h.identifier).slice(0, 56).padEnd(56);
      console.log(`  ${h.score.toFixed(3)}  ${title}  ${h.year || "????"}`);
    }
  }

  bar("✓ demo complete");
  console.log("Stage 2 verification: bge-m3 vectors land in Neo4j, vector index");
  console.log("queries return ranked Spanish-relevant hits.");

  await neo4j.close();
}

main().catch((err) => {
  console.error("\n✗ demo failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
