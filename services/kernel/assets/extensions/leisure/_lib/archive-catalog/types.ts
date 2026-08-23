/**
 * Shared archive.org catalog — public types.
 *
 * Cinema, music, books all consume the same archive.org search/metadata
 * endpoints. This lib provides the catalog primitives (titles table,
 * FTS5, tag aggregation, ingester, runs bookkeeping) that each module
 * was previously copy-pasting. Each consumer keeps its own *_titles,
 * *_titles_fts, *_tags, *_ingest_runs tables (the lib's migrations are
 * parameterized by `prefix`); domain-specific extras (subtitles in
 * cinema, library + play history in music, watchlist + reader in books)
 * stay in the consumer module.
 */

/**
 * Generic catalog row — what we store about any archive.org item,
 * independent of mediatype. Module-specific fields (cinema's
 * has_torrent, music's tracks, books' files) live elsewhere or are
 * derived on demand from /metadata.
 */
export interface CatalogTitle {
  identifier: string;
  title: string;
  date: string;
  year: number;            // parsed from date — 0 means unknown
  creator: string;
  description: string;
  subject: string[];
  collection: string[];
  language: string;
  licenseurl: string;
  downloads: number;
  week_downloads: number;
  avg_rating: number;
  num_reviews: number;
  /** Raw `format[]` from archive.org. Lets consumers detect format-derived
   *  flags (cinema's has_torrent comes from `Archive BitTorrent` here). */
  format: string[];
  addeddate: string;
  publicdate: string;
  ingested_at: string;
  last_seen_at: string;
}

/** Raw row returned by archive.org's scrape API. Fields are sometimes
 *  arrays (Solr multi-valued) and sometimes scalars. */
export interface ArchiveScrapeRow {
  identifier: string;
  title?: string | string[];
  date?: string | string[];
  creator?: string | string[];
  description?: string | string[];
  subject?: string | string[];
  collection?: string | string[];
  language?: string | string[];
  licenseurl?: string | string[];
  downloads?: number;
  week?: number;
  avg_rating?: number;
  num_reviews?: number;
  format?: string | string[];
  addeddate?: string;
  publicdate?: string;
}

export interface CatalogListFilter {
  /** FTS5 query (passed straight after sanitize). Empty = no text filter. */
  query?: string;
  /** Single archive.org collection slug, e.g. "78rpm". */
  collection?: string;
  /** Multiple normalized tags (lowercased). AND or OR via tagsMatch. */
  tags?: string[];
  tagsMatch?: "all" | "any";
  language?: string;
  yearMin?: number;
  yearMax?: number;
  sort?: "downloads" | "year_desc" | "year_asc" | "added_desc" | "rating";
  limit?: number;
  offset?: number;
}

export interface CatalogTagRow {
  tag_norm: string;
  tag_display: string;
  count: number;
  rank: number;
}

export interface IngestRun {
  id: string;
  collection: string;
  cursor: string;
  fetched: number;
  upserted: number;
  status: "running" | "done" | "failed" | "paused";
  error: string;
  started_at: string;
  finished_at: string | null;
}

export interface IngestRunUpdate {
  cursor?: string;
  fetched?: number;       // monotonic add
  upserted?: number;      // monotonic add
  status?: IngestRun["status"];
  error?: string;
  finished_at?: string | null;
}

/**
 * Configuration for an ingester pass. Each consumer module supplies
 * the mediatype + collections relevant to it.
 */
export interface IngestPassConfig {
  /** archive.org mediatype filter — `audio` | `movies` | `texts`. */
  mediatype: "audio" | "movies" | "texts";
  /** Optional extra Solr clause AND'd into the query (e.g.
   *  `format:"Archive BitTorrent"` for cinema). */
  extraQuery?: string;
  pageSize?: number;       // default 200, max 1000
  maxPages?: number;       // pages per pass (default 1)
  pageDelayMs?: number;    // sleep between pages (default 800ms)
  requestTimeoutMs?: number;
  /**
   * Hard ceiling on how many rows this catalog may hold. Once reached the
   * ingester stops walking the cursor and leaves the run parked.
   *
   * There was no ceiling at all: `maxPages` throttles ONE pass, but the cursor
   * survives across ticks, so a collection kept growing every 15 minutes until
   * archive.org ran out of items. Each title also carries three FTS shadow
   * rows, so the on-disk cost is roughly four rows per title.
   *
   * 0 or unset = unlimited (previous behaviour).
   */
  maxRows?: number;
}

export interface IngestPassResult {
  collection: string;
  pages: number;
  fetched: number;
  inserted: number;
  updated: number;
  cursor: string;
  finished: boolean;
  durationMs: number;
}
