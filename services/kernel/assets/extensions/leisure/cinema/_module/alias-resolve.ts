/**
 * Recovering identities the year-blocked matcher structurally cannot reach.
 *
 * `canonical/matcher.ts` finds candidates by taking every canonical work within
 * ±3 years of the upload and scoring their aliases. That blocking is what makes
 * it fast over a 258k corpus, and it is why an upload with no year gets no
 * candidates at all — not a low score, *no candidates* — and why one whose year
 * is wrong by more than three looks at the wrong shelf entirely.
 *
 * A full-text index over the aliases does not care about years. Given a messy
 * release title it returns the works whose aliases read like it, out of all
 * 258k at once. That is the whole contribution here: **recall**. Scoring is
 * deliberately the matcher's own `titleSimilarity`, and the bar is its own
 * `REVIEW_FLOOR`, so a proposal from this path is worth exactly what a proposal
 * from that path is worth — only found differently.
 *
 * The index is SQLite FTS5 (`cinema_alias_fts`, over `cinema_canonical_aliases`)
 * and the candidates live in `cinema_resolve_candidates`. This used to run on
 * the graph — a Lucene index over `(:CanonicalWork)` nodes, CANDIDATE edges and
 * a GDS component pass — which meant projecting the whole catalogue into the
 * graph for one lookup. Nothing else read that projection.
 *
 * ## Nothing here decides anything
 *
 * Every proposal lands in `state='review'`, never `auto`. The matcher refuses to
 * auto-accept a yearless upload on purpose: with no year there is no
 * disambiguator, and a confident-looking wrong answer is the failure this whole
 * subsystem is built to avoid. Finding candidates does not change that, so these
 * go to the existing review lane and a human decides.
 *
 * Writes touch only rows the matcher left at `state='none'`. Human verdicts
 * (`confirmed`, `rejected`) and machine ones (`auto`, `review`) are never
 * overwritten, and every row written is tagged `via: graph-fulltext` in its
 * candidates, so the whole contribution can be withdrawn in one statement.
 */

import { log, type SqliteDb } from "@kernl/extension-sdk";
import { extractYear, normalizeTitle, titleSimilarity } from "./title-norm.js";
import { MATCHER_VERSION, REVIEW_FLOOR, yearFactor } from "./canonical/matcher.js";

/**
 * How a proposal from this path is recognised later.
 *
 * Provenance lives in `candidates_json`, not in `matcher_version`. The obvious
 * move — a high version number, "well clear of MATCHER_VERSION" — is a trap: the
 * matcher re-evaluates rows whose version is BELOW its own, so a proposal
 * stamped 1000 would be skipped by every future re-match and outlive the corpus
 * it was derived from. These rows are guesses awaiting better information, so
 * they must be the first thing reconsidered, not the last.
 *
 * Hence version 0 — "no matcher has ruled on this" — which is exactly true, and
 * puts the row at the front of the queue the moment the real matcher has
 * something new to say.
 *
 * The mark keeps its old name: proposals written while this ran on the graph
 * carry it, and a revert has to find them too.
 */
export const GRAPH_PROPOSAL_MARK = "graph-fulltext";
/** Rows this path writes claim no matcher verdict. */
const GRAPH_PROPOSAL_VERSION = 0;

/** Works to consider per title before scoring. */
const CANDIDATES_PER_TITLE = 8;
/** Alias hits read per title to find that many distinct works. */
const ALIAS_HITS_PER_TITLE = 40;
/** Titles per pass. */
export const DEFAULT_RESOLVE_BATCH = 500;

/**
 * A normalized title as an FTS5 query: every word, quoted (so FTS5 syntax in a
 * release title — `AND`, `NEAR`, `*`, `"` — is text, not an operator), OR-ed so
 * a work matching most words ranks first. Single letters are left out; they
 * match a large share of the corpus and decide nothing.
 */
export function ftsQuery(norm: string): string {
  const words = [...new Set(norm.split(/\s+/).filter((w) => w.length > 1))];
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
}

export interface ResolveBatchResult {
  /** Titles examined. Zero means there is nothing left unmatched. */
  titles: number;
  /** Titles that got at least one candidate above the floor. */
  withCandidates: number;
  /** Candidates written. */
  candidates: number;
  cursor: string;
}

interface PendingTitle {
  identifier: string;
  title: string;
  year: number;
}

/**
 * Titles the matcher could not place: it either found nothing (`none`) or never
 * saw them. Ordered by identifier so the pass is resumable by cursor.
 */
function pendingTitles(db: SqliteDb, cursor: string, limit: number): PendingTitle[] {
  return db
    .prepare(
      `SELECT t.identifier, t.title, t.year
         FROM cinema_titles t
         LEFT JOIN cinema_title_matches m ON m.identifier = t.identifier
        WHERE t.identifier > ?
          AND t.deleted_at IS NULL
          AND t.hidden = 0
          AND (m.state IS NULL OR m.state = 'none')
     ORDER BY t.identifier
        LIMIT ?`,
    )
    .all(cursor, limit) as PendingTitle[];
}

/**
 * Ask the alias index for lookalikes, score them the matcher's way, and record
 * the survivors as candidates. One query per title: one OR-ed query for a whole
 * batch would rank titles against each other.
 */
export function proposeBatch(
  db: SqliteDb,
  cursor: string,
  limit: number = DEFAULT_RESOLVE_BATCH,
): ResolveBatchResult {
  const titles = pendingTitles(db, cursor, limit);
  if (titles.length === 0) return { titles: 0, withCandidates: 0, candidates: 0, cursor };

  const hitsFor = db.prepare(
    `SELECT a.qid AS qid
       FROM cinema_alias_fts f
       JOIN cinema_canonical_aliases a ON a.rowid = f.rowid
      WHERE cinema_alias_fts MATCH ?
   ORDER BY bm25(cinema_alias_fts)
      LIMIT ?`,
  );
  const work = db.prepare("SELECT label, year FROM cinema_canonical_works WHERE qid = ?");
  const aliases = db.prepare("SELECT alias_norm FROM cinema_canonical_aliases WHERE qid = ?");
  const save = db.prepare(
    `INSERT INTO cinema_resolve_candidates (identifier, qid, score) VALUES (?, ?, ?)
     ON CONFLICT(identifier, qid) DO UPDATE SET score = excluded.score`,
  );

  let withCandidates = 0;
  let candidates = 0;
  for (const t of titles) {
    const norm = normalizeTitle(t.title);
    const query = norm ? ftsQuery(norm) : "";
    if (!query) continue;

    // The year in the metadata column, or the one the release title carries
    // ("Angel Puss (1944)") — same two places the matcher looks.
    const uploadYear = t.year > 0 ? t.year : extractYear(t.title);

    let qids: string[];
    try {
      const rows = hitsFor.all(query, ALIAS_HITS_PER_TITLE) as Array<{ qid: string }>;
      qids = [...new Set(rows.map((r) => r.qid))].slice(0, CANDIDATES_PER_TITLE);
    } catch (err) {
      // A single unparseable title must not sink the batch.
      log.debug(`cinema resolve: full-text query failed for "${t.title}" — ${String(err)}`);
      continue;
    }

    // Full-text ranks by term overlap, which is the wrong yardstick for deciding
    // sameness — rescore with the matcher's own similarity against the best
    // alias each work answers to, then apply its year factor.
    //
    // Dropping the year BLOCKING is the point of this path; dropping the year
    // CHECK was a mistake that let "Angel Puss (1944)" propose a 1988 film of
    // the same name. `yearFactor` already encodes both halves of what is wanted
    // here: beyond three years apart it returns 0 and the candidate dies, while
    // an upload with no year at all gets 0.9 — enough to reach review on a
    // strong title, never enough to be accepted automatically.
    let matched = false;
    for (const qid of qids) {
      const w = work.get(qid) as { label: string; year: number } | undefined;
      if (!w) continue;
      const factor = yearFactor(uploadYear, Number(w.year ?? 0));
      if (factor === 0) continue;
      let best = titleSimilarity(norm, normalizeTitle(w.label ?? ""));
      for (const a of aliases.all(qid) as Array<{ alias_norm: string }>) {
        const score = titleSimilarity(norm, a.alias_norm);
        if (score > best) best = score;
      }
      const final = best * factor;
      if (final >= REVIEW_FLOOR) {
        save.run(t.identifier, qid, final);
        candidates++;
        matched = true;
      }
    }
    if (matched) withCandidates++;
  }

  return {
    titles: titles.length,
    withCandidates,
    candidates,
    cursor: titles[titles.length - 1].identifier,
  };
}

// ── Component resolution ───────────────────────────────────────────────

export interface ComponentResult {
  components: number;
  /** Components holding exactly one canonical work — nothing rivals the match. */
  unrivalled: number;
  /** Components holding several — a human has to choose. */
  ambiguous: number;
  /** Rows written to the review lane. */
  proposed: number;
  /** Titles found to be copies of each other via a shared candidate. */
  coCopies: number;
}

/**
 * Group the candidates into connected components — uploads and the works they
 * might be, joined by a candidate — and read each one as a claim about the
 * world.
 *
 * When a component holds exactly ONE canonical work, nothing rivals that
 * identity — the same reasoning behind the matcher's unrivalled floor, applied
 * to a cluster instead of a single row. When it holds several, the uploads are
 * still copies of *each other* even though which film they are is open.
 *
 * A union-find over the candidate rows: they are tens of thousands at most.
 */
export function resolveComponents(db: SqliteDb): ComponentResult {
  const rows = db
    .prepare("SELECT identifier, qid, score FROM cinema_resolve_candidates")
    .all() as Array<{ identifier: string; qid: string; score: number }>;

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let n = x; n !== root; ) { const next = parent.get(n)!; parent.set(n, root); n = next; }
    return root;
  };
  const union = (a: string, b: string) => {
    for (const x of [a, b]) if (!parent.has(x)) parent.set(x, x);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  // Titles and works share one namespace here; prefix them apart.
  for (const r of rows) union(`t:${r.identifier}`, `w:${r.qid}`);

  const groups = new Map<string, { qids: Set<string>; titles: Map<string, number> }>();
  for (const r of rows) {
    const root = find(`t:${r.identifier}`);
    const g = groups.get(root) ?? { qids: new Set(), titles: new Map() };
    g.qids.add(r.qid);
    g.titles.set(r.identifier, Math.max(g.titles.get(r.identifier) ?? 0, Number(r.score) || 0));
    groups.set(root, g);
  }

  // Only rows the matcher gave up on. `state='none'` in the WHERE is the whole
  // safety story: an auto/confirmed/rejected/review row is never touched, so a
  // human verdict cannot be overwritten by a machine proposal.
  const propose = db.prepare(
    `UPDATE cinema_title_matches
        SET qid = ?, score = ?, state = 'review',
            candidates_json = ?, matcher_version = ${GRAPH_PROPOSAL_VERSION},
            matched_at = ?
      WHERE identifier = ? AND state = 'none'`,
  );
  const insert = db.prepare(
    `INSERT INTO cinema_title_matches
       (identifier, qid, score, state, candidates_json, matcher_version, matched_at)
     VALUES (?, ?, ?, 'review', ?, ${GRAPH_PROPOSAL_VERSION}, ?)
     ON CONFLICT(identifier) DO NOTHING`,
  );

  let unrivalled = 0, ambiguous = 0, proposed = 0, coCopies = 0;
  const now = new Date().toISOString();
  for (const g of groups.values()) {
    if (g.titles.size > 1) coCopies += g.titles.size;
    if (g.qids.size !== 1) {
      ambiguous++;
      continue;
    }
    unrivalled++;
    const qid = [...g.qids][0];
    const candidatesJson = JSON.stringify([{ qid, via: GRAPH_PROPOSAL_MARK }]);
    for (const [id, score] of g.titles) {
      const inserted = insert.run(id, qid, score, candidatesJson, now).changes ?? 0;
      const updated = propose.run(qid, score, candidatesJson, now, id).changes ?? 0;
      proposed += inserted > 0 ? inserted : updated;
    }
  }

  log.info(
    `cinema resolve: ${groups.size} components — ${unrivalled} unrivalled, ` +
    `${ambiguous} ambiguous, ${proposed} rows sent to review`,
  );
  return { components: groups.size, unrivalled, ambiguous, proposed, coCopies };
}

/**
 * Undo everything this path ever wrote. Provenance made actionable.
 *
 * The version stamp goes back to the matcher's too. A reverted row is once
 * again the matcher's `none` verdict, and leaving it stamped as a graph
 * proposal would claim this path still has an opinion about a row it has
 * explicitly withdrawn from.
 */
export function revertGraphProposals(db: SqliteDb): number {
  const info = db
    .prepare(
      `UPDATE cinema_title_matches
          SET qid = '', score = 0, state = 'none', candidates_json = '[]',
              matcher_version = ${MATCHER_VERSION}
        WHERE state = 'review' AND candidates_json LIKE '%${GRAPH_PROPOSAL_MARK}%'`,
    )
    .run();
  return info.changes ?? 0;
}

/**
 * Repair rows left stamped as graph proposals while sitting at `none` — the
 * footprint of a revert that restored state but not provenance.
 */
export function clearStaleProposalStamps(db: SqliteDb): number {
  const info = db
    .prepare(
      `UPDATE cinema_title_matches
          SET matcher_version = ${MATCHER_VERSION}
        WHERE state = 'none' AND candidates_json LIKE '%${GRAPH_PROPOSAL_MARK}%'`,
    )
    .run();
  return info.changes ?? 0;
}
