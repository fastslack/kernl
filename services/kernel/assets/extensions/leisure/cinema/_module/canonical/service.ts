/**
 * Persistence for canonical identification: what the matcher decided, what a
 * human decided, and what is still owed an answer.
 *
 * Kept out of CinemaService deliberately. That class is already a thousand
 * lines covering ingest, listing, search, tags, and user state; folding four
 * more tables into it would make the file harder to hold in one piece for no
 * gain, since nothing here shares state with it beyond the identifier.
 *
 * The pending signal is the ABSENCE of a match row, mirroring how
 * `embedded_at IS NULL` drives the embedding runner — one convention for
 * "work still owed", already understood by anyone reading this module.
 */

import type { SqliteDb } from "../../../../../../src/core/db/sqlite.js";
import { MATCHER_VERSION, type Candidate, type MatchOutcome, type MatchState } from "./matcher.js";

export interface MatchRow {
  identifier: string;
  qid: string;
  score: number;
  state: MatchState;
  candidates: Candidate[];
  matcher_version: number;
  matched_at: string;
  decided_at: string | null;
  decided_by: string;
}

/** A review-queue entry: the upload, and what the matcher thinks it might be. */
export interface ReviewItem {
  identifier: string;
  title: string;
  year: number;
  creator: string;
  poster_url: string;
  score: number;
  candidates: Candidate[];
}

export interface CanonicalStats {
  /** Rows in the local Wikidata corpus. */
  corpus_works: number;
  corpus_aliases: number;
  /** Year slices pulled vs still owed. */
  slices_done: number;
  slices_total: number;
  /** Catalogue titles by match state. */
  total_titles: number;
  matched: number;      // auto + confirmed — what "identified" means
  review: number;
  rejected: number;
  none: number;
  pending: number;      // never considered, or considered by an older matcher
}

export class CanonicalService {
  constructor(private db: SqliteDb) {}

  // ── Pending work ────────────────────────────────────────────────

  /**
   * Titles still owed a verdict.
   *
   * Ordered by year because the matcher's fuzzy path caches candidates in
   * year blocks — feeding it titles in year order turns what would be a
   * cache miss per title into one load per year.
   *
   * A human decision is never re-opened by a matcher upgrade: `confirmed` and
   * `rejected` rows are excluded regardless of the version they were made at.
   */
  pendingTitles(limit: number): Array<{ identifier: string; title: string; year: number }> {
    return this.db.prepare(`
      SELECT t.identifier, t.title, t.year
      FROM cinema_titles t
      LEFT JOIN cinema_title_matches m ON m.identifier = t.identifier
      WHERE t.deleted_at IS NULL
        AND t.hidden = 0
        AND (
          m.identifier IS NULL
          OR (m.state NOT IN ('confirmed','rejected') AND m.matcher_version < ?)
        )
      ORDER BY t.year, t.identifier
      LIMIT ?
    `).all(MATCHER_VERSION, Math.max(1, limit)) as Array<{ identifier: string; title: string; year: number }>;
  }

  countPending(): number {
    const r = this.db.prepare(`
      SELECT COUNT(*) AS n
      FROM cinema_titles t
      LEFT JOIN cinema_title_matches m ON m.identifier = t.identifier
      WHERE t.deleted_at IS NULL
        AND t.hidden = 0
        AND (
          m.identifier IS NULL
          OR (m.state NOT IN ('confirmed','rejected') AND m.matcher_version < ?)
        )
    `).get(MATCHER_VERSION) as { n: number };
    return r?.n ?? 0;
  }

  // ── Writing decisions ───────────────────────────────────────────

  /** Record what the matcher concluded. Overwrites any previous machine verdict. */
  recordMatch(identifier: string, outcome: MatchOutcome): void {
    this.db.prepare(`
      INSERT INTO cinema_title_matches
        (identifier, qid, score, state, candidates_json, matcher_version, matched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identifier) DO UPDATE SET
        qid             = excluded.qid,
        score           = excluded.score,
        state           = excluded.state,
        candidates_json = excluded.candidates_json,
        matcher_version = excluded.matcher_version,
        matched_at      = excluded.matched_at
      -- A human verdict outranks any re-run. Without this guard a matcher
      -- upgrade would silently discard every confirmation and rejection.
      WHERE cinema_title_matches.state NOT IN ('confirmed','rejected')
    `).run(
      identifier, outcome.qid, outcome.score, outcome.state,
      JSON.stringify(outcome.candidates), MATCHER_VERSION, new Date().toISOString(),
    );
  }

  /**
   * A human's answer.
   *
   * `qid` empty means "none of these" — recorded as `rejected` so the matcher
   * never proposes the same candidates again. Anything else is `confirmed`,
   * and confirming is how a review-queue item becomes identified.
   */
  decide(identifier: string, qid: string, by = "user"): boolean {
    const state: MatchState = qid ? "confirmed" : "rejected";
    const r = this.db.prepare(`
      UPDATE cinema_title_matches
      SET qid = ?, state = ?, decided_at = ?, decided_by = ?,
          score = CASE WHEN ? <> '' THEN 1.0 ELSE 0 END
      WHERE identifier = ?
    `).run(qid, state, new Date().toISOString(), by, qid, identifier);
    return (r as { changes?: number }).changes ? true : false;
  }

  // ── Reading ─────────────────────────────────────────────────────

  match(identifier: string): MatchRow | null {
    const r = this.db.prepare(`SELECT * FROM cinema_title_matches WHERE identifier = ?`)
      .get(identifier) as (Omit<MatchRow, "candidates"> & { candidates_json: string }) | undefined;
    if (!r) return null;
    const { candidates_json, ...rest } = r;
    return { ...rest, candidates: safeParse(candidates_json) };
  }

  /** The grey zone, worst-scoring last so the most likely wins get decided first. */
  reviewQueue(limit = 50, offset = 0): ReviewItem[] {
    const rows = this.db.prepare(`
      SELECT m.identifier, m.score, m.candidates_json,
             t.title, t.year, t.creator, t.poster_url
      FROM cinema_title_matches m
      JOIN cinema_titles t ON t.identifier = m.identifier
      WHERE m.state = 'review' AND t.deleted_at IS NULL
      ORDER BY m.score DESC, m.identifier
      LIMIT ? OFFSET ?
    `).all(Math.max(1, Math.min(limit, 200)), Math.max(0, offset)) as Array<{
      identifier: string; score: number; candidates_json: string;
      title: string; year: number; creator: string; poster_url: string;
    }>;
    return rows.map(({ candidates_json, ...r }) => ({ ...r, candidates: safeParse(candidates_json) }));
  }

  countReview(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM cinema_title_matches WHERE state = 'review'`)
      .get() as { n: number };
    return r?.n ?? 0;
  }

  stats(): CanonicalStats {
    const one = (sql: string, ...p: unknown[]): number =>
      ((this.db.prepare(sql).get(...p) as { n: number } | undefined)?.n ?? 0);

    const byState = this.db.prepare(`
      SELECT state, COUNT(*) AS n FROM cinema_title_matches GROUP BY state
    `).all() as Array<{ state: MatchState; n: number }>;
    const counts = new Map(byState.map((r) => [r.state, r.n]));

    return {
      corpus_works:   one(`SELECT COUNT(*) AS n FROM cinema_canonical_works`),
      corpus_aliases: one(`SELECT COUNT(*) AS n FROM cinema_canonical_aliases`),
      slices_done:    one(`SELECT COUNT(*) AS n FROM cinema_canonical_sync WHERE status = 'done'`),
      slices_total:   one(`SELECT COUNT(*) AS n FROM cinema_canonical_sync`),
      total_titles:   one(`SELECT COUNT(*) AS n FROM cinema_titles WHERE deleted_at IS NULL AND hidden = 0`),
      matched:        (counts.get("auto") ?? 0) + (counts.get("confirmed") ?? 0),
      review:         counts.get("review") ?? 0,
      rejected:       counts.get("rejected") ?? 0,
      none:           counts.get("none") ?? 0,
      pending:        this.countPending(),
    };
  }

  // ── Ratings layer bookkeeping ───────────────────────────────────

  /** Works with an IMDb id and no external rating yet. */
  worksAwaitingRatings(limit: number): Array<{ qid: string; imdb_id: string }> {
    return this.db.prepare(`
      SELECT qid, imdb_id FROM cinema_canonical_works
      WHERE imdb_id <> '' AND ext_fetched_at IS NULL
      LIMIT ?
    `).all(Math.max(1, limit)) as Array<{ qid: string; imdb_id: string }>;
  }

  /**
   * Stamp a rating lookup.
   *
   * Stamped even when the upstream had nothing, so a work with no rating is
   * asked about once rather than retried on every pass forever.
   */
  recordRating(qid: string, rating: number, votes: number, source: string): void {
    this.db.prepare(`
      UPDATE cinema_canonical_works
      SET ext_rating = ?, ext_votes = ?, ext_source = ?, ext_fetched_at = ?
      WHERE qid = ?
    `).run(rating, votes, source, new Date().toISOString(), qid);
  }

  countWorksAwaitingRatings(): number {
    const r = this.db.prepare(`
      SELECT COUNT(*) AS n FROM cinema_canonical_works
      WHERE imdb_id <> '' AND ext_fetched_at IS NULL
    `).get() as { n: number };
    return r?.n ?? 0;
  }
}

/** A malformed candidates blob must not take down the review queue. */
function safeParse(json: string): Candidate[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as Candidate[]) : [];
  } catch {
    return [];
  }
}
