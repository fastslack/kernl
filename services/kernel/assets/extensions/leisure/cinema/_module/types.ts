/**
 * Public types for the cinema module. Mirrors the SQLite schema with
 * arrays/numbers parsed from their JSON-encoded columns.
 */

/**
 * The work an upload was identified as, when it was identified at all.
 *
 * Null for the long tail that never matched — which is not a defect. Prelinger
 * and the educational collections are legitimate cinema that Wikidata does not
 * catalogue as works, so an absent identity means "unknown", never "junk".
 */
export interface CinemaCanonical {
  qid: string;
  label: string;
  year: number;
  director: string;
  country: string;
  imdb_id: string;
  /** External rating on the catalogue's own 0..5 scale. 0 when unrated. */
  ext_rating: number;
  ext_votes: number;
}

/**
 * What the item actually holds, once probed.
 *
 * Null until the probe runs. Absent facts are why the catalogue could not
 * tell a 90-minute feature from a 40-second clip, or a playable item from
 * one whose torrent bundles only metadata.
 */
export interface CinemaMedia {
  /** Real duration in seconds. 0 when the item reported none. */
  duration_sec: number;
  width: number;
  height: number;
  has_video: boolean;
  has_streamable: boolean;
  has_subtitles: boolean;
  best_format: string;
  probed_at: string;
}

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
  /** Canonical identity, when the matcher or a human established one. */
  canonical?: CinemaCanonical | null;
  /**
   * How many uploads of this film the catalogue holds, on a collapsed row.
   * 1 means this is the only copy; absent on uncollapsed queries.
   */
  copies?: number;
  /** File-level facts, once archive.org has been asked what is in the item. */
  media?: CinemaMedia | null;
  /**
   * Curated lists this work belongs to, as CANON_LISTS keys. Empty for
   * everything else, which is most of the catalogue — these lists are small
   * by definition.
   */
  canon?: string[];
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
  /**
   * Films or series. The archive has no such field — a serial lives in the
   * television collections and a feature does not — so this is the collection
   * membership, named the way someone browsing thinks about it.
   */
  kind?: "film" | "series";
  /**
   * Restrict to titles identified as a canonical work.
   *
   * Off by default, deliberately. The unidentified tail contains the
   * industrial and educational cinema the archive is uniquely good at, so
   * hiding it by default would throw away some of the best material in the
   * catalogue to make a quality metric look tidier.
   */
  identifiedOnly?: boolean;
  /**
   * Collapse the many uploads of one film into a single row.
   *
   * Changes what the numbers mean as well as what is shown: a collapsed row
   * carries its work's SUMMED downloads and votes rather than one copy's
   * share of them, which is the whole point — thirty reviews split across six
   * uploads left every one of them looking unmeasured.
   */
  collapse?: boolean;
  /**
   * Minimum real duration, in seconds.
   *
   * The single most effective quality filter available, because it removes
   * things that are not films at all: 40-second clips, test patterns, and
   * audio-only items mis-filed under `mediatype:movies`. Reads the probed
   * duration, not `runtime_sec`, which is 0 across much of the catalogue.
   */
  minDurationSec?: number;
  /** Minimum vertical resolution — drops the unwatchable transfers. */
  minHeight?: number;
  hasSubtitles?: boolean;
  /**
   * Only items with a format the player can actually stream.
   *
   * Not the same as `hasTorrent`, which is what the catalogue used before and
   * is wrong often enough to matter — an item can carry a torrent that
   * bundles nothing but metadata and a thumbnail.
   */
  playableOnly?: boolean;
  /**
   * Restrict to one curated list (see CANON_LISTS), e.g. "nfr".
   *
   * An editorial filter rather than a statistical one: it answers "what did
   * people whose job is film preservation pick", which no ranking over
   * downloads or ratings can express.
   */
  canonList?: string;
  /** Restrict to titles on ANY curated list. */
  canonOnly?: boolean;
  /**
   * `rating` is the raw average and `best` is the weighted one. They are not
   * the same question: raw average puts a single five-star review above a
   * canonical film with three hundred.
   */
  sort?: "downloads" | "year_desc" | "year_asc" | "added_desc" | "rating" | "best";
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
