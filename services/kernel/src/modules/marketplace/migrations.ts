import type { Migration } from "../../core/db/migrations.js";

/**
 * Consolidated initial schema for the `marketplace` extension.
 *
 * Previously v2 rebuilt `marketplace_items` just to widen the `type` CHECK
 * constraint to include 'channel'. Merged into v1.
 *
 * Forward-only: add new changes as v2+, never edit this in place.
 */
export const marketplaceMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- Distributable items (extensions, agents, flows, themes, templates, channels).
      CREATE TABLE IF NOT EXISTS marketplace_items (
        id                 TEXT PRIMARY KEY,
        type               TEXT NOT NULL CHECK(type IN ('extension','agent','flow','theme','template','channel')),
        slug               TEXT NOT NULL UNIQUE,
        name               TEXT NOT NULL,
        description        TEXT NOT NULL DEFAULT '',
        long_description   TEXT NOT NULL DEFAULT '',
        version            TEXT NOT NULL DEFAULT '1.0.0',
        author             TEXT NOT NULL DEFAULT 'Kernl',
        author_url         TEXT NOT NULL DEFAULT '',
        icon               TEXT NOT NULL DEFAULT '',
        category           TEXT NOT NULL DEFAULT 'utility',
        tags               TEXT NOT NULL DEFAULT '[]',
        license            TEXT NOT NULL DEFAULT 'MIT',
        price_cents        INTEGER NOT NULL DEFAULT 0,
        currency           TEXT NOT NULL DEFAULT 'EUR',
        source_type        TEXT NOT NULL DEFAULT 'bundled'
                           CHECK(source_type IN ('bundled','local','import','community')),
        source_ref         TEXT NOT NULL DEFAULT '',
        package_data       TEXT NOT NULL DEFAULT '{}',
        min_kernel_version TEXT NOT NULL DEFAULT '',
        dependencies       TEXT NOT NULL DEFAULT '[]',
        install_count      INTEGER NOT NULL DEFAULT 0,
        avg_rating         REAL NOT NULL DEFAULT 0,
        review_count       INTEGER NOT NULL DEFAULT 0,
        status             TEXT NOT NULL DEFAULT 'available'
                           CHECK(status IN ('available','installed','active','disabled')),
        installed_at       TEXT,
        installed_version  TEXT NOT NULL DEFAULT '',
        featured           INTEGER NOT NULL DEFAULT 0,
        verified           INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mkt_type     ON marketplace_items(type);
      CREATE INDEX IF NOT EXISTS idx_mkt_status   ON marketplace_items(status);
      CREATE INDEX IF NOT EXISTS idx_mkt_category ON marketplace_items(category);

      -- User-authored reviews / ratings for an item.
      CREATE TABLE IF NOT EXISTS marketplace_reviews (
        id         TEXT PRIMARY KEY,
        item_id    TEXT NOT NULL REFERENCES marketplace_items(id) ON DELETE CASCADE,
        rating     INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        title      TEXT NOT NULL DEFAULT '',
        body       TEXT NOT NULL DEFAULT '',
        author     TEXT NOT NULL DEFAULT 'local',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mkt_review_item ON marketplace_reviews(item_id);

      -- Purchase ledger (also records free installs with payment_method='free').
      CREATE TABLE IF NOT EXISTS marketplace_purchases (
        id             TEXT PRIMARY KEY,
        item_id        TEXT NOT NULL REFERENCES marketplace_items(id) ON DELETE CASCADE,
        price_cents    INTEGER NOT NULL,
        currency       TEXT NOT NULL DEFAULT 'EUR',
        payment_method TEXT NOT NULL DEFAULT 'free',
        receipt_data   TEXT NOT NULL DEFAULT '{}',
        purchased_at   TEXT NOT NULL,
        refunded_at    TEXT
      );

      -- Applied visual theme (CSS variables + fonts + custom CSS).
      CREATE TABLE IF NOT EXISTS marketplace_themes (
        id             TEXT PRIMARY KEY,
        item_id        TEXT NOT NULL REFERENCES marketplace_items(id) ON DELETE CASCADE,
        active         INTEGER NOT NULL DEFAULT 0,
        variables      TEXT NOT NULL DEFAULT '{}',
        fonts          TEXT NOT NULL DEFAULT '[]',
        custom_css     TEXT NOT NULL DEFAULT '',
        preview_colors TEXT NOT NULL DEFAULT '[]',
        applied_at     TEXT
      );
    `,
  },
  {
    // v2 — Subscribed catalog repos. Each row registers a remote git repo
    // (Anthropic skills convention or our own .kernl layout). On boot, every
    // row is re-registered as a GitCatalogProvider so subscriptions survive
    // restarts. Manual + scheduled sync-all updates last_synced_at +
    // items_found, the latter for the dashboard counter.
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS catalog_repos (
        id              TEXT PRIMARY KEY,
        url             TEXT NOT NULL UNIQUE,
        ref             TEXT NOT NULL DEFAULT '',
        name            TEXT NOT NULL DEFAULT '',
        description     TEXT NOT NULL DEFAULT '',
        items_found     INTEGER NOT NULL DEFAULT 0,
        sync_error      TEXT NOT NULL DEFAULT '',
        last_synced_at  TEXT,
        added_at        TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_catalog_repos_url ON catalog_repos(url);
    `,
  },
];
