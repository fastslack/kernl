/**
 * Grouping the many uploads of one film into one work.
 *
 * The grouping itself is a pure function over rows so it can be reasoned
 * about and tested without a database; persistence is a separate step.
 *
 * Two things make this harder than "group by title":
 *
 * 1. The same film is uploaded under titles that do not resemble each other.
 *    "Nosferatu" and "Nosferatu, eine Symphonie des Grauens" share almost no
 *    trigrams. Only the canonical identity from the matcher knows they are
 *    one film, which is why this pass runs after that one and keys on `qid`
 *    whenever there is one.
 *
 * 2. Identification is partial. Within one film's copies, some will have
 *    matched and some will not, and a naive keying would file them into two
 *    different works — leaving exactly the fragmentation this is meant to
 *    remove. The second pass fixes that: an unidentified copy joins an
 *    identified group when its normalized title and year say it belongs.
 *
 * Where it refuses to merge: ambiguity, not merely a missing year. An upload
 * with no year joins a film whose title only ONE work answers to, because
 * there is nothing to be wrong about — and `cinema_titles.year` is 0 across a
 * large slice of the catalogue, so treating a missing year as fatal would
 * throw away most of the dedupe. When the title is claimed by two works, as
 * "Dracula" is, the upload stays a singleton rather than collapsing genuine
 * remakes into a fiction.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { normalizeTitle, extractYear, workKey } from "./title-norm.js";

/** The columns grouping actually reads. */
export interface WorkCandidateRow {
  identifier: string;
  title: string;
  year: number;
  runtime_sec: number;
  downloads: number;
  week_downloads: number;
  avg_rating: number;
  num_reviews: number;
  has_torrent: number;
  /** The canonical work this copy was identified as; empty when unmatched. */
  qid: string;
  /** JSON array of collection slugs. Used to spot generic-title shelves. */
  collection_json?: string;
}

/**
 * Collections whose items are never copies of each other.
 *
 * The trailer shelves are the problem case, and they are a large one. Measured
 * against the live catalogue: of the groups that came out with 30+ members,
 * 100% contained trailers; at 20+, 99%; at 10+, 95%. The reason is that
 * archive.org's Turner trailer import gives every clip the name of the film
 * or show it promotes, so thirty-eight distinct trailers all arrive titled
 * "Family Guy" with the same year. They are not thirty-eight uploads of one
 * thing, and summing their downloads into one row is simply wrong.
 */
export const DEDUPE_EXCLUDED_COLLECTIONS = ["movie_trailers", "movie_trailers_unsorted"];

/**
 * Above this many members, a group is not believed.
 *
 * A backstop for generic titles the collection list does not catch —
 * "BOSTON BLACKIE TV SHOW" arrived 29 times, one per episode, from no trailer
 * shelf at all.
 *
 * The threshold is set from the data rather than picked: with trailers
 * removed, the largest groups that are genuinely one film are around a dozen
 * or so — `American Look` (1958) at 14, `White Zombie` (1932) at 11, `The
 * Vampire Bat` (1933) at 9 — all real public-domain films with many separate
 * uploads. 20 sits above those and below the episodic pile-ups. A rejected
 * group is split back into singletons, which is the honest fallback: showing
 * a film's copies separately is a cosmetic problem, merging thirty different
 * items is a factual one.
 */
const MAX_GROUP_SIZE = 20;

function inExcludedCollection(row: WorkCandidateRow): boolean {
  const json = row.collection_json;
  if (!json) return false;
  return DEDUPE_EXCLUDED_COLLECTIONS.some((c) => json.includes(`"${c}"`));
}

export interface WorkGroup {
  work_key: string;
  qid: string;
  title: string;
  year: number;
  primary_identifier: string;
  members: string[];
  copies: number;
  downloads: number;
  week_downloads: number;
  num_reviews: number;
  avg_rating: number;
}

/**
 * Which copy represents the group.
 *
 * Ordered by what makes a copy WATCHABLE rather than by what makes it
 * popular, because popularity is the thing being aggregated — picking the
 * most-downloaded copy would just re-privilege whichever upload happened to
 * get linked somewhere in 2012.
 *
 *   1. has a torrent      — the module's whole playback path assumes one
 *   2. has a known runtime — a row with runtime 0 is frequently a stub or a
 *                            derivative with no playable file
 *   3. longest runtime     — among real copies of one film, the longer one is
 *                            the more complete cut, not a different film
 *   4. most downloads      — a genuine tiebreak once the above agree
 *   5. identifier          — so the choice is stable across rebuilds rather
 *                            than depending on row order
 */
export function compareCopies(a: WorkCandidateRow, b: WorkCandidateRow): number {
  if (a.has_torrent !== b.has_torrent) return b.has_torrent - a.has_torrent;
  const aKnown = a.runtime_sec > 0 ? 1 : 0;
  const bKnown = b.runtime_sec > 0 ? 1 : 0;
  if (aKnown !== bKnown) return bKnown - aKnown;
  if (a.runtime_sec !== b.runtime_sec) return b.runtime_sec - a.runtime_sec;
  if (a.downloads !== b.downloads) return b.downloads - a.downloads;
  return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
}

/**
 * The title-and-year signature of an upload, or null when it has neither a
 * usable title nor a year.
 *
 * The year falls back to whatever the uploader typed into the title, because
 * `cinema_titles.year` is 0 on a large slice of the catalogue while the title
 * itself frequently carries "(1922)".
 */
function signature(row: WorkCandidateRow): { key: string; norm: string; year: number } | null {
  const norm = normalizeTitle(row.title);
  if (!norm) return null;
  const year = row.year > 0 ? row.year : extractYear(row.title);
  if (year <= 0) return null;
  return { key: workKey(norm, year), norm, year };
}

/** The normalized title alone, for the yearless pass. */
function bareNorm(row: WorkCandidateRow): string {
  return normalizeTitle(row.title);
}

/**
 * Group rows into works.
 *
 * Pure: same input, same output, no clock and no database.
 */
export function groupTitles(rows: WorkCandidateRow[]): WorkGroup[] {
  // ── Pass 0: shelves whose items are never copies of each other.
  //
  // Taken out before anything else rather than filtered afterwards: a trailer
  // must not even register its title/year signature, or an unidentified real
  // upload arriving later would join the trailer pile.
  const keyOf = new Map<string, string>();               // identifier → work_key
  const signatureToQidKey = new Map<string, string>();   // "norm::year" → "qid:…"

  const groupable: WorkCandidateRow[] = [];
  for (const row of rows) {
    if (inExcludedCollection(row)) keyOf.set(row.identifier, `id:${row.identifier}`);
    else groupable.push(row);
  }

  // ── Pass 1: identified copies claim a qid group, and register the
  // title/year signatures that group is known by.
  for (const row of groupable) {
    if (!row.qid) continue;
    const key = `qid:${row.qid}`;
    keyOf.set(row.identifier, key);
    const sig = signature(row);
    if (sig) signatureToQidKey.set(sig.key, key);
  }

  // ── Pass 2: unidentified copies that DO carry a year.
  //
  // If this copy's signature matches one an identified group already answers
  // to, it is the same film and joins that group — this is what keeps a
  // matched and an unmatched copy of one film from becoming two works.
  // Otherwise it forms (or joins) a signature-keyed group of its own.
  //
  // Every dated group's title is also recorded, so the yearless pass below
  // can tell a title that names one film from a title that names several.
  const keysByBareTitle = new Map<string, Set<string>>();
  const noteTitle = (norm: string, key: string) => {
    const seen = keysByBareTitle.get(norm);
    if (seen) seen.add(key);
    else keysByBareTitle.set(norm, new Set([key]));
  };
  for (const row of groupable) {
    const sig = signature(row);
    if (!sig) continue;
    const key = row.qid ? `qid:${row.qid}` : (signatureToQidKey.get(sig.key) ?? `norm:${sig.key}`);
    if (!row.qid) keyOf.set(row.identifier, key);
    noteTitle(sig.norm, key);
  }

  // ── Pass 3: uploads with no year anywhere.
  //
  // These join a dated group when its title is claimed by exactly one work.
  // Ambiguity — not a missing year — is what forces a singleton: "Dracula"
  // answers to three different films and must not collapse them, but
  // "Metropolis" answers to one and there is nothing to get wrong.
  for (const row of groupable) {
    if (row.qid || keyOf.has(row.identifier)) continue;
    const norm = bareNorm(row);
    const claimants = norm ? keysByBareTitle.get(norm) : undefined;
    keyOf.set(
      row.identifier,
      claimants && claimants.size === 1
        ? [...claimants][0]
        : `id:${row.identifier}`,
    );
  }

  // ── Fold members into groups.
  const byKey = new Map<string, WorkCandidateRow[]>();
  for (const row of rows) {
    const key = keyOf.get(row.identifier);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }

  // ── Disbelieve implausibly large groups.
  //
  // Split back into singletons rather than truncated: keeping an arbitrary
  // twenty of thirty members would still merge items that are not copies,
  // and would do it invisibly.
  for (const [key, members] of [...byKey]) {
    if (members.length <= MAX_GROUP_SIZE) continue;
    byKey.delete(key);
    for (const m of members) byKey.set(`id:${m.identifier}`, [m]);
  }

  const out: WorkGroup[] = [];
  for (const [work_key, members] of byKey) {
    const sorted = [...members].sort(compareCopies);
    const primary = sorted[0];

    let downloads = 0;
    let week = 0;
    let reviews = 0;
    let ratingWeighted = 0;
    for (const m of members) {
      downloads += m.downloads;
      week += m.week_downloads;
      reviews += m.num_reviews;
      // Vote-weighted, not a mean of means: a lone 5.0 must not outweigh a
      // 4.2 backed by forty reviewers merely because they sat on different
      // uploads of the same film.
      ratingWeighted += m.avg_rating * m.num_reviews;
    }

    out.push({
      work_key,
      qid: work_key.startsWith("qid:") ? work_key.slice(4) : "",
      title: primary.title,
      year: primary.year > 0 ? primary.year : extractYear(primary.title),
      primary_identifier: primary.identifier,
      members: members.map((m) => m.identifier),
      copies: members.length,
      downloads,
      week_downloads: week,
      num_reviews: reviews,
      avg_rating: reviews > 0 ? ratingWeighted / reviews : 0,
    });
  }
  return out;
}

export interface RebuildWorksResult {
  works: number;
  members: number;
  /** Works with more than one copy — the fragmentation that was there. */
  collapsed: number;
  /** Rows removed from the grid by collapsing. */
  duplicates: number;
}

/**
 * Rebuild both derived tables from scratch.
 *
 * A full rebuild rather than an incremental update, for the same reason
 * cinema_tags is rebuilt: a new title can change which copy represents an
 * existing work and can merge two groups that were previously separate, so
 * the incremental version would have to reconsider most of the table anyway.
 * One scan of a 74k-row table is cheap; a subtly stale grouping is not.
 */
export function rebuildWorks(db: SqliteDb): RebuildWorksResult {
  const rows = db.prepare(`
    SELECT t.identifier, t.title, t.year, t.runtime_sec, t.downloads,
           t.week_downloads, t.avg_rating, t.num_reviews, t.has_torrent,
           t.collection_json,
           COALESCE(
             CASE WHEN m.state IN ('auto','confirmed') THEN m.qid ELSE '' END,
             ''
           ) AS qid
    FROM cinema_titles t
    LEFT JOIN cinema_title_matches m ON m.identifier = t.identifier
    WHERE t.deleted_at IS NULL AND t.hidden = 0
  `).all() as WorkCandidateRow[];

  const groups = groupTitles(rows);
  const now = new Date().toISOString();

  const insertWork = db.prepare(`
    INSERT INTO cinema_works
      (work_key, qid, title, year, primary_identifier, copies, downloads,
       week_downloads, num_reviews, avg_rating, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMember = db.prepare(
    `INSERT INTO cinema_work_members (identifier, work_key) VALUES (?, ?)`,
  );

  let members = 0;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM cinema_works`).run();
    db.prepare(`DELETE FROM cinema_work_members`).run();
    for (const g of groups) {
      insertWork.run(
        g.work_key, g.qid, g.title, g.year, g.primary_identifier, g.copies,
        g.downloads, g.week_downloads, g.num_reviews, g.avg_rating, now,
      );
      for (const id of g.members) {
        insertMember.run(id, g.work_key);
        members++;
      }
    }
  });
  tx();

  const collapsed = groups.filter((g) => g.copies > 1).length;
  return {
    works: groups.length,
    members,
    collapsed,
    duplicates: members - groups.length,
  };
}
