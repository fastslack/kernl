/**
 * Generic archive.org catalog service. One instance per consumer
 * (cinema, music, books) — each binds its own table prefix and reads
 * from its own *_titles / *_tags / *_titles_fts tables.
 *
 * Owns:
 *   - upserts from scrape rows (preserves existing user-state by simply
 *     not touching it — user-state lives in a separate table per
 *     consumer, joined by `identifier`)
 *   - tag rebuild (aggregate `subject_json` → *_tags)
 *   - top-tags read with optional prefix filter (autocomplete)
 *   - FTS5 search with bm25 ranking
 *   - ingest run bookkeeping (start, update, latest)
 *   - light catalog stats (countAll)
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { isoNow, newId } from "../../../../../src/core/helpers.js";
import type {
  ArchiveScrapeRow,
  CatalogListFilter,
  CatalogTagRow,
  CatalogTitle,
  IngestRun,
  IngestRunUpdate,
} from "./types.js";

interface RawRunRow {
  id: string;
  collection: string;
  cursor: string;
  fetched: number;
  upserted: number;
  status: IngestRun["status"];
  error: string;
  started_at: string;
  finished_at: string | null;
}

interface RawTitleRow {
  identifier: string;
  title: string;
  date: string;
  year: number;
  creator: string;
  description: string;
  subject_json: string;
  collection_json: string;
  language: string;
  licenseurl: string;
  downloads: number;
  week_downloads: number;
  avg_rating: number;
  num_reviews: number;
  format_json: string;
  addeddate: string;
  publicdate: string;
  ingested_at: string;
  last_seen_at: string;
}

export interface ArchiveCatalogOpts {
  db: SqliteDb;
  /** Table prefix — `music`, `cinema`, `books`. Whitelisted by migrations gen. */
  prefix: string;
}

export class ArchiveCatalog {
  private readonly db: SqliteDb;
  private readonly p: string;
  /** Pre-computed table names. We never interpolate `prefix` outside
   *  this constructor, eliminating the surface for SQL identifier
   *  injection at every call site. */
  private readonly T: {
    titles: string; fts: string; tags: string; runs: string;
  };

  constructor(opts: ArchiveCatalogOpts) {
    if (!/^[a-z][a-z0-9_]*$/.test(opts.prefix)) {
      throw new Error(`ArchiveCatalog: invalid prefix "${opts.prefix}"`);
    }
    this.db = opts.db;
    this.p = opts.prefix;
    this.T = {
      titles: `${this.p}_titles`,
      fts:    `${this.p}_titles_fts`,
      tags:   `${this.p}_tags`,
      runs:   `${this.p}_ingest_runs`,
    };
  }

  // ── Catalog reads ─────────────────────────────────────────────────

  countAll(filter: CatalogListFilter = {}): number {
    const { where, params } = this.buildWhere(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${this.T.titles} WHERE ${where.join(" AND ")}`)
      .get(...params) as { n: number };
    return row.n;
  }

  getOne(identifier: string): CatalogTitle | null {
    const r = this.db
      .prepare(`SELECT * FROM ${this.T.titles} WHERE identifier = ? AND deleted_at IS NULL`)
      .get(identifier) as RawTitleRow | undefined;
    return r ? this.hydrate(r) : null;
  }

  list(filter: CatalogListFilter = {}): CatalogTitle[] {
    const { where, params } = this.buildWhere(filter);
    const order = this.sortClause(filter.sort);
    const limit = clamp(filter.limit ?? 60, 1, 500);
    const offset = clamp(filter.offset ?? 0, 0, 1_000_000);
    const rows = this.db
      .prepare(`
        SELECT * FROM ${this.T.titles}
         WHERE ${where.join(" AND ")}
         ORDER BY ${order}
         LIMIT ? OFFSET ?
      `)
      .all(...params, limit, offset) as RawTitleRow[];
    return rows.map((r) => this.hydrate(r));
  }

  // ── Upsert ────────────────────────────────────────────────────────

  upsertFromScrape(row: ArchiveScrapeRow): { inserted: boolean; updated: boolean } {
    const identifier = row.identifier?.trim();
    if (!identifier) return { inserted: false, updated: false };

    const now = isoNow();
    const title = asString(row.title) || identifier;
    const date = asString(row.date);
    const year = parseYear(date);
    const description = asString(row.description);
    const subjectJson = JSON.stringify(asArray(row.subject).map(String));
    const collectionJson = JSON.stringify(asArray(row.collection).map(String));
    const formatJson = JSON.stringify(asArray(row.format).map(String));

    const existing = this.db
      .prepare(`SELECT description FROM ${this.T.titles} WHERE identifier = ?`)
      .get(identifier) as { description: string } | undefined;

    if (existing) {
      const descChanged = existing.description !== description;
      this.db
        .prepare(`
          UPDATE ${this.T.titles} SET
            title = ?,
            date = ?,
            year = ?,
            creator = ?,
            description = ?,
            subject_json = ?,
            collection_json = ?,
            language = ?,
            licenseurl = ?,
            downloads = ?,
            week_downloads = ?,
            avg_rating = ?,
            num_reviews = ?,
            format_json = ?,
            addeddate = ?,
            publicdate = ?,
            embedded_at = CASE WHEN ? THEN NULL ELSE embedded_at END,
            last_seen_at = ?,
            deleted_at = NULL
          WHERE identifier = ?
        `)
        .run(
          title, date, year, asString(row.creator),
          description, subjectJson, collectionJson,
          asString(row.language), asString(row.licenseurl),
          row.downloads ?? 0, row.week ?? 0,
          row.avg_rating ?? 0, row.num_reviews ?? 0,
          formatJson, row.addeddate ?? "", row.publicdate ?? "",
          descChanged ? 1 : 0, now, identifier,
        );
      return { inserted: false, updated: true };
    }

    this.db
      .prepare(`
        INSERT INTO ${this.T.titles} (
          identifier, title, date, year, creator, description,
          subject_json, collection_json, language, licenseurl,
          downloads, week_downloads, avg_rating, num_reviews,
          format_json, addeddate, publicdate,
          embedded_at, embedded_model, embedded_dim,
          ingested_at, last_seen_at, deleted_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          NULL, '', 0,
          ?, ?, NULL
        )
      `)
      .run(
        identifier, title, date, year, asString(row.creator), description,
        subjectJson, collectionJson, asString(row.language), asString(row.licenseurl),
        row.downloads ?? 0, row.week ?? 0, row.avg_rating ?? 0, row.num_reviews ?? 0,
        formatJson, row.addeddate ?? "", row.publicdate ?? "",
        now, now,
      );
    return { inserted: true, updated: false };
  }

  // ── Embedding bookkeeping ─────────────────────────────────────────

  markEmbedded(identifier: string, model: string, dim: number): void {
    this.db
      .prepare(`
        UPDATE ${this.T.titles}
           SET embedded_at = ?, embedded_model = ?, embedded_dim = ?
         WHERE identifier = ?
      `)
      .run(isoNow(), model, dim, identifier);
  }

  pendingEmbeddings(limit = 100): CatalogTitle[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM ${this.T.titles}
         WHERE deleted_at IS NULL AND embedded_at IS NULL
         ORDER BY downloads DESC
         LIMIT ?
      `)
      .all(clamp(limit, 1, 1000)) as RawTitleRow[];
    return rows.map((r) => this.hydrate(r));
  }

  // ── Ingest runs ───────────────────────────────────────────────────

  startRun(collection: string, cursor = ""): IngestRun {
    const id = newId();
    const now = isoNow();
    this.db
      .prepare(`
        INSERT INTO ${this.T.runs}
          (id, collection, cursor, fetched, upserted, status, error, started_at, finished_at)
        VALUES (?, ?, ?, 0, 0, 'running', '', ?, NULL)
      `)
      .run(id, collection, cursor, now);
    return {
      id, collection, cursor,
      fetched: 0, upserted: 0,
      status: "running", error: "",
      started_at: now, finished_at: null,
    };
  }

  updateRun(id: string, patch: IngestRunUpdate): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.cursor !== undefined)      { sets.push("cursor = ?");                params.push(patch.cursor); }
    if (patch.fetched !== undefined)     { sets.push("fetched = fetched + ?");      params.push(patch.fetched); }
    if (patch.upserted !== undefined)    { sets.push("upserted = upserted + ?");    params.push(patch.upserted); }
    if (patch.status !== undefined)      { sets.push("status = ?");                 params.push(patch.status); }
    if (patch.error !== undefined)       { sets.push("error = ?");                  params.push(patch.error); }
    if (patch.finished_at !== undefined) { sets.push("finished_at = ?");            params.push(patch.finished_at); }
    if (sets.length === 0) return;
    params.push(id);
    this.db
      .prepare(`UPDATE ${this.T.runs} SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
  }

  latestRun(collection: string): IngestRun | null {
    const r = this.db
      .prepare(`
        SELECT * FROM ${this.T.runs}
         WHERE collection = ?
         ORDER BY started_at DESC
         LIMIT 1
      `)
      .get(collection) as RawRunRow | undefined;
    return r ? { ...r } : null;
  }

  recentRuns(limit = 20): IngestRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${this.T.runs} ORDER BY started_at DESC LIMIT ?`)
      .all(clamp(limit, 1, 200)) as RawRunRow[];
    return rows.map((r) => ({ ...r }));
  }

  // ── Tags ──────────────────────────────────────────────────────────

  /**
   * Top N tags by count, optionally filtered by name prefix for
   * autocomplete. Reads from the precomputed *_tags table — call
   * `rebuildTags()` after a non-trivial ingest to refresh.
   */
  topTags(limit = 60, search?: string): CatalogTagRow[] {
    const params: unknown[] = [];
    let sql = `SELECT tag_norm, tag_display, count, rank FROM ${this.T.tags}`;
    if (search && search.trim()) {
      sql += ` WHERE tag_norm LIKE ?`;
      params.push(`%${search.trim().toLowerCase()}%`);
    }
    sql += ` ORDER BY rank LIMIT ?`;
    params.push(clamp(limit, 1, 500));
    return this.db.prepare(sql).all(...params) as CatalogTagRow[];
  }

  /**
   * Rebuild the *_tags table from *_titles.subject_json. Cheap (~1-2s on
   * 200k rows), idempotent. Drop + replace inside a transaction.
   *
   * Filtering matches cinema's heuristic: 2+ chars, not pure punct/digits,
   * dedupe case-insensitively, pick the most-common original casing for
   * display.
   */
  rebuildTags(): { tags: number; titlesScanned: number; durationMs: number } {
    const t0 = Date.now();
    interface Bucket { count: number; displays: Map<string, number>; }
    const buckets = new Map<string, Bucket>();
    let titlesScanned = 0;

    const rows = this.db
      .prepare(`SELECT subject_json FROM ${this.T.titles} WHERE deleted_at IS NULL AND subject_json <> '[]'`)
      .all() as Array<{ subject_json: string }>;

    for (const r of rows) {
      titlesScanned++;
      let parsed: unknown;
      try { parsed = JSON.parse(r.subject_json); } catch { continue; }
      if (!Array.isArray(parsed)) continue;
      for (const raw of parsed) {
        if (typeof raw !== "string") continue;
        const trimmed = raw.trim();
        if (trimmed.length < 2) continue;
        if (/^[\d\s.\-_]+$/.test(trimmed)) continue;
        const norm = trimmed.toLowerCase();
        if (/^[a-z]{3}$/.test(norm)) continue;     // language codes
        if (norm === "audio" || norm === "music") continue;
        let b = buckets.get(norm);
        if (!b) {
          b = { count: 0, displays: new Map() };
          buckets.set(norm, b);
        }
        b.count++;
        b.displays.set(trimmed, (b.displays.get(trimmed) ?? 0) + 1);
      }
    }

    const items = [...buckets.entries()].map(([norm, b]) => {
      let best = norm; let bestN = -1;
      for (const [d, n] of b.displays) {
        if (n > bestN) { best = d; bestN = n; }
      }
      return { norm, display: best, count: b.count };
    });
    items.sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));

    const now = isoNow();
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM ${this.T.tags}`).run();
      const stmt = this.db.prepare(`
        INSERT INTO ${this.T.tags} (tag_norm, tag_display, count, rank, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      items.forEach((it, i) => {
        stmt.run(it.norm, it.display, it.count, i + 1, now);
      });
    });
    tx();
    return { tags: items.length, titlesScanned, durationMs: Date.now() - t0 };
  }

  // ── Internals ─────────────────────────────────────────────────────

  private buildWhere(f: CatalogListFilter): { where: string[]; params: unknown[] } {
    const where: string[] = ["deleted_at IS NULL"];
    const params: unknown[] = [];
    if (f.collection) {
      where.push(`json_each_contains(collection_json, ?)`);   // overridden below
      params.push(f.collection);
      // SQLite doesn't have json_each_contains, but EXISTS over json_each
      // works. Replace the placeholder with the real construct here.
      where[where.length - 1] = `EXISTS (SELECT 1 FROM json_each(collection_json) WHERE value = ?)`;
    }
    if (f.tags && f.tags.length > 0) {
      const join = (f.tagsMatch ?? "all") === "any" ? "OR" : "AND";
      const exprs = f.tags.map(() =>
        `EXISTS (SELECT 1 FROM json_each(subject_json) WHERE LOWER(value) = ?)`,
      );
      where.push(`(${exprs.join(` ${join} `)})`);
      for (const t of f.tags) params.push(t.toLowerCase());
    }
    if (f.language) { where.push("language = ?"); params.push(f.language); }
    if (f.yearMin)  { where.push("year >= ?");    params.push(f.yearMin); }
    if (f.yearMax)  { where.push("year <= ?");    params.push(f.yearMax); }
    return { where, params };
  }

  private sortClause(s?: CatalogListFilter["sort"]): string {
    switch (s) {
      case "year_desc":  return "year DESC, downloads DESC";
      case "year_asc":   return "year ASC, downloads DESC";
      case "added_desc": return "addeddate DESC";
      case "rating":     return "avg_rating DESC, downloads DESC";
      case "downloads":
      default:           return "downloads DESC";
    }
  }

  private hydrate(r: RawTitleRow): CatalogTitle {
    return {
      identifier: r.identifier,
      title: r.title,
      date: r.date,
      year: r.year,
      creator: r.creator,
      description: r.description,
      subject: safeArray(r.subject_json),
      collection: safeArray(r.collection_json),
      language: r.language,
      licenseurl: r.licenseurl,
      downloads: r.downloads,
      week_downloads: r.week_downloads,
      avg_rating: r.avg_rating,
      num_reviews: r.num_reviews,
      format: safeArray(r.format_json),
      addeddate: r.addeddate,
      publicdate: r.publicdate,
      ingested_at: r.ingested_at,
      last_seen_at: r.last_seen_at,
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function asString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

function asArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.length > 0) return [v];
  return [];
}

function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

function parseYear(date: string): number {
  if (!date) return 0;
  const m = date.match(/(\d{4})/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n >= 1000 && n <= 2100 ? n : 0;
}
