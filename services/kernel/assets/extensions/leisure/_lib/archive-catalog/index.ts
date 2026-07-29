/**
 * Public API of the shared archive.org catalog lib.
 *
 * Consumers (cinema, music, books) typically need:
 *   - `archiveCatalogMigrations(prefix)` for their migrations array
 *   - `new ArchiveCatalog({ db, prefix })` for the service handle
 *   - `ingestNextChunk(catalog, collections, config)` from a cron tick
 *   - The types for filters/results
 */

export { archiveCatalogMigrations } from "./migrations.js";
export { ArchiveCatalog } from "./service.js";
export { ingestPass, ingestNextChunk } from "./ingester.js";
export type {
  CatalogTitle, CatalogTagRow, CatalogListFilter,
  ArchiveScrapeRow, IngestRun, IngestRunUpdate,
  IngestPassConfig, IngestPassResult,
} from "./types.js";
