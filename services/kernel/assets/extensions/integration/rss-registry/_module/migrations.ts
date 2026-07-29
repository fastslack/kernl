import type { Migration } from "../../../../../src/core/db/migrations.js";

export const rssRegistryMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS rss_categories (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        icon        TEXT NOT NULL DEFAULT '',
        parent_id   TEXT REFERENCES rss_categories(id) ON DELETE SET NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rss_categories_parent ON rss_categories(parent_id);

      CREATE TABLE IF NOT EXISTS rss_registry (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        slug             TEXT NOT NULL UNIQUE,
        description      TEXT NOT NULL DEFAULT '',
        category_id      TEXT REFERENCES rss_categories(id) ON DELETE SET NULL,
        feed_url         TEXT NOT NULL,
        website_url      TEXT NOT NULL DEFAULT '',
        language         TEXT NOT NULL DEFAULT 'en',
        country          TEXT NOT NULL DEFAULT '',
        update_frequency TEXT NOT NULL DEFAULT 'hourly'
                         CHECK(update_frequency IN ('realtime','hourly','daily','weekly')),
        status           TEXT NOT NULL DEFAULT 'active'
                         CHECK(status IN ('active','disabled','error','dead')),
        last_check_at    TEXT,
        last_check_ok    INTEGER,
        last_item_at     TEXT,
        item_count       INTEGER NOT NULL DEFAULT 0,
        error_count      INTEGER NOT NULL DEFAULT 0,
        error_message    TEXT NOT NULL DEFAULT '',
        tags             TEXT NOT NULL DEFAULT '',
        quality_score    INTEGER NOT NULL DEFAULT 50,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rss_registry_category ON rss_registry(category_id);
      CREATE INDEX IF NOT EXISTS idx_rss_registry_status ON rss_registry(status);
      CREATE INDEX IF NOT EXISTS idx_rss_registry_slug ON rss_registry(slug);
      CREATE INDEX IF NOT EXISTS idx_rss_registry_language ON rss_registry(language);
      CREATE INDEX IF NOT EXISTS idx_rss_registry_quality ON rss_registry(quality_score);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS rss_items (
        id            TEXT PRIMARY KEY,
        feed_id       TEXT NOT NULL REFERENCES rss_registry(id) ON DELETE CASCADE,
        guid          TEXT NOT NULL DEFAULT '',
        title         TEXT NOT NULL DEFAULT '',
        link          TEXT NOT NULL DEFAULT '',
        author        TEXT NOT NULL DEFAULT '',
        description   TEXT NOT NULL DEFAULT '',
        content       TEXT NOT NULL DEFAULT '',
        image_url     TEXT NOT NULL DEFAULT '',
        published_at  TEXT,
        fetched_at    TEXT NOT NULL,
        hash          TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_rss_items_feed_hash ON rss_items(feed_id, hash);
      CREATE INDEX IF NOT EXISTS idx_rss_items_feed ON rss_items(feed_id);
      CREATE INDEX IF NOT EXISTS idx_rss_items_published ON rss_items(published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_rss_items_fetched ON rss_items(fetched_at DESC);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE rss_registry ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_rss_registry_cat_order ON rss_registry(category_id, sort_order);
    `,
  },
];
