/**
 * Brain indexer: pulls rows from module tables into the unified embedding
 * space, incrementally, by watermark.
 *
 * Why watermark-pull instead of event hooks: the kernel event bus only
 * emits a coarse `data.changed` (module-level, no row id), so a pure
 * event-driven indexer can't know WHICH row changed. Instead each source
 * declares a timestamp column; the indexer scans rows whose timestamp is
 * past the last watermark, embeds their text profile, upserts, and advances
 * the watermark. A `data.changed` event just triggers a cheap re-scan of
 * that source (only new/changed rows are touched).
 *
 * Every source is best-effort: a missing table or drifted column is caught
 * and skipped, so the brain works regardless of which extensions are
 * installed (graceful degradation, consistent with the rest of the kernel).
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import { log } from "../../core/logger.js";
import type { BrainService } from "./service.js";

export interface BrainSource {
  /** Item kind label in the unified space. */
  kind: string;
  /** SQLite source table. */
  table: string;
  /** Primary-key column (back-pointer target). Default `id`. */
  idCol?: string;
  /** Monotonic timestamp column used as the watermark. Default `updated_at`. */
  tsCol?: string;
  /** Soft-delete column; rows where it is non-null/non-empty are removed
   *  from the index instead of upserted. */
  softDeleteCol?: string;
  /** Columns concatenated (in order) into the embedded text profile. */
  textCols: string[];
}

/**
 * Default first-batch coverage (from the design's Fase 2): the modules
 * whose rows make up "your life". Each maps to a known core/extension table.
 * Unknown tables are skipped at run time, so listing one that isn't
 * installed is harmless.
 */
export const DEFAULT_SOURCES: BrainSource[] = [
  { kind: "task", table: "tasks", tsCol: "updated_at", softDeleteCol: "deleted_at", textCols: ["title", "description", "tags"] },
  { kind: "note", table: "notes", tsCol: "updated_at", textCols: ["title", "body", "tags"] },
  { kind: "contact", table: "contacts", tsCol: "updated_at", textCols: ["name", "company", "relationship", "notes"] },
  { kind: "comm", table: "communications", tsCol: "updated_at", textCols: ["subject", "body"] },
  { kind: "reminder", table: "reminders", tsCol: "updated_at", textCols: ["title", "body"] },
  { kind: "event", table: "calendar_events", tsCol: "updated_at", textCols: ["title", "description", "location"] },
];

/** Map a `data.changed` module name to the source table(s) it touches, so a
 *  change event re-scans only the relevant source. Unmapped modules fall
 *  back to a full (still watermark-cheap) re-scan. */
export const MODULE_TO_KINDS: Record<string, string[]> = {
  tasks: ["task"],
  notes: ["note"],
  crm: ["contact"],
  contacts: ["contact"],
  comms: ["comm"],
  communications: ["comm"],
  email: ["comm"],
  reminders: ["reminder"],
  calendar: ["event"],
  events: ["event"],
};

const BATCH = 500;

export class BrainIndexer {
  constructor(
    private readonly db: SqliteDb,
    private readonly service: BrainService,
    private readonly sources: BrainSource[] = DEFAULT_SOURCES,
  ) {}

  sourcesForKinds(kinds?: string[]): BrainSource[] {
    if (!kinds || kinds.length === 0) return this.sources;
    const set = new Set(kinds);
    return this.sources.filter((s) => set.has(s.kind));
  }

  /** Index every (or selected) source incrementally. Returns total upserts. */
  async indexAll(kinds?: string[]): Promise<{ indexed: number; removed: number; perKind: Record<string, number> }> {
    let indexed = 0;
    let removed = 0;
    const perKind: Record<string, number> = {};
    for (const source of this.sourcesForKinds(kinds)) {
      try {
        const r = await this.indexSource(source);
        indexed += r.indexed;
        removed += r.removed;
        if (r.indexed > 0) perKind[source.kind] = (perKind[source.kind] ?? 0) + r.indexed;
      } catch (e) {
        log.debug(`brain.indexSource(${source.table}) failed: ${(e as Error).message}`);
      }
    }
    return { indexed, removed, perKind };
  }

  /**
   * Scan one source from its watermark forward, in batches, until drained.
   * Embeds each batch in a single call. Advances the watermark to the max
   * timestamp seen. Soft-deleted rows are removed from the index.
   */
  async indexSource(source: BrainSource): Promise<{ indexed: number; removed: number }> {
    const idCol = source.idCol ?? "id";
    const tsCol = source.tsCol ?? "updated_at";
    if (!this.tableExists(source.table)) return { indexed: 0, removed: 0 };

    const cols = [idCol, tsCol, ...source.textCols];
    if (source.softDeleteCol) cols.push(source.softDeleteCol);
    const have = this.existingColumns(source.table);
    const selCols = cols.filter((c) => have.has(c));
    if (!selCols.includes(idCol) || !selCols.includes(tsCol)) return { indexed: 0, removed: 0 };
    const usableTextCols = source.textCols.filter((c) => have.has(c));
    if (usableTextCols.length === 0) return { indexed: 0, removed: 0 };

    let indexed = 0;
    let removed = 0;
    let watermark = this.service.getWatermark(source.table);

    // Loop batches until a partial batch (drained).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const sql =
        `SELECT ${selCols.join(", ")} FROM ${source.table} ` +
        `WHERE ${tsCol} > ? ORDER BY ${tsCol} ASC LIMIT ${BATCH}`;
      const rows = this.db.prepare(sql).all(watermark) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;

      const toEmbed: Array<{ row: Record<string, unknown>; text: string }> = [];
      for (const row of rows) {
        const id = String(row[idCol]);
        const softDeleted =
          source.softDeleteCol &&
          row[source.softDeleteCol] != null &&
          row[source.softDeleteCol] !== "";
        if (softDeleted) {
          removed += this.service.removeBySource(source.table, id);
          continue;
        }
        const text = textProfile(row, usableTextCols);
        if (text) toEmbed.push({ row, text });
      }

      if (toEmbed.length > 0) {
        const vectors = await this.service.embed(toEmbed.map((t) => t.text));
        for (let i = 0; i < toEmbed.length; i++) {
          const { row, text } = toEmbed[i];
          this.service.upsert({
            kind: source.kind,
            sourceTable: source.table,
            sourceId: String(row[idCol]),
            text,
            embedding: vectors[i],
            sourceUpdatedAt: String(row[tsCol]),
          });
          indexed++;
        }
      }

      // Advance watermark to the last row's timestamp in this batch.
      const lastTs = String(rows[rows.length - 1][tsCol]);
      if (lastTs <= watermark) break; // guard against non-advancing ts (avoid infinite loop)
      watermark = lastTs;
      this.service.setWatermark(source.table, watermark);

      if (rows.length < BATCH) break;
    }

    return { indexed, removed };
  }

  private tableExists(table: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) as { name: string } | undefined;
    return !!row;
  }

  private existingColumns(table: string): Set<string> {
    try {
      const rows = this.db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>;
      return new Set(rows.map((r) => r.name));
    } catch {
      return new Set();
    }
  }
}

/** Build the embedded profile: non-empty column values joined by ". ". */
export function textProfile(row: Record<string, unknown>, textCols: string[]): string {
  return textCols
    .map((c) => row[c])
    .filter((v) => v != null && String(v).trim() !== "")
    .map((v) => String(v).trim())
    .join(". ")
    .slice(0, 4000); // cap to keep embedding inputs bounded
}
