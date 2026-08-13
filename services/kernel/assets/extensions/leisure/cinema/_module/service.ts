/**
 * CinemaService — SQLite-backed CRUD for the local catalog of archive.org
 * titles plus the ingest-run audit trail. Embeddings + Neo4j writes live
 * in a separate Stage-2 module (cinema/embeddings.ts) so this layer stays
 * pure data.
 *
 * Conventions:
 *   - JSON columns (subject, collection) are stored as text and parsed on
 *     read. Empty arrays serialize as "[]".
 *   - Booleans are 0/1 INTEGER NOT NULL.
 *   - Soft delete via deleted_at; every read filters by `deleted_at IS NULL`.
 *   - upsertTitle is called by the ingester per scrape page; it preserves
 *     the user-only columns (watchlist, watched_at, user_rating, …) when
 *     re-ingesting an existing identifier.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { rebuildWorks, type RebuildWorksResult } from "./works.js";
import type {
  ArchiveScrapeRow,
  CinemaCanonical,
  CinemaMedia,
  CinemaListFilter,
  CinemaTagRow,
  CinemaTitle,
  IngestRun,
  IngestRunUpdate,
} from "./types.js";

/**
 * archive.org collection slugs that exist as both a *collection* AND an
 * *item* (the collection landing-page item with the same identifier). When
 * scraped under `mediatype:movies AND collection:X`, these self-referential
 * items slip through — they have a torrent attached (it bundles every item
 * in the collection) and a 6-digit download count from years of browsing
 * traffic, so they sort to the top of the catalog and look like wildly
 * popular movies. They aren't: runtime_sec=0, year=0, no playable file.
 *
 * Kept as a fixed allow/deny list rather than detected heuristically
 * because runtime_sec=0 + year=0 also hits a long tail of legitimate
 * fan-made shorts and modern uploads.
 */
const COLLECTION_ITEM_BLOCKLIST = new Set<string>([
  // Curated archive.org megacollections we scrape against.
  "feature_films",
  "silent_films",
  "classic_cartoons",
  "classic_tv",
  "SciFi_Horror",
  "prelinger",
  "moviesandfilms",
  "culturalandacademicfilms",
  "artsandmusicvideos",
  "animationandcartoons",
  "short_films",
  "vintage_cartoons",
  "educationalfilms",
  "opensource_movies",
  // Legacy slugs that ingested but were never in CINEMA_COLLECTIONS.
  "horror",
  "sci-fi_horror",
  "film_noir",
]);

/** True when the upstream row IS one of archive.org's collection landing
 *  pages, not an actual film. The check is identifier-exact. */
export function isCollectionLandingItem(identifier: string): boolean {
  return COLLECTION_ITEM_BLOCKLIST.has(identifier);
}

/**
 * archive.org collections that publish under `mediatype:movies` but whose
 * contents are NOT movies/series/documentaries — they're sub-second to
 * sub-minute generative-art clips, screensaver loops, test patterns, etc.
 * Rows whose `collection` list intersects this set get refused at ingest
 * and hidden from the live catalog. Add new entries as the long tail
 * surfaces noise.
 *
 * Match is exact against each value inside the row's `collection` JSON
 * array — archive.org's slugs are case-sensitive (`ElectricSheep`, not
 * `electricsheep`).
 */
const NOISE_COLLECTION_BLOCKLIST = new Set<string>([
  // Generative fractal screensaver clips from the Electric Sheep
  // distributed-rendering project. Useful as art, but not as cinema.
  "ElectricSheep",
]);

/** True when ANY of the row's collections is on the noise list. Empty
 *  collection list returns false (we don't have a reason to block). */
export function isNoiseCollection(collections: string[]): boolean {
  for (const c of collections) {
    if (NOISE_COLLECTION_BLOCKLIST.has(c)) return true;
  }
  return false;
}

/** Public access for SQL builders that need the same list. */
export const NOISE_COLLECTION_SLUGS = Array.from(NOISE_COLLECTION_BLOCKLIST);

interface TitleRow {
  identifier: string;
  title: string;
  date: string;
  year: number;
  creator: string;
  description: string;
  description_es: string;
  subject_json: string;
  collection_json: string;
  language: string;
  licenseurl: string;
  runtime_sec: number;
  downloads: number;
  week_downloads: number;
  avg_rating: number;
  num_reviews: number;
  has_torrent: number;
  poster_url: string;
  addeddate: string;
  publicdate: string;
  watchlist: number;
  watched_at: string | null;
  user_rating: number;
  user_tags: string;
  notes: string;
  hidden: number;
  embedded_at: string | null;
  embedded_model: string;
  embedded_dim: number;
  ingested_at: string;
  last_seen_at: string;
  deleted_at: string | null;
  // Canonical identity, present only on queries that join it in. Absent (not
  // null) on the plain `SELECT *` paths, which is why every read of these is
  // optional-chained rather than null-checked.
  canon_state?: string | null;
  canon_qid?: string | null;
  canon_label?: string | null;
  canon_year?: number | null;
  canon_director?: string | null;
  canon_country?: string | null;
  canon_imdb_id?: string | null;
  canon_ext_rating?: number | null;
  canon_ext_votes?: number | null;
  // Work aggregates, present only on collapsed queries.
  work_copies?: number | null;
  work_downloads?: number | null;
  work_week_downloads?: number | null;
  work_num_reviews?: number | null;
  work_avg_rating?: number | null;
  // File-level facts, present on any query that joins cinema_title_media.
  // All null when the title has not been probed yet.
  media_duration_sec?: number | null;
  media_width?: number | null;
  media_height?: number | null;
  media_has_video?: number | null;
  media_has_streamable?: number | null;
  media_has_subtitles?: number | null;
  media_best_format?: string | null;
  media_probed_at?: string | null;
  /** Comma-separated CANON_LISTS keys, from the group_concat subquery. */
  canon_lists?: string | null;
}

/**
 * The canonical layer, attached to a title row.
 *
 * A LEFT JOIN in both directions: a title may have no match row at all, and a
 * match row may be a `review`/`none` verdict carrying no work. The
 * `mt.qid <> ''` guard on the second join keeps those from joining to a
 * phantom work.
 */
const CANONICAL_JOIN = `
  LEFT JOIN cinema_title_matches mt ON mt.identifier = t.identifier
  LEFT JOIN cinema_canonical_works w ON w.qid = mt.qid AND mt.qid <> ''
`;

const CANONICAL_COLUMNS = `
  mt.state AS canon_state, mt.qid AS canon_qid,
  w.label AS canon_label, w.year AS canon_year,
  w.director AS canon_director, w.country AS canon_country,
  w.imdb_id AS canon_imdb_id,
  w.ext_rating AS canon_ext_rating, w.ext_votes AS canon_ext_votes
`;

/** What "identified" means, as SQL. Machine-accepted or human-confirmed. */
const IDENTIFIED_SQL = `mt.state IN ('auto','confirmed')`;

/**
 * Curated-list membership, as a scalar subquery.
 *
 * A subquery rather than a join because a work can sit on several rails at
 * once, and joining would multiply the row. `group_concat` collapses them
 * into one comma-separated cell, which the shaper splits back out. The
 * (qid, list_key) primary key makes each lookup an index seek.
 *
 * Keyed off the MATCH's qid, so an upload inherits the rails of the work it
 * was identified as — the Library of Congress selected a film, not somebody's
 * transfer of it.
 */
/*
 * Gated on the match STATE, not merely on a non-empty qid. A row a human
 * rejected keeps the candidate qid — the rejection is recorded as the state,
 * not by clearing the field — so without this a title someone explicitly said
 * is NOT Citizen Kane would still inherit Citizen Kane's rails. Same rule
 * `shapeCanonical` applies to the identity itself.
 */
const CANON_COLUMN = `
  (SELECT group_concat(cn.list_key)
     FROM cinema_canon cn
    WHERE cn.qid = mt.qid AND mt.qid <> ''
      AND ${IDENTIFIED_SQL}) AS canon_lists
`;

/**
 * Restrict to a rail. Requires CANONICAL_JOIN to be in scope.
 *
 * `EXISTS` rather than a join, for the same reason: membership on two rails
 * must not duplicate the row.
 */
function canonExistsSql(list?: string): string {
  const listClause = list ? ` AND cn.list_key = ?` : "";
  return `EXISTS (
    SELECT 1 FROM cinema_canon cn
     WHERE cn.qid = mt.qid AND mt.qid <> ''
       AND ${IDENTIFIED_SQL}${listClause}
  )`;
}

/**
 * Append whatever media conditions the filter asks for, and say whether the
 * media table needs joining at all.
 *
 * Shared rather than repeated because `list`, `countAll` and `filterByIds`
 * each build their own WHERE, and a listing whose conditions drifted from its
 * count would report a total that does not match what it shows.
 *
 * Every condition is written so an UNPROBED title fails it. That is the
 * honest reading: asking for "at least 60 minutes" cannot be answered for an
 * item nobody has looked inside, and quietly including it would defeat the
 * filter during the hours the probe is still walking.
 */
function pushCanonClauses(
  filter: CinemaListFilter,
  where: string[],
  params: unknown[],
): boolean {
  if (!filter.canonList && !filter.canonOnly) return false;
  where.push(canonExistsSql(filter.canonList));
  if (filter.canonList) params.push(filter.canonList);
  return true;
}

function pushMediaClauses(
  filter: CinemaListFilter,
  where: string[],
  params: unknown[],
): boolean {
  let needed = false;
  if (filter.minDurationSec && filter.minDurationSec > 0) {
    where.push("md.duration_sec >= ?");
    params.push(filter.minDurationSec);
    needed = true;
  }
  if (filter.minHeight && filter.minHeight > 0) {
    where.push("md.height >= ?");
    params.push(filter.minHeight);
    needed = true;
  }
  if (filter.hasSubtitles) {
    where.push("md.has_subtitles = 1");
    needed = true;
  }
  if (filter.playableOnly) {
    where.push("md.has_streamable = 1");
    needed = true;
  }
  return needed;
}

/**
 * Collapse to one row per film.
 *
 * An INNER join on `primary_identifier` is the whole mechanism: every title
 * belongs to exactly one work and every work names exactly one copy, so
 * joining on that column keeps the chosen copy and drops the rest. No GROUP
 * BY, no window function, and the row that survives is still a full
 * `cinema_titles` row that every downstream consumer already understands.
 */
const WORKS_JOIN = `JOIN cinema_works cw ON cw.primary_identifier = t.identifier`;

/**
 * File-level facts. LEFT, because an unprobed title must not vanish from the
 * catalogue — the probe walks 74k items over hours and the grid has to keep
 * working throughout.
 */
const MEDIA_JOIN = `LEFT JOIN cinema_title_media md ON md.identifier = t.identifier`;

const MEDIA_COLUMNS = `
  md.duration_sec AS media_duration_sec,
  md.width AS media_width, md.height AS media_height,
  md.has_video AS media_has_video, md.has_streamable AS media_has_streamable,
  md.has_subtitles AS media_has_subtitles,
  md.best_format AS media_best_format, md.probed_at AS media_probed_at
`;

/**
 * The aggregates a collapsed row reports.
 *
 * Selected as well as ordered by, because the two must agree: ranking a row
 * on its work's 51,000 summed downloads while the card shows the chosen
 * copy's own 200 would be its own kind of lie.
 */
const WORKS_COLUMNS = `
  cw.copies AS work_copies,
  cw.downloads AS work_downloads,
  cw.week_downloads AS work_week_downloads,
  cw.num_reviews AS work_num_reviews,
  cw.avg_rating AS work_avg_rating
`;

/**
 * How much an unidentified title is discounted in the "best" order.
 *
 * A discount rather than a filter: the user asked for good material to rise,
 * not for the rest to disappear. At 0.85 an unidentified title sits below an
 * identified one of equal measured quality but still above a badly-reviewed
 * identified one, which is the right relationship — being catalogued is
 * evidence, not a verdict.
 */
const UNIDENTIFIED_FACTOR = 0.85;

/**
 * Collections where being unidentified says nothing, so the discount is not
 * applied.
 *
 * Measured against the live catalogue rather than assumed. Identification
 * rates by collection:
 *
 *   silent_films          61%
 *   SciFi_Horror          48%
 *   feature_films         44%
 *   classic_cartoons       0%   (81 of 81 unidentified)
 *   animationandcartoons   0%
 *
 * Zero is not a quality signal, it is an absence: Wikidata catalogues
 * features and does not catalogue theatrical animated shorts, so every
 * Popeye and Betty Boop entry fails identification no matter how good it is.
 * Discounting them would demote the most-downloaded material in the
 * catalogue — the top item is a Popeye short with over a million downloads —
 * on the strength of a fact about Wikidata's coverage rather than about the
 * film.
 *
 * A static list rather than a computed rate, matching how this module already
 * handles COLLECTION_ITEM_BLOCKLIST and NOISE_COLLECTION_BLOCKLIST: the
 * behaviour stays predictable, and the reasoning is recorded where the next
 * person will look for it.
 */
const DISCOUNT_EXEMPT_COLLECTIONS = [
  "classic_cartoons",
  "animationandcartoons",
  "vintage_cartoons",
  "educationalfilms",
  "culturalandacademicfilms",
  "prelinger",
  "short_films",
];

/** True when the row belongs to a collection the discount does not apply to. */
const DISCOUNT_EXEMPT_SQL = `(${
  DISCOUNT_EXEMPT_COLLECTIONS
    .map((c) => `t.collection_json LIKE '%"${c}"%'`)
    .join(" OR ")
})`;

/**
 * TMDb rates 0..10 and archive.org rates 0..5. Everything downstream — the
 * global mean, the weighted score, the UI — speaks the 0..5 scale, so the
 * external number is halved at the point it enters rather than in six places
 * afterwards.
 */
const EXT_RATING_TO_LOCAL_SCALE = 2.0;

interface RunRow {
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

const PARSE_JSON_ARRAY = (raw: string): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/** Coerce a Solr/scrape multi-valued field that may arrive as `T | T[] | undefined`. */
function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** First non-empty string from a possibly-array field. */
function asString(v: string | string[] | undefined | null): string {
  if (!v) return "";
  if (Array.isArray(v)) return v.find((x) => typeof x === "string" && x.length > 0) ?? "";
  return String(v);
}

/** Extract YYYY from upstream `date` (which is sometimes "1955-12-25",
 *  sometimes "1955", sometimes "circa 1955" — give up gracefully).
 *  Falls back to scanning the title (archive.org users often embed the
 *  year there: "A GENTLEMAN OF NERVE (1914)"). */
function parseYear(date: string, title: string = ""): number {
  const re = /\b(1[0-9]{3}|20[0-2][0-9])\b/;
  const fromDate = re.exec(date);
  if (fromDate) return parseInt(fromDate[1], 10);
  const fromTitle = re.exec(title);
  return fromTitle ? parseInt(fromTitle[1], 10) : 0;
}

/** Runtime can be "HH:MM:SS", "MM:SS", or seconds. Upstream is messy. */
function parseRuntimeSec(raw: string | number | undefined): number {
  if (raw == null) return 0;
  if (typeof raw === "number") return Math.max(0, Math.floor(raw));
  const trimmed = String(raw).trim();
  if (!trimmed) return 0;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const parts = trimmed.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

/** archive.org marks items with a seedable .torrent via this format flag. */
function detectHasTorrent(format: string | string[] | undefined): boolean {
  const formats = asArray(format).map(String);
  return formats.some((f) => /Archive\s*BitTorrent/i.test(f));
}

/**
 * archive.org's `collection` field includes per-user favorites prefixed
 * with `fav-` whenever someone favorites the item. They aren't real
 * collections — they're noise that pollutes browsing/filtering and (more
 * importantly for us) the embedding text profile.
 */
function cleanCollections(raw: string | string[] | undefined): string[] {
  return asArray(raw)
    .map(String)
    .filter((c) => c && !c.startsWith("fav-") && !c.startsWith("fav_"));
}

/**
 * Turn user-typed keyword text into a safe FTS5 MATCH expression.
 *
 * FTS5 has its own mini-language with operators (`AND`, `OR`, `NOT`,
 * `NEAR`, `*`, `^`, `:`, `"`, `()`) that crash the parser when the
 * user types a stray punctuation. We don't want to expose that grammar
 * — strip every special char, then quote each remaining token so it's
 * treated literally. Multi-token input becomes an implicit AND.
 *
 * Examples:
 *   "ALF la serie"        →  "alf" "la" "serie"
 *   'matrix"; drop tbl'   →  "matrix" "drop" "tbl"
 *   "  -  "               →  ""   (caller falls back to no-query path)
 */
export function sanitizeFtsQuery(raw: string): string {
  // Replace anything that isn't a unicode letter / digit / dash / apostrophe
  // with a space. The unicode61 tokenizer handles diacritics on its own.
  const cleaned = raw
    .replace(/[^\p{L}\p{N}\-' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  // Quote each token so the user's "*" or "AND" never becomes an FTS5
  // operator. Skip lone hyphens and short noise tokens.
  const tokens = cleaned
    .split(" ")
    .map((t) => t.replace(/^['-]+|['-]+$/g, ""))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/** Canonical poster URL — every archive.org item has one even if blank. */
function posterUrlFor(identifier: string): string {
  return `https://archive.org/services/img/${encodeURIComponent(identifier)}`;
}

export class CinemaService {
  constructor(private db: SqliteDb) {}

  // ── Titles: read ──────────────────────────────────────────────

  getByIdentifier(identifier: string): CinemaTitle | null {
    const row = this.db
      .prepare(`
        SELECT t.*, ${CANONICAL_COLUMNS}, ${CANON_COLUMN}, ${MEDIA_COLUMNS}
        FROM cinema_titles t
        ${CANONICAL_JOIN}
        ${MEDIA_JOIN}
        WHERE t.identifier = ? AND t.deleted_at IS NULL
      `)
      .get(identifier) as TitleRow | undefined;
    return row ? this.shape(row) : null;
  }

  /**
   * Take a list of identifiers (typically the candidate set from a
   * hybrid search) and return the matching rows that ALSO pass the
   * remaining filter criteria (tags, year, language, watchlist, etc.).
   * Preserves the input order — caller's ranking wins over BD sort.
   */
  filterByIds(ids: string[], filter: CinemaListFilter = {}): CinemaTitle[] {
    if (ids.length === 0) return [];
    const where: string[] = ["t.deleted_at IS NULL", `t.identifier IN (${ids.map(() => "?").join(",")})`];
    const params: unknown[] = [...ids];

    if (filter.hidden !== true) where.push("t.hidden = 0");
    if (filter.hasTorrent !== false) where.push("t.has_torrent = 1");
    if (filter.watchlist === true) where.push("t.watchlist = 1");
    if (filter.collection) {
      where.push("t.collection_json LIKE ?");
      params.push(`%"${filter.collection}"%`);
    }
    // Films vs series. The archive files serials under the television
    // collections, so membership is the only thing that distinguishes them.
    if (filter.kind === "series") {
      where.push("(t.collection_json LIKE '%\"classic_tv\"%' OR t.collection_json LIKE '%\"television\"%')");
    } else if (filter.kind === "film") {
      where.push("t.collection_json NOT LIKE '%\"classic_tv\"%' AND t.collection_json NOT LIKE '%\"television\"%'");
    }
    if (filter.yearMin) {
      where.push("t.year >= ?");
      params.push(filter.yearMin);
    }
    if (filter.yearMax) {
      where.push("t.year <= ?");
      params.push(filter.yearMax);
    }
    if (filter.language) {
      where.push("LOWER(t.language) LIKE ?");
      params.push(`${filter.language.toLowerCase()}%`);
    }
    const tagList: string[] = [];
    if (filter.tag) tagList.push(filter.tag);
    if (filter.tags && filter.tags.length > 0) tagList.push(...filter.tags);
    if (tagList.length > 0) {
      const matchAll = (filter.tagsMatch ?? "all") === "all";
      const clauses = tagList.map(() => "t.subject_json LIKE ?");
      where.push(`(${clauses.join(matchAll ? " AND " : " OR ")})`);
      for (const tag of tagList) params.push(`%"${tag}"%`);
    }

    if (filter.identifiedOnly) where.push(IDENTIFIED_SQL);
    pushCanonClauses(filter, where, params);
    pushMediaClauses(filter, where, params);

    // Collapsing a search result keeps only the copy that represents each
    // work. The search ranked every copy independently, so without this a
    // query for "metropolis" returns the same film six times.
    const collapse = filter.collapse === true;

    const rows = this.db
      .prepare(`
        SELECT t.*, ${CANONICAL_COLUMNS}, ${CANON_COLUMN}, ${MEDIA_COLUMNS}${collapse ? `, ${WORKS_COLUMNS}` : ""}
        FROM cinema_titles t
        ${collapse ? WORKS_JOIN : ""}
        ${CANONICAL_JOIN}
        ${MEDIA_JOIN}
        WHERE ${where.join(" AND ")}
      `)
      .all(...params) as TitleRow[];
    // Reorder by the input id sequence so the caller's ranking wins.
    const byId = new Map(rows.map((r) => [r.identifier, r]));
    const out: CinemaTitle[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (r) out.push(this.shape(r));
    }

    // …unless the caller asked for quality explicitly.
    //
    // Search order is text relevance, which answers "does this match the
    // words". "The best sci-fi series" asks something else, and the two have
    // to compose: the query decides WHICH titles, the sort decides in what
    // order. Sci-fi series are only findable by text — they live in the
    // television collections with no sci-fi collection of their own — so
    // without this, that question had no way to be asked at all.
    if (filter.sort === "best") {
      const C = this.meanRating();
      const m = 5;
      // Mirrors qualityScore() in SQL — same votes-from-wherever-they-exist
      // rule, same discount for an unidentified title. The two must agree, or
      // "best" would mean one thing when browsing and another when searching.
      const score = (t: CinemaTitle) => {
        const canon = t.canonical;
        const base = canon && canon.ext_votes > 0
          ? ((canon.ext_votes * canon.ext_rating) + (m * C)) / (canon.ext_votes + m)
          : ((t.num_reviews * t.avg_rating) + (m * C)) / (t.num_reviews + m);
        const exempt = t.collection.some((c) => DISCOUNT_EXEMPT_COLLECTIONS.includes(c));
        return base * (canon || exempt ? 1 : UNIDENTIFIED_FACTOR);
      };
      out.sort((a, b) => score(b) - score(a) || b.num_reviews - a.num_reviews);
    }
    return out;
  }

  /**
   * Bare FTS5 ranked search. Returns just identifiers in bm25 order so
   * the hybrid-search fusion can compute ranks without paying the cost
   * of hydrating full rows. Caller hydrates whatever it ends up keeping.
   */
  fullTextSearch(query: string, limit: number): string[] {
    if (!query.trim()) return [];
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare(`
        SELECT t.identifier
        FROM cinema_titles_fts f
        JOIN cinema_titles t ON t.rowid = f.rowid
        WHERE t.deleted_at IS NULL
          AND t.has_torrent = 1
          AND t.hidden = 0
          AND cinema_titles_fts MATCH ?
        ORDER BY bm25(cinema_titles_fts, 5.0, 2.0, 3.0, 1.0)
        LIMIT ?
      `)
      .all(ftsQuery, Math.max(1, limit)) as Array<{ identifier: string }>;
    return rows.map((r) => r.identifier);
  }

  list(filter: CinemaListFilter = {}): CinemaTitle[] {
    const where: string[] = ["t.deleted_at IS NULL"];
    const params: unknown[] = [];

    if (filter.hidden !== true) where.push("t.hidden = 0");
    if (filter.hasTorrent !== false) where.push("t.has_torrent = 1");
    if (filter.watchlist === true) where.push("t.watchlist = 1");

    if (filter.collection) {
      // collection_json is a JSON array string; LIKE is good enough until FTS.
      where.push("t.collection_json LIKE ?");
      params.push(`%"${filter.collection}"%`);
    }
    // Films vs series. The archive files serials under the television
    // collections, so membership is the only thing that distinguishes them.
    if (filter.kind === "series") {
      where.push("(t.collection_json LIKE '%\"classic_tv\"%' OR t.collection_json LIKE '%\"television\"%')");
    } else if (filter.kind === "film") {
      where.push("t.collection_json NOT LIKE '%\"classic_tv\"%' AND t.collection_json NOT LIKE '%\"television\"%'");
    }
    if (filter.yearMin) {
      where.push("t.year >= ?");
      params.push(filter.yearMin);
    }
    if (filter.yearMax) {
      where.push("t.year <= ?");
      params.push(filter.yearMax);
    }
    if (filter.language) {
      // upstream language is sometimes a 2-letter code, sometimes "English",
      // sometimes empty. case-insensitive prefix match catches both.
      where.push("LOWER(t.language) LIKE ?");
      params.push(`${filter.language.toLowerCase()}%`);
    }
    // Tag filtering uses LIKE over the JSON array. Cheaper than json_each
    // for single-tag lookups and avoids the JOIN overhead. Multi-tag with
    // match='all' AND-chains; match='any' OR-chains.
    const tagList: string[] = [];
    if (filter.tag) tagList.push(filter.tag);
    if (filter.tags && filter.tags.length > 0) tagList.push(...filter.tags);
    if (tagList.length > 0) {
      const matchAll = (filter.tagsMatch ?? "all") === "all";
      const clauses = tagList.map(() => "t.subject_json LIKE ?");
      where.push(`(${clauses.join(matchAll ? " AND " : " OR ")})`);
      for (const tag of tagList) params.push(`%"${tag}"%`);
    }

    if (filter.identifiedOnly) where.push(IDENTIFIED_SQL);
    pushCanonClauses(filter, where, params);
    pushMediaClauses(filter, where, params);

    // Collapsed queries read their numbers off the work rather than off the
    // one copy that represents it.
    const collapse = filter.collapse === true;
    const worksJoin = collapse ? WORKS_JOIN : "";
    const worksCols = collapse ? `, ${WORKS_COLUMNS}` : "";
    const local = collapse ? "cw" : "t";

    const limit = Math.max(1, Math.min(filter.limit ?? 60, 500));
    const offset = Math.max(0, filter.offset ?? 0);

    // ── Query branch ────────────────────────────────────────────
    // With `filter.query`: use FTS5 + bm25 ranking. Tokens come from
    // title/creator/subject/description. Title weighted 5x, subject 3x,
    // creator 2x, description 1x — so a sitcom-name match in title
    // outranks an accidental mention in some other film's description.
    //
    // Without `filter.query`: classic listing ordered by `sort`.
    if (filter.query && filter.query.trim()) {
      const ftsQuery = sanitizeFtsQuery(filter.query);
      if (!ftsQuery) {
        // After stripping FTS5 special chars we have nothing to search;
        // return an empty result rather than fall through to a global list.
        return [];
      }
      const rows = this.db
        .prepare(`
          SELECT t.*, ${CANONICAL_COLUMNS}, ${CANON_COLUMN}, ${MEDIA_COLUMNS}${worksCols}
          FROM cinema_titles_fts f
          JOIN cinema_titles t ON t.rowid = f.rowid
          ${worksJoin}
          ${CANONICAL_JOIN}
          ${MEDIA_JOIN}
          WHERE ${where.join(" AND ")}
            AND cinema_titles_fts MATCH ?
          ORDER BY bm25(cinema_titles_fts, 5.0, 2.0, 3.0, 1.0)
          LIMIT ? OFFSET ?
        `)
        .all(...params, ftsQuery, limit, offset) as TitleRow[];
      return rows.map((r) => this.shape(r));
    }

    const order = (() => {
      switch (filter.sort) {
        case "year_desc": return "t.year DESC, t.downloads DESC";
        case "year_asc":  return "t.year ASC, t.downloads DESC";
        case "added_desc": return "t.addeddate DESC";
        case "rating":    return "t.avg_rating DESC, t.num_reviews DESC";
        // "Best", which is not the same as "highest average".
        //
        // A raw average ranks a 5.0 from three reviewers above a 4.6 from
        // thirty — on the sci-fi shelf that put VIOLENCE JACK ALL OVAs and War
        // Of The Monsters ahead of Das Kabinett des Doktor Caligari. The
        // weighted form pulls a title toward the global mean in proportion to
        // how little is known about it, so confidence has to be earned by
        // votes. Same shape IMDb uses for its Top 250.
        case "best":      return `${this.qualityScore(local)} DESC, ${local}.num_reviews DESC`;
        case "downloads":
        default:          return `${local}.downloads DESC`;
      }
    })();

    const rows = this.db
      .prepare(`
        SELECT t.*, ${CANONICAL_COLUMNS}, ${CANON_COLUMN}, ${MEDIA_COLUMNS}${worksCols}
        FROM cinema_titles t
        ${worksJoin}
        ${CANONICAL_JOIN}
        ${MEDIA_JOIN}
        WHERE ${where.join(" AND ")}
        ORDER BY ${order}
        LIMIT ? OFFSET ?
      `)
      .all(...params, limit, offset) as TitleRow[];

    return rows.map((r) => this.shape(r));
  }

  countAll(filter: CinemaListFilter = {}): number {
    const where: string[] = ["t.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (filter.hidden !== true) where.push("t.hidden = 0");
    if (filter.hasTorrent !== false) where.push("t.has_torrent = 1");
    if (filter.watchlist === true) where.push("t.watchlist = 1");
    if (filter.collection) {
      where.push("t.collection_json LIKE ?");
      params.push(`%"${filter.collection}"%`);
    }
    // Films vs series. The archive files serials under the television
    // collections, so membership is the only thing that distinguishes them.
    if (filter.kind === "series") {
      where.push("(t.collection_json LIKE '%\"classic_tv\"%' OR t.collection_json LIKE '%\"television\"%')");
    } else if (filter.kind === "film") {
      where.push("t.collection_json NOT LIKE '%\"classic_tv\"%' AND t.collection_json NOT LIKE '%\"television\"%'");
    }
    if (filter.yearMin) {
      where.push("t.year >= ?");
      params.push(filter.yearMin);
    }
    if (filter.yearMax) {
      where.push("t.year <= ?");
      params.push(filter.yearMax);
    }
    if (filter.language) {
      where.push("LOWER(t.language) LIKE ?");
      params.push(`${filter.language.toLowerCase()}%`);
    }
    const tagList: string[] = [];
    if (filter.tag) tagList.push(filter.tag);
    if (filter.tags && filter.tags.length > 0) tagList.push(...filter.tags);
    if (tagList.length > 0) {
      const matchAll = (filter.tagsMatch ?? "all") === "all";
      const clauses = tagList.map(() => "t.subject_json LIKE ?");
      where.push(`(${clauses.join(matchAll ? " AND " : " OR ")})`);
      for (const tag of tagList) params.push(`%"${tag}"%`);
    }
    // The canonical join is only paid for when the filter actually asks about
    // identity — a count is otherwise a pure scan over cinema_titles and there
    // is no reason to make it join two more tables.
    // The canon clauses reference `mt`, so asking about a rail is another
    // reason the canonical join has to be present.
    const needsCanon = pushCanonClauses(filter, where, params);
    const needsCanonical = filter.identifiedOnly === true || needsCanon;
    if (filter.identifiedOnly) where.push(IDENTIFIED_SQL);
    const needsMedia = pushMediaClauses(filter, where, params);
    // Collapsed, the count is of FILMS rather than uploads — the same join
    // that drops duplicate rows from the listing drops them from the total,
    // so the two never disagree about how many results there are.
    const join = [
      filter.collapse === true ? WORKS_JOIN : "",
      needsCanonical ? CANONICAL_JOIN : "",
      needsMedia ? MEDIA_JOIN : "",
    ].filter(Boolean).join("\n");

    if (filter.query && filter.query.trim()) {
      const ftsQuery = sanitizeFtsQuery(filter.query);
      if (!ftsQuery) return 0;
      const row = this.db
        .prepare(`
          SELECT COUNT(*) AS n
          FROM cinema_titles_fts f
          JOIN cinema_titles t ON t.rowid = f.rowid
          ${join}
          WHERE ${where.join(" AND ")} AND cinema_titles_fts MATCH ?
        `)
        .get(...params, ftsQuery) as { n: number };
      return row.n;
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM cinema_titles t ${join} WHERE ${where.join(" AND ")}`)
      .get(...params) as { n: number };
    return row.n;
  }

  /** IDs that haven't been embedded with the current model — for the
   *  embeddings worker. Pass current model+dim; mismatches re-embed. */
  pendingEmbeddingIds(currentModel: string, currentDim: number, limit: number): string[] {
    const rows = this.db
      .prepare(`
        SELECT identifier FROM cinema_titles
        WHERE deleted_at IS NULL AND has_torrent = 1
          AND (embedded_at IS NULL OR embedded_model <> ? OR embedded_dim <> ?)
        ORDER BY downloads DESC
        LIMIT ?
      `)
      .all(currentModel, currentDim, Math.max(1, limit)) as Array<{ identifier: string }>;
    return rows.map((r) => r.identifier);
  }

  // ── Titles: write ─────────────────────────────────────────────

  /**
   * Insert or update a title. Preserves user-only columns on update so
   * re-ingesting an identifier never clobbers your watchlist/notes/rating.
   * Marks `embedded_at = NULL` whenever the description text changes so
   * the embedder will re-process.
   */
  upsertFromScrape(row: ArchiveScrapeRow): { inserted: boolean; updated: boolean } {
    const identifier = row.identifier?.trim();
    if (!identifier) return { inserted: false, updated: false };
    // Drop archive.org collection-landing items at the ingest gate — they
    // have a torrent + huge download count but are not actual movies.
    if (isCollectionLandingItem(identifier)) {
      return { inserted: false, updated: false };
    }
    // Drop rows that belong to a noise collection (ElectricSheep, …).
    // We check the raw collection list before normalisation because the
    // blocklist matches archive.org's exact slug casing.
    const rawCollections = asArray(row.collection).map(String);
    if (isNoiseCollection(rawCollections)) {
      return { inserted: false, updated: false };
    }

    const now = isoNow();
    const title = asString(row.title) || identifier;
    const date = asString(row.date);
    const year = parseYear(date, title);
    const description = asString(row.description);
    const subject = JSON.stringify(asArray(row.subject).map(String));
    const collection = JSON.stringify(cleanCollections(row.collection));

    const existing = this.db
      .prepare("SELECT description, description_es FROM cinema_titles WHERE identifier = ?")
      .get(identifier) as { description: string; description_es: string } | undefined;

    if (existing) {
      // Update path — preserve user columns. Reset embedded_at if the
      // description we'd embed actually changed.
      const descChanged = existing.description !== description;
      this.db
        .prepare(`
          UPDATE cinema_titles SET
            title = ?,
            date = ?,
            year = ?,
            creator = ?,
            description = ?,
            subject_json = ?,
            collection_json = ?,
            language = ?,
            licenseurl = ?,
            runtime_sec = ?,
            downloads = ?,
            week_downloads = ?,
            avg_rating = ?,
            num_reviews = ?,
            has_torrent = ?,
            poster_url = ?,
            addeddate = ?,
            publicdate = ?,
            embedded_at = CASE WHEN ? THEN NULL ELSE embedded_at END,
            last_seen_at = ?,
            deleted_at = NULL
          WHERE identifier = ?
        `)
        .run(
          title,
          date,
          year,
          asString(row.creator),
          description,
          subject,
          collection,
          asString(row.language),
          asString(row.licenseurl),
          parseRuntimeSec(row.runtime),
          row.downloads ?? 0,
          row.week ?? 0,
          row.avg_rating ?? 0,
          row.num_reviews ?? 0,
          detectHasTorrent(row.format) ? 1 : 0,
          posterUrlFor(identifier),
          row.addeddate ?? "",
          row.publicdate ?? "",
          descChanged ? 1 : 0,
          now,
          identifier,
        );
      return { inserted: false, updated: true };
    }

    this.db
      .prepare(`
        INSERT INTO cinema_titles (
          identifier, title, date, year, creator, description, description_es,
          subject_json, collection_json, language, licenseurl, runtime_sec,
          downloads, week_downloads, avg_rating, num_reviews, has_torrent,
          poster_url, addeddate, publicdate,
          watchlist, watched_at, user_rating, user_tags, notes, hidden,
          embedded_at, embedded_model, embedded_dim,
          ingested_at, last_seen_at, deleted_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, '',
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          0, NULL, 0, '', '', 0,
          NULL, '', 0,
          ?, ?, NULL
        )
      `)
      .run(
        identifier,
        title,
        date,
        year,
        asString(row.creator),
        description,
        subject,
        collection,
        asString(row.language),
        asString(row.licenseurl),
        parseRuntimeSec(row.runtime),
        row.downloads ?? 0,
        row.week ?? 0,
        row.avg_rating ?? 0,
        row.num_reviews ?? 0,
        detectHasTorrent(row.format) ? 1 : 0,
        posterUrlFor(identifier),
        row.addeddate ?? "",
        row.publicdate ?? "",
        now,
        now,
      );
    return { inserted: true, updated: false };
  }

  /** Mark a title as watchlisted (or remove). User-driven endpoint, not
   *  the ingester. */
  setWatchlist(identifier: string, watchlist: boolean): void {
    this.db
      .prepare("UPDATE cinema_titles SET watchlist = ? WHERE identifier = ? AND deleted_at IS NULL")
      .run(watchlist ? 1 : 0, identifier);
  }

  setWatched(identifier: string, watched: boolean): void {
    this.db
      .prepare("UPDATE cinema_titles SET watched_at = ? WHERE identifier = ? AND deleted_at IS NULL")
      .run(watched ? isoNow() : null, identifier);
  }

  /** Stage 2 helper — record that a title was embedded with a given model/dim. */
  markEmbedded(identifier: string, model: string, dim: number): void {
    this.db
      .prepare(`
        UPDATE cinema_titles
        SET embedded_at = ?, embedded_model = ?, embedded_dim = ?
        WHERE identifier = ?
      `)
      .run(isoNow(), model, dim, identifier);
  }

  /** IDs that still need a Spanish translation. Returns the most-downloaded
   *  pending rows first so the popular titles get translated before the
   *  long tail. */
  pendingTranslationIds(limit: number): string[] {
    const rows = this.db
      .prepare(`
        SELECT identifier FROM cinema_titles
        WHERE deleted_at IS NULL AND has_torrent = 1 AND hidden = 0
          AND description <> '' AND (description_es IS NULL OR description_es = '')
        ORDER BY downloads DESC
        LIMIT ?
      `)
      .all(Math.max(1, limit)) as Array<{ identifier: string }>;
    return rows.map((r) => r.identifier);
  }

  /** Count rows that still need Spanish translation. */
  pendingTranslationCount(): number {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS n FROM cinema_titles
        WHERE deleted_at IS NULL AND has_torrent = 1 AND hidden = 0
          AND description <> '' AND (description_es IS NULL OR description_es = '')
      `)
      .get() as { n: number };
    return row.n;
  }

  /** Count rows that already have a Spanish translation. */
  translatedCount(): number {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS n FROM cinema_titles
        WHERE deleted_at IS NULL AND has_torrent = 1 AND hidden = 0
          AND description_es IS NOT NULL AND description_es <> ''
      `)
      .get() as { n: number };
    return row.n;
  }

  /** Store the Spanish translation and force a re-embed. `embedded_at` is
   *  NULL-able so we use that as the primary "needs re-embed" signal — the
   *  pendingEmbeddingIds() query's OR-chain picks it up immediately. We
   *  also reset model/dim to their defaults ('', 0) — they're NOT NULL —
   *  so the existing OR-mismatch path also triggers as a safety net. */
  setDescriptionEs(identifier: string, text: string): void {
    this.db
      .prepare(`
        UPDATE cinema_titles
        SET description_es = ?,
            embedded_at = NULL,
            embedded_model = '',
            embedded_dim = 0
        WHERE identifier = ?
      `)
      .run(text, identifier);
  }

  // ── Ingest runs ───────────────────────────────────────────────

  startRun(collection: string, cursor: string = ""): IngestRun {
    const id = newId();
    const now = isoNow();
    this.db
      .prepare(`
        INSERT INTO cinema_ingest_runs
          (id, collection, cursor, fetched, upserted, embedded, status, error, started_at, finished_at)
        VALUES (?, ?, ?, 0, 0, 0, 'running', '', ?, NULL)
      `)
      .run(id, collection, cursor, now);
    return {
      id,
      collection,
      cursor,
      fetched: 0,
      upserted: 0,
      embedded: 0,
      status: "running",
      error: "",
      started_at: now,
      finished_at: null,
    };
  }

  updateRun(id: string, patch: IngestRunUpdate): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.cursor !== undefined) { sets.push("cursor = ?"); params.push(patch.cursor); }
    if (patch.fetched !== undefined) { sets.push("fetched = fetched + ?"); params.push(patch.fetched); }
    if (patch.upserted !== undefined) { sets.push("upserted = upserted + ?"); params.push(patch.upserted); }
    if (patch.embedded !== undefined) { sets.push("embedded = embedded + ?"); params.push(patch.embedded); }
    if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
    if (patch.error !== undefined) { sets.push("error = ?"); params.push(patch.error); }
    if (patch.finished_at !== undefined) { sets.push("finished_at = ?"); params.push(patch.finished_at); }
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE cinema_ingest_runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  /**
   * Returns the most recent run for a collection. Used by the agent to
   * decide whether to resume (status='paused' or 'running' with cursor)
   * or open a new pass (status='done' and we want to refresh).
   */
  latestRun(collection: string): IngestRun | null {
    const row = this.db
      .prepare(`
        SELECT * FROM cinema_ingest_runs
        WHERE collection = ?
        ORDER BY started_at DESC
        LIMIT 1
      `)
      .get(collection) as RunRow | undefined;
    return row ? { ...row } : null;
  }

  recentRuns(limit = 20): IngestRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM cinema_ingest_runs ORDER BY started_at DESC LIMIT ?`)
      .all(Math.max(1, limit)) as RunRow[];
    return rows.map((r) => ({ ...r }));
  }

  // ── Tags ──────────────────────────────────────────────────────

  /** Top N tags by count, optionally filtered by name prefix for autocomplete. */
  /**
   * Tags worth putting on a chip.
   *
   * The raw ranking is by frequency, and the most frequent subjects on
   * archive.org are not genres — they are what the uploader typed into the
   * form. On this catalogue the top of the list reads Movie (14,265), trailer
   * (11,596), video, Youtube, IGN, Entertainment: true of almost everything,
   * useful for finding nothing. Filtering them out is what turns the row from
   * a frequency histogram into a way to browse.
   *
   * Only the browse row filters. An explicit `search` still matches anything,
   * because someone typing "trailer" means it.
   */
  private static readonly META_TAGS = new Set<string>([
    "movie", "movies", "film", "films", "video", "videos", "trailer",
    "trailers", "movie trailer", "movie trailers", "feature film",
    "full movie", "clip", "clips", "youtube", "archive", "internet archive",
    "entertainment", "ign", "media", "upload", "uploads", "public domain",
    "television", "tv", "tv show", "tv series", "series", "episode",
    "episodes", "hd", "1080p", "720p", "dvd", "vhs", "color", "b&w",
    "black and white", "english", "spanish", "subtitles", "audio",
  ]);

  topTags(limit: number, search?: string): CinemaTagRow[] {
    const params: unknown[] = [];
    let sql = `SELECT tag_norm, tag_display, count, rank FROM cinema_tags`;
    if (search && search.trim()) {
      sql += ` WHERE tag_norm LIKE ?`;
      params.push(`${search.trim().toLowerCase()}%`);
      sql += ` ORDER BY rank LIMIT ?`;
      params.push(Math.max(1, Math.min(limit, 500)));
      return this.db.prepare(sql).all(...params) as CinemaTagRow[];
    }

    // Over-fetch, then drop the metadata ones, so a filtered row still fills.
    sql += ` ORDER BY rank LIMIT ?`;
    const want = Math.max(1, Math.min(limit, 500));
    params.push(Math.min(want * 4 + 40, 2000));
    const rows = this.db.prepare(sql).all(...params) as CinemaTagRow[];
    return rows
      .filter((r) => !CinemaService.META_TAGS.has(r.tag_norm))
      .slice(0, want);
  }

  /**
   * Rebuild the cinema_tags table from cinema_titles.subject_json.
   *
   * Normalization:
   *   - lowercase + trim
   *   - strip diacritics  (uses SQLite's lower() which handles ASCII;
   *     for accented strings we don't bother — the FTS5 tokenizer also
   *     strips diacritics, and tag display still shows the pretty form)
   *   - drop tags shorter than 2 chars or pure numeric/punct ("1", ".")
   *   - drop the same noise prefixes we strip from collections (fav-)
   *
   * Display picks the most common original casing per normalized form.
   * Returns the count written.
   */
  rebuildTags(): { tags: number; titlesScanned: number } {
    const start = Date.now();
    interface Bucket { count: number; displays: Map<string, number>; }
    const buckets = new Map<string, Bucket>();
    let titlesScanned = 0;

    const rows = this.db
      .prepare(`SELECT subject_json FROM cinema_titles WHERE deleted_at IS NULL AND subject_json <> '[]'`)
      .all() as Array<{ subject_json: string }>;

    for (const r of rows) {
      titlesScanned++;
      let parsed: unknown;
      try { parsed = JSON.parse(r.subject_json); } catch { continue; }
      if (!Array.isArray(parsed)) continue;
      for (const raw of parsed) {
        if (typeof raw !== "string") continue;
        const trimmed = raw.trim();
        if (trimmed.length < 2) continue;
        // skip pure-digit / pure-punct noise
        if (/^[\d\s.\-_]+$/.test(trimmed)) continue;
        if (trimmed.toLowerCase().startsWith("fav-")) continue;
        const norm = trimmed.toLowerCase();
        let b = buckets.get(norm);
        if (!b) {
          b = { count: 0, displays: new Map() };
          buckets.set(norm, b);
        }
        b.count++;
        b.displays.set(trimmed, (b.displays.get(trimmed) ?? 0) + 1);
      }
    }

    const items = [...buckets.entries()].map(([norm, b]) => {
      // pick most common original casing
      let best = norm; let bestN = -1;
      for (const [d, n] of b.displays) {
        if (n > bestN) { best = d; bestN = n; }
      }
      return { norm, display: best, count: b.count };
    });
    items.sort((a, b) => b.count - a.count);

    const now = isoNow();
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM cinema_tags").run();
      const stmt = this.db.prepare(`
        INSERT INTO cinema_tags (tag_norm, tag_display, count, rank, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      items.forEach((it, i) => {
        stmt.run(it.norm, it.display, it.count, i + 1, now);
      });
    });
    tx();

    void start; // silence unused; keeping the timer here documents intent
    return { tags: items.length, titlesScanned };
  }

  /**
   * Rebuild the derived work tables.
   *
   * Delegates to works.ts, which owns the grouping rules; this exists so
   * callers (the API route, the ingest hook) have one door and do not each
   * import the rebuild directly.
   */
  rebuildWorks(): RebuildWorksResult {
    return rebuildWorks(this.db);
  }

  /**
   * The other uploads of the same film.
   *
   * Ordered the way the primary copy was chosen, so the list reads as
   * "the best copy first" rather than in whatever order SQLite returns.
   */
  siblingCopies(identifier: string): CinemaTitle[] {
    const rows = this.db.prepare(`
      SELECT t.*, ${CANONICAL_COLUMNS}
      FROM cinema_work_members me
      JOIN cinema_work_members sib ON sib.work_key = me.work_key
      JOIN cinema_titles t ON t.identifier = sib.identifier
      ${CANONICAL_JOIN}
      WHERE me.identifier = ?
        AND sib.identifier <> ?
        AND t.deleted_at IS NULL
      ORDER BY t.has_torrent DESC,
               CASE WHEN t.runtime_sec > 0 THEN 0 ELSE 1 END,
               t.runtime_sec DESC,
               t.downloads DESC,
               t.identifier
    `).all(identifier, identifier) as TitleRow[];
    return rows.map((r) => this.shape(r));
  }

  /** Snapshot of how much duplication the catalogue actually carries. */
  worksStats(): { works: number; titles: number; collapsed: number; duplicates: number } {
    const one = (sql: string): number =>
      ((this.db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);
    const works = one(`SELECT COUNT(*) AS n FROM cinema_works`);
    const titles = one(`SELECT COUNT(*) AS n FROM cinema_work_members`);
    return {
      works,
      titles,
      collapsed: one(`SELECT COUNT(*) AS n FROM cinema_works WHERE copies > 1`),
      duplicates: Math.max(0, titles - works),
    };
  }

  // ── internal ──────────────────────────────────────────────────

  /**
   * Weighted rating, as a SQL expression.
   *
   * `(v/(v+m)) * R + (m/(v+m)) * C` — a title with few votes sits near the
   * global mean C and climbs only as votes accumulate. C is read once per
   * process: it moves with the catalogue, not with the query, and recomputing
   * it per request would cost a full scan for a number that barely changes.
   */
  private globalMean: number | null = null;
  /** The catalogue's mean rating — the value both ranking paths pull toward. */
  private meanRating(): number {
    if (this.globalMean === null) {
      const row = this.db
        .prepare("SELECT AVG(avg_rating) AS m FROM cinema_titles WHERE num_reviews > 0")
        .get() as { m: number | null } | undefined;
      this.globalMean = row?.m ?? 3.5;
    }
    return this.globalMean;
  }
  private bayesianScore(minVotes = 5): string {
    if (this.globalMean === null) {
      const row = this.db
        .prepare("SELECT AVG(avg_rating) AS m FROM cinema_titles WHERE num_reviews > 0")
        .get() as { m: number | null } | undefined;
      this.globalMean = row?.m ?? 3.5;
    }
    const C = this.globalMean;
    return `(((t.num_reviews * t.avg_rating) + (${minVotes} * ${C})) / (t.num_reviews + ${minVotes}))`;
  }

  /**
   * "Best", once the catalogue has a canonical identity to lean on.
   *
   * The weighted rating alone could not answer this question. Almost every
   * row carries zero reviews, so with v=0 the score collapses to the global
   * mean for the entire catalogue and the sort silently degenerates into
   * "whatever happened to get commented on" — the tiebreak, not the score,
   * was doing all the work.
   *
   * Two changes fix that:
   *
   *   1. Votes now come from wherever they exist. A film TMDb has scored with
   *      four thousand votes is measured; the same film with no archive.org
   *      reviews was previously indistinguishable from an unwatched upload.
   *   2. Being identified at all is itself evidence. A work catalogued in
   *      Wikidata was released, credited, and written about; an uploader's
   *      home movie was not. That is the single strongest signal available
   *      here, and it is available for every row rather than the ~1% that
   *      carry reviews.
   *
   * Requires CANONICAL_JOIN to be in scope.
   *
   * `local` selects where the archive.org-side votes come from. Collapsed
   * queries pass `cw`, so the score sees the work's summed votes rather than
   * one copy's share of them — which is the third way this catalogue's
   * ratings were being under-counted, alongside missing reviews and missing
   * identity.
   */
  private qualityScore(local: "t" | "cw" = "t", minVotes = 5): string {
    const C = this.meanRating();
    return `
      (CASE
         WHEN w.ext_votes > 0 THEN
           ((w.ext_votes * (w.ext_rating / ${EXT_RATING_TO_LOCAL_SCALE})) + (${minVotes} * ${C}))
           / (w.ext_votes + ${minVotes})
         ELSE
           ((${local}.num_reviews * ${local}.avg_rating) + (${minVotes} * ${C}))
           / (${local}.num_reviews + ${minVotes})
       END)
      * (CASE
           WHEN ${IDENTIFIED_SQL} THEN 1.0
           -- Unidentified, but in a collection Wikidata does not catalogue.
           -- Nothing was learned, so nothing is charged.
           WHEN ${DISCOUNT_EXEMPT_SQL} THEN 1.0
           ELSE ${UNIDENTIFIED_FACTOR}
         END)
    `;
  }

  private shape(row: TitleRow): CinemaTitle {
    return {
      identifier: row.identifier,
      title: row.title,
      date: row.date,
      year: row.year,
      creator: row.creator,
      description: row.description,
      description_es: row.description_es,
      subject: PARSE_JSON_ARRAY(row.subject_json),
      collection: PARSE_JSON_ARRAY(row.collection_json),
      language: row.language,
      licenseurl: row.licenseurl,
      runtime_sec: row.runtime_sec,
      downloads: row.downloads,
      week_downloads: row.week_downloads,
      avg_rating: row.avg_rating,
      num_reviews: row.num_reviews,
      has_torrent: row.has_torrent === 1,
      poster_url: row.poster_url,
      addeddate: row.addeddate,
      publicdate: row.publicdate,
      watchlist: row.watchlist === 1,
      watched_at: row.watched_at,
      user_rating: row.user_rating,
      user_tags: row.user_tags,
      notes: row.notes,
      hidden: row.hidden === 1,
      embedded_at: row.embedded_at,
      embedded_model: row.embedded_model,
      embedded_dim: row.embedded_dim,
      ingested_at: row.ingested_at,
      last_seen_at: row.last_seen_at,
      canonical: shapeCanonical(row),
      media: shapeMedia(row),
      canon: row.canon_lists ? row.canon_lists.split(",").filter(Boolean) : [],
      ...shapeWork(row),
    };
  }
}

/**
 * The file-level facts for a row, or null.
 *
 * Null means "nobody has looked inside this item yet", which is different
 * from "this item is empty" — the latter is a probed row with `has_video`
 * false, and the UI needs to tell those apart rather than showing a warning
 * on every unprobed title.
 */
function shapeMedia(row: TitleRow): CinemaMedia | null {
  if (!row.media_probed_at) return null;
  return {
    duration_sec: row.media_duration_sec ?? 0,
    width: row.media_width ?? 0,
    height: row.media_height ?? 0,
    has_video: row.media_has_video === 1,
    has_streamable: row.media_has_streamable === 1,
    has_subtitles: row.media_has_subtitles === 1,
    best_format: row.media_best_format ?? "",
    probed_at: row.media_probed_at,
  };
}

/**
 * The work-level view of a collapsed row.
 *
 * Overrides the copy's own downloads and votes with the work's totals — the
 * numbers that were always true and were only ever split because the archive
 * holds one film as six items. Returns nothing at all on an uncollapsed
 * query, so those rows keep reporting exactly what they did before.
 */
function shapeWork(row: TitleRow): Partial<CinemaTitle> {
  if (row.work_copies == null) return {};
  return {
    copies: row.work_copies,
    downloads: row.work_downloads ?? 0,
    week_downloads: row.work_week_downloads ?? 0,
    num_reviews: row.work_num_reviews ?? 0,
    avg_rating: row.work_avg_rating ?? 0,
  };
}

/**
 * The canonical block for a row, or null.
 *
 * Null covers three different situations that all mean the same thing to a
 * caller: the query did not join the canonical tables, the title was never
 * matched, or it was matched to a verdict that carries no work (`review`,
 * `none`, `rejected`). Only an accepted identity produces a block.
 *
 * The external rating is halved here, once, so everything downstream reads a
 * 0..5 number like the rest of the catalogue.
 */
function shapeCanonical(row: TitleRow): CinemaCanonical | null {
  const state = row.canon_state;
  if (state !== "auto" && state !== "confirmed") return null;
  if (!row.canon_qid) return null;
  return {
    qid: row.canon_qid,
    label: row.canon_label ?? "",
    year: row.canon_year ?? 0,
    director: row.canon_director ?? "",
    country: row.canon_country ?? "",
    imdb_id: row.canon_imdb_id ?? "",
    ext_rating: (row.canon_ext_rating ?? 0) / EXT_RATING_TO_LOCAL_SCALE,
    ext_votes: row.canon_ext_votes ?? 0,
  };
}
