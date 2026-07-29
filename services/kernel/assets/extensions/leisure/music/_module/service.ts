/**
 * MusicService — archive.org audio search + local user library.
 *
 * Mirrors the Books module's shape (search → cache → details → library +
 * progress) but adds:
 *   - format_kind heuristic so we can split vinyls / netlabels / live in UI
 *   - track listing with stream URLs (tracks come back ready to feed
 *     `<audio src>`, no further URL building in the UI)
 *   - play history table — unlike books "read progress" we want a log so the
 *     same album surfaces in "Recently played" without us guessing.
 *
 * Caching strategy is deliberately the same as Books (6h TTL, sha1 of the
 * filter object) — single source of truth for cache invariants, cheap to
 * grep across the two modules.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { isoNow } from "../../../../../src/core/helpers.js";
import type {
  MusicItem,
  MusicListFilter,
  MusicDetails,
  MusicTrack,
  MusicFormatKind,
  MusicLibraryEntry,
  MusicTag,
} from "./types.js";
import { ArchiveCatalog } from "../../_lib/archive-catalog/index.js";
import { createHash } from "node:crypto";

const SEARCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TAGS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_SEARCH = "https://archive.org/advancedsearch.php";
const ARCHIVE_METADATA = "https://archive.org/metadata";

/**
 * archive.org's audio mediatype is a giant tent — Radio Programs (~3.7M)
 * and podcasts (~1.2M) crowd out music in unfiltered tag aggregations.
 * For the "All" kind we restrict the agg query to real music collections so
 * the chip row surfaces genre/era tags (jazz, vaporwave, ambient, …) instead
 * of "Council of European National Top Level Domain Registries members".
 */
const MUSIC_COLLECTIONS_FILTER = `(collection:78rpm OR collection:georgeblood OR collection:netlabels OR collection:audio_music OR collection:opensource_audio OR collection:lps OR collection:etree)`;

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

/** Stream-friendly audio formats. Anything else is metadata noise. */
const STREAMABLE_FORMATS = /^(VBR MP3|MP3|128Kbps MP3|64Kbps MP3|24bit FLAC|Flac|FLAC|Ogg Vorbis|Ogg|WAV|AAC)$/i;

export class MusicService {
  /**
   * Local archive.org catalog for `mediatype:audio`. Owns the ingester
   * + tag aggregation. Tags scale with however much we've ingested
   * locally — first boot we have nothing and topTags returns []; the
   * background ingester populates the catalog over time and tags follow.
   */
  readonly catalog: ArchiveCatalog;

  constructor(private db: SqliteDb) {
    this.catalog = new ArchiveCatalog({ db, prefix: "music" });
  }

  // ── Search ──────────────────────────────────────────────────────────

  async search(filter: MusicListFilter): Promise<{ items: MusicItem[]; total: number; cached: boolean }> {
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
    const fields = [
      "identifier", "title", "creator", "date", "year", "description",
      "language", "subject", "collection", "downloads", "publicdate",
    ];
    for (const f of fields) params.append("fl[]", f);

    const url = `${ARCHIVE_SEARCH}?${params.toString()}`;
    const r = await fetch(url, { headers: { "user-agent": "Kernl/music" } });
    if (!r.ok) throw new Error(`archive.org search returned ${r.status}`);
    const json = await r.json() as { response: { numFound: number; docs: ArchiveDoc[] } };

    const library = new Set(this.listLibraryIds());
    const items: MusicItem[] = (json.response?.docs ?? []).map((d) => this.normalize(d, library));
    const total = json.response?.numFound ?? items.length;

    this.writeCache(key, { items, total });
    return { items, total, cached: false };
  }

  // ── Details (track list with stream URLs) ───────────────────────────

  async details(identifier: string): Promise<MusicDetails> {
    const r = await fetch(`${ARCHIVE_METADATA}/${encodeURIComponent(identifier)}`, {
      headers: { "user-agent": "Kernl/music" },
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
        collection?: string | string[];
      };
      files?: Array<{
        name: string;
        title?: string;
        track?: string | number;
        format?: string;
        size?: string;
        length?: string;
      }>;
    };

    const m = meta.metadata ?? {};
    const collection = toArray(m.collection);
    const tracks: MusicTrack[] = (meta.files ?? [])
      .filter((f) => STREAMABLE_FORMATS.test(f.format ?? ""))
      .map((f) => ({
        name: f.name,
        title: typeof f.title === "string" && f.title.trim()
          ? f.title.trim()
          : prettyTrackName(f.name),
        track: parseTrack(f.track),
        format: f.format ?? "",
        size: parseInt(f.size ?? "0", 10) || 0,
        length_seconds: parseLength(f.length ?? ""),
        url: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(f.name)}`,
      }))
      .sort(byTrackThenName);

    return {
      identifier,
      title: firstString(m.title) || identifier,
      creator: firstString(m.creator),
      year: parseYear(m.year ?? m.date ?? ""),
      description: firstString(m.description),
      language: firstString(m.language),
      subject: toArray(m.subject),
      collection,
      format_kind: deriveKind(collection),
      cover_url: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
      tracks: dedupeBestFormat(tracks),
    };
  }

  // ── Library ─────────────────────────────────────────────────────────

  addToLibrary(b: {
    identifier: string;
    title?: string;
    creator?: string;
    year?: number | null;
    cover_url?: string;
    format_kind?: MusicFormatKind;
    collection?: string;
  }): void {
    const now = isoNow();
    this.db.prepare(
      `INSERT OR REPLACE INTO music_library
        (identifier, title, creator, year, cover_url, format_kind, collection,
         added_at, play_count, last_played_at, last_position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?,
         COALESCE((SELECT play_count    FROM music_library WHERE identifier = ?), 0),
         (SELECT last_played_at FROM music_library WHERE identifier = ?),
         COALESCE((SELECT last_position FROM music_library WHERE identifier = ?), 0))`,
    ).run(
      b.identifier,
      b.title ?? "",
      b.creator ?? "",
      b.year ?? null,
      b.cover_url ?? "",
      b.format_kind ?? "audio",
      b.collection ?? "",
      now,
      b.identifier, b.identifier, b.identifier,
    );
  }

  removeFromLibrary(identifier: string): void {
    this.db.prepare(`DELETE FROM music_library WHERE identifier = ?`).run(identifier);
  }

  listLibrary(filter?: { kind?: MusicFormatKind | "any" }): MusicLibraryEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.kind && filter.kind !== "any") {
      where.push(`format_kind = ?`);
      params.push(filter.kind);
    }
    const sql = `SELECT identifier, title, creator, year, cover_url, format_kind, collection,
                        added_at, play_count, last_played_at, last_position
                   FROM music_library
                  ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                  ORDER BY added_at DESC`;
    return this.db.prepare(sql).all(...params) as MusicLibraryEntry[];
  }

  recordPlay(args: { identifier: string; track_name?: string; seconds?: number; position?: number }): void {
    const now = isoNow();
    this.db.prepare(
      `INSERT INTO music_play_history (identifier, track_name, played_at, seconds)
       VALUES (?, ?, ?, ?)`,
    ).run(args.identifier, args.track_name ?? "", now, Math.round(args.seconds ?? 0));
    // Bump library counters if the album lives in the user's library; the
    // INSERT OR IGNORE keeps drive-by plays (not in library) silently logged
    // in history without polluting the library row count.
    const updated = this.db.prepare(
      `UPDATE music_library
          SET play_count = play_count + 1,
              last_played_at = ?,
              last_position = ?
        WHERE identifier = ?`,
    ).run(now, args.position ?? 0, args.identifier);
    void updated;
  }

  recentPlays(limit = 24): MusicLibraryEntry[] {
    const rows = this.db.prepare(
      `SELECT m.identifier, m.title, m.creator, m.year, m.cover_url, m.format_kind, m.collection,
              m.added_at, m.play_count, m.last_played_at, m.last_position
         FROM music_library m
        WHERE m.last_played_at IS NOT NULL
        ORDER BY m.last_played_at DESC
        LIMIT ?`,
    ).all(limit) as MusicLibraryEntry[];
    return rows;
  }

  private listLibraryIds(): string[] {
    return (this.db.prepare(`SELECT identifier FROM music_library`).all() as Array<{ identifier: string }>)
      .map((r) => r.identifier);
  }

  // ── Internals ───────────────────────────────────────────────────────

  private buildQuery(f: MusicListFilter): string {
    // ── Solr-injection hardening ──────────────────────────────────
    // Every value below ultimately gets concatenated into an unquoted Solr
    // expression. We sanitize at this boundary instead of trusting upstream
    // because /api/music/search forwards URL params straight in. Strategy:
    //   * `phrase` clauses (titles, descriptions, free-text tags): wrap in
    //     "double quotes" and strip any embedded quotes / backslashes so
    //     Solr can't escape its own phrase context.
    //   * structured slugs (collection, language, kind): match a strict
    //     identifier regex; reject anything else by silently dropping the
    //     clause. Better to over-fetch than to ship an injectable URL.
    //   * year ranges: integer-coerce.
    const clauses: string[] = ["mediatype:audio"];
    const free = sanitizePhrase(f.query ?? "");
    if (free) {
      // Phrase-search across the four most relevant fields. Quoting protects
      // against `q=) OR mediatype:texts` style breakouts.
      clauses.push(
        `(title:"${free}" OR creator:"${free}" OR description:"${free}" OR subject:"${free}")`,
      );
    }
    const kindCollections = collectionsForKind(f.kind);
    if (kindCollections.length > 0) {
      const c = kindCollections.length === 1
        ? `collection:${kindCollections[0]}`
        : `(${kindCollections.map((x) => `collection:${x}`).join(" OR ")})`;
      clauses.push(c);
    }
    const col = sanitizeSlug(f.collection);
    if (col) clauses.push(`collection:${col}`);
    const lang = sanitizeSlug(f.language);
    if (lang) clauses.push(`language:${lang}`);
    // Creator filter — quoted phrase so multi-word artists like
    // "Charly García" or "Atahualpa Yupanqui" don't get OR-split into
    // partial-token matches.
    const creator = sanitizePhrase(f.creator);
    if (creator) clauses.push(`creator:"${creator}"`);
    const ymin = sanitizeYear(f.yearMin);
    const ymax = sanitizeYear(f.yearMax);
    if (ymin != null) clauses.push(`year:[${ymin} TO ${ymax ?? "*"}]`);
    else if (ymax != null) clauses.push(`year:[* TO ${ymax}]`);
    if (f.tags && f.tags.length > 0) {
      const subj = f.tags
        .map((t) => sanitizePhrase(t))
        .filter((t) => t.length > 0)
        .map((t) => `subject:"${t}"`);
      if (subj.length > 0) {
        const join = (f.tagsMatch ?? "all") === "any" ? " OR " : " AND ";
        clauses.push(subj.length === 1 ? subj[0] : `(${subj.join(join)})`);
      }
    }
    return clauses.join(" AND ");
  }

  // ── Tag catalog ────────────────────────────────────────────────────
  /**
   * Top `subject` tags from the LOCAL music catalog — a SQLite mirror
   * of the archive.org rows we've ingested so far. Same architecture
   * cinema uses (148k local titles → 10k+ tag rows).
   *
   * On first boot the catalog is empty (the ingester needs a few minutes
   * to populate it). To avoid an empty chip row, we fall back to a
   * one-shot archive.org `user_aggs=subject` aggregation cached 24h —
   * gives 25 tags as a starter set until the local catalog catches up.
   *
   * Once the local catalog has >5k titles the chip row jumps to
   * thousands of unique tags and the fallback stops being used.
   */
  async topTagsLive(args: {
    kind?: MusicFormatKind | "any";
    q?: string;
    limit?: number;
  } = {}): Promise<MusicTag[]> {
    const kind = args.kind ?? "any";
    const limit = Math.max(1, Math.min(args.limit ?? 60, 500));
    const q = args.q?.trim();

    // ── Autocomplete path: discover long-tail tags ─────────────────
    // When the user types a query, our local catalog often misses it
    // (it's only the slice we've ingested so far) and the global
    // user_aggs only returns top-25 tags so long-tail (e.g. "Rock
    // Argentina" — 28 items) never makes the cut.
    //
    // To give the user the experience they expect from a tag search,
    // we fan out three lookups in parallel:
    //   1. Local DB substring match — fast, includes counts from
    //      whatever we've ingested locally.
    //   2. Archive.org *exact* subject verification — confirms the
    //      typed phrase exists as a subject anywhere in the corpus
    //      and returns its real item count. This is what catches
    //      "Rock Argentina" and other long-tail tags by name.
    //   3. Archive.org *discovery* aggregation — `subject:<q>` agg
    //      surfaces sibling tags ("Rock and Roll Hall of Fame", etc.)
    //      so the user can also discover related tags they didn't
    //      know existed.
    if (q && q.length >= 2) {
      const local = this.catalog.topTags(limit, q);
      const [exactCount, discovery] = await Promise.all([
        this.archiveExactSubjectCount(q, kind),
        this.archiveDiscoverySubjectTags(q, kind),
      ]);
      return mergeTagSources({ local, exactQuery: q, exactCount, discovery, limit });
    }

    // ── Default path: local catalog top tags ───────────────────────
    const localCount = this.catalog.countAll();
    if (localCount >= 200) {
      const collections = collectionsForKind(kind);
      let rows = this.catalog.topTags(limit * 2);
      if (collections.length > 0) {
        rows = this.filterTagsByCollection(rows, collections, limit);
      }
      return rows.slice(0, limit).map((t, i) => ({ ...t, rank: i + 1 }));
    }

    // Fallback: archive.org one-shot aggregation while local catalog
    // is small (first boot, before the ingester catches up).
    const cacheKey = createHash("sha1").update(`tags:fallback:${kind}`).digest("hex");
    let tags = this.readTagsCache(cacheKey);
    if (!tags) {
      tags = await this.fetchTagsFromArchive(kind);
      if (tags.length > 0) this.writeTagsCache(cacheKey, tags);
    }
    return tags.slice(0, limit).map((t, i) => ({ ...t, rank: i + 1 }));
  }

  /**
   * Verify a phrase exists as a subject in archive.org (exact match).
   * Returns the item count so the chip can show it as user-relevant.
   * 1h cache so rapid keystrokes don't hammer archive.org.
   */
  private async archiveExactSubjectCount(
    rawQ: string,
    kind: MusicFormatKind | "any",
  ): Promise<number> {
    const q = sanitizePhrase(rawQ);
    if (!q) return 0;
    const cacheKey = createHash("sha1").update(`exactsubj:${kind}:${q.toLowerCase()}`).digest("hex");
    const cached = this.readTagsCache(cacheKey);
    if (cached) return Number(cached[0]?.count ?? 0);

    const collections = collectionsForKind(kind);
    const collFilter = collections.length > 0
      ? ` AND (${collections.map((c) => `collection:${c}`).join(" OR ")})`
      : "";
    const url = new URL(ARCHIVE_SEARCH);
    url.searchParams.set("q", `mediatype:audio AND subject:"${q}"${collFilter}`);
    url.searchParams.set("output", "json");
    url.searchParams.set("rows", "0");
    url.searchParams.append("fl[]", "identifier");

    try {
      const r = await fetch(url.href, { headers: { "user-agent": "Kernl/music" } });
      if (!r.ok) return 0;
      const j = (await r.json()) as { response?: { numFound?: number } };
      const n = Number(j.response?.numFound ?? 0);
      // Cache the result as a single-item tag list so the existing cache
      // table works (we only need the count payload).
      this.writeTagsCache(cacheKey, [{ tag_norm: q.toLowerCase(), tag_display: q, count: n, rank: 1 }]);
      return n;
    } catch {
      return 0;
    }
  }

  /**
   * Discovery agg: items whose subject matches `q`, then aggregate
   * their other subjects. Surfaces siblings the user might not know
   * about. Filtered to buckets that actually contain `q` so the chip
   * row stays relevant. 1h cache.
   */
  private async archiveDiscoverySubjectTags(
    rawQ: string,
    kind: MusicFormatKind | "any",
  ): Promise<MusicTag[]> {
    const q = sanitizePhrase(rawQ);
    if (!q) return [];
    const cacheKey = createHash("sha1").update(`discsubj:${kind}:${q.toLowerCase()}`).digest("hex");
    const cached = this.readTagsCache(cacheKey);
    if (cached) return cached;

    const collections = collectionsForKind(kind);
    const collFilter = collections.length > 0
      ? ` AND (${collections.map((c) => `collection:${c}`).join(" OR ")})`
      : "";
    const url = new URL(ARCHIVE_SEARCH);
    // Quote-or-not: if the query is a single word, leave it bare so
    // Solr can still tokenize subject matches; if multi-word, quote so
    // it's treated as a phrase ("rock argentina" not rock OR argentina).
    const subjClause = q.includes(" ") ? `subject:"${q}"` : `subject:${q}`;
    url.searchParams.set("q", `mediatype:audio AND ${subjClause}${collFilter}`);
    url.searchParams.set("output", "json");
    url.searchParams.set("rows", "0");
    url.searchParams.set("user_aggs", "subject");

    let buckets: Array<{ key: string; doc_count: number }> = [];
    try {
      const r = await fetch(url.href, { headers: { "user-agent": "Kernl/music" } });
      if (!r.ok) return [];
      const j = (await r.json()) as ArchiveAggResponse;
      const aggs = j.response?.aggregations ?? {};
      const aggKey = Object.keys(aggs)[0];
      buckets = aggKey ? aggs[aggKey].buckets ?? [] : [];
    } catch {
      return [];
    }

    const needle = q.toLowerCase();
    // Keep only buckets whose tag actually contains the user's query —
    // otherwise we'd return "Radio Program" when they typed "rock".
    const filtered = buckets
      .filter((b) => b.key && !isNoiseTag(b.key) && b.key.toLowerCase().includes(needle));

    // Dedupe by lowercase, prefer Title Case display.
    const merged = new Map<string, { display: string; count: number }>();
    for (const b of filtered) {
      const norm = b.key.toLowerCase();
      const cur = merged.get(norm);
      if (cur) {
        cur.count += b.doc_count;
        if (preferDisplay(b.key, cur.display)) cur.display = b.key;
      } else {
        merged.set(norm, { display: b.key, count: b.doc_count });
      }
    }
    const tags = Array.from(merged.entries())
      .map(([norm, v]) => ({ tag_norm: norm, tag_display: v.display, count: v.count, rank: 0 }))
      .sort((a, b) => b.count - a.count);

    this.writeTagsCache(cacheKey, tags);
    return tags;
  }

  /**
   * Narrow a tag list to tags actually used by titles in the given
   * collections. Cheap implementation: scan the per-tag count via a
   * single COUNT(*) per tag. For a chip row of ~60 tags that's 60 quick
   * queries — sub-100ms with the indexes from migration 1.
   */
  private filterTagsByCollection(
    candidates: MusicTag[],
    collections: string[],
    keep: number,
  ): MusicTag[] {
    if (collections.length === 0) return candidates;
    const collClause = collections.map(() => "?").join(",");
    const stmt = this.db.prepare(`
      SELECT COUNT(*) AS n FROM music_titles t
       WHERE t.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM json_each(t.subject_json) WHERE LOWER(value) = ?)
         AND EXISTS (SELECT 1 FROM json_each(t.collection_json) WHERE value IN (${collClause}))
    `);
    const out: MusicTag[] = [];
    for (const t of candidates) {
      if (out.length >= keep * 2) break;
      const r = stmt.get(t.tag_norm, ...collections) as { n: number };
      if (r.n > 0) out.push({ ...t, count: r.n });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }

  private async fetchTagsFromArchive(kind: MusicFormatKind | "any"): Promise<MusicTag[]> {
    const collections = collectionsForKind(kind);
    const collectionFilter = collections.length > 0
      ? `(${collections.map((c) => `collection:${c}`).join(" OR ")})`
      : MUSIC_COLLECTIONS_FILTER;
    const q = `mediatype:audio AND ${collectionFilter}`;

    const url = new URL(ARCHIVE_SEARCH);
    url.searchParams.set("q", q);
    url.searchParams.set("output", "json");
    url.searchParams.set("rows", "0");
    url.searchParams.set("user_aggs", "subject");

    let json: ArchiveAggResponse;
    try {
      const r = await fetch(url.href, { headers: { "user-agent": "Kernl/music" } });
      if (!r.ok) return [];
      json = (await r.json()) as ArchiveAggResponse;
    } catch {
      return [];
    }

    const aggs = json.response?.aggregations ?? {};
    const aggKey = Object.keys(aggs)[0];
    const buckets = aggKey ? aggs[aggKey].buckets ?? [] : [];

    const merged = new Map<string, { display: string; count: number }>();
    for (const b of buckets) {
      if (!b.key || isNoiseTag(b.key)) continue;
      const norm = b.key.toLowerCase();
      const cur = merged.get(norm);
      if (cur) {
        cur.count += b.doc_count;
        if (preferDisplay(b.key, cur.display)) cur.display = b.key;
      } else {
        merged.set(norm, { display: b.key, count: b.doc_count });
      }
    }
    return Array.from(merged.entries())
      .map(([norm, v]) => ({ tag_norm: norm, tag_display: v.display, count: v.count, rank: 0 }))
      .sort((a, b) => b.count - a.count);
  }

  private readTagsCache(key: string): MusicTag[] | null {
    const row = this.db.prepare(
      `SELECT payload_json, cached_at FROM music_search_cache WHERE cache_key = ?`,
    ).get(key) as { payload_json: string; cached_at: string } | undefined;
    if (!row) return null;
    if (Date.now() - new Date(row.cached_at).getTime() > TAGS_CACHE_TTL_MS) return null;
    try { return JSON.parse(row.payload_json) as MusicTag[]; } catch { return null; }
  }
  private writeTagsCache(key: string, tags: MusicTag[]): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO music_search_cache (cache_key, payload_json, cached_at) VALUES (?, ?, ?)`,
    ).run(key, JSON.stringify(tags), isoNow());
  }

  private sortClause(sort?: MusicListFilter["sort"]): string {
    switch (sort) {
      case "year_desc":  return "year desc";
      case "year_asc":   return "year asc";
      case "date_added": return "publicdate desc";
      case "title_asc":  return "titleSorter asc";
      case "downloads":
      default:           return "downloads desc";
    }
  }

  private cacheKey(f: MusicListFilter): string {
    return createHash("sha1").update(JSON.stringify({
      q: f.query ?? "", k: f.kind ?? "any", c: f.collection ?? "",
      cr: f.creator ?? "",
      l: f.language ?? "", yi: f.yearMin ?? 0, ya: f.yearMax ?? 0,
      t: (f.tags ?? []).slice().sort(), tm: f.tagsMatch ?? "all",
      s: f.sort ?? "downloads", p: f.page ?? 1, lim: f.limit ?? 24,
    })).digest("hex");
  }

  private readCache(key: string): { items: MusicItem[]; total: number } | null {
    const row = this.db.prepare(
      `SELECT payload_json, cached_at FROM music_search_cache WHERE cache_key = ?`,
    ).get(key) as { payload_json: string; cached_at: string } | undefined;
    if (!row) return null;
    if (Date.now() - new Date(row.cached_at).getTime() > SEARCH_CACHE_TTL_MS) return null;
    try { return JSON.parse(row.payload_json); } catch { return null; }
  }

  private writeCache(key: string, payload: { items: MusicItem[]; total: number }): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO music_search_cache (cache_key, payload_json, cached_at) VALUES (?, ?, ?)`,
    ).run(key, JSON.stringify(payload), isoNow());
  }

  private normalize(d: ArchiveDoc, library: Set<string>): MusicItem {
    const collection = toArray(d.collection);
    return {
      identifier: d.identifier,
      title: firstString(d.title) || d.identifier,
      creator: firstString(d.creator),
      year: parseYear(d.year ?? d.date ?? ""),
      date: typeof d.date === "string" ? d.date : "",
      description: firstString(d.description).slice(0, 800),
      language: firstString(d.language),
      subject: toArray(d.subject).slice(0, 12),
      collection,
      downloads: typeof d.downloads === "number" ? d.downloads : 0,
      publicdate: d.publicdate ?? "",
      cover_url: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
      details_url: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
      format_kind: deriveKind(collection),
      in_library: library.has(d.identifier),
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
function parseTrack(v: string | number | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
/** Archive's `length` is either "MM:SS", "H:MM:SS", or seconds-as-float. */
function parseLength(v: string): number | null {
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v));
  const parts = v.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}
function prettyTrackName(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/^\d+\s*[-.]?\s*/, "")
    .trim();
}

/**
 * Map our high-level `kind` filter to archive.org collection slugs.
 * Picked from the most populous collections under mediatype:audio so a
 * single dropdown choice maps to a meaningful slice.
 *  - vinyl_78  → `78rpm` + `georgeblood` (the two giant 78rpm corpora)
 *  - vinyl_lp  → `lps` (a much smaller LP collection on archive)
 *  - netlabel  → `netlabels` + `audio_music`
 *  - live      → `etree` (Live Music Archive)
 *  - radio     → `oldtimeradio` + `radioprograms`
 *  - audiobook → `librivoxaudio`
 */
function collectionsForKind(kind: MusicListFilter["kind"]): string[] {
  switch (kind) {
    case "vinyl_78":  return ["78rpm", "georgeblood"];
    case "vinyl_lp":  return ["lps"];
    case "netlabel":  return ["netlabels", "audio_music"];
    case "live":      return ["etree"];
    case "radio":     return ["oldtimeradio", "radioprograms"];
    case "audiobook": return ["librivoxaudio"];
    case "audio":
    case "any":
    case undefined:
    default:          return [];
  }
}

/** Reverse mapping — given an item's collection list, pick the most
 *  specific kind we recognize. Order matters: 78rpm wins over generic
 *  `audio_music` because the chip "Vinyl 78" is more user-facing than
 *  "Audio". */
function deriveKind(collections: string[]): MusicFormatKind {
  const set = new Set(collections.map((c) => c.toLowerCase()));
  if (set.has("78rpm") || set.has("georgeblood")) return "vinyl_78";
  if (set.has("lps")) return "vinyl_lp";
  if (set.has("librivoxaudio")) return "audiobook";
  if (set.has("etree")) return "live";
  if (set.has("oldtimeradio") || set.has("radioprograms")) return "radio";
  if (set.has("netlabels") || set.has("audio_music")) return "netlabel";
  return "audio";
}

/** Sort tracks by track number when available, falling back to filename. */
function byTrackThenName(a: MusicTrack, b: MusicTrack): number {
  if (a.track != null && b.track != null) return a.track - b.track;
  if (a.track != null) return -1;
  if (b.track != null) return 1;
  return a.name.localeCompare(b.name);
}

/**
 * Archive items frequently expose the same logical track in 2-3 formats
 * (VBR MP3 + 64Kbps MP3 + Flac). Collapse to one entry per logical track,
 * preferring VBR MP3 for streaming (best balance of quality + browser
 * support; FLAC isn't ubiquitously supported in `<audio>`).
 */
function dedupeBestFormat(tracks: MusicTrack[]): MusicTrack[] {
  const FORMAT_RANK: Record<string, number> = {
    "VBR MP3": 0, "MP3": 1, "128Kbps MP3": 2, "Ogg Vorbis": 3,
    "64Kbps MP3": 4, "Flac": 5, "FLAC": 5, "24bit FLAC": 6, "WAV": 7, "AAC": 8,
  };
  const byKey = new Map<string, MusicTrack>();
  for (const t of tracks) {
    const key = stripFormatExt(t.name);
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, t); continue; }
    const a = FORMAT_RANK[existing.format] ?? 99;
    const b = FORMAT_RANK[t.format] ?? 99;
    if (b < a) byKey.set(key, t);
  }
  return Array.from(byKey.values()).sort(byTrackThenName);
}
function stripFormatExt(name: string): string {
  return name.replace(/\.(mp3|ogg|flac|wav|m4a|aac)$/i, "").toLowerCase();
}

/** Shape of the `aggregations` payload archive.org returns for `user_aggs=subject`. */
interface ArchiveAggResponse {
  response?: {
    aggregations?: Record<string, {
      buckets?: Array<{ key: string; doc_count: number }>;
    }>;
  };
}

/**
 * Tags considered too noisy/uninformative to surface in the chip row.
 * - Pure numbers (years, "1", "2024")
 * - Single character
 * - Three-letter language codes (eng / spa / fre …) archive.org leaks
 * - The literal "audio" / "music" — not useful as a *filter* when every
 *   item is already an audio recording (often a music one).
 */
function isNoiseTag(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 2) return true;
  if (/^\d+$/.test(s)) return true;
  const lower = s.toLowerCase();
  if (/^[a-z]{3}$/.test(lower)) return true;
  if (lower === "audio" || lower === "music") return true;
  return false;
}

/**
 * When two casings of the same tag exist ("Jazz" + "jazz"), pick the
 * display string that looks more user-curated. Heuristic: anything with
 * uppercase letters wins over an all-lowercase variant.
 */
function preferDisplay(candidate: string, current: string): boolean {
  const candHasUpper = /[A-Z]/.test(candidate);
  const currHasUpper = /[A-Z]/.test(current);
  if (candHasUpper && !currHasUpper) return true;
  if (!candHasUpper && currHasUpper) return false;
  // Both same casing class — keep the shorter one ("Jazz" beats "Jazz Music").
  return candidate.length < current.length;
}

// ── Solr-injection sanitizers ────────────────────────────────────────
/**
 * Quote-safe phrase. archive.org's Solr parser treats unbalanced
 * `"`, `\`, `(`, `)` etc. as syntax. We strip them; truncate to a
 * sensible bound so a 10KB query string can't blow up the URL.
 */
function sanitizePhrase(s: string | undefined): string {
  if (!s) return "";
  return s
    .replace(/["\\]/g, "")     // quotes + backslashes — would escape phrase context
    .replace(new RegExp("[\\u0001-\\u001F\\u007F\\u0000]", "g"), " ") // C0/DEL control chars (RegExp ctor avoids bun 1.2 \x00 normalization bug)
    .trim()
    .slice(0, 200);
}
/** Strict slug: letters, digits, underscore, hyphen, dot. Anything else → drop. */
function sanitizeSlug(s: string | undefined): string {
  if (!s) return "";
  return /^[A-Za-z0-9_.\-]+$/.test(s) ? s : "";
}
function sanitizeYear(n: number | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < 0 || i > 3000) return null;
  return i;
}

/**
 * Merge tag candidates from local catalog + remote exact verify + remote
 * discovery, dedupe by normalized form, rank.
 *
 * Ordering policy:
 *   - The exact match the user typed always sits at the top (so they can
 *     hit Enter and pick it without scrolling).
 *   - Then everything else by count desc.
 *
 * Counts: when a tag appears in BOTH local and remote, prefer remote
 * (it reflects the global corpus count, not just our local sample).
 */
function mergeTagSources(args: {
  local: MusicTag[];
  exactQuery: string;
  exactCount: number;
  discovery: MusicTag[];
  limit: number;
}): MusicTag[] {
  const merged = new Map<string, MusicTag>();

  // Local first — establishes baseline counts for tags we have ingested.
  for (const t of args.local) {
    merged.set(t.tag_norm, { ...t, rank: 0 });
  }

  // Discovery (remote agg). Replace counts with remote when present
  // since global counts are more meaningful than local sample counts.
  for (const t of args.discovery) {
    const cur = merged.get(t.tag_norm);
    if (cur) {
      merged.set(t.tag_norm, {
        tag_norm: t.tag_norm,
        tag_display: cur.tag_display.length > t.tag_display.length ? t.tag_display : cur.tag_display,
        count: t.count,    // remote count wins
        rank: 0,
      });
    } else {
      merged.set(t.tag_norm, { ...t, rank: 0 });
    }
  }

  // Exact verify — pin to top regardless of count.
  let pinned: MusicTag | null = null;
  if (args.exactCount > 0) {
    const norm = args.exactQuery.toLowerCase();
    const existing = merged.get(norm);
    pinned = existing
      ? { ...existing, count: args.exactCount }
      : { tag_norm: norm, tag_display: args.exactQuery, count: args.exactCount, rank: 0 };
    merged.delete(norm); // remove from rest so pinned stays first
  }

  const rest = [...merged.values()].sort((a, b) => b.count - a.count);
  const ordered = pinned ? [pinned, ...rest] : rest;
  return ordered.slice(0, args.limit).map((t, i) => ({ ...t, rank: i + 1 }));
}
