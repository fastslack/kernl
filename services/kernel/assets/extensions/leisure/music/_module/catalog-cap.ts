/**
 * The music catalog's ceiling, set on System › Storage (the capacity of the
 * `music.catalog-untouched` retention policy). Handed to the shared
 * archive-catalog ingester as `maxRows` on every tick, so a change on the page
 * applies from the next pass. 0 = no limit (the ingester then falls back to
 * ARCHIVE_INGEST_MAX_ROWS).
 */
import { retentionCap, type SqliteDb } from "@kernl/extension-sdk";

export const MUSIC_CATALOG_POLICY = "music.catalog-untouched";

export const CATALOG_CAP_OPTIONS = [100_000, 250_000, 500_000, 1_000_000, 2_000_000];

export function musicCatalogCap(db: SqliteDb): number {
  return retentionCap(db, MUSIC_CATALOG_POLICY, 0);
}
