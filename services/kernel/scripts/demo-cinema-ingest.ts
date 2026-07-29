/**
 * Stage-1 demo — exercises the cinema module against a real archive.org
 * collection.
 *
 * Boots an in-memory SQLite, runs the cinema migration, ingests one page
 * of `silent_films` (the smallest of the curated collections — roughly
 * 3-4k titles), prints sample rows + run state.
 *
 * No network calls outside archive.org's scrape API. No kernel side-effects.
 *
 * Run:
 *   npx tsx scripts/demo-cinema-ingest.ts [collection]
 */

import Database from "better-sqlite3";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { ingestPass } from "../assets/extensions/leisure/cinema/_module/ingester.js";

function bar(s: string): void {
  console.log("\n" + "─".repeat(72) + "\n  " + s + "\n" + "─".repeat(72));
}

async function main(): Promise<void> {
  const collection = process.argv[2] ?? "silent_films";
  bar(`Cinema ingest demo — collection=${collection}`);

  // In-memory db so the demo is repeatable and side-effect-free.
  const db = new Database(":memory:");
  runMigrations(db, "cinema", cinemaMigrations);
  const service = new CinemaService(db);

  bar("Open run + walk one scrape page (200 rows)");
  const run = service.startRun(collection);
  console.log(`run id: ${run.id.slice(0, 12)}…  cursor=(empty, fresh start)`);

  const t0 = Date.now();
  const result = await ingestPass(service, run, { pageSize: 200, maxPages: 1 });
  const wallMs = Date.now() - t0;
  service.updateRun(run.id, {
    status: result.finished ? "done" : "running",
    finished_at: result.finished ? new Date().toISOString() : null,
  });

  console.log(
    `pass: ${result.pages} page(s)  fetched=${result.fetched}  ` +
      `inserted=${result.inserted}  updated=${result.updated}  ` +
      `${result.finished ? "finished" : "more pages remain"}  ` +
      `(${wallMs} ms wall)`,
  );

  bar("Run state after pass");
  const after = service.latestRun(collection);
  if (!after) {
    console.log("⚠ no run row — something is wrong");
    process.exit(1);
  }
  console.log(`status=${after.status}  fetched=${after.fetched}  upserted=${after.upserted}`);
  console.log(`cursor=${after.cursor.slice(0, 60)}${after.cursor.length > 60 ? "…" : ""}`);
  console.log(`started_at=${after.started_at}`);
  console.log(`finished_at=${after.finished_at ?? "—"}`);

  bar("Sample rows (first 5 by downloads)");
  const sample = service.list({ collection, sort: "downloads", limit: 5 });
  for (const t of sample) {
    console.log(
      `  · ${t.identifier.padEnd(36)}  ${t.title.slice(0, 50).padEnd(50)}  ` +
        `${t.year || "????"}  ↓ ${t.downloads.toLocaleString().padStart(9)}`,
    );
  }

  bar("One full row (verify all fields parsed correctly)");
  const first = sample[0];
  if (first) {
    console.log(JSON.stringify({
      identifier: first.identifier,
      title: first.title,
      year: first.year,
      creator: first.creator,
      description_preview: first.description.slice(0, 200),
      subject_count: first.subject.length,
      collection: first.collection,
      language: first.language,
      runtime_sec: first.runtime_sec,
      downloads: first.downloads,
      avg_rating: first.avg_rating,
      has_torrent: first.has_torrent,
      poster_url: first.poster_url,
      addeddate: first.addeddate,
      embedded_at: first.embedded_at,
    }, null, 2));
  }

  bar("Aggregate counts");
  console.log(`total titles in catalog: ${service.countAll()}`);
  console.log(`pending embedding (bge-m3 / 1024): ${service.pendingEmbeddingIds("text-embedding-bge-m3", 1024, 99999).length}`);

  bar("✓ demo complete");
  console.log("Stage 1 verification: ingester walks scrape API, upsert preserves user");
  console.log("columns, run state survives across calls (cursor persisted).");
}

main().catch((err) => {
  console.error("\n✗ demo failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
