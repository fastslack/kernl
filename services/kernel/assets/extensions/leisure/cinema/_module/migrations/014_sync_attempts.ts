import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Track how many times a corpus slice has been attempted.
 *
 * Without a count there is no way to give up, and no way to give up means one
 * permanently-failing year holds the whole phase open forever. That happened:
 * year 2017 answered with a non-JSON error page, stayed pending, and the
 * corpus phase could never report itself finished — so matching, which is the
 * part anyone actually wants, was unreachable behind it.
 *
 * With a count, a slice that has failed repeatedly stops being owed. Coverage
 * is then incomplete, which is a real cost and is logged as one, but it is a
 * far smaller cost than never matching at all.
 */
export const cinemaSyncAttemptsMigration: Migration = {
  version: 14,
  sql: `
    ALTER TABLE cinema_canonical_sync ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  `,
};
