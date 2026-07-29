/**
 * Generic archive.org collection ingester.
 *
 * archive.org's scrape API (https://archive.org/services/search/v1/scrape)
 * is the cursor-paginated cousin of advancedsearch — no 10k-row cap, intended
 * for bulk catalog harvesting. Each call returns up to 10000 rows + a
 * `cursor` for the next page; absent cursor = end of stream.
 *
 * One `ingestPass()` walks N pages of one collection, upserts the rows via
 * the catalog service, and persists the next cursor in the runs table so
 * subsequent ticks resume mid-collection across kernel restarts.
 *
 * `ingestNextChunk()` is the cron-friendly entry: pick a collection that
 * has work left, open or resume its run, walk maxPages pages.
 */

import { log } from "../../../../../src/core/logger.js";
import type { ArchiveCatalog } from "./service.js";
import type {
  ArchiveScrapeRow,
  IngestPassConfig,
  IngestPassResult,
  IngestRun,
} from "./types.js";

const SCRAPE_URL = "https://archive.org/services/search/v1/scrape";
const FIELDS = [
  "identifier", "title", "date", "creator", "description", "subject",
  "collection", "language", "licenseurl", "downloads", "week",
  "avg_rating", "num_reviews", "format", "addeddate", "publicdate",
];
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_PAGES_PER_PASS = 1;
const DEFAULT_PAGE_DELAY_MS = 800;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface ScrapeResponse {
  items?: ArchiveScrapeRow[];
  count?: number;
  total?: number;
  cursor?: string | null;
}

async function fetchScrapePage(
  query: string,
  cursor: string,
  pageSize: number,
  timeoutMs: number,
  uaTag: string,
): Promise<ScrapeResponse> {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("count", String(pageSize));
  // archive.org's scrape API takes a comma-separated `fields` param;
  // repeating fields=a&fields=b silently ignores them (lesson learned).
  params.set("fields", FIELDS.join(","));
  if (cursor) params.set("cursor", cursor);

  const url = `${SCRAPE_URL}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": `Kernl/${uaTag}` },
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
 * Ingest the next chunk of a collection. Resumes from the persisted
 * cursor if a previous run left one behind. Returns counts so the
 * caller can log/report.
 */
export async function ingestPass(
  catalog: ArchiveCatalog,
  run: IngestRun,
  config: IngestPassConfig,
  uaTag = "archive-ingester",
): Promise<IngestPassResult> {
  const t0 = Date.now();
  const pageSize    = clamp(config.pageSize ?? DEFAULT_PAGE_SIZE, 100, 1000);
  const maxPages    = Math.max(1, config.maxPages ?? DEFAULT_PAGES_PER_PASS);
  const pageDelayMs = Math.max(0, config.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS);
  const timeoutMs   = Math.max(1000, config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

  const baseFilter = config.extraQuery
    ? `mediatype:${config.mediatype} AND ${config.extraQuery}`
    : `mediatype:${config.mediatype}`;
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
      resp = await fetchScrapePage(query, cursor, pageSize, timeoutMs, uaTag);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`archive-ingester[${uaTag}]: ${run.collection} page ${pages + 1} failed — ${msg}`);
      // Persist the cursor we DIDN'T advance past so the next tick retries.
      catalog.updateRun(run.id, {
        cursor,
        status: "paused",
        error: msg.slice(0, 240),
      });
      throw err;
    }

    const items = resp.items ?? [];
    fetched += items.length;
    pages++;

    for (const it of items) {
      const r = catalog.upsertFromScrape(it);
      if (r.inserted) inserted++;
      else if (r.updated) updated++;
    }

    const next = resp.cursor ?? "";
    cursor = next;

    catalog.updateRun(run.id, {
      cursor,
      fetched: items.length,
      upserted: items.length,
    });

    if (!next || items.length === 0) {
      finished = true;
      break;
    }

    if (p < maxPages - 1) {
      await new Promise((r) => setTimeout(r, pageDelayMs));
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
 * One-shot helper for cron-driven ingestion.
 *
 * Strategy:
 *   1. If any collection has a 'paused' run → resume it.
 *   2. Else if any collection has a 'running' run with cursor → resume.
 *   3. Else if a collection has no run yet → open one.
 *   4. Else (all done) → refresh the oldest finished collection.
 */
export async function ingestNextChunk(
  catalog: ArchiveCatalog,
  collections: string[],
  config: IngestPassConfig,
  uaTag = "archive-ingester",
): Promise<IngestPassResult | null> {
  if (collections.length === 0) return null;
  const snapshot = collections.map((c) => ({ collection: c, latest: catalog.latestRun(c) }));

  const paused = snapshot.find((s) => s.latest?.status === "paused");
  const running = snapshot.find(
    (s) => s.latest?.status === "running" && (s.latest.cursor ?? "") !== "",
  );
  const fresh = snapshot.find((s) => !s.latest);

  let run: IngestRun | null = null;
  if (paused?.latest) {
    run = paused.latest;
    catalog.updateRun(run.id, { status: "running", error: "" });
    run = { ...run, status: "running", error: "" };
  } else if (running?.latest) {
    run = running.latest;
  } else if (fresh) {
    run = catalog.startRun(fresh.collection);
  } else {
    const oldest = [...snapshot].sort((a, b) => {
      const at = a.latest?.finished_at ?? a.latest?.started_at ?? "";
      const bt = b.latest?.finished_at ?? b.latest?.started_at ?? "";
      return at.localeCompare(bt);
    })[0];
    run = catalog.startRun(oldest.collection);
  }

  if (!run) return null;

  try {
    const result = await ingestPass(catalog, run, config, uaTag);
    catalog.updateRun(run.id, {
      status: result.finished ? "done" : "running",
      finished_at: result.finished ? new Date().toISOString() : null,
    });
    return result;
  } catch (err) {
    log.error(`archive-ingester[${uaTag}]: pass failed for ${run.collection}`, err);
    return null;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
