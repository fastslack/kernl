import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { EmbeddingsClient } from "../../../../../src/core/embeddings/client.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";
import { guardedFetch } from "../../../../../src/core/url-guard.js";
import { parseFeed, itemHash, type ParsedItem } from "./parser.js";
import { SEED_CATEGORIES, SEED_FEEDS } from "./seed.js";
import type {
  CategoryAddInput,
  FeedAddInput,
  FeedListQuery,
  FeedSearchQuery,
  FeedUpdateInput,
  FetchResult,
  ItemListQuery,
  RegistryStats,
  RssCategory,
  RssFeed,
  RssFeedWithCategory,
  RssItem,
  RssItemWithFeed,
  ValidationResult,
} from "./types.js";

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "Kernl/1.0 (+rss-registry)";

export class RssRegistryService {
  constructor(
    private readonly db: SqliteDb,
    private readonly events: EventBus | null = null,
    private embeddings: EmbeddingsClient | null = null,
  ) {}

  /** Embeddings client used for relevance ranking; null falls back to lexical. */
  getEmbeddingsClient(): EmbeddingsClient | null {
    return this.embeddings;
  }

  /** Wired post-bootstrap once the kernel's embeddings client exists. */
  setEmbeddingsClient(client: EmbeddingsClient | null): void {
    this.embeddings = client;
  }

  // ── Categories ────────────────────────────────────────────────

  addCategory(input: CategoryAddInput): RssCategory {
    const id = newId();
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO rss_categories (id, name, description, icon, parent_id, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.description ?? "",
        input.icon ?? "",
        input.parent_id ?? null,
        input.sort_order ?? 0,
        now,
      );
    return this.getCategory(id)!;
  }

  getCategory(id: string): RssCategory | null {
    const row = this.db
      .prepare("SELECT * FROM rss_categories WHERE id = ?")
      .get(id) as RssCategory | undefined;
    return row ?? null;
  }

  getCategoryByName(name: string): RssCategory | null {
    const row = this.db
      .prepare("SELECT * FROM rss_categories WHERE name = ?")
      .get(name) as RssCategory | undefined;
    return row ?? null;
  }

  listCategories(): RssCategory[] {
    return this.db
      .prepare("SELECT * FROM rss_categories ORDER BY sort_order, name")
      .all() as RssCategory[];
  }

  updateCategory(
    id: string,
    changes: Partial<Pick<RssCategory, "name" | "description" | "icon" | "sort_order">>,
  ): RssCategory | null {
    const cat = this.getCategory(id);
    if (!cat) return null;
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (changes.name !== undefined)        { sets.push("name = ?");        vals.push(changes.name); }
    if (changes.description !== undefined) { sets.push("description = ?"); vals.push(changes.description); }
    if (changes.icon !== undefined)        { sets.push("icon = ?");        vals.push(changes.icon); }
    if (changes.sort_order !== undefined)  { sets.push("sort_order = ?");  vals.push(changes.sort_order); }
    if (sets.length === 0) return cat;
    vals.push(id);
    this.db.prepare(`UPDATE rss_categories SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as never[]));
    return this.getCategory(id);
  }

  /**
   * Delete a category. Feeds previously assigned to it are NOT deleted —
   * their `category_id` becomes NULL via the FK ON DELETE SET NULL clause
   * (so they survive as "Uncategorized" in the UI).
   */
  deleteCategory(id: string): boolean {
    const result = this.db.prepare("DELETE FROM rss_categories WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ── Feeds ─────────────────────────────────────────────────────

  addFeed(input: FeedAddInput): RssFeed {
    const id = newId();
    const now = isoNow();
    const slug = input.slug ?? this.slugify(input.name);
    this.db
      .prepare(
        `INSERT INTO rss_registry (
          id, name, slug, description, category_id, feed_url, website_url,
          language, country, update_frequency, tags, quality_score,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        slug,
        input.description ?? "",
        input.category_id ?? null,
        input.feed_url,
        input.website_url ?? "",
        input.language ?? "en",
        input.country ?? "",
        input.update_frequency ?? "hourly",
        (input.tags ?? []).join(","),
        input.quality_score ?? 50,
        now,
        now,
      );
    return this.getFeed(id)!;
  }

  getFeed(id: string): RssFeed | null {
    const row = this.db
      .prepare("SELECT * FROM rss_registry WHERE id = ?")
      .get(id) as RssFeed | undefined;
    return row ?? null;
  }

  getFeedBySlug(slug: string): RssFeed | null {
    const row = this.db
      .prepare("SELECT * FROM rss_registry WHERE slug = ?")
      .get(slug) as RssFeed | undefined;
    return row ?? null;
  }

  updateFeed(id: string, changes: FeedUpdateInput): RssFeed | null {
    const feed = this.getFeed(id);
    if (!feed) return null;

    const sets: string[] = [];
    const vals: unknown[] = [];
    const map: Record<string, unknown> = {
      name: changes.name,
      description: changes.description,
      category_id: changes.category_id,
      feed_url: changes.feed_url,
      website_url: changes.website_url,
      language: changes.language,
      country: changes.country,
      update_frequency: changes.update_frequency,
      status: changes.status,
      quality_score: changes.quality_score,
      sort_order: changes.sort_order,
    };
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(val);
      }
    }
    if (changes.tags !== undefined) {
      sets.push("tags = ?");
      vals.push(changes.tags.join(","));
    }
    if (sets.length === 0) return feed;

    sets.push("updated_at = ?");
    vals.push(isoNow());
    vals.push(id);
    this.db
      .prepare(`UPDATE rss_registry SET ${sets.join(", ")} WHERE id = ?`)
      .run(...(vals as unknown[] as never[]));
    return this.getFeed(id);
  }

  deleteFeed(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM rss_registry WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  listFeeds(query?: FeedListQuery): RssFeedWithCategory[] {
    const wheres: string[] = ["1=1"];
    const vals: unknown[] = [];
    if (query?.category_id) {
      wheres.push("f.category_id = ?");
      vals.push(query.category_id);
    }
    if (query?.status) {
      wheres.push("f.status = ?");
      vals.push(query.status);
    }
    if (query?.language) {
      wheres.push("f.language = ?");
      vals.push(query.language);
    }
    if (query?.country) {
      wheres.push("f.country = ?");
      vals.push(query.country);
    }
    if (query?.min_quality !== undefined) {
      wheres.push("f.quality_score >= ?");
      vals.push(query.min_quality);
    }
    const limit = query?.limit ?? 500;
    const offset = query?.offset ?? 0;
    vals.push(limit, offset);

    const sql = `
      SELECT f.*, c.name as category_name, c.icon as category_icon
      FROM rss_registry f
      LEFT JOIN rss_categories c ON f.category_id = c.id
      WHERE ${wheres.join(" AND ")}
      ORDER BY f.sort_order, f.quality_score DESC, f.name
      LIMIT ? OFFSET ?
    `;
    return this.db.prepare(sql).all(...(vals as never[])) as RssFeedWithCategory[];
  }

  /**
   * Persist a new ordering for the categories. Caller passes the IDs in the
   * desired order and we rewrite `sort_order` to match. Single transaction so
   * the UI never sees a half-applied state.
   */
  reorderCategories(orderedIds: string[]): void {
    const stmt = this.db.prepare("UPDATE rss_categories SET sort_order = ? WHERE id = ?");
    const tx = this.db.transaction((ids: string[]) => {
      for (let i = 0; i < ids.length; i++) stmt.run(i, ids[i]);
    });
    tx(orderedIds);
  }

  /**
   * Persist a new ordering for the feeds inside a category (or for the
   * uncategorised set when `categoryId` is null). We also (re)assign
   * `category_id` so the same call can move + reorder in one shot, which is
   * what the sidebar drag-and-drop needs.
   */
  reorderFeeds(categoryId: string | null, orderedIds: string[]): void {
    const stmt = this.db.prepare(
      "UPDATE rss_registry SET category_id = ?, sort_order = ?, updated_at = ? WHERE id = ?",
    );
    const now = isoNow();
    const tx = this.db.transaction((ids: string[]) => {
      for (let i = 0; i < ids.length; i++) stmt.run(categoryId, i, now, ids[i]);
    });
    tx(orderedIds);
  }

  searchFeeds(query: FeedSearchQuery): RssFeedWithCategory[] {
    const wheres: string[] = [
      "(f.name LIKE ? OR f.description LIKE ? OR f.tags LIKE ?)",
    ];
    const term = `%${query.query}%`;
    const vals: unknown[] = [term, term, term];
    if (query.category_id) {
      wheres.push("f.category_id = ?");
      vals.push(query.category_id);
    }
    if (query.language) {
      wheres.push("f.language = ?");
      vals.push(query.language);
    }
    const limit = query.limit ?? 50;
    vals.push(term, limit);

    const sql = `
      SELECT f.*, c.name as category_name, c.icon as category_icon
      FROM rss_registry f
      LEFT JOIN rss_categories c ON f.category_id = c.id
      WHERE ${wheres.join(" AND ")} AND f.status = 'active'
      ORDER BY
        f.quality_score DESC,
        CASE WHEN f.name LIKE ? THEN 0 ELSE 1 END,
        f.name
      LIMIT ?
    `;
    return this.db.prepare(sql).all(...(vals as never[])) as RssFeedWithCategory[];
  }

  discoverFeeds(topic: string, tags: string[] = []): RssFeedWithCategory[] {
    const keywords = topic.toLowerCase().split(/\s+/).filter(Boolean);
    const allTerms = [...keywords, ...tags];
    if (allTerms.length === 0) return [];

    const conditions = allTerms.map(
      () => "(f.name LIKE ? OR f.description LIKE ? OR f.tags LIKE ?)",
    );
    const vals: unknown[] = [];
    for (const t of allTerms) {
      const like = `%${t}%`;
      vals.push(like, like, like);
    }
    const sql = `
      SELECT f.*, c.name as category_name, c.icon as category_icon
      FROM rss_registry f
      LEFT JOIN rss_categories c ON f.category_id = c.id
      WHERE f.status = 'active' AND (${conditions.join(" OR ")})
      ORDER BY f.quality_score DESC, f.name
      LIMIT 20
    `;
    return this.db.prepare(sql).all(...(vals as never[])) as RssFeedWithCategory[];
  }

  // ── Validation & Fetch ────────────────────────────────────────

  async testFeed(feedId: string): Promise<ValidationResult> {
    const feed = this.getFeed(feedId);
    if (!feed) return { valid: false, feed_url: "", error: "Feed not found" };
    return this.validateFeedUrl(feed.feed_url, feedId);
  }

  async validateFeedUrl(
    feedUrl: string,
    feedId?: string,
  ): Promise<ValidationResult> {
    const start = Date.now();
    try {
      const resp = await guardedFetch(feedUrl, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        const error = `HTTP ${resp.status}`;
        if (feedId) this.updateFeedHealth(feedId, false, error);
        return {
          valid: false,
          feed_url: feedUrl,
          error,
          response_time_ms: Date.now() - start,
        };
      }

      const xml = await resp.text();
      const parsed = parseFeed(xml);
      const responseTimeMs = Date.now() - start;

      let lastItemDate: string | undefined;
      for (const item of parsed.items) {
        if (item.published_at) {
          if (!lastItemDate || item.published_at > lastItemDate) {
            lastItemDate = item.published_at;
          }
        }
      }
      if (feedId) {
        this.updateFeedHealth(
          feedId,
          true,
          "",
          parsed.items.length,
          lastItemDate,
        );
      }
      return {
        valid: true,
        feed_url: feedUrl,
        title: parsed.title,
        item_count: parsed.items.length,
        last_item_date: lastItemDate,
        response_time_ms: responseTimeMs,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const responseTimeMs = Date.now() - start;
      if (feedId) this.updateFeedHealth(feedId, false, error);
      return {
        valid: false,
        feed_url: feedUrl,
        error,
        response_time_ms: responseTimeMs,
      };
    }
  }

  /**
   * Fetch a feed and persist new items. Dedup by (feed_id, hash). Emits
   * `rss.item.new` for each newly stored item, then `rss.feed.fetched` once
   * with the totals.
   */
  async fetchFeed(feedId: string): Promise<FetchResult> {
    const feed = this.getFeed(feedId);
    if (!feed) {
      return { feed_id: feedId, ok: false, new_items: 0, total_items: 0, error: "Feed not found" };
    }

    try {
      const resp = await guardedFetch(feed.feed_url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        const msg = `HTTP ${resp.status}`;
        this.updateFeedHealth(feedId, false, msg);
        return { feed_id: feedId, ok: false, new_items: 0, total_items: 0, error: msg };
      }
      const xml = await resp.text();
      const parsed = parseFeed(xml);

      let newCount = 0;
      let lastItemAt: string | undefined;
      const insertedItems: RssItem[] = [];

      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO rss_items (
          id, feed_id, guid, title, link, author, description, content,
          image_url, published_at, fetched_at, hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = isoNow();
      for (const item of parsed.items) {
        const hash = itemHash(item);
        const id = newId();
        const result = insert.run(
          id,
          feedId,
          item.guid,
          item.title,
          item.link,
          item.author,
          item.description,
          item.content,
          item.image_url,
          item.published_at,
          now,
          hash,
        );
        if (result.changes > 0) {
          newCount++;
          insertedItems.push({
            id,
            feed_id: feedId,
            guid: item.guid,
            title: item.title,
            link: item.link,
            author: item.author,
            description: item.description,
            content: item.content,
            image_url: item.image_url,
            published_at: item.published_at,
            fetched_at: now,
            hash,
          });
        }
        if (item.published_at && (!lastItemAt || item.published_at > lastItemAt)) {
          lastItemAt = item.published_at;
        }
      }

      this.updateFeedHealth(feedId, true, "", parsed.items.length, lastItemAt);

      // Emit per-item events first (consumers may want to react fast),
      // then a summary feed.fetched event.
      if (this.events) {
        for (const it of insertedItems) {
          await this.events.emit("rss.item.new", { feed, item: it });
        }
        await this.events.emit("rss.feed.fetched", {
          feed_id: feedId,
          new_items: newCount,
          total_items: parsed.items.length,
        });
      }

      return {
        feed_id: feedId,
        ok: true,
        new_items: newCount,
        total_items: parsed.items.length,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.updateFeedHealth(feedId, false, msg);
      return { feed_id: feedId, ok: false, new_items: 0, total_items: 0, error: msg };
    }
  }

  /** Fetch every active feed (used by scheduler & "Refresh all" button). */
  async fetchAllActive(): Promise<FetchResult[]> {
    const feeds = this.listFeeds({ status: "active", limit: 1000 });
    const out: FetchResult[] = [];
    // Concurrency cap to avoid hammering the network or our own event loop.
    const CONCURRENCY = 6;
    let i = 0;
    async function pump(self: RssRegistryService): Promise<void> {
      while (i < feeds.length) {
        const idx = i++;
        const r = await self.fetchFeed(feeds[idx].id);
        out.push(r);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => pump(this)));
    return out;
  }

  /** Feeds whose last_check_at is older than the cutoff for their frequency. */
  feedsDueForFetch(): RssFeed[] {
    const now = Date.now();
    const dueFor = (freq: string): number => {
      switch (freq) {
        case "realtime": return 5 * 60 * 1000;
        case "hourly":   return 60 * 60 * 1000;
        case "daily":    return 24 * 60 * 60 * 1000;
        case "weekly":   return 7 * 24 * 60 * 60 * 1000;
        default:         return 60 * 60 * 1000;
      }
    };
    const all = this.db
      .prepare("SELECT * FROM rss_registry WHERE status = 'active'")
      .all() as RssFeed[];
    return all.filter((f) => {
      if (!f.last_check_at) return true;
      const age = now - new Date(f.last_check_at).getTime();
      return age >= dueFor(f.update_frequency);
    });
  }

  updateFeedHealth(
    feedId: string,
    ok: boolean,
    error: string,
    itemCount?: number,
    lastItemAt?: string,
  ): void {
    const now = isoNow();
    if (ok) {
      this.db
        .prepare(
          `UPDATE rss_registry SET
            last_check_at = ?, last_check_ok = 1, status = 'active',
            item_count = COALESCE(?, item_count), last_item_at = COALESCE(?, last_item_at),
            error_message = '', error_count = 0, updated_at = ?
          WHERE id = ?`,
        )
        .run(now, itemCount ?? null, lastItemAt ?? null, now, feedId);
    } else {
      this.db
        .prepare(
          `UPDATE rss_registry SET
            last_check_at = ?, last_check_ok = 0,
            error_count = error_count + 1, error_message = ?,
            status = CASE WHEN error_count >= 5 THEN 'dead' ELSE 'error' END,
            updated_at = ?
          WHERE id = ?`,
        )
        .run(now, error, now, feedId);
    }
  }

  // ── Items ─────────────────────────────────────────────────────

  listItems(query?: ItemListQuery): RssItemWithFeed[] {
    const wheres: string[] = ["1=1"];
    const vals: unknown[] = [];
    if (query?.feed_id) {
      wheres.push("i.feed_id = ?");
      vals.push(query.feed_id);
    }
    if (query?.category_id) {
      wheres.push("f.category_id = ?");
      vals.push(query.category_id);
    }
    if (query?.language) {
      wheres.push("f.language = ?");
      vals.push(query.language);
    }
    if (query?.since) {
      wheres.push("(i.published_at >= ? OR i.fetched_at >= ?)");
      vals.push(query.since, query.since);
    }
    if (query?.search) {
      wheres.push("(i.title LIKE ? OR i.description LIKE ?)");
      const term = `%${query.search}%`;
      vals.push(term, term);
    }
    const limit = query?.limit ?? 100;
    const offset = query?.offset ?? 0;
    vals.push(limit, offset);

    const sql = `
      SELECT i.*,
             f.name AS feed_name, f.slug AS feed_slug, f.feed_url,
             f.category_id, f.language,
             c.name AS category_name, c.icon AS category_icon
      FROM rss_items i
      JOIN rss_registry f ON i.feed_id = f.id
      LEFT JOIN rss_categories c ON f.category_id = c.id
      WHERE ${wheres.join(" AND ")}
      ORDER BY COALESCE(i.published_at, i.fetched_at) DESC
      LIMIT ? OFFSET ?
    `;
    return this.db.prepare(sql).all(...(vals as never[])) as RssItemWithFeed[];
  }

  getItem(id: string): RssItemWithFeed | null {
    const sql = `
      SELECT i.*,
             f.name AS feed_name, f.slug AS feed_slug, f.feed_url,
             f.category_id, f.language,
             c.name AS category_name, c.icon AS category_icon
      FROM rss_items i
      JOIN rss_registry f ON i.feed_id = f.id
      LEFT JOIN rss_categories c ON f.category_id = c.id
      WHERE i.id = ?
    `;
    const row = this.db.prepare(sql).get(id) as RssItemWithFeed | undefined;
    return row ?? null;
  }

  /** Per-feed item counts. Used by the reader sidebar for unread-style badges. */
  itemCountsByFeed(): Map<string, number> {
    const rows = this.db
      .prepare(
        "SELECT feed_id, COUNT(*) AS count FROM rss_items GROUP BY feed_id",
      )
      .all() as Array<{ feed_id: string; count: number }>;
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.feed_id, r.count);
    return out;
  }

  /** Live preview — fetch feed items in-memory without persisting. */
  async previewFeed(feedUrl: string): Promise<{ ok: boolean; items: ParsedItem[]; title: string; error?: string }> {
    try {
      const resp = await guardedFetch(feedUrl, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        return { ok: false, items: [], title: "", error: `HTTP ${resp.status}` };
      }
      const xml = await resp.text();
      const parsed = parseFeed(xml);
      return { ok: true, items: parsed.items.slice(0, 30), title: parsed.title };
    } catch (err) {
      return { ok: false, items: [], title: "", error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Stats ─────────────────────────────────────────────────────

  getStats(): RegistryStats {
    const total = this.db
      .prepare("SELECT COUNT(*) as count FROM rss_registry")
      .get() as { count: number };
    const active = this.db
      .prepare("SELECT COUNT(*) as count FROM rss_registry WHERE status = 'active'")
      .get() as { count: number };
    const errorFeeds = this.db
      .prepare("SELECT COUNT(*) as count FROM rss_registry WHERE status IN ('error','dead')")
      .get() as { count: number };
    const avgQuality = this.db
      .prepare("SELECT AVG(quality_score) as avg FROM rss_registry")
      .get() as { avg: number | null };
    const totalItems = this.db
      .prepare("SELECT COUNT(*) as count FROM rss_items")
      .get() as { count: number };
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const items24 = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM rss_items WHERE COALESCE(published_at, fetched_at) >= ?",
      )
      .get(since) as { count: number };

    const byCategory = this.db
      .prepare(
        `SELECT COALESCE(c.name, 'Uncategorized') as category, COUNT(*) as count
         FROM rss_registry f
         LEFT JOIN rss_categories c ON f.category_id = c.id
         GROUP BY c.name
         ORDER BY count DESC`,
      )
      .all() as Array<{ category: string; count: number }>;
    const byLanguage = this.db
      .prepare(
        `SELECT language, COUNT(*) as count
         FROM rss_registry GROUP BY language
         ORDER BY count DESC LIMIT 15`,
      )
      .all() as Array<{ language: string; count: number }>;
    const byFrequency = this.db
      .prepare(
        `SELECT update_frequency as frequency, COUNT(*) as count
         FROM rss_registry GROUP BY update_frequency
         ORDER BY count DESC`,
      )
      .all() as Array<{ frequency: string; count: number }>;

    return {
      total_feeds: total.count,
      active_feeds: active.count,
      error_feeds: errorFeeds.count,
      by_category: byCategory,
      by_language: byLanguage,
      by_frequency: byFrequency,
      avg_quality_score: Math.round(avgQuality.avg ?? 0),
      total_items: totalItems.count,
      items_last_24h: items24.count,
    };
  }

  // ── Seeding ───────────────────────────────────────────────────

  seedBuiltins(force = false): { categories: number; feeds: number } {
    if (force) {
      this.db.exec("DELETE FROM rss_items; DELETE FROM rss_registry; DELETE FROM rss_categories;");
    }
    const catMap = new Map<string, string>();
    let categoriesCreated = 0;
    let feedsCreated = 0;

    for (const c of SEED_CATEGORIES) {
      let cat = this.getCategoryByName(c.name);
      if (!cat) {
        cat = this.addCategory({ name: c.name, icon: c.icon, description: c.description });
        categoriesCreated++;
      }
      catMap.set(c.name, cat.id);
    }
    for (const f of SEED_FEEDS) {
      const existing = this.getFeedBySlug(f.slug);
      if (existing) continue;
      this.addFeed({
        name: f.name,
        slug: f.slug,
        description: f.description,
        category_id: catMap.get(f.category) ?? undefined,
        feed_url: f.feed_url,
        website_url: f.website_url,
        language: f.language,
        country: f.country,
        update_frequency: f.update_frequency,
        tags: f.tags.split(",").map((t) => t.trim()),
        quality_score: f.quality_score,
      });
      feedsCreated++;
    }
    log.info(`RSS registry seeded: ${categoriesCreated} categories, ${feedsCreated} feeds`);
    return { categories: categoriesCreated, feeds: feedsCreated };
  }

  // ── Helpers ───────────────────────────────────────────────────

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }
}
