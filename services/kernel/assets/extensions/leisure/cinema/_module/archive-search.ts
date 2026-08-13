/**
 * Search archive.org itself, without indexing anything first.
 *
 * The local catalogue is a slice: whatever the ingester has walked so far.
 * Searching it can only ever find what was already pulled in, and the semantic
 * mode on top of it needs an embedding per row — 74,773 local inferences before
 * the first query. Neither is a precondition for finding a film.
 *
 * archive.org runs a Solr index over every item it holds and answers queries
 * for free over HTTP. `advancedsearch.php` is that endpoint. No key, no
 * ingest, no embeddings, and the corpus is the whole archive rather than the
 * part we happen to have mirrored.
 *
 * The module already spoke to this endpoint from the torrent importer, pinned
 * to `format:"Archive BitTorrent"` — this is the same conversation without
 * that filter, shaped into the row the catalogue UI already renders.
 */

import type { CinemaTitle } from "./types.js";
import { CINEMA_COLLECTIONS } from "./ingester.js";

/** The same curated shelves the local catalogue is ingested from. */
const CURATED_COLLECTIONS = CINEMA_COLLECTIONS;

const ENDPOINT = "https://archive.org/advancedsearch.php";
const TIMEOUT_MS = 20_000;

export interface RemoteSearchQuery {
  q: string;
  rows?: number;
  page?: number;
  /** Restrict to a year range, as the catalogue's own filters do. */
  yearFrom?: number;
  yearTo?: number;
  language?: string;
  /** Search all of archive.org instead of the curated film collections. */
  everywhere?: boolean;
  /** Omitted → Solr relevance, which is what a search box should rank by. */
  sort?: "relevance" | "downloads" | "newest";
}

/** Solr reserved characters. A stray `:` or `[` turns a title into a 400. */
function escapeSolr(term: string): string {
  return term.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, "\\$1");
}

/**
 * Words that carry no signal in an OR query.
 *
 * The loose leg is a disjunction, so every term widens the result set. "silent
 * films with vampires" including `with` matches essentially every item in the
 * archive that has the word anywhere, drowning the three terms that meant
 * something. Short words are already dropped by length; these are the ones
 * long enough to survive that and still say nothing.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "there", "their",
  "about", "into", "over", "under", "between", "film", "films", "movie",
  "movies", "video", "videos", "full", "part",
  "los", "las", "una", "unos", "unas", "del", "con", "por", "para", "sobre",
  "que", "como", "pelicula", "peliculas", "video", "completa",
]);

/**
 * Build the query.
 *
 * The user's words go in as a quoted phrase OR loose terms, so "silent films
 * with vampires" matches items that only carry some of those words — the
 * behaviour anyone expects from a search box. Everything else is a filter.
 */
function buildQuery(q: RemoteSearchQuery): string {
  const parts: string[] = ["mediatype:(movies)"];

  // Curated collections, by default.
  //
  // This is the single biggest lever on result quality, measured against the
  // live index: unrestricted, "dracula" returns 2,961 items topped by
  // PSICOMAGIA and FEMINISMO vs FEMINISMO POLITICO-MEDIATICO, because the
  // archive is mostly amateur uploads and its relevance score cannot tell them
  // apart. Restricted to the same collections the local catalogue is built
  // from, it returns 165 — all of them Dracula films. Same for "vampires":
  // 1,309 of noise becomes 107 with Les Vampires (1915) near the top.
  if (!q.everywhere) parts.push(`collection:(${CURATED_COLLECTIONS.join(" OR ")})`);

  const text = q.q.trim();
  if (text) {
    const words = text
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
      .map((w) => escapeSolr(w));

    // Fielded, and ANDed within the field.
    //
    // An unfielded term searches a catch-all that ranks by nothing useful —
    // that is where the junk came from. And `title:(silent vampires)` ORs
    // inside the field, so it matches everything with "vampires"; the AND is
    // what makes a multi-word query mean what it says.
    if (words.length) {
      const conj = words.join(" AND ");
      parts.push(`(title:(${conj}) OR subject:(${conj}))`);
    } else {
      const escaped = escapeSolr(text);
      parts.push(`(title:("${escaped}") OR subject:("${escaped}"))`);
    }
  }

  if (q.yearFrom || q.yearTo) {
    const from = q.yearFrom ?? 1800;
    const to = q.yearTo ?? new Date().getFullYear();
    parts.push(`year:[${from} TO ${to}]`);
  }
  if (q.language?.trim()) parts.push(`language:(${escapeSolr(q.language.trim())})`);

  return parts.join(" AND ");
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(String).join(", ");
  return v == null ? "" : String(v);
}
function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v) return [v];
  return [];
}
function num(v: unknown): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A Solr doc as the catalogue's row type.
 *
 * Fields the local table has and the index does not — runtime, ratings,
 * translated description — come back empty rather than invented. `_remote`
 * marks the row as not-yet-in-the-catalogue so the UI can offer to add it
 * instead of pretending it is already local.
 */
function toTitle(doc: Record<string, unknown>): CinemaTitle & { _remote: true } {
  const identifier = str(doc.identifier);
  const date = str(doc.date ?? doc.publicdate);
  return {
    identifier,
    title: str(doc.title) || identifier,
    date,
    year: num(doc.year) || (date ? num(date.slice(0, 4)) : 0),
    creator: str(doc.creator),
    description: str(doc.description),
    description_es: "",
    subject: list(doc.subject),
    collection: list(doc.collection),
    language: str(doc.language),
    licenseurl: str(doc.licenseurl),
    runtime_sec: 0,
    downloads: num(doc.downloads),
    week_downloads: num(doc.week),
    avg_rating: num(doc.avg_rating),
    num_reviews: num(doc.num_reviews),
    has_torrent: false,
    poster_url: identifier ? `https://archive.org/services/img/${encodeURIComponent(identifier)}` : "",
    addeddate: str(doc.addeddate),
    publicdate: str(doc.publicdate),
    watchlist: false,
    _remote: true,
  } as CinemaTitle & { _remote: true };
}

export interface RemoteSearchResult {
  items: Array<CinemaTitle & { _remote: true }>;
  /** What archive.org reports, which is usually far more than one page. */
  total: number;
}

export async function searchArchive(q: RemoteSearchQuery): Promise<RemoteSearchResult> {
  const rows = Math.min(Math.max(q.rows ?? 24, 1), 100);
  const page = Math.max(q.page ?? 1, 1);

  const params = new URLSearchParams();
  params.set("q", buildQuery(q));
  for (const f of [
    "identifier", "title", "date", "year", "creator", "description",
    "subject", "collection", "language", "licenseurl", "downloads",
    "week", "avg_rating", "num_reviews", "addeddate", "publicdate",
  ]) {
    params.append("fl[]", f);
  }
  // No sort — Solr then orders by its own relevance score.
  //
  // Forcing `downloads desc` throws that score away and ranks by popularity
  // across everything that matched any term, which for "silent films with
  // vampires" put About Bananas and Baldur's Gate 2 on top and buried Les
  // Vampires (1915). Popularity is available as an explicit choice; it is the
  // wrong default for a search box.
  if (q.sort === "downloads") params.append("sort[]", "downloads desc");
  else if (q.sort === "newest") params.append("sort[]", "date desc");
  params.set("output", "json");
  params.set("rows", String(rows));
  params.set("page", String(page));

  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    headers: { "user-agent": "Kernl/cinema-search" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`archive.org search returned ${res.status}`);

  const body = (await res.json()) as {
    response?: { numFound?: number; docs?: Array<Record<string, unknown>> };
  };
  const docs = body.response?.docs ?? [];
  return {
    items: docs.map(toTitle).filter((t) => t.identifier),
    total: num(body.response?.numFound),
  };
}
