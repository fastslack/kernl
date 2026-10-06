/**
 * Retention for the archive.org catalogue mirror.
 *
 * `cinema_titles` is re-ingestable reference data: everything in it came from
 * archive.org and can be fetched again. What cannot be fetched again is what
 * the user did with a title, so the policy deletes only rows nobody touched.
 *
 * A title counts as touched when any of these hold:
 *   - user columns on the row: watchlist, watched_at, user_rating, user_tags,
 *     notes, hidden (hiding is a decision too — deleting the row would bring
 *     the title back unhidden on the next ingest)
 *   - it has subtitles (`cinema_subs`: generated, downloaded or published)
 *   - a human confirmed or rejected its canonical match
 *   - a directory lists it (items or cover), local or followed
 *   - a transcription or conversion job ran on one of its files
 *
 * And a title is kept, untouched itself, when it is another copy of a work the
 * user touched: same canonical qid, or same `cinema_work_members` group. A
 * watched film keeps its alternative uploads.
 *
 * Age is measured on both ingested_at and last_seen_at: a row goes only when
 * it was neither added nor refreshed within the window.
 *
 * Dependent per-title rows (match decision, work membership, media probe,
 * subtitle announcements) go in the same batch; there are no foreign keys to
 * cascade them. The FTS index follows through the cinema_titles triggers.
 * The derived works and tags tables are rebuilt once after the last batch.
 */

import type { RetentionPolicy, RetentionRunContext, SqliteDb } from "@kernl/extension-sdk";
import { CinemaService } from "./service.js";
import { CINEMA_CATALOG_POLICY, CATALOG_CAP_OPTIONS } from "./catalog-cap.js";
import { rebuildWorks } from "./works.js";

/** Identifier embedded in an archive.org download URL (`/download/<id>/file`). */
function urlIdentifier(col: string): string {
  const rest = `substr(${col}, instr(${col}, '/download/') + 10)`;
  return `CASE WHEN instr(${rest}, '/') > 0 THEN substr(${rest}, 1, instr(${rest}, '/') - 1) ELSE ${rest} END`;
}

/**
 * Every identifier the user touched, plus the other copies of the works those
 * belong to. Malformed directory JSON contributes nothing instead of failing
 * the whole run.
 */
const PROTECTED_CTE = `
  WITH touched(identifier) AS (
    SELECT identifier FROM cinema_titles
     WHERE watchlist <> 0 OR watched_at IS NOT NULL OR user_rating <> 0
        OR user_tags <> '' OR notes <> '' OR hidden <> 0
    UNION SELECT identifier FROM cinema_subs
    UNION SELECT identifier FROM cinema_title_matches
     WHERE state IN ('confirmed', 'rejected')
    UNION SELECT CASE j.type
                   WHEN 'object' THEN json_extract(j.value, '$.identifier')
                   WHEN 'text'   THEN j.value
                 END
      FROM cinema_directories d,
           json_each(CASE WHEN json_valid(d.items_json) THEN d.items_json ELSE '[]' END) j
     WHERE d.deleted_at IS NULL
    UNION SELECT cover_identifier FROM cinema_directories
     WHERE deleted_at IS NULL AND cover_identifier <> ''
    UNION SELECT ${urlIdentifier("url")} FROM cinema_transcribe_jobs
     WHERE url LIKE '%/download/%'
    UNION SELECT ${urlIdentifier("url")} FROM cinema_convert_jobs
     WHERE url LIKE '%/download/%'
  ),
  protected(identifier) AS (
    SELECT identifier FROM touched
    UNION SELECT m2.identifier
      FROM touched tt
      JOIN cinema_title_matches m1 ON m1.identifier = tt.identifier
      JOIN cinema_title_matches m2 ON m2.qid = m1.qid
     WHERE m1.qid <> ''
       AND m1.state IN ('auto', 'confirmed', 'review')
       AND m2.state IN ('auto', 'confirmed', 'review')
    UNION SELECT w2.identifier
      FROM touched tt
      JOIN cinema_work_members w1 ON w1.identifier = tt.identifier
      JOIN cinema_work_members w2 ON w2.work_key = w1.work_key
  )
`;

/** The eligible rows. `NOT IN` over a NULL would match nothing, hence the filter. */
const ELIGIBLE_WHERE = `
  t.ingested_at < ?1 AND t.last_seen_at < ?1
  AND t.identifier NOT IN (SELECT identifier FROM protected WHERE identifier IS NOT NULL)
`;

/** Per-title rows that only make sense while the title exists. */
const DEPENDENT_TABLES = [
  "cinema_title_matches",
  "cinema_work_members",
  "cinema_title_media",
  "cinema_subs_index",
] as const;

/**
 * Rows the last statement itself deleted. bun's `.run().changes` also counts
 * the rows the FTS triggers wrote, which would inflate the figure the runner
 * compares against the batch size; SQLite's changes() does not.
 */
function directChanges(db: SqliteDb): number {
  return (db.prepare(`SELECT changes() AS n`).get() as { n: number }).n;
}

function missingTable(err: unknown): boolean {
  return /no such table/i.test(String(err));
}

export function countUntouchedCatalog(db: SqliteDb, cutoff: string): number {
  const row = db
    .prepare(`${PROTECTED_CTE} SELECT COUNT(*) AS n FROM cinema_titles t WHERE ${ELIGIBLE_WHERE}`)
    .get(cutoff) as { n: number };
  return row.n;
}

export function purgeUntouchedCatalog(db: SqliteDb, cutoff: string, limit: number): number {
  const ids = (
    db
      .prepare(`${PROTECTED_CTE} SELECT t.identifier FROM cinema_titles t WHERE ${ELIGIBLE_WHERE} LIMIT ?2`)
      .all(cutoff, limit) as Array<{ identifier: string }>
  ).map((r) => r.identifier);
  if (ids.length === 0) return 0;
  const list = JSON.stringify(ids);
  for (const table of DEPENDENT_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE identifier IN (SELECT value FROM json_each(?))`).run(list);
  }
  db.prepare(`DELETE FROM cinema_titles WHERE identifier IN (SELECT value FROM json_each(?))`).run(list);
  return directChanges(db);
}

export function cinemaRetentionPolicies(): RetentionPolicy[] {
  return [
    {
      id: CINEMA_CATALOG_POLICY,
      label: "Cinema catalogue: untouched titles",
      description:
        "Deletes archive.org titles neither added nor refreshed in the window. " +
        "Always keeps anything watchlisted, watched, rated, hidden, subtitled, in a directory or transcribed, " +
        "and every other copy of those works.",
      kind: "reference",
      tables: ["cinema_titles", "cinema_titles_fts", ...DEPENDENT_TABLES],
      capacity: {
        unit: "titles",
        count: (db) => (db.prepare("SELECT COUNT(*) AS n FROM cinema_titles WHERE deleted_at IS NULL").get() as { n: number }).n,
        defaultCap: null,
        capOptions: CATALOG_CAP_OPTIONS,
      },
      defaultDays: 180,
      dayOptions: [90, 180, 365],
      defaultEnabled: false,
      estimate(rc: RetentionRunContext) {
        if (!rc.cutoff) return 0;
        try {
          return countUntouchedCatalog(rc.db, rc.cutoff);
        } catch (err) {
          if (missingTable(err)) return 0;
          throw err;
        }
      },
      purge(rc: RetentionRunContext) {
        if (!rc.cutoff) return 0;
        try {
          return purgeUntouchedCatalog(rc.db, rc.cutoff, rc.batchSize);
        } catch (err) {
          if (missingTable(err)) return 0;
          throw err;
        }
      },
      afterPurge(rc: RetentionRunContext, deleted: number) {
        if (deleted <= 0) return;
        // A purged title may have been the copy a work was shown by, and tag
        // counts include it — both derived tables are cheap full rebuilds.
        rebuildWorks(rc.db);
        new CinemaService(rc.db).rebuildTags();
      },
    },
  ];
}
