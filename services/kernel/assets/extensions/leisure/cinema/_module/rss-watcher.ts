/**
 * RSS watcher — near-real-time poll of archive.org collection feeds.
 *
 * The full scrape ingester (`ingester.ts`) does a cursor-paginated sweep
 * of every collection — exhaustive but slow (one collection per tick,
 * ~6s per page, hours to walk feature_films end-to-end). RSS gives us
 * the latest ~50 items per collection essentially for free. We poll the
 * curated collection list, extract identifiers, compare against what's
 * already in `cinema_titles`, and hydrate the new ones via a single
 * batch scrape call so the same upsert path that powers the full
 * ingester runs unchanged.
 *
 * Designed to coexist with `ingester.ts` — both feed `service.upsertFromScrape`
 * idempotently, and the scrape API's `last_seen_at` bump keeps either
 * one from looking "stale".
 */

import { log } from "../../../../../src/core/logger.js";
import type { CinemaService } from "./service.js";
import type { ArchiveScrapeRow } from "./types.js";
import { CINEMA_COLLECTIONS } from "./ingester.js";

const RSS_BASE = "https://archive.org/services/collection-rss.php";
const SCRAPE_URL = "https://archive.org/services/search/v1/scrape";
/** Same field list the full ingester requests — keeps the upsert path's
 *  inputs identical between the two paths so neither one fills in zeros
 *  for fields the other one provides. */
const SCRAPE_FIELDS = [
  "identifier", "title", "date", "creator", "description", "subject",
  "collection", "language", "licenseurl", "runtime", "downloads", "week",
  "avg_rating", "num_reviews", "format", "addeddate", "publicdate",
];
/** Polite per-collection timeout — RSS feeds occasionally hang on the
 *  archive.org side; we don't want one slow collection to block the
 *  whole tick. */
const RSS_TIMEOUT_MS = 8_000;
const SCRAPE_TIMEOUT_MS = 15_000;
/** RSS endpoint returns ~50 items by default; archive.org silently caps
 *  larger requests at 50 so there's no point asking for more. */
const RSS_ITEMS_PER_FEED = 50;
/** Polite delay between collection requests. */
const PER_FEED_DELAY_MS = 400;

export interface RssWatchOptions {
  /** Collection slugs to poll. Defaults to the curated CINEMA_COLLECTIONS. */
  collections?: string[];
  /** Skip the scrape-hydrate step (just count what's new). Mostly for
   *  diagnostics / dry-run. Default: false. */
  dryRun?: boolean;
}

export interface RssWatchResult {
  /** How many RSS feeds were successfully polled. */
  feedsOk: number;
  /** How many feeds failed (timeout / 5xx / parse error). */
  feedsErr: number;
  /** Total identifiers seen across all feeds. */
  rssIds: number;
  /** Identifiers that were NOT already in cinema_titles. */
  newIds: number;
  /** Rows successfully upserted via scrape-hydrate. */
  upserted: number;
  /** Wall-clock duration of the full pass. */
  durationMs: number;
  /** Per-collection counts for the agent's summary line. */
  perCollection: Array<{ collection: string; rss: number; new: number }>;
}

/**
 * Run one pass: poll each collection's RSS feed, find new identifiers,
 * hydrate them via the scrape API, upsert into cinema_titles. Safe to
 * call back-to-back — duplicates are no-ops thanks to the identifier PK.
 */
export async function watchRssFeeds(
  service: CinemaService,
  opts: RssWatchOptions = {},
): Promise<RssWatchResult> {
  const t0 = Date.now();
  const collections = opts.collections ?? CINEMA_COLLECTIONS;
  let feedsOk = 0;
  let feedsErr = 0;
  let rssIds = 0;
  const perCollection: RssWatchResult["perCollection"] = [];
  const allNewIds = new Set<string>();

  for (const collection of collections) {
    try {
      const ids = await fetchRssIdentifiers(collection);
      // Cheap existence check — getByIdentifier returns the full row but
      // SQLite's prepared statement makes this fast enough at ~50 IDs/feed.
      // Adding a dedicated `hasIdentifier` to the service for this single
      // caller would be overkill.
      const newOnes = ids.filter((id) => service.getByIdentifier(id) === null);
      rssIds += ids.length;
      perCollection.push({ collection, rss: ids.length, new: newOnes.length });
      for (const id of newOnes) allNewIds.add(id);
      feedsOk++;
    } catch (err) {
      feedsErr++;
      log.warn(
        `cinema rss-watcher: ${collection} failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      perCollection.push({ collection, rss: 0, new: 0 });
    }
    if (PER_FEED_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, PER_FEED_DELAY_MS));
    }
  }

  let upserted = 0;
  if (!opts.dryRun && allNewIds.size > 0) {
    // Hydrate full metadata for the new identifiers in batches. The
    // scrape API's `q=identifier:(id1 OR id2 OR ...)` form lets us pull
    // 100 rows per HTTP round-trip vs 100 separate /metadata calls.
    const rows = await scrapeByIdentifiers([...allNewIds]);
    for (const row of rows) {
      try {
        const r = service.upsertFromScrape(row);
        if (r.inserted || r.updated) upserted++;
      } catch (err) {
        log.warn(
          `cinema rss-watcher: upsert ${row.identifier} failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    feedsOk,
    feedsErr,
    rssIds,
    newIds: allNewIds.size,
    upserted,
    durationMs: Date.now() - t0,
    perCollection,
  };
}

// ── RSS parsing ──────────────────────────────────────────────────────────

async function fetchRssIdentifiers(collection: string): Promise<string[]> {
  const url = `${RSS_BASE}?collection=${encodeURIComponent(collection)}&mediatype=movies`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RSS_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": "Kernl/cinema-rss-watcher" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!r.ok) throw new Error(`rss ${r.status} ${r.statusText}`);
    const xml = await r.text();
    return parseIdentifiersFromRss(xml).slice(0, RSS_ITEMS_PER_FEED);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the identifier out of every <item> in the RSS body. We don't need
 * a full XML parser: archive.org's collection RSS has a stable shape and
 * every item carries `<link>https://archive.org/details/<identifier></link>`
 * (and the matching `<guid>` for redundancy).
 *
 * Why regex instead of DOMParser/xml2js: the kernel runs Bun without a
 * DOMParser shim, and pulling a parser dep for one stable field would be
 * overkill. The regex is anchored on the `/details/<id>` URL shape so it
 * can't accidentally pick up an id from the <description> HTML thumbnail.
 */
function parseIdentifiersFromRss(xml: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Match <link>https://archive.org/details/<id></link> first, then fall
  // back to <guid>...</guid> for items where archive.org swapped them.
  const linkRe = /<link>\s*https?:\/\/(?:www\.)?archive\.org\/details\/([A-Za-z0-9._@-]+)\s*<\/link>/gi;
  for (const m of xml.matchAll(linkRe)) {
    const id = m[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// ── Batch scrape hydration ───────────────────────────────────────────────

/**
 * Pull full metadata for up to N identifiers via the scrape API in
 * chunks of 100. The query syntax `identifier:(a OR b OR …)` accepts
 * surprisingly long OR-lists but we chunk anyway to keep URLs sane and
 * stay polite. Order of returned rows is irrelevant — upsert is keyed
 * on identifier.
 */
async function scrapeByIdentifiers(ids: string[]): Promise<ArchiveScrapeRow[]> {
  const out: ArchiveScrapeRow[] = [];
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const orList = slice.map((id) => `identifier:${id}`).join(" OR ");
    const params = new URLSearchParams();
    params.set("q", orList);
    params.set("count", String(slice.length));
    params.set("fields", SCRAPE_FIELDS.join(","));
    const url = `${SCRAPE_URL}?${params.toString()}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SCRAPE_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        headers: { "user-agent": "Kernl/cinema-rss-watcher" },
        signal: ctrl.signal,
        redirect: "follow",
      });
      if (!r.ok) {
        log.warn(`cinema rss-watcher: scrape ${r.status} for chunk ${i}/${ids.length}`);
        continue;
      }
      const body = (await r.json()) as { items?: ArchiveScrapeRow[] };
      if (Array.isArray(body.items)) out.push(...body.items);
    } catch (err) {
      log.warn(
        `cinema rss-watcher: scrape chunk ${i} failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}
