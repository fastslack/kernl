/**
 * News Service - RSS Feed Fetcher and Aggregator
 * 
 * Fetches, parses, and aggregates RSS/Atom feeds for the dashboard.
 * Features:
 * - TTL-based caching per feed
 * - Parallel fetching with Promise.allSettled
 * - Graceful error handling (one feed failure doesn't block others)
 * - User-configurable feeds with categories
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import { log } from "../../../../../src/core/logger.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

// ── Types ──────────────────────────────────────────────

export interface UserFeed {
  id: string;
  name: string;
  url: string;
  category: string;
  is_active: boolean;
  sort_order: number;
  icon: string;
  color: string;
  last_fetch: string | null;
  error_count: number;
  created_at: string;
  updated_at: string;
}

export interface FeedCategory {
  id: string;
  name: string;
  icon: string;
  color: string;
  sort_order: number;
  is_active: boolean;
}

export interface NewsColumn {
  id: string;
  name: string;
  color: string;
  icon: string;
  sort_order: number;
  is_active: boolean;
  feed_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface NewsArticle {
  id: string;
  feedId: string;
  feedName: string;
  feedColor: string;
  category: string;
  title: string;
  description: string;
  link: string;
  pubDate: string;
  imageUrl?: string;
  author?: string;
}

export interface NewsData {
  articles: NewsArticle[];
  feeds: UserFeed[];
  categories: FeedCategory[];
  columns: NewsColumn[];
  fetchedAt: string;
  errors: Array<{ feedId: string; feedName: string; error: string }>;
}

// ── Cache ──────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes per feed

interface CacheEntry {
  articles: NewsArticle[];
  expiresAt: number;
}

class NewsCache {
  private store = new Map<string, CacheEntry>();

  get(feedId: string): NewsArticle[] | null {
    const entry = this.store.get(feedId);
    if (!entry || Date.now() > entry.expiresAt) {
      this.store.delete(feedId);
      return null;
    }
    return entry.articles;
  }

  set(feedId: string, articles: NewsArticle[]): void {
    this.store.set(feedId, {
      articles,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }

  invalidate(feedId: string): void {
    this.store.delete(feedId);
  }

  clear(): void {
    this.store.clear();
  }
}

// ── Service ────────────────────────────────────────────

export class NewsService {
  private cache = new NewsCache();

  /**
   * The graph getter is consulted per call so backend toggles in
   * /extensions take effect on the next persist/query without restarting.
   */
  constructor(private db: Database, private getGraph: () => GraphDriver | null = () => null) {
    // Constraints are best-effort at construction; if no driver is active
    // they're skipped silently and reattempted lazily on next write.
    this.ensureGraphConstraints().catch(e => log.warn("News: graph constraint setup failed", e));
  }

  private getReadyGraph(): GraphDriver | null {
    const g = this.getGraph();
    return g?.capabilities.cypher ? g : null;
  }

  private async ensureGraphConstraints(): Promise<void> {
    const graph = this.getReadyGraph();
    if (!graph) return;
    await graph.run(`
      CREATE CONSTRAINT article_link IF NOT EXISTS
      FOR (a:Article) REQUIRE a.link IS UNIQUE
    `);
    await graph.run(`
      CREATE INDEX article_module IF NOT EXISTS
      FOR (a:Article) ON (a.module)
    `);
    await graph.run(`
      CREATE INDEX article_pubDate IF NOT EXISTS
      FOR (a:Article) ON (a.pubDate)
    `);
    log.info("News: graph constraints/indexes ensured");
  }

  /** Persist articles to the active graph driver. MERGE by link to avoid duplicates. */
  private async persistToNeo4j(articles: NewsArticle[]): Promise<void> {
    const graph = this.getReadyGraph();
    if (!graph || articles.length === 0) return;
    try {
      await graph.run(`
        UNWIND $articles AS a
        MERGE (art:Article {link: a.link})
        ON CREATE SET
          art.module     = 'news',
          art.title      = a.title,
          art.description = a.description,
          art.pubDate    = a.pubDate,
          art.imageUrl   = a.imageUrl,
          art.author     = a.author,
          art.feedId     = a.feedId,
          art.feedName   = a.feedName,
          art.feedColor  = a.feedColor,
          art.category   = a.category,
          art.createdAt  = datetime()
        ON MATCH SET
          art.title      = a.title,
          art.description = a.description,
          art.imageUrl   = a.imageUrl
      `, {
        articles: articles.map(a => ({
          link: a.link,
          title: a.title,
          description: a.description,
          pubDate: a.pubDate,
          imageUrl: a.imageUrl ?? null,
          author: a.author ?? null,
          feedId: a.feedId,
          feedName: a.feedName,
          feedColor: a.feedColor,
          category: a.category,
        })),
      });
    } catch (e) {
      log.warn("News: failed to persist articles to Neo4j", e);
    }
  }

  /** Load historical articles from the graph for given feeds, up to daysBack. */
  async loadFromNeo4j(feedIds: string[], daysBack = 30, limit = 200): Promise<NewsArticle[]> {
    const graph = this.getReadyGraph();
    if (!graph) return [];
    try {
      const cutoff = new Date(Date.now() - daysBack * 86_400_000).toISOString();
      const result = await graph.run(`
        MATCH (a:Article)
        WHERE a.module = 'news'
          AND a.feedId IN $feedIds
          AND a.pubDate >= $cutoff
        RETURN a
        ORDER BY a.pubDate DESC
        LIMIT toInteger($limit)
      `, { feedIds, cutoff, limit });

      return result.records.map(r => {
        const n = (r.get("a") as { properties: Record<string, string> }).properties;
        return {
          id: `${n.feedId}-${createHash("sha256").update(n.link).digest("hex").slice(0, 16)}`,
          feedId: n.feedId,
          feedName: n.feedName,
          feedColor: n.feedColor ?? "",
          category: n.category,
          title: n.title,
          description: n.description ?? "",
          link: n.link,
          pubDate: n.pubDate,
          imageUrl: n.imageUrl ?? undefined,
          author: n.author ?? undefined,
        };
      });
    } catch (e) {
      log.warn("News: failed to load articles from Neo4j", e);
      return [];
    }
  }

  // ── Feed CRUD ────────────────────────────────────────

  /**
   * List feeds - reads from rss_registry (active feeds) and maps to UserFeed format
   */
  listFeeds(activeOnly = false): UserFeed[] {
    // Read from rss_registry table (the main repository)
    const sql = activeOnly
      ? `SELECT r.id, r.name, r.feed_url as url, COALESCE(c.name, 'general') as category,
                c.icon, r.status = 'active' as is_active, 0 as sort_order, '' as color,
                r.last_check_at as last_fetch, r.error_count, r.created_at, r.updated_at
         FROM rss_registry r
         LEFT JOIN rss_categories c ON r.category_id = c.id
         WHERE r.status = 'active'
         ORDER BY c.name, r.name`
      : `SELECT r.id, r.name, r.feed_url as url, COALESCE(c.name, 'general') as category,
                c.icon, r.status = 'active' as is_active, 0 as sort_order, '' as color,
                r.last_check_at as last_fetch, r.error_count, r.created_at, r.updated_at
         FROM rss_registry r
         LEFT JOIN rss_categories c ON r.category_id = c.id
         ORDER BY c.name, r.name`;
    
    return this.db.query(sql).all() as UserFeed[];
  }

  getFeed(id: string): UserFeed | null {
    return this.db.query(`SELECT * FROM user_feeds WHERE id = ?`).get(id) as UserFeed | null;
  }

  addFeed(input: {
    name: string;
    url: string;
    category?: string;
    color?: string;
    icon?: string;
  }): UserFeed {
    const id = newId();
    const now = isoNow();

    this.db.run(
      `INSERT INTO user_feeds (id, name, url, category, icon, color, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM user_feeds), ?, ?)`,
      [id, input.name, input.url, input.category || "general", input.icon || "", input.color || "", now, now],
    );

    return this.getFeed(id)!;
  }

  updateFeed(id: string, updates: Partial<{
    name: string;
    url: string;
    category: string;
    color: string;
    icon: string;
    is_active: boolean;
    sort_order: number;
  }>): UserFeed | null {
    const feed = this.getFeed(id);
    if (!feed) return null;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.url !== undefined) {
      fields.push("url = ?");
      values.push(updates.url);
      this.cache.invalidate(id); // URL changed, invalidate cache
    }
    if (updates.category !== undefined) {
      fields.push("category = ?");
      values.push(updates.category);
    }
    if (updates.color !== undefined) {
      fields.push("color = ?");
      values.push(updates.color);
    }
    if (updates.icon !== undefined) {
      fields.push("icon = ?");
      values.push(updates.icon);
    }
    if (updates.is_active !== undefined) {
      fields.push("is_active = ?");
      values.push(updates.is_active ? 1 : 0);
    }
    if (updates.sort_order !== undefined) {
      fields.push("sort_order = ?");
      values.push(updates.sort_order);
    }

    if (fields.length === 0) return feed;

    fields.push("updated_at = ?");
    values.push(isoNow());
    values.push(id);

    this.db.run(`UPDATE user_feeds SET ${fields.join(", ")} WHERE id = ?`, values);

    return this.getFeed(id);
  }

  deleteFeed(id: string): boolean {
    const result = this.db.run(`DELETE FROM user_feeds WHERE id = ?`, [id]);
    if (result.changes > 0) {
      this.cache.invalidate(id);
      return true;
    }
    return false;
  }

  toggleFeed(id: string): UserFeed | null {
    const feed = this.getFeed(id);
    if (!feed) return null;

    const newActive = feed.is_active ? 0 : 1;
    this.db.run(`UPDATE user_feeds SET is_active = ?, updated_at = ? WHERE id = ?`, [newActive, isoNow(), id]);

    return this.getFeed(id);
  }

  // ── Categories ───────────────────────────────────────

  /**
   * List categories - reads from rss_categories (the main repository)
   */
  listCategories(): FeedCategory[] {
    return this.db.query(`
      SELECT id, name, icon, '' as color, 0 as sort_order, 1 as is_active
      FROM rss_categories
      ORDER BY name
    `).all() as FeedCategory[];
  }

  // ── News Fetching ────────────────────────────────────

  async getNews(options: {
    categories?: string[];
    limit?: number;
    forceRefresh?: boolean;
  } = {}): Promise<NewsData> {
    const { categories, limit = 100, forceRefresh = false } = options;

    // Get active feeds
    let feeds = this.listFeeds(true);
    if (categories && categories.length > 0) {
      feeds = feeds.filter((f) => categories.includes(f.category));
    }

    if (feeds.length === 0) {
      return {
        articles: [],
        feeds: this.listFeeds(true),  // Only active feeds
        categories: this.listCategories(),
        columns: this.listColumns(),
        fetchedAt: isoNow(),
        errors: [],
      };
    }

    // Fetch all feeds in parallel
    const results = await Promise.allSettled(
      feeds.map((feed) => this.fetchFeed(feed, forceRefresh)),
    );

    // Collect fresh articles and errors
    const freshArticles: NewsArticle[] = [];
    const errors: Array<{ feedId: string; feedName: string; error: string }> = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const feed = feeds[i];

      if (result.status === "fulfilled") {
        freshArticles.push(...result.value);
      } else {
        errors.push({
          feedId: feed.id,
          feedName: feed.name,
          error: result.reason?.message || String(result.reason),
        });
      }
    }

    // Persist fresh articles to Neo4j (fire-and-forget)
    this.persistToNeo4j(freshArticles).catch(() => {});

    // Load historical articles from Neo4j and merge with fresh
    const feedIds = feeds.map(f => f.id);
    const historical = await this.loadFromNeo4j(feedIds, 30, limit * 2);

    // Deduplicate by link (fresh takes priority)
    const seen = new Set<string>();
    const allArticles: NewsArticle[] = [];
    for (const a of freshArticles) {
      if (!seen.has(a.link)) {
        seen.add(a.link);
        allArticles.push(a);
      }
    }
    for (const a of historical) {
      if (!seen.has(a.link)) {
        seen.add(a.link);
        allArticles.push(a);
      }
    }

    // Sort by pubDate (newest first) and limit
    allArticles.sort((a, b) => {
      const dateA = new Date(a.pubDate).getTime() || 0;
      const dateB = new Date(b.pubDate).getTime() || 0;
      return dateB - dateA;
    });

    return {
      articles: allArticles.slice(0, limit),
      feeds: this.listFeeds(true),  // Only active feeds
      categories: this.listCategories(),
      columns: this.listColumns(),
      fetchedAt: isoNow(),
      errors,
    };
  }

  // ── Columns CRUD ─────────────────────────────────────

  listColumns(): NewsColumn[] {
    const cols = this.db.query(`
      SELECT id, name, color, icon, sort_order, is_active, created_at, updated_at
      FROM news_columns
      ORDER BY sort_order, name
    `).all() as Array<Omit<NewsColumn, 'feed_ids'>>;

    return cols.map(col => {
      const feedIds = this.db.query(`
        SELECT feed_id FROM news_column_feeds WHERE column_id = ? ORDER BY sort_order
      `).all(col.id) as Array<{ feed_id: string }>;
      return { ...col, is_active: !!col.is_active, feed_ids: feedIds.map(f => f.feed_id) };
    });
  }

  getColumn(id: string): NewsColumn | null {
    const col = this.db.query(`
      SELECT id, name, color, icon, sort_order, is_active, created_at, updated_at
      FROM news_columns WHERE id = ?
    `).get(id) as Omit<NewsColumn, 'feed_ids'> | null;
    if (!col) return null;

    const feedIds = this.db.query(`
      SELECT feed_id FROM news_column_feeds WHERE column_id = ? ORDER BY sort_order
    `).all(id) as Array<{ feed_id: string }>;
    return { ...col, is_active: !!col.is_active, feed_ids: feedIds.map(f => f.feed_id) };
  }

  createColumn(input: { name: string; color?: string; icon?: string }): NewsColumn {
    const id = newId();
    const now = isoNow();
    const maxOrder = (this.db.query(`SELECT MAX(sort_order) as m FROM news_columns`).get() as { m: number | null })?.m ?? 0;

    this.db.run(`
      INSERT INTO news_columns (id, name, color, icon, sort_order, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `, [id, input.name, input.color || '#5B9BF7', input.icon || '', maxOrder + 1, now, now]);

    return this.getColumn(id)!;
  }

  updateColumn(id: string, updates: Partial<{ name: string; color: string; icon: string; is_active: boolean; sort_order: number }>): NewsColumn | null {
    const col = this.getColumn(id);
    if (!col) return null;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
    if (updates.color !== undefined) { fields.push("color = ?"); values.push(updates.color); }
    if (updates.icon !== undefined) { fields.push("icon = ?"); values.push(updates.icon); }
    if (updates.is_active !== undefined) { fields.push("is_active = ?"); values.push(updates.is_active ? 1 : 0); }
    if (updates.sort_order !== undefined) { fields.push("sort_order = ?"); values.push(updates.sort_order); }

    if (fields.length === 0) return col;

    fields.push("updated_at = ?");
    values.push(isoNow());
    values.push(id);

    this.db.run(`UPDATE news_columns SET ${fields.join(", ")} WHERE id = ?`, values);
    return this.getColumn(id);
  }

  deleteColumn(id: string): boolean {
    const result = this.db.run(`DELETE FROM news_columns WHERE id = ?`, [id]);
    return result.changes > 0;
  }

  setColumnFeeds(columnId: string, feedIds: string[]): void {
    this.db.run(`DELETE FROM news_column_feeds WHERE column_id = ?`, [columnId]);
    const stmt = this.db.prepare(`INSERT INTO news_column_feeds (column_id, feed_id, sort_order) VALUES (?, ?, ?)`);
    for (let i = 0; i < feedIds.length; i++) {
      stmt.run(columnId, feedIds[i], i);
    }
  }

  addFeedToColumn(columnId: string, feedId: string): void {
    const maxOrder = (this.db.query(`SELECT MAX(sort_order) as m FROM news_column_feeds WHERE column_id = ?`).get(columnId) as { m: number | null })?.m ?? 0;
    this.db.run(`INSERT OR IGNORE INTO news_column_feeds (column_id, feed_id, sort_order) VALUES (?, ?, ?)`, [columnId, feedId, maxOrder + 1]);
  }

  removeFeedFromColumn(columnId: string, feedId: string): void {
    this.db.run(`DELETE FROM news_column_feeds WHERE column_id = ? AND feed_id = ?`, [columnId, feedId]);
  }

  private async fetchFeed(feed: UserFeed, forceRefresh: boolean): Promise<NewsArticle[]> {
    // Check cache first
    if (!forceRefresh) {
      const cached = this.cache.get(feed.id);
      if (cached) return cached;
    }

    try {
      const response = await fetch(feed.url, {
        signal: AbortSignal.timeout(10_000),
        headers: {
          "User-Agent": "Kernl/1.0 RSS Reader",
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const xml = await response.text();
      const articles = this.parseRss(xml, feed);

      // Update last_fetch and reset error_count
      this.db.run(
        `UPDATE user_feeds SET last_fetch = ?, error_count = 0, updated_at = ? WHERE id = ?`,
        [isoNow(), isoNow(), feed.id],
      );

      // Cache results
      this.cache.set(feed.id, articles);

      return articles;
    } catch (error) {
      // Increment error count
      this.db.run(
        `UPDATE user_feeds SET error_count = error_count + 1, updated_at = ? WHERE id = ?`,
        [isoNow(), feed.id],
      );

      log.debug(`Feed ${feed.name}: ${error}`);
      throw error;
    }
  }

  private parseRss(xml: string, feed: UserFeed): NewsArticle[] {
    const articles: NewsArticle[] = [];

    // Detect feed type and extract items
    const isAtom = xml.includes("<feed") && xml.includes("xmlns=\"http://www.w3.org/2005/Atom\"");
    
    if (isAtom) {
      return this.parseAtom(xml, feed);
    } else {
      return this.parseRss2(xml, feed);
    }
  }

  private parseRss2(xml: string, feed: UserFeed): NewsArticle[] {
    const articles: NewsArticle[] = [];
    
    // Extract items using regex (fast, no external dependency)
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const itemXml = match[1];
      
      const title = this.extractTag(itemXml, "title");
      const link = this.extractTag(itemXml, "link") || this.extractTag(itemXml, "guid");
      const description = this.extractTag(itemXml, "description") || this.extractTag(itemXml, "content:encoded");
      const pubDate = this.extractTag(itemXml, "pubDate") || this.extractTag(itemXml, "dc:date");
      const author = this.extractTag(itemXml, "author") || this.extractTag(itemXml, "dc:creator");
      
      // Try to extract image
      let imageUrl = this.extractMediaUrl(itemXml);

      if (title && link) {
        articles.push({
          id: `${feed.id}-${createHash("sha256").update(link).digest("hex").slice(0, 16)}`,
          feedId: feed.id,
          feedName: feed.name,
          feedColor: feed.color,
          category: feed.category,
          title: this.cleanHtml(title),
          description: this.cleanHtml(description || "").slice(0, 500),
          link: link.trim(),
          pubDate: this.parseDate(pubDate),
          imageUrl,
          author: author ? this.cleanHtml(author) : undefined,
        });
      }
    }

    return articles;
  }

  private parseAtom(xml: string, feed: UserFeed): NewsArticle[] {
    const articles: NewsArticle[] = [];
    
    const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
    let match;

    while ((match = entryRegex.exec(xml)) !== null) {
      const entryXml = match[1];
      
      const title = this.extractTag(entryXml, "title");
      const link = this.extractAtomLink(entryXml);
      const summary = this.extractTag(entryXml, "summary") || this.extractTag(entryXml, "content");
      const published = this.extractTag(entryXml, "published") || this.extractTag(entryXml, "updated");
      const author = this.extractAtomAuthor(entryXml);
      const imageUrl = this.extractMediaUrl(entryXml);

      if (title && link) {
        articles.push({
          id: `${feed.id}-${createHash("sha256").update(link).digest("hex").slice(0, 16)}`,
          feedId: feed.id,
          feedName: feed.name,
          feedColor: feed.color,
          category: feed.category,
          title: this.cleanHtml(title),
          description: this.cleanHtml(summary || "").slice(0, 500),
          link: link.trim(),
          pubDate: this.parseDate(published),
          imageUrl,
          author,
        });
      }
    }

    return articles;
  }

  // ── XML Helpers ──────────────────────────────────────

  private extractTag(xml: string, tag: string): string | null {
    // Handle CDATA sections
    const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, "i");
    const cdataMatch = xml.match(cdataRegex);
    if (cdataMatch) return cdataMatch[1].trim();

    // Handle regular tags
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
  }

  private extractAtomLink(xml: string): string | null {
    // Look for <link rel="alternate" href="..."> or just <link href="...">
    const linkRegex = /<link[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let match;
    
    while ((match = linkRegex.exec(xml)) !== null) {
      const fullTag = match[0];
      const href = match[1];
      
      // Prefer alternate links
      if (fullTag.includes('rel="alternate"') || !fullTag.includes("rel=")) {
        return href;
      }
    }
    
    return null;
  }

  private extractAtomAuthor(xml: string): string | undefined {
    const authorRegex = /<author[^>]*>([\s\S]*?)<\/author>/i;
    const match = xml.match(authorRegex);
    if (!match) return undefined;

    const name = this.extractTag(match[1], "name");
    return name || undefined;
  }

  private extractMediaUrl(xml: string): string | undefined {
    // Try media:content
    const mediaMatch = xml.match(/<media:content[^>]*url=["']([^"']+)["'][^>]*>/i);
    if (mediaMatch) return mediaMatch[1];

    // Try media:thumbnail
    const thumbMatch = xml.match(/<media:thumbnail[^>]*url=["']([^"']+)["'][^>]*>/i);
    if (thumbMatch) return thumbMatch[1];

    // Try enclosure (podcasts)
    const enclosureMatch = xml.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image[^"']*["'][^>]*>/i);
    if (enclosureMatch) return enclosureMatch[1];

    // Try image tag
    const imageMatch = xml.match(/<image[^>]*>[\s\S]*?<url>([^<]+)<\/url>/i);
    if (imageMatch) return imageMatch[1].trim();

    // Try to find og:image in description
    const ogMatch = xml.match(/og:image["'][^>]*content=["']([^"']+)["']/i);
    if (ogMatch) return ogMatch[1];

    // Try img src in content
    const imgMatch = xml.match(/<img[^>]*src=["']([^"']+)["'][^>]*>/i);
    if (imgMatch) {
      const src = imgMatch[1];
      if (src.startsWith("http")) return src;
    }

    return undefined;
  }

  private cleanHtml(html: string): string {
    return html
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1") // Remove CDATA wrappers
      .replace(/<[^>]+>/g, "") // Remove HTML tags
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
      .replace(/\s+/g, " ")
      .trim();
  }

  private parseDate(dateStr: string | null): string {
    if (!dateStr) return new Date().toISOString();

    try {
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return date.toISOString();
      }
    } catch {
      // Fall through
    }

    return new Date().toISOString();
  }

  // ── Cache Management ─────────────────────────────────

  refreshCache(): void {
    this.cache.clear();
  }
}
