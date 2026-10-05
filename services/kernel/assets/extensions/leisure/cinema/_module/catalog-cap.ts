/**
 * The cinema catalog's ceiling, set on System › Storage (the capacity of the
 * `cinema.catalog-untouched` retention policy). The archive.org ingester walks
 * a cursor every few minutes and never stopped on its own; it now parks once
 * the catalog holds this many titles. Falls back to the instance-wide
 * ARCHIVE_INGEST_MAX_ROWS setting, and 0 means no limit.
 */
import { retentionCap, type SqliteDb } from "@kernl/extension-sdk";

export const CINEMA_CATALOG_POLICY = "cinema.catalog-untouched";

export const CATALOG_CAP_OPTIONS = [100_000, 250_000, 500_000, 1_000_000, 2_000_000];

export function cinemaCatalogCap(db: SqliteDb): number {
  const env = Number(process.env.ARCHIVE_INGEST_MAX_ROWS ?? "");
  return retentionCap(db, CINEMA_CATALOG_POLICY, Number.isFinite(env) && env > 0 ? Math.floor(env) : 0);
}
