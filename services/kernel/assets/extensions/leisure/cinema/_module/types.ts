/**
 * Public types for the cinema module. Mirrors the SQLite schema with
 * arrays/numbers parsed from their JSON-encoded columns.
 */

export interface CinemaTitle {
  identifier: string;
  title: string;
  date: string;
  year: number;
  creator: string;
  description: string;
  description_es: string;
  subject: string[];
  collection: string[];
  language: string;
  licenseurl: string;
  runtime_sec: number;
  downloads: number;
  week_downloads: number;
  avg_rating: number;
  num_reviews: number;
  has_torrent: boolean;
  poster_url: string;
  addeddate: string;
  publicdate: string;
  // user-only
  watchlist: boolean;
  watched_at: string | null;
  user_rating: number;
  user_tags: string;
  notes: string;
  hidden: boolean;
  // embedding bookkeeping
  embedded_at: string | null;
  embedded_model: string;
  embedded_dim: number;
  // ingest bookkeeping
  ingested_at: string;
  last_seen_at: string;
}

/** Raw row returned by archive.org's scrape API. Fields are sometimes
 *  arrays (Solr multi-valued) and sometimes scalars. We normalize on
 *  upsert. */
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
  runtime?: string | number;        // upstream gives "HH:MM:SS" or seconds
  downloads?: number;
  week?: number;
  avg_rating?: number;
  num_reviews?: number;
  format?: string | string[];        // we use this to derive has_torrent
  addeddate?: string;
  publicdate?: string;
}

export interface CinemaListFilter {
  query?: string;        // FTS5 + bm25 ranking on title/creator/subject/description
  collection?: string;   // single collection slug
  /** Normalized tag (lowercase). Matches against subject_json elements. */
  tag?: string;
  /** Multiple tags: ALL must match (AND) when match='all', ANY when 'any'. */
  tags?: string[];
  tagsMatch?: "all" | "any";
  /** ISO 2-letter language code, e.g. "en", "es". */
  language?: string;
  yearMin?: number;
  yearMax?: number;
  watchlist?: boolean;
  hidden?: boolean;      // default false (hide hidden)
  hasTorrent?: boolean;  // default true
  sort?: "downloads" | "year_desc" | "year_asc" | "added_desc" | "rating";
  limit?: number;
  offset?: number;
}

export interface CinemaTagRow {
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
  embedded: number;
  status: "running" | "done" | "failed" | "paused";
  error: string;
  started_at: string;
  finished_at: string | null;
}

export interface IngestRunUpdate {
  cursor?: string;
  fetched?: number;          // monotonic add
  upserted?: number;         // monotonic add
  embedded?: number;         // monotonic add
  status?: IngestRun["status"];
  error?: string;
  finished_at?: string | null;
}
