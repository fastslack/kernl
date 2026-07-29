import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Soft-delete rows that belong to archive.org collections we consider
 * noise (generative-art screensavers, sub-minute test loops, etc.). The
 * canonical list lives in `service.ts` as `NOISE_COLLECTION_BLOCKLIST`;
 * this migration just performs the one-shot cleanup of rows already in
 * the catalog when the blocklist grew.
 *
 * Match is a substring LIKE on the JSON array — collection_json looks
 * like `["ElectricSheep","artsandmusicvideos"]` so the literal
 * `"ElectricSheep"` quoted is a safe needle.
 *
 * Adding a new noise collection later only requires a new migration
 * file with the corresponding DELETE — the runtime guard in
 * `upsertFromScrape` already refuses fresh ingests.
 */
export const cinemaPurgeNoiseCollectionsMigration: Migration = {
  version: 8,
  sql: `
    UPDATE cinema_titles
    SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE deleted_at IS NULL
      AND collection_json LIKE '%"ElectricSheep"%';
  `,
};
