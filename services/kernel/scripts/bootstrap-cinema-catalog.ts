/**
 * Bootstrap the cinema catalog — walks every collection end-to-end.
 *
 * Talks to the running kernel's HTTP API (default http://localhost:3086);
 * it does NOT spin up a kernel of its own, so the cron + embedder keep
 * working in parallel. The endpoint picks up the persisted cursor across
 * calls, so this script is restart-safe.
 *
 * Strategy:
 *   - For each collection, repeatedly POST /api/cinema/ingest/run with
 *     a big maxPages until `finished: true`.
 *   - 1500 ms pause between calls (be polite to archive.org's CDN).
 *   - Logs progress per collection + a running total.
 *
 * Env:
 *   KERNEL_URL          default http://localhost:3086
 *   PAGE_SIZE           default 500
 *   MAX_PAGES           default 10  (each call walks up to 5k rows)
 *   PAUSE_MS            default 1500
 *   COLLECTIONS         comma-separated override (default: all 9)
 */

const KERNEL_URL = (process.env.KERNEL_URL ?? "http://localhost:3086").replace(/\/+$/, "");
const PAGE_SIZE = parseInt(process.env.PAGE_SIZE ?? "500", 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES ?? "10", 10);
const PAUSE_MS = parseInt(process.env.PAUSE_MS ?? "1500", 10);

const ALL_COLLECTIONS = [
  "film_noir",          // smallest first → fast feedback
  "classic_cartoons",
  "sci-fi_horror",
  "horror",
  "silent_films",
  "classic_tv",
  "prelinger",
  "feature_films",
  "opensource_movies",  // last, by far the biggest
];

const COLLECTIONS = process.env.COLLECTIONS
  ? process.env.COLLECTIONS.split(",").map((s) => s.trim()).filter(Boolean)
  : ALL_COLLECTIONS;

interface IngestRunResult {
  collection: string;
  pages: number;
  fetched: number;
  inserted: number;
  updated: number;
  cursor: string;
  finished: boolean;
  durationMs: number;
}

async function ingestOnce(collection: string): Promise<IngestRunResult | null> {
  const r = await fetch(`${KERNEL_URL}/api/cinema/ingest/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ collection, maxPages: MAX_PAGES, pageSize: PAGE_SIZE }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.error(`✗ ingest failed (${r.status}): ${txt.slice(0, 200)}`);
    return null;
  }
  const body = (await r.json()) as { result: IngestRunResult };
  return body.result ?? null;
}

async function totalCatalog(): Promise<number> {
  try {
    const r = await fetch(`${KERNEL_URL}/api/cinema/ingest/status`);
    if (!r.ok) return -1;
    const body = (await r.json()) as { total?: number };
    return body.total ?? -1;
  } catch { return -1; }
}

function bar(s: string): void {
  console.log("\n" + "─".repeat(72) + "\n  " + s + "\n" + "─".repeat(72));
}

async function main(): Promise<void> {
  bar(`Bootstrap cinema catalog · kernel=${KERNEL_URL} · pageSize=${PAGE_SIZE} maxPages=${MAX_PAGES}`);
  console.log(`collections: ${COLLECTIONS.join(", ")}`);
  console.log(`starting catalog total: ${await totalCatalog()}`);

  const startedAt = Date.now();
  const summary: Array<{ collection: string; tick: number; inserted: number; updated: number; finished: boolean }> = [];

  for (const collection of COLLECTIONS) {
    bar(`▶ ${collection}`);
    let tick = 0;
    let totalInserted = 0;
    let totalUpdated = 0;
    let lastFetched = -1;
    let stalledTicks = 0;

    while (true) {
      tick++;
      const result = await ingestOnce(collection);
      if (!result) {
        console.log(`  [${tick}] aborting — kernel didn't respond`);
        break;
      }

      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(
        `  [${String(tick).padStart(3)}] pages=${result.pages} ` +
          `fetched=${String(result.fetched).padStart(5)} ` +
          `inserted=${String(result.inserted).padStart(5)} ` +
          `updated=${String(result.updated).padStart(5)} ` +
          `${result.finished ? "✓ collection complete" : "more remain"} ` +
          `(${result.durationMs} ms · t+${elapsed}s)`,
      );
      totalInserted += result.inserted;
      totalUpdated += result.updated;

      if (result.finished) break;

      // archive.org's scrape API has been observed to occasionally return
      // the same page twice (cursor doesn't advance). Detect a stall: if
      // 3 consecutive ticks bring 0 inserts, give up on this collection
      // and move on. The cron will pick it back up later.
      if (result.inserted === 0 && lastFetched === result.fetched) {
        stalledTicks++;
        if (stalledTicks >= 3) {
          console.log(`  ⚠ stalled — giving up after ${stalledTicks} no-progress ticks. Cron will retry.`);
          break;
        }
      } else {
        stalledTicks = 0;
      }
      lastFetched = result.fetched;

      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }

    summary.push({
      collection,
      tick,
      inserted: totalInserted,
      updated: totalUpdated,
      finished: tick > 0,
    });
    console.log(
      `  Σ ${collection}: ${tick} ticks · +${totalInserted} new · ${totalUpdated} updates`,
    );
  }

  bar("Summary");
  for (const s of summary) {
    console.log(
      `  ${s.collection.padEnd(22)} ticks=${String(s.tick).padStart(3)} +${s.inserted} new (${s.updated} updates)`,
    );
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\nfinal catalog total: ${await totalCatalog()}  ·  wall time: ${elapsed}s`);
  console.log("Embeddings worker (cinema:embed-pending, cron */5) processes these in the background.");
}

main().catch((err) => {
  console.error("\n✗ bootstrap failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
