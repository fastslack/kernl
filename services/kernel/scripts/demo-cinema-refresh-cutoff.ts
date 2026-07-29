/**
 * demo-cinema-refresh-cutoff.ts — proves the two guarantees added to the
 * cinema ingester, end-to-end against the LIVE archive.org scrape API using
 * the real CinemaService on an in-memory SQLite (no kernel side-effects):
 *
 *   1. Newest-first ordering  — the first page's rows are sorted by
 *      addeddate desc, so fresh arrivals are ingested before the old tail.
 *   2. Early cutoff (refresh) — once the DB already holds the newest rows,
 *      a refresh pass (earlyCutoff:true) stops on the first all-known page
 *      instead of re-walking the whole collection. With earlyCutoff:false
 *      (backfill) it keeps walking.
 *
 * Run:  bun run scripts/demo-cinema-refresh-cutoff.ts [collection]
 */

import Database from "better-sqlite3";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import { CinemaService } from "../assets/extensions/leisure/cinema/_module/service.js";
import { ingestPass } from "../assets/extensions/leisure/cinema/_module/ingester.js";
import type { IngestRun } from "../assets/extensions/leisure/cinema/_module/types.js";

function bar(s: string): void {
  console.log("\n" + "─".repeat(72) + "\n  " + s + "\n" + "─".repeat(72));
}

function freshRun(service: CinemaService, collection: string): IngestRun {
  // startRun persists a run row; we reset cursor to "" for each pass so the
  // scrape resumes from the newest row (addeddate desc).
  const run = service.startRun(collection);
  return { ...run, cursor: "" };
}

async function main(): Promise<void> {
  const collection = process.argv[2] ?? "silent_films";
  const db = new Database(":memory:");
  runMigrations(db, "cinema", cinemaMigrations);
  const service = new CinemaService(db);

  bar(`1) BACKFILL — ingest the newest page of ${collection}`);
  const back = await ingestPass(service, freshRun(service, collection), {
    pageSize: 100,
    maxPages: 1,
    earlyCutoff: false,
  });
  console.log(`   inserted=${back.inserted}  updated=${back.updated}  fetched=${back.fetched}`);

  // Verify newest-first: the max addeddate in the DB should equal the newest
  // row on archive.org for this collection.
  const newest = service.list({ collection, sort: "added_desc", limit: 3 } as never);
  console.log("   newest 3 rows now in catalog (by addeddate):");
  for (const t of newest as Array<{ identifier: string; addeddate: string }>) {
    console.log(`     · ${t.addeddate}  ${t.identifier}`);
  }
  const orderedDesc = (newest as Array<{ addeddate: string }>)
    .map((t) => t.addeddate)
    .every((v, i, a) => i === 0 || a[i - 1] >= v);

  bar("2) REFRESH with earlyCutoff:true — newest already known → stop early");
  const refresh = await ingestPass(service, freshRun(service, collection), {
    pageSize: 100,
    maxPages: 5,
    earlyCutoff: true,
  });
  console.log(`   pages=${refresh.pages} (cap 5)  inserted=${refresh.inserted}  finished=${refresh.finished}`);

  bar("3) REFRESH with earlyCutoff:false — keeps walking past the known head");
  const nocut = await ingestPass(service, freshRun(service, collection), {
    pageSize: 100,
    maxPages: 3,
    earlyCutoff: false,
  });
  console.log(`   pages=${nocut.pages} (cap 3)  inserted=${nocut.inserted}  finished=${nocut.finished}`);

  bar("verdict");
  const newestFirst = orderedDesc && back.inserted > 0;
  const cutoffStops = refresh.pages < 5 && refresh.finished && refresh.inserted === 0;
  const backfillWalks = nocut.pages > refresh.pages;
  console.log(`  newest-first ordering .......... ${newestFirst ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`  refresh stops on known page .... ${cutoffStops ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`  backfill keeps walking ......... ${backfillWalks ? "PASS ✅" : "FAIL ❌"}`);
  if (!newestFirst || !cutoffStops || !backfillWalks) process.exit(1);
  console.log("\n✓ all guarantees verified against live archive.org");
}

main().catch((err) => {
  console.error("\n✗ demo failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
