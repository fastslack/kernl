import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Soft-delete archive.org collection landing-page items that got ingested
 * as if they were movies. They share identifier with a collection slug
 * (`feature_films`, `moviesandfilms`, etc.), carry a torrent (the bundled
 * collection download), and accumulate huge view counts from browsing
 * traffic — so they sort to the very top of the catalog and look like
 * blockbuster movies. Clicking one leads nowhere because there's no
 * playable file.
 *
 * Going forward `service.upsertFromScrape()` refuses these identifiers
 * (see COLLECTION_ITEM_BLOCKLIST). This migration is the one-shot cleanup
 * for the 11-or-so rows already in the table.
 *
 * Soft-delete (not DROP) preserves any user state the catalog may have
 * accumulated against the identifier (watchlist, ratings) — should a true
 * "collection landing as item" use-case appear later we can un-delete.
 */
export const cinemaPurgeCollectionItemsMigration: Migration = {
  version: 7,
  sql: `
    UPDATE cinema_titles
    SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE deleted_at IS NULL
      AND identifier IN (
        'feature_films',
        'silent_films',
        'classic_cartoons',
        'classic_tv',
        'SciFi_Horror',
        'prelinger',
        'moviesandfilms',
        'culturalandacademicfilms',
        'artsandmusicvideos',
        'animationandcartoons',
        'short_films',
        'vintage_cartoons',
        'educationalfilms',
        'opensource_movies',
        'horror',
        'sci-fi_horror',
        'film_noir'
      );
  `,
};
