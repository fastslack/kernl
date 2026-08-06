/**
 * Pull the film corpus out of Wikidata into a local table.
 *
 * Why local rather than querying live per title: the matcher is the part of
 * this feature most likely to be wrong on the first attempt, and improving it
 * means re-running it over 74k rows. Against a remote endpoint that is 74k
 * network round-trips per iteration and a good way to get rate-limited off
 * Wikimedia's infrastructure. Against a local table it is a few seconds, so
 * the matcher can be tuned as many times as it takes.
 *
 * Why sliced by year: a single unbounded "all films" query times out — WDQS
 * enforces a 60s server-side limit and the film set is ~250k works with
 * multilingual labels attached. One year is a few thousand works, which
 * answers comfortably. Slices are tracked individually in
 * `cinema_canonical_sync`, so a failed year is retried on the next pass
 * without redoing the ones that succeeded.
 *
 * Licensing: Wikidata is CC0. That is the reason this is the backbone rather
 * than IMDb's dumps, which carry a non-commercial restriction that a bundled,
 * distributable extension cannot honour.
 */

import { log } from "../../../../../../src/core/logger.js";
import type { SqliteDb } from "../../../../../../src/core/db/sqlite.js";
import { normalizeTitle } from "../title-norm.js";
import { MAX_YEAR_DELTA } from "./matcher.js";

const ENDPOINT = "https://query.wikidata.org/sparql";

/**
 * Wikimedia's user-agent policy requires a descriptive agent with a contact
 * route; anonymous scripted traffic gets blocked. This identifies the tool
 * and the project rather than impersonating a browser.
 */
const USER_AGENT = "Kernl-cinema/1.0 (https://github.com/kernl; canonical-corpus-sync)";

/** WDQS caps queries at 60s. Give the transport a little more than that. */
const REQUEST_TIMEOUT_MS = 75_000;

/** Be a good citizen between slices — this is free infrastructure. */
const SLICE_DELAY_MS = 1_500;

/**
 * How many times a slice is retried before it is written off.
 *
 * Three separate passes failing is no longer bad luck: WDQS answers some year
 * queries with a non-JSON error page consistently. Retrying such a slice
 * forever keeps the corpus phase from ever finishing, and matching sits
 * behind it.
 */
const MAX_SLICE_ATTEMPTS = 3;

/**
 * The languages aliases are pulled in.
 *
 * Not "all languages": Wikidata carries labels in 300+, most of which are
 * transliterations no archive.org uploader would ever type, and pulling them
 * multiplies the corpus size for no matching power. This list is the
 * languages the catalogue's own `language` column actually contains, plus the
 * ones the European silent era was produced in — which is the collection this
 * feature exists to rescue.
 */
const ALIAS_LANGS = [
  "en", "es", "fr", "de", "it", "pt", "ru", "ja",
  "sv", "da", "no", "nl", "pl", "cs", "hu", "fi",
];

/** The first year with films worth cataloguing. */
export const FIRST_FILM_YEAR = 1888;

export interface WorkRow {
  qid: string;
  label: string;
  year: number;
  imdb_id: string;
  director: string;
  country: string;
  genres: string[];
  duration_min: number;
}

export interface AliasRow {
  qid: string;
  alias_raw: string;
  lang: string;
}

export interface SliceResult {
  slice: string;
  works: number;
  aliases: number;
  durationMs: number;
}

/** Every year of cinema, oldest first. The upper bound on what could be pulled. */
export function allSlices(currentYear: number): string[] {
  const out: string[] = [];
  for (let y = FIRST_FILM_YEAR; y <= currentYear; y++) out.push(String(y));
  return out;
}

/**
 * The slices worth pulling: the years the catalogue actually holds titles in,
 * widened by the matcher's year tolerance.
 *
 * Pulling all of cinema is the wrong shape of work. A catalogue covering
 * eighty years does not need the other fifty, and the years it skips are
 * often the expensive ones — a single modern year answers with several
 * thousand works while a 1920s year answers with a few hundred. The widening
 * is not optional: the fuzzy path compares against every work within
 * MAX_YEAR_DELTA of the upload's year, so a corpus pulled without that margin
 * would be missing exactly the rows that path goes looking for.
 *
 * Degrades to `allSlices` as the catalogue grows to cover everything, so this
 * is a saving now rather than a ceiling later.
 */
export function relevantSlices(db: SqliteDb, currentYear: number): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT year FROM cinema_titles
    WHERE deleted_at IS NULL AND hidden = 0 AND year > 0
  `).all() as Array<{ year: number }>;

  const wanted = new Set<number>();
  for (const { year } of rows) {
    for (let y = year - MAX_YEAR_DELTA; y <= year + MAX_YEAR_DELTA; y++) {
      if (y >= FIRST_FILM_YEAR && y <= currentYear) wanted.add(y);
    }
  }
  return [...wanted].sort((a, b) => a - b).map(String);
}

interface SparqlBinding {
  [key: string]: { value: string; type: string } | undefined;
}

async function sparql(query: string): Promise<SparqlBinding[]> {
  const params = new URLSearchParams({ query, format: "json" });
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    headers: { "user-agent": USER_AGENT, accept: "application/sparql-results+json" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`wikidata ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
  }
  // Read as text first. WDQS answers overload and throttling with an HTML
  // error page under a 200, so `res.ok` is not enough and `res.json()` throws
  // a bare "Failed to parse JSON" that says nothing about what happened.
  const body = await res.text();
  try {
    const json = JSON.parse(body) as { results?: { bindings?: SparqlBinding[] } };
    return json.results?.bindings ?? [];
  } catch {
    throw new Error(
      `wikidata returned non-JSON (${body.length} bytes): ${body.slice(0, 160).replace(/\s+/g, " ")}`,
    );
  }
}

/** `http://www.wikidata.org/entity/Q151895` → `Q151895`. */
function qidOf(uri: string): string {
  const i = uri.lastIndexOf("/");
  return i >= 0 ? uri.slice(i + 1) : uri;
}

/**
 * Facts for one year.
 *
 * `wdt:P31/wdt:P279* wd:Q11424` would also catch documentaries and animated
 * films filed under subclasses, but the transitive closure is what makes this
 * query time out. The explicit union of the handful of types that matter is
 * both faster and more predictable about what ends up in the corpus.
 */
function factsQuery(year: number): string {
  return `
    SELECT DISTINCT ?work ?workLabel ?imdb ?directorLabel ?countryLabel ?genreLabel ?duration WHERE {
      VALUES ?type { wd:Q11424 wd:Q93204 wd:Q202866 wd:Q24869 wd:Q506240 wd:Q226730 }
      ?work wdt:P31 ?type ;
            wdt:P577 ?date .
      FILTER(YEAR(?date) = ${year})
      OPTIONAL { ?work wdt:P345  ?imdb }
      OPTIONAL { ?work wdt:P57   ?director }
      OPTIONAL { ?work wdt:P495  ?country }
      OPTIONAL { ?work wdt:P136  ?genre }
      OPTIONAL { ?work wdt:P2047 ?duration }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
  `;
}

/** Every title the year's works are known by, across ALIAS_LANGS. */
function aliasQuery(year: number): string {
  const langs = ALIAS_LANGS.map((l) => `"${l}"`).join(", ");
  return `
    SELECT DISTINCT ?work ?label WHERE {
      VALUES ?type { wd:Q11424 wd:Q93204 wd:Q202866 wd:Q24869 wd:Q506240 wd:Q226730 }
      ?work wdt:P31 ?type ;
            wdt:P577 ?date .
      FILTER(YEAR(?date) = ${year})
      { ?work rdfs:label ?label } UNION { ?work skos:altLabel ?label }
      FILTER(LANG(?label) IN (${langs}))
    }
  `;
}

/**
 * Fold the fact bindings into one row per work.
 *
 * SPARQL returns the cartesian product of the OPTIONAL clauses, so a film
 * with two directors and three genres arrives as six rows. Director and
 * country keep the first value seen (a film has one primary of each often
 * enough that picking one is honest); genres accumulate into a set.
 */
function foldFacts(bindings: SparqlBinding[], year: number): WorkRow[] {
  const byQid = new Map<string, WorkRow & { genreSet: Set<string> }>();
  for (const b of bindings) {
    const uri = b.work?.value;
    if (!uri) continue;
    const qid = qidOf(uri);
    let row = byQid.get(qid);
    if (!row) {
      row = {
        qid,
        label: b.workLabel?.value ?? "",
        year,
        imdb_id: b.imdb?.value ?? "",
        director: b.directorLabel?.value ?? "",
        country: b.countryLabel?.value ?? "",
        genres: [],
        duration_min: Math.round(Number(b.duration?.value ?? 0)) || 0,
        genreSet: new Set<string>(),
      };
      byQid.set(qid, row);
    }
    if (!row.imdb_id && b.imdb?.value) row.imdb_id = b.imdb.value;
    if (!row.director && b.directorLabel?.value) row.director = b.directorLabel.value;
    if (!row.country && b.countryLabel?.value) row.country = b.countryLabel.value;
    const g = b.genreLabel?.value;
    if (g) row.genreSet.add(g);
  }
  return [...byQid.values()].map(({ genreSet, ...r }) => ({ ...r, genres: [...genreSet] }));
}

/**
 * A Wikidata label that is really a placeholder.
 *
 * When an entity has no label in the requested language the label service
 * returns the bare QID. Storing that as an alias would let any upload titled
 * "Q151895" match, and more importantly it pollutes the corpus with rows that
 * carry no title at all.
 */
function isPlaceholderLabel(label: string): boolean {
  return /^Q\d+$/.test(label);
}

/** Fetch one year's works and aliases. Network only — no writes. */
export async function fetchSlice(year: number): Promise<{ works: WorkRow[]; aliases: AliasRow[] }> {
  const facts = await fetchWithRetry(() => sparql(factsQuery(year)), `facts ${year}`);
  const works = foldFacts(facts, year).filter((w) => w.label && !isPlaceholderLabel(w.label));

  const known = new Set(works.map((w) => w.qid));
  const aliasBindings = await fetchWithRetry(() => sparql(aliasQuery(year)), `aliases ${year}`);
  const aliases: AliasRow[] = [];
  for (const b of aliasBindings) {
    const uri = b.work?.value;
    const label = b.label?.value;
    if (!uri || !label || isPlaceholderLabel(label)) continue;
    const qid = qidOf(uri);
    // The alias query and the facts query are separate round-trips against a
    // live dataset; an alias whose work did not come back in the facts pass
    // has nothing to attach to and would violate the foreign relationship.
    if (!known.has(qid)) continue;
    aliases.push({ qid, alias_raw: label, lang: (b.label as { "xml:lang"?: string })?.["xml:lang"] ?? "" });
  }
  return { works, aliases };
}

/**
 * One retry on failure.
 *
 * WDQS returns a 500 with a timeout body under load often enough that a
 * single immediate failure says nothing about whether the query is sound.
 * Beyond one retry the slice is left failed for the next pass to pick up —
 * that is what the sync table is for.
 */
async function fetchWithRetry<T>(fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`cinema canonical: ${what} failed, retrying once — ${msg}`);
    await new Promise((r) => setTimeout(r, 5_000));
    return await fn();
  }
}

/** Persist one slice's rows. Upserts, so re-running a slice is safe. */
export function persistSlice(
  db: SqliteDb,
  works: WorkRow[],
  aliases: AliasRow[],
): { works: number; aliases: number } {
  const now = new Date().toISOString();

  const upsertWork = db.prepare(`
    INSERT INTO cinema_canonical_works
      (qid, label, label_norm, year, imdb_id, director, country, genre_json,
       duration_min, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(qid) DO UPDATE SET
      label        = excluded.label,
      label_norm   = excluded.label_norm,
      year         = excluded.year,
      imdb_id      = excluded.imdb_id,
      director     = excluded.director,
      country      = excluded.country,
      genre_json   = excluded.genre_json,
      duration_min = excluded.duration_min,
      fetched_at   = excluded.fetched_at
  `);

  // Aliases are INSERT OR IGNORE rather than upsert: the PK is
  // (qid, alias_norm), and two raw spellings that normalize to the same key
  // are the same alias for matching purposes. First spelling wins.
  const insertAlias = db.prepare(`
    INSERT OR IGNORE INTO cinema_canonical_aliases (qid, alias_norm, alias_raw, lang)
    VALUES (?, ?, ?, ?)
  `);

  let aliasCount = 0;
  const tx = db.transaction(() => {
    for (const w of works) {
      upsertWork.run(
        w.qid, w.label, normalizeTitle(w.label), w.year, w.imdb_id,
        w.director, w.country, JSON.stringify(w.genres), w.duration_min, now,
      );
      // The display label is itself an alias — otherwise a work whose only
      // title is its English label would be unmatchable.
      const labelNorm = normalizeTitle(w.label);
      if (labelNorm) {
        insertAlias.run(w.qid, labelNorm, w.label, "en");
        aliasCount++;
      }
    }
    for (const a of aliases) {
      const norm = normalizeTitle(a.alias_raw);
      if (!norm) continue;
      insertAlias.run(a.qid, norm, a.alias_raw, a.lang);
      aliasCount++;
    }
  });
  tx();

  return { works: works.length, aliases: aliasCount };
}

/**
 * Slices still owed — never-attempted ones first, previously-failed ones last.
 *
 * The order is the point. Sorted purely by year, a slice that fails every time
 * sits at the head of the queue forever and every pass spends itself on it:
 * year 2017 answered with a non-JSON error page and, being lower than the ten
 * years behind it, blocked all of them until the runner gave up. Demoting
 * known-bad slices means a poison year costs its own retry and nothing else.
 */
export function pendingSlices(db: SqliteDb, currentYear: number): string[] {
  const rows = db.prepare(
    `SELECT slice, status, attempts FROM cinema_canonical_sync`,
  ).all() as Array<{ slice: string; status: string; attempts: number }>;

  const done = new Set(rows.filter((r) => r.status === "done").map((r) => r.slice));
  // Given up on. Still failing after this many tries is a property of the
  // slice, not of the moment, and continuing to owe it keeps the corpus phase
  // open forever — which blocks matching, the part that matters.
  const exhausted = new Set(
    rows.filter((r) => r.status === "failed" && r.attempts >= MAX_SLICE_ATTEMPTS)
      .map((r) => r.slice),
  );
  const failed = new Set(rows.filter((r) => r.status === "failed").map((r) => r.slice));

  const owed = relevantSlices(db, currentYear)
    .filter((s) => !done.has(s) && !exhausted.has(s));
  return [
    ...owed.filter((s) => !failed.has(s)),
    ...owed.filter((s) => failed.has(s)),
  ];
}

/** Slices abandoned after repeated failure — reported so coverage gaps are visible. */
export function exhaustedSlices(db: SqliteDb): Array<{ slice: string; error: string }> {
  return db.prepare(`
    SELECT slice, error FROM cinema_canonical_sync
    WHERE status = 'failed' AND attempts >= ?
    ORDER BY slice
  `).all(MAX_SLICE_ATTEMPTS) as Array<{ slice: string; error: string }>;
}

/** Fetch + persist one slice, recording the outcome. Throws on failure. */
export async function syncSlice(db: SqliteDb, slice: string): Promise<SliceResult> {
  const t0 = Date.now();
  const year = Number(slice);
  // `attempts` only ever grows, so a slice that keeps failing eventually
  // crosses MAX_SLICE_ATTEMPTS and stops being owed. A success resets it,
  // because a slice that recovers is not a slice with a history.
  const mark = db.prepare(`
    INSERT INTO cinema_canonical_sync (slice, works, aliases, status, error, updated_at, attempts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slice) DO UPDATE SET
      works = excluded.works, aliases = excluded.aliases,
      status = excluded.status, error = excluded.error, updated_at = excluded.updated_at,
      attempts = CASE
        WHEN excluded.status = 'done' THEN 0
        ELSE cinema_canonical_sync.attempts + 1
      END
  `);

  try {
    const { works, aliases } = await fetchSlice(year);
    const counts = persistSlice(db, works, aliases);
    mark.run(slice, counts.works, counts.aliases, "done", "", new Date().toISOString(), 0);
    return { slice, works: counts.works, aliases: counts.aliases, durationMs: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    mark.run(slice, 0, 0, "failed", msg.slice(0, 240), new Date().toISOString(), 1);
    throw err;
  }
}

export interface SyncPassResult {
  slices: SliceResult[];
  remaining: number;
  finished: boolean;
}

/**
 * Walk up to `maxSlices` pending slices.
 *
 * A slice that throws stops the pass rather than burning through the whole
 * budget against an endpoint that is evidently unhappy; it is already
 * recorded as failed, so the next pass retries it.
 */
export async function syncPass(
  db: SqliteDb,
  currentYear: number,
  maxSlices = 5,
): Promise<SyncPassResult> {
  const pending = pendingSlices(db, currentYear);
  const todo = pending.slice(0, Math.max(1, maxSlices));
  const done: SliceResult[] = [];
  let failures = 0;

  for (const [i, slice] of todo.entries()) {
    try {
      const r = await syncSlice(db, slice);
      done.push(r);
      log.info(`cinema canonical: ${slice} — ${r.works} works, ${r.aliases} aliases (${r.durationMs}ms)`);
    } catch (err) {
      // Carry on to the next slice rather than abandoning the pass.
      //
      // Stopping on the first failure meant one year that always fails took
      // the whole pass down with it, and since it was retried first every
      // time, the years behind it were never attempted at all. A single bad
      // slice is a bad slice; it is not evidence the endpoint is down.
      failures++;
      log.warn(`cinema canonical: slice ${slice} failed, continuing`, err);
    }
    if (i < todo.length - 1) await new Promise((r) => setTimeout(r, SLICE_DELAY_MS));
  }

  // Every attempt failing IS that evidence, and the caller treats a pass with
  // no completed slices as an error worth backing off from.
  if (failures > 0 && done.length === 0) {
    log.warn(`cinema canonical: all ${failures} slice(s) in this pass failed`);
  }

  const remaining = pendingSlices(db, currentYear).length;
  return { slices: done, remaining, finished: remaining === 0 };
}
