/**
 * archive.org scrape API client + collection ingester.
 *
 * The scrape API (https://archive.org/services/search/v1/scrape) is the
 * cursor-paginated cousin of advancedsearch — it has no 10k-row cap and
 * is intended for bulk catalog harvesting. Each call returns up to 10000
 * rows plus a `cursor` to fetch the next page; an absent cursor means we
 * walked the entire result set.
 *
 * One ingestPass() call walks N pages (default 1) of one collection,
 * upserts the rows, and persists the next cursor in cinema_ingest_runs so
 * subsequent ticks resume mid-collection. The caller (the cron agent in
 * Stage 2) decides scheduling.
 */

import { log } from "../../../../../src/core/logger.js";
import type { CinemaService } from "./service.js";
import type { ArchiveScrapeRow, IngestRun } from "./types.js";

/** archive.org collection slugs we ingest. Verified against the live
 *  scrape API — `film_noir`, `horror`, and `sci-fi_horror` (lowercase)
 *  return zero items, the only working noir/horror collection slug is
 *  `SciFi_Horror` (case-sensitive). `opensource_movies` exists but has
 *  ~2.4M mostly-noise user uploads, so we skip it from the curated set
 *  — power users can add it via /api/cinema/ingest/run with an explicit
 *  collection arg. */
export const CINEMA_COLLECTIONS = [
  "feature_films",
  "silent_films",
  "classic_cartoons",
  "classic_tv",
  "SciFi_Horror",
  "prelinger",
  "moviesandfilms",
  // Stage-6 additions — verified non-empty against the live scrape API.
  "culturalandacademicfilms",
  "artsandmusicvideos",
  "animationandcartoons",
  "short_films",
  "vintage_cartoons",
  "educationalfilms",
];

const SCRAPE_URL = "https://archive.org/services/search/v1/scrape";
/** Sort newest-first so freshly-added items are ingested before we walk
 *  back into the already-known tail. Combined with the early-cutoff in
 *  ingestPass (refresh passes only), a refresh grabs just the new arrivals
 *  and stops instead of re-walking tens of thousands of rows we already
 *  have. The scrape API honours `sorts` while keeping cursor pagination
 *  stable — verified live against collection:moviesandfilms. A stale cursor
 *  from the old (identifier-order) walks is harmless: archive.org ignores a
 *  cursor whose sorter doesn't match and restarts from the newest row. */
const SORT_NEWEST_FIRST = "addeddate desc";
const FIELDS = [
  "identifier", "title", "date", "creator", "description", "subject",
  "collection", "language", "licenseurl", "runtime", "downloads", "week",
  "avg_rating", "num_reviews", "format", "addeddate", "publicdate",
];
/** archive.org docs say the max is 10000 but anything over ~500 hits CDN
 *  timeouts on heavy collections. 200 keeps us snappy and polite. */
const DEFAULT_PAGE_SIZE = 200;
/** Pages per ingestPass() call. 1 page = 200 rows = ~6s upstream. */
const DEFAULT_PAGES_PER_PASS = 1;
/** Sleep between pages in the same pass — be polite to archive.org. */
const PAGE_DELAY_MS = 800;
/** Per-request timeout. archive.org's scrape API is occasionally slow on
 *  large collections (>100k rows). */
const REQUEST_TIMEOUT_MS = 30_000;
/** Filter to items that ship a seedable .torrent. We could ingest all
 *  movies and let the user decide, but the catalog gets ~10x bigger and
 *  most non-torrent items are derivatives we don't care about. */
const TORRENT_ONLY_QUERY = 'mediatype:movies AND format:"Archive BitTorrent"';

interface ScrapeResponse {
  items?: ArchiveScrapeRow[];
  count?: number;            // rows in this page
  total?: number;            // total rows in the result set
  cursor?: string | null;     // null/missing = end of stream
}

export interface IngestPassOptions {
  /** Override the global page size for this pass. */
  pageSize?: number;
  /** How many scrape pages to walk in one pass. */
  maxPages?: number;
  /** Restrict to items with format:"Archive BitTorrent". Default true. */
  torrentOnly?: boolean;
  /** Stop the pass as soon as a full page yields zero new inserts. Only
   *  safe for REFRESH passes over a collection we've already walked to
   *  completion: since we sort newest-first, an all-known page means we've
   *  reached the known tail and everything older is known too. Leave false
   *  for first-time/interrupted backfills to guarantee full coverage. */
  earlyCutoff?: boolean;
}

export interface IngestPassResult {
  collection: string;
  pages: number;
  fetched: number;
  inserted: number;
  updated: number;
  cursor: string;             // empty when the collection finished
  finished: boolean;          // true when archive.org returns no cursor
  durationMs: number;
}

async function fetchScrapePage(
  query: string,
  cursor: string,
  pageSize: number,
): Promise<ScrapeResponse> {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("count", String(pageSize));
  // archive.org's scrape API takes a single comma-separated `fields`
  // parameter — repeating fields=a&fields=b silently ignores them and
  // returns the default subset (which does NOT include `format`, so
  // has_torrent ends up wrong on every row).
  params.set("fields", FIELDS.join(","));
  params.set("sorts", SORT_NEWEST_FIRST);
  if (cursor) params.set("cursor", cursor);

  const url = `${SCRAPE_URL}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": "Kernl/cinema-ingester" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`scrape ${r.status} ${r.statusText} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as ScrapeResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ingest the next chunk of a collection. Resumes from the persisted cursor
 * if a previous run left one behind.
 *
 * Returns counts so the caller can log/report. Updates the IngestRun row
 * monotonically — caller is responsible for opening/closing the run.
 */
export async function ingestPass(
  service: CinemaService,
  run: IngestRun,
  opts: IngestPassOptions = {},
): Promise<IngestPassResult> {
  const t0 = Date.now();
  // archive.org's scrape API enforces count >= 100. Below that returns
  // a 400 with "count is too small". 1000 is the upstream max we can use
  // without hitting CDN timeouts on heavy collections.
  const pageSize = Math.max(100, Math.min(opts.pageSize ?? DEFAULT_PAGE_SIZE, 1000));
  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_PAGES_PER_PASS);
  const torrentOnly = opts.torrentOnly !== false;
  const earlyCutoff = opts.earlyCutoff === true;

  const baseFilter = torrentOnly ? TORRENT_ONLY_QUERY : "mediatype:movies";
  const query = `${baseFilter} AND collection:${run.collection}`;

  let cursor = run.cursor;
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let pages = 0;
  let finished = false;

  for (let p = 0; p < maxPages; p++) {
    let resp: ScrapeResponse;
    try {
      resp = await fetchScrapePage(query, cursor, pageSize);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`cinema ingest: ${run.collection} page ${pages + 1} failed — ${msg}`);
      // Persist the cursor we DIDN'T advance past so the next tick retries.
      service.updateRun(run.id, {
        cursor,
        status: "paused",
        error: msg.slice(0, 240),
      });
      throw err;
    }

    const items = resp.items ?? [];
    fetched += items.length;
    pages++;

    let pageInserts = 0;
    for (const it of items) {
      const r = service.upsertFromScrape(it);
      if (r.inserted) {
        inserted++;
        pageInserts++;
      } else if (r.updated) {
        updated++;
      }
    }

    const next = resp.cursor ?? "";
    cursor = next;

    // Persist progress every page so a kernel restart resumes cleanly.
    service.updateRun(run.id, {
      cursor,
      fetched: items.length,
      upserted: items.length,
    });

    // Only an absent cursor is a hard end-of-stream signal. An empty
    // items[] with cursor still present is a transient gap (heavy
    // collections like opensource_movies have these mid-walk); breaking
    // out without marking finished keeps the caller's run in "running"
    // so the next tick resumes from the persisted cursor instead of
    // permanently labelling it "done" at 4% coverage.
    if (!next) {
      finished = true;
      break;
    }
    if (items.length === 0) {
      // Don't burn the rest of the pass on a presumed-empty zone; let
      // the next tick try again with a small back-off baked into the
      // cron schedule.
      log.warn(`cinema ingest: ${run.collection} returned empty page with cursor present — leaving run RUNNING for retry`);
      break;
    }

    // Early cutoff (refresh passes only): sorted newest-first, so a page
    // that produced zero new inserts means we've reached the already-known
    // tail — everything further down is older and known too. Mark finished
    // instead of re-walking the whole collection we already have.
    if (earlyCutoff && pageInserts === 0) {
      finished = true;
      log.info(
        `cinema ingest: ${run.collection} — reached known tail (0 new on ${items.length}-row page), stopping early after ${fetched} rows this pass`,
      );
      break;
    }

    if (p < maxPages - 1) {
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
  }

  return {
    collection: run.collection,
    pages,
    fetched,
    inserted,
    updated,
    cursor,
    finished,
    durationMs: Date.now() - t0,
  };
}

/**
 * One-shot helper used by the cron agent: pick a collection that has work
 * left, open or resume its run, walk maxPages pages.
 *
 * Strategy:
 *   1. If any collection has a 'paused' run, resume it.
 *   2. Else if any collection has a 'running' run with a cursor, resume.
 *   3. Else if a collection has no run yet, open one.
 *   4. Else (everything is 'done'): pick the oldest finished run and
 *      open a new pass to refresh it.
 */
export async function ingestNextChunk(
  service: CinemaService,
  collections: string[] = CINEMA_COLLECTIONS,
  opts: IngestPassOptions = {},
): Promise<IngestPassResult | null> {
  if (collections.length === 0) return null;

  // Build a snapshot of latest runs per collection.
  const snapshot = collections.map((c) => ({ collection: c, latest: service.latestRun(c) }));

  const paused = snapshot.find((s) => s.latest?.status === "paused");
  const running = snapshot.find(
    (s) => s.latest?.status === "running" && (s.latest.cursor ?? "") !== "",
  );
  const fresh = snapshot.find((s) => !s.latest);

  let run: IngestRun | null = null;
  // Refresh passes (re-checking a fully-walked collection for new arrivals)
  // opt into early-cutoff; first-time/interrupted backfills must not, so
  // they keep walking to full coverage. Callers can still force either via
  // opts.earlyCutoff.
  let isRefresh = false;
  if (paused?.latest) {
    run = paused.latest;
    service.updateRun(run.id, { status: "running", error: "" });
    run = { ...run, status: "running", error: "" };
  } else if (running?.latest) {
    run = running.latest;
  } else if (fresh) {
    run = service.startRun(fresh.collection);
  } else {
    // Everything done — refresh the oldest finished collection.
    const oldest = [...snapshot].sort((a, b) => {
      const at = a.latest?.finished_at ?? a.latest?.started_at ?? "";
      const bt = b.latest?.finished_at ?? b.latest?.started_at ?? "";
      return at.localeCompare(bt);
    })[0];
    run = service.startRun(oldest.collection);
    isRefresh = true;
  }

  if (!run) return null;

  try {
    const result = await ingestPass(service, run, {
      ...opts,
      earlyCutoff: opts.earlyCutoff ?? isRefresh,
    });
    service.updateRun(run.id, {
      status: result.finished ? "done" : "running",
      finished_at: result.finished ? new Date().toISOString() : null,
    });
    return result;
  } catch (err) {
    // ingestPass already flagged the run as 'paused' before re-throwing.
    log.error(`cinema ingest: pass failed for ${run.collection}`, err);
    return null;
  }
}
