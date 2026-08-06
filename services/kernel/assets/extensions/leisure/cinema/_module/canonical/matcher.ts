/**
 * Deciding which canonical work, if any, an archive.org upload is a copy of.
 *
 * The asymmetry that shapes everything here: a missed match costs a title its
 * badge, while a WRONG match hands a stranger's home movie the identity — and
 * therefore the rating and the ranking position — of a canonical film. That is
 * precisely the disease this feature exists to cure, so the whole design is
 * biased toward refusing to guess.
 *
 * Three refusals are built in:
 *   - a title that matches several works equally goes to review, never to a
 *     coin flip (this is what happens to bare "Dracula")
 *   - a year more than three off is not a near-miss, it is a different work,
 *     and scores zero no matter how well the titles agree
 *   - an upload with no year at all can never clear the automatic floor, even
 *     on a perfect title match, because the disambiguator is missing
 *
 * Matching runs against the LOCAL corpus, so re-running it after tuning any
 * of the above costs seconds rather than 74k network calls.
 */

import type { SqliteDb } from "../../../../../../src/core/db/sqlite.js";
import { normalizeTitle, extractYear, trigrams, diceCoefficient } from "../title-norm.js";

/**
 * Bumped whenever the logic below changes in a way that could produce a
 * different answer. Stored per decision so a re-run can invalidate machine
 * verdicts while leaving human ones untouched.
 */
export const MATCHER_VERSION = 2;

/** At or above this, accept without asking anyone. */
export const AUTO_FLOOR = 0.95;

/**
 * The floor when there is exactly ONE candidate and the years agree exactly.
 *
 * 0.95 was set against the risk of picking wrongly between rival works. That
 * risk does not exist when nothing rivals the match, and holding both cases
 * to the same bar sent a large amount of correct work to a human for no
 * reason. Measured on the live catalogue, the 0.90–0.95 single-candidate band
 * held 1,735 items and the sample was correct every time — episode numbers
 * prefixed to a series title, a typo on Wikidata's side ("Johny Tolengo"), a
 * missing article ("Crimen en el hotel alojamiento"), release tags left in
 * ("Night of the Living Dead |1968| WebRip").
 *
 * It stops at 0.90 because below that the same catalogue holds real errors:
 * "Grandma's Reading Glass" scoring against "Grandpa's Reading Glass" at
 * 0.809, and two different "Enoch Arden" films at 0.850. Those must keep
 * going to a human — which the exact-year requirement also enforces, since
 * both of those disagree on year.
 */
export const AUTO_FLOOR_UNRIVALLED = 0.90;
/** At or above this but below AUTO_FLOOR, ask a human. */
export const REVIEW_FLOOR = 0.80;
/**
 * How close the runner-up may be before the top match stops counting as
 * decided. Two works within this margin are, for our purposes, tied.
 */
export const AMBIGUITY_EPSILON = 0.02;
/** Beyond this many years apart, it is a different work — not a near-miss. */
export const MAX_YEAR_DELTA = 3;

export type MatchState = "auto" | "confirmed" | "review" | "rejected" | "none";

export interface Candidate {
  qid: string;
  label: string;
  year: number;
  imdb_id: string;
  director: string;
  country: string;
  score: number;
  /** Which of the work's titles produced the score — shown in the review UI. */
  via: string;
}

export interface MatchOutcome {
  qid: string;
  score: number;
  state: Exclude<MatchState, "confirmed" | "rejected">;
  candidates: Candidate[];
}

interface WorkLite {
  qid: string;
  label: string;
  year: number;
  imdb_id: string;
  director: string;
  country: string;
}

/**
 * How much a year disagreement discounts a title match.
 *
 * Not a hard equality test: a film premieres at a festival one year and is
 * released the next, national release dates drift, and archive.org uploaders
 * copy the year off whichever print they have. One year of slack is normal,
 * two or three is suspicious but survivable on a strong title match, and
 * beyond that the titles agreeing means they are two different films that
 * share a name — the remake case.
 *
 * An upload with no year is capped below the automatic floor by design: it
 * can reach review on a perfect title, never acceptance.
 */
export function yearFactor(uploadYear: number, workYear: number): number {
  if (uploadYear <= 0 || workYear <= 0) return 0.9;
  const delta = Math.abs(uploadYear - workYear);
  if (delta === 0) return 1;
  if (delta === 1) return 0.98;
  if (delta === 2) return 0.93;
  if (delta === 3) return 0.85;
  return 0;
}

interface BlockEntry extends WorkLite {
  aliasNorms: string[];
  aliasGrams: Set<string>[];
}

/**
 * Candidate lookup over the local corpus.
 *
 * Two access paths, cheapest first:
 *   exact()     an index seek on alias_norm — answers most uploads outright
 *   yearBlock() every work within the year window, with trigrams precomputed
 *
 * The block path is the expensive one (tens of thousands of rows for a modern
 * year), so it is only taken when the exact path came up empty, and blocks are
 * cached because the runner feeds titles in year order — consecutive titles
 * reuse the same block instead of rebuilding it.
 */
export class CandidateIndex {
  private blockCache = new Map<number, BlockEntry[]>();
  /** Small on purpose: a block is heavy and the access pattern is sequential. */
  private static MAX_CACHED_BLOCKS = 4;

  private exactStmt;
  private blockStmt;

  constructor(private db: SqliteDb) {
    this.exactStmt = db.prepare(`
      SELECT w.qid, w.label, w.year, w.imdb_id, w.director, w.country
      FROM cinema_canonical_aliases a
      JOIN cinema_canonical_works w ON w.qid = a.qid
      WHERE a.alias_norm = ?
    `);
    this.blockStmt = db.prepare(`
      SELECT w.qid, w.label, w.year, w.imdb_id, w.director, w.country, a.alias_norm
      FROM cinema_canonical_works w
      JOIN cinema_canonical_aliases a ON a.qid = w.qid
      WHERE w.year BETWEEN ? AND ?
    `);
  }

  /** Works claiming this exact normalized title. */
  exact(normTitle: string): WorkLite[] {
    if (!normTitle) return [];
    return this.exactStmt.all(normTitle) as WorkLite[];
  }

  /** Every work within MAX_YEAR_DELTA of `year`, trigrams precomputed. */
  yearBlock(year: number): BlockEntry[] {
    const cached = this.blockCache.get(year);
    if (cached) return cached;

    const rows = this.blockStmt.all(
      year - MAX_YEAR_DELTA,
      year + MAX_YEAR_DELTA,
    ) as Array<WorkLite & { alias_norm: string }>;

    const byQid = new Map<string, BlockEntry>();
    for (const r of rows) {
      let e = byQid.get(r.qid);
      if (!e) {
        e = {
          qid: r.qid, label: r.label, year: r.year, imdb_id: r.imdb_id,
          director: r.director, country: r.country,
          aliasNorms: [], aliasGrams: [],
        };
        byQid.set(r.qid, e);
      }
      e.aliasNorms.push(r.alias_norm);
      e.aliasGrams.push(trigrams(r.alias_norm));
    }
    const block = [...byQid.values()];

    if (this.blockCache.size >= CandidateIndex.MAX_CACHED_BLOCKS) {
      // Sequential access, so the oldest entry is the one furthest from where
      // the runner currently is.
      const oldest = this.blockCache.keys().next().value;
      if (oldest !== undefined) this.blockCache.delete(oldest);
    }
    this.blockCache.set(year, block);
    return block;
  }

  /** Corpus size, for the status endpoint. */
  workCount(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM cinema_canonical_works`).get() as { n: number };
    return r?.n ?? 0;
  }
}

/** Rank, then decide. Shared by both the exact and the fuzzy path. */
function decide(scored: Candidate[], uploadYear = 0): MatchOutcome {
  const ranked = scored
    .filter((c) => c.score >= REVIEW_FLOOR)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return { qid: "", score: 0, state: "none", candidates: [] };

  const top = ranked[0];
  const runnerUp = ranked[1];
  // Keep a handful for the review UI; beyond that the list stops being a
  // choice and becomes a wall.
  const candidates = ranked.slice(0, 6);

  const tied = runnerUp !== undefined && top.score - runnerUp.score <= AMBIGUITY_EPSILON;

  if (top.score >= AUTO_FLOOR && !tied) {
    return { qid: top.qid, score: top.score, state: "auto", candidates };
  }

  // Unrivalled: nothing else cleared the floor, and the years match exactly.
  //
  // The strict floor exists to stop the matcher picking between rival works.
  // With no rival there is nothing to pick between, and the year — the
  // disambiguator that separates a remake from its original — agrees outright.
  // What remains is a title that differs by an episode number, a displaced
  // article, or a typo on one side.
  if (
    ranked.length === 1 &&
    uploadYear > 0 &&
    top.year === uploadYear &&
    top.score >= AUTO_FLOOR_UNRIVALLED
  ) {
    return { qid: top.qid, score: top.score, state: "auto", candidates };
  }
  // Everything that scored but did not earn acceptance — including a strong
  // but tied match — is a question for a human, not a guess.
  return { qid: "", score: top.score, state: "review", candidates };
}

function toCandidate(w: WorkLite, score: number, via: string): Candidate {
  return {
    qid: w.qid, label: w.label, year: w.year, imdb_id: w.imdb_id,
    director: w.director, country: w.country, score, via,
  };
}

/**
 * Match one upload against the corpus.
 *
 * `rawTitle` is the archive.org title as uploaded and `rowYear` the catalogue's
 * parsed year, which is frequently 0 — in that case the year the uploader
 * typed into the title itself is recovered, since "Nosferatu (1922)" carries
 * its own disambiguator even when the metadata does not.
 */
export function matchTitle(
  index: CandidateIndex,
  rawTitle: string,
  rowYear: number,
): MatchOutcome {
  const norm = normalizeTitle(rawTitle);
  if (!norm) return { qid: "", score: 0, state: "none", candidates: [] };

  const year = rowYear > 0 ? rowYear : extractYear(rawTitle);

  // ── Fast path: someone else already spells it exactly this way ──
  const exact = index.exact(norm);
  if (exact.length > 0) {
    const scored = exact.map((w) => toCandidate(w, yearFactor(year, w.year), norm));
    const outcome = decide(scored, year);
    // An exact title hit that still failed to clear anything means every
    // candidate was ruled out on year — a remake, not this film. Fall through
    // rather than returning "none", because the fuzzy pass searches a
    // different year window and may find the right one.
    if (outcome.state !== "none") return outcome;
  }

  // ── Slow path: fuzzy, within the year window ──
  //
  // Only reachable with a usable year. Fuzzy-matching a yearless title against
  // the entire 250k-work corpus is both too slow to run and too reckless to
  // trust, so a yearless upload that did not match exactly stays unmatched.
  if (year <= 0) return { qid: "", score: 0, state: "none", candidates: [] };

  const grams = trigrams(norm);
  const scored: Candidate[] = [];
  for (const w of index.yearBlock(year)) {
    const yf = yearFactor(year, w.year);
    if (yf === 0) continue;
    let best = 0;
    let via = "";
    for (let i = 0; i < w.aliasGrams.length; i++) {
      const sim = w.aliasNorms[i] === norm ? 1 : diceCoefficient(grams, w.aliasGrams[i]);
      if (sim > best) {
        best = sim;
        via = w.aliasNorms[i];
      }
    }
    const score = best * yf;
    if (score >= REVIEW_FLOOR) scored.push(toCandidate(w, score, via));
  }

  return decide(scored, year);
}
