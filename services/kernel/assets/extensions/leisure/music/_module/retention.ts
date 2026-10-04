/**
 * Retention for the music catalogue mirror (`music_titles`, filled by the
 * shared archive-catalog ingester).
 *
 * Every row came from archive.org and can be ingested again; what the user did
 * with a title cannot. A title counts as touched when it is in the library
 * (`music_library`) or was ever played (`music_play_history`) — those are the
 * only tables that link a music title to the user. Untouched rows neither
 * added nor refreshed within the window are deleted.
 *
 * No per-title tables hang off music_titles, so nothing else needs deleting;
 * the FTS index follows through the music_titles triggers, and the derived
 * tag table is rebuilt once after the last batch.
 */

import type { RetentionPolicy, RetentionRunContext, SqliteDb } from "@kernl/extension-sdk";
import { ArchiveCatalog } from "../../_lib/archive-catalog/index.js";

const ELIGIBLE_WHERE = `
  ingested_at < ?1 AND last_seen_at < ?1
  AND identifier NOT IN (SELECT identifier FROM music_library)
  AND identifier NOT IN (SELECT identifier FROM music_play_history)
`;

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

export function countUntouchedMusic(db: SqliteDb, cutoff: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM music_titles WHERE ${ELIGIBLE_WHERE}`)
    .get(cutoff) as { n: number };
  return row.n;
}

export function purgeUntouchedMusic(db: SqliteDb, cutoff: string, limit: number): number {
  db
    .prepare(`
      DELETE FROM music_titles WHERE rowid IN (
        SELECT rowid FROM music_titles WHERE ${ELIGIBLE_WHERE} LIMIT ?2
      )
    `)
    .run(cutoff, limit);
  return directChanges(db);
}

export function musicRetentionPolicies(): RetentionPolicy[] {
  return [
    {
      id: "music.catalog-untouched",
      label: "Music catalogue: untouched titles",
      description:
        "Deletes archive.org music titles neither added nor refreshed in the window. " +
        "Always keeps anything in your library or that you ever played.",
      kind: "reference",
      tables: ["music_titles", "music_titles_fts"],
      defaultDays: 180,
      dayOptions: [90, 180, 365],
      defaultEnabled: false,
      estimate(rc: RetentionRunContext) {
        if (!rc.cutoff) return 0;
        try {
          return countUntouchedMusic(rc.db, rc.cutoff);
        } catch (err) {
          if (missingTable(err)) return 0;
          throw err;
        }
      },
      purge(rc: RetentionRunContext) {
        if (!rc.cutoff) return 0;
        try {
          return purgeUntouchedMusic(rc.db, rc.cutoff, rc.batchSize);
        } catch (err) {
          if (missingTable(err)) return 0;
          throw err;
        }
      },
      afterPurge(rc: RetentionRunContext, deleted: number) {
        if (deleted <= 0) return;
        new ArchiveCatalog({ db: rc.db, prefix: "music" }).rebuildTags();
      },
    },
  ];
}
