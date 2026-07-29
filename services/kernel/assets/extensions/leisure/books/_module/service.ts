import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { isoNow } from "../../../../../src/core/helpers.js";
import type {
  BookItem,
  BookListFilter,
  BookDetails,
  BookFile,
} from "./types.js";
import { createHash } from "node:crypto";

const SEARCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;     // 6 hours
const ARCHIVE_SEARCH = "https://archive.org/advancedsearch.php";
const ARCHIVE_METADATA = "https://archive.org/metadata";

interface ArchiveDoc {
  identifier: string;
  title?: string | string[];
  creator?: string | string[];
  date?: string;
  year?: string | number;
  description?: string | string[];
  language?: string | string[];
  subject?: string | string[];
  collection?: string | string[];
  downloads?: number;
  publicdate?: string;
}

export class BooksService {
  constructor(private db: SqliteDb) {}

  /**
   * Search archive.org's `texts` mediatype with the given filter. Cached
   * locally for 6h per (query, language, collection, year, sort, page).
   */
  async search(filter: BookListFilter): Promise<{ items: BookItem[]; total: number; cached: boolean }> {
    const key = this.cacheKey(filter);
    const cached = this.readCache(key);
    if (cached) return { ...cached, cached: true };

    const q = this.buildQuery(filter);
    const params = new URLSearchParams({
      q,
      output: "json",
      rows: String(Math.min(Math.max(filter.limit ?? 24, 1), 100)),
      page: String(Math.max(filter.page ?? 1, 1)),
      sort: this.sortClause(filter.sort),
    });
    // archive.org's `fl[]` repeated-key syntax — append manually.
    const fields = [
      "identifier", "title", "creator", "date", "year", "description",
      "language", "subject", "collection", "downloads", "publicdate",
    ];
    for (const f of fields) params.append("fl[]", f);

    const url = `${ARCHIVE_SEARCH}?${params.toString()}`;
    const r = await fetch(url, { headers: { "user-agent": "Kernl/books" } });
    if (!r.ok) throw new Error(`archive.org search returned ${r.status}`);
    const json = await r.json() as { response: { numFound: number; docs: ArchiveDoc[] } };

    const watchlist = new Set(this.listWatchlistIds());
    const items: BookItem[] = (json.response?.docs ?? []).map((d) => this.normalize(d, watchlist));
    const total = json.response?.numFound ?? items.length;

    this.writeCache(key, { items, total });
    return { items, total, cached: false };
  }

  /**
   * Fetch detailed metadata + file list for one book. Doesn't cache —
   * users only hit this on click and the metadata is small (~50 KB).
   */
  async details(identifier: string): Promise<BookDetails> {
    const r = await fetch(`${ARCHIVE_METADATA}/${encodeURIComponent(identifier)}`, {
      headers: { "user-agent": "Kernl/books" },
    });
    if (!r.ok) throw new Error(`archive.org metadata returned ${r.status}`);
    const meta = await r.json() as {
      metadata?: {
        title?: string | string[];
        creator?: string | string[];
        year?: string | number;
        date?: string;
        description?: string | string[];
        language?: string | string[];
        subject?: string | string[];
      };
      files?: Array<{
        name: string;
        format?: string;
        size?: string;
      }>;
    };

    const m = meta.metadata ?? {};
    const files: BookFile[] = (meta.files ?? [])
      .filter((f) => isReadableFormat(f.format ?? ""))
      .map((f) => ({
        name: f.name,
        format: f.format ?? "",
        size: parseInt(f.size ?? "0", 10) || 0,
        url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(f.name)}`,
      }));

    // Pick the best primary file: PDF first (most universal), then EPUB.
    const primary = files.find((f) => f.format === "Image Container PDF" || f.format === "PDF" || f.format === "Text PDF")
                 ?? files.find((f) => f.format === "EPUB")
                 ?? files[0]
                 ?? null;

    return {
      identifier,
      title: firstString(m.title) || identifier,
      creator: firstString(m.creator),
      year: parseYear(m.year ?? m.date ?? ""),
      description: firstString(m.description),
      language: firstString(m.language),
      subject: toArray(m.subject),
      files,
      primary_file: primary,
    };
  }

  // ── Watchlist ────────────────────────────────────────────────────────

  addToWatchlist(b: { identifier: string; title?: string; creator?: string; year?: number | null; cover_url?: string }): void {
    const now = isoNow();
    this.db.prepare(
      `INSERT OR REPLACE INTO books_watchlist
        (identifier, title, creator, year, cover_url, added_at, read_progress, last_opened_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT read_progress FROM books_watchlist WHERE identifier = ?), 0), NULL)`,
    ).run(
      b.identifier,
      b.title ?? "",
      b.creator ?? "",
      b.year ?? null,
      b.cover_url ?? "",
      now,
      b.identifier,
    );
  }

  removeFromWatchlist(identifier: string): void {
    this.db.prepare(`DELETE FROM books_watchlist WHERE identifier = ?`).run(identifier);
  }

  listWatchlist(): BookItem[] {
    const rows = this.db.prepare(
      `SELECT identifier, title, creator, year, cover_url, read_progress
         FROM books_watchlist ORDER BY added_at DESC`,
    ).all() as Array<{ identifier: string; title: string; creator: string; year: number | null; cover_url: string; read_progress: number }>;
    return rows.map((r) => ({
      identifier: r.identifier,
      title: r.title,
      creator: r.creator,
      year: r.year,
      date: r.year ? String(r.year) : "",
      description: "",
      language: "",
      subject: [],
      collection: [],
      downloads: 0,
      publicdate: "",
      cover_url: r.cover_url,
      read_url: `https://archive.org/details/${r.identifier}`,
      in_watchlist: true,
      read_progress: r.read_progress,
    }));
  }

  setReadProgress(identifier: string, progress: number): void {
    const p = Math.max(0, Math.min(1, progress));
    this.db.prepare(
      `UPDATE books_watchlist SET read_progress = ?, last_opened_at = ? WHERE identifier = ?`,
    ).run(p, isoNow(), identifier);
  }

  private listWatchlistIds(): string[] {
    return (this.db.prepare(`SELECT identifier FROM books_watchlist`).all() as Array<{ identifier: string }>)
      .map((r) => r.identifier);
  }

  // ── Internals ────────────────────────────────────────────────────────

  private buildQuery(f: BookListFilter): string {
    const clauses: string[] = ["mediatype:texts"];
    if (f.query?.trim()) {
      // Quote to keep multi-word phrases together; escape internal quotes.
      const safe = f.query.trim().replace(/"/g, "");
      clauses.push(`(title:(${safe}) OR creator:(${safe}) OR description:(${safe}))`);
    }
    if (f.language) clauses.push(`language:${f.language}`);
    if (f.collection) clauses.push(`collection:${f.collection}`);
    if (f.yearMin) clauses.push(`year:[${f.yearMin} TO ${f.yearMax ?? "*"}]`);
    else if (f.yearMax) clauses.push(`year:[* TO ${f.yearMax}]`);
    return clauses.join(" AND ");
  }

  private sortClause(sort?: BookListFilter["sort"]): string {
    switch (sort) {
      case "year_desc": return "year desc";
      case "year_asc":  return "year asc";
      case "date_added": return "publicdate desc";
      case "downloads":
      default:          return "downloads desc";
    }
  }

  private cacheKey(f: BookListFilter): string {
    return createHash("sha1").update(JSON.stringify({
      q: f.query ?? "", l: f.language ?? "", c: f.collection ?? "",
      yi: f.yearMin ?? 0, ya: f.yearMax ?? 0, s: f.sort ?? "downloads",
      p: f.page ?? 1, lim: f.limit ?? 24,
    })).digest("hex");
  }

  private readCache(key: string): { items: BookItem[]; total: number } | null {
    const row = this.db.prepare(
      `SELECT payload_json, cached_at FROM books_search_cache WHERE cache_key = ?`,
    ).get(key) as { payload_json: string; cached_at: string } | undefined;
    if (!row) return null;
    if (Date.now() - new Date(row.cached_at).getTime() > SEARCH_CACHE_TTL_MS) return null;
    try { return JSON.parse(row.payload_json); } catch { return null; }
  }

  private writeCache(key: string, payload: { items: BookItem[]; total: number }): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO books_search_cache (cache_key, payload_json, cached_at) VALUES (?, ?, ?)`,
    ).run(key, JSON.stringify(payload), isoNow());
  }

  private normalize(d: ArchiveDoc, watchlist: Set<string>): BookItem {
    return {
      identifier: d.identifier,
      title: firstString(d.title) || d.identifier,
      creator: firstString(d.creator),
      year: parseYear(d.year ?? d.date ?? ""),
      date: typeof d.date === "string" ? d.date : "",
      description: firstString(d.description).slice(0, 800),
      language: firstString(d.language),
      subject: toArray(d.subject).slice(0, 12),
      collection: toArray(d.collection),
      downloads: typeof d.downloads === "number" ? d.downloads : 0,
      publicdate: d.publicdate ?? "",
      cover_url: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
      read_url: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
      in_watchlist: watchlist.has(d.identifier),
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────
function firstString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}
function toArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return v.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  return [];
}
function parseYear(v: string | number): number | null {
  if (typeof v === "number") return v >= 1000 && v <= 2100 ? v : null;
  if (typeof v !== "string") return null;
  const m = v.match(/(\d{4})/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1000 && n <= 2100 ? n : null;
}
function isReadableFormat(fmt: string): boolean {
  // We surface only formats a browser can render natively or via a
  // light viewer. Drop derived/junk formats.
  return /^(Image Container PDF|Text PDF|PDF|EPUB|Plain Text|HTML)$/i.test(fmt);
}
