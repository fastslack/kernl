/**
 * News/RSS Feed Migrations
 * 
 * User-configurable RSS feeds for the dashboard news panel.
 */

import type { Migration } from "../../../../../src/core/db/migrations.js";

export const newsMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS user_feeds (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        url         TEXT NOT NULL UNIQUE,
        category    TEXT NOT NULL DEFAULT 'general',
        is_active   INTEGER NOT NULL DEFAULT 1,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        icon        TEXT NOT NULL DEFAULT '',
        color       TEXT NOT NULL DEFAULT '',
        last_fetch  TEXT,
        error_count INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_feeds_active ON user_feeds(is_active);
      CREATE INDEX IF NOT EXISTS idx_user_feeds_category ON user_feeds(category);

      CREATE TABLE IF NOT EXISTS feed_categories (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        icon        TEXT NOT NULL DEFAULT '',
        color       TEXT NOT NULL DEFAULT '',
        sort_order  INTEGER NOT NULL DEFAULT 0,
        is_active   INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      -- News columns/streams (up to 6 user-configurable)
      CREATE TABLE IF NOT EXISTS news_columns (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        color       TEXT NOT NULL DEFAULT '#5B9BF7',
        icon        TEXT NOT NULL DEFAULT '',
        sort_order  INTEGER NOT NULL DEFAULT 0,
        is_active   INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      -- Junction table: which feeds appear in which columns
      CREATE TABLE IF NOT EXISTS news_column_feeds (
        column_id   TEXT NOT NULL REFERENCES news_columns(id) ON DELETE CASCADE,
        feed_id     TEXT NOT NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (column_id, feed_id)
      );
      CREATE INDEX IF NOT EXISTS idx_news_column_feeds_column ON news_column_feeds(column_id);
      CREATE INDEX IF NOT EXISTS idx_news_column_feeds_feed ON news_column_feeds(feed_id);
    `,
  },
];

/**
 * Seed default categories and feeds.
 * Called after migrations in module init.
 */
export function seedDefaultFeeds(db: import("bun:sqlite").Database): void {
  const now = new Date().toISOString();

  // Seed categories
  const categories = [
    { id: "world", name: "World News", icon: "globe", color: "#3b82f6", sort: 1 },
    { id: "tech", name: "Technology", icon: "cpu", color: "#8b5cf6", sort: 2 },
    { id: "science", name: "Science", icon: "flask", color: "#10b981", sort: 3 },
    { id: "business", name: "Business", icon: "briefcase", color: "#f59e0b", sort: 4 },
    { id: "sports", name: "Sports", icon: "trophy", color: "#ef4444", sort: 5 },
    { id: "entertainment", name: "Entertainment", icon: "film", color: "#ec4899", sort: 6 },
    { id: "dev", name: "Development", icon: "code", color: "#06b6d4", sort: 7 },
    { id: "ai", name: "AI & ML", icon: "brain", color: "#a855f7", sort: 8 },
    { id: "crypto", name: "Crypto", icon: "bitcoin", color: "#f97316", sort: 9 },
    { id: "general", name: "General", icon: "rss", color: "#6b7280", sort: 99 },
  ];

  const catStmt = db.prepare(`
    INSERT OR IGNORE INTO feed_categories (id, name, icon, color, sort_order, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `);

  for (const cat of categories) {
    catStmt.run(cat.id, cat.name, cat.icon, cat.color, cat.sort, now);
  }

  // Seed default feeds - World News + Technology + Dev
  const defaultFeeds = [
    // World News
    { name: "BBC News", url: "https://feeds.bbci.co.uk/news/world/rss.xml", category: "world", color: "#bb1919" },
    { name: "Reuters", url: "https://www.reutersagency.com/feed/?best-regions=europe&post_type=best", category: "world", color: "#ff8000" },
    { name: "The Guardian", url: "https://www.theguardian.com/world/rss", category: "world", color: "#052962" },
    { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", category: "world", color: "#fa9000" },
    { name: "NPR News", url: "https://feeds.npr.org/1001/rss.xml", category: "world", color: "#5a82aa" },
    
    // Technology
    { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", category: "tech", color: "#ff4e00" },
    { name: "The Verge", url: "https://www.theverge.com/rss/index.xml", category: "tech", color: "#e5127d" },
    { name: "TechCrunch", url: "https://techcrunch.com/feed/", category: "tech", color: "#0a9e01" },
    { name: "Wired", url: "https://www.wired.com/feed/rss", category: "tech", color: "#000000" },
    { name: "MIT Tech Review", url: "https://www.technologyreview.com/feed/", category: "tech", color: "#a31d1d" },
    
    // Development
    { name: "Hacker News", url: "https://hnrss.org/frontpage", category: "dev", color: "#ff6600" },
    { name: "Dev.to", url: "https://dev.to/feed", category: "dev", color: "#0a0a0a" },
    { name: "Lobsters", url: "https://lobste.rs/rss", category: "dev", color: "#9c0000" },
    
    // AI & ML
    { name: "AI News", url: "https://www.artificialintelligence-news.com/feed/", category: "ai", color: "#4f46e5" },
    { name: "MIT AI News", url: "https://news.mit.edu/rss/topic/artificial-intelligence2", category: "ai", color: "#a31f34" },
  ];

  const feedStmt = db.prepare(`
    INSERT OR IGNORE INTO user_feeds (id, name, url, category, icon, color, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', ?, 1, ?, ?, ?)
  `);

  for (let i = 0; i < defaultFeeds.length; i++) {
    const feed = defaultFeeds[i];
    const id = `feed-${feed.category}-${i + 1}`;
    feedStmt.run(id, feed.name, feed.url, feed.category, feed.color, i + 1, now, now);
  }
}
