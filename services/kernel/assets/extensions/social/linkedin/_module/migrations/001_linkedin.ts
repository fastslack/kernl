import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const linkedinMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS linkedin_accounts (
        id              TEXT PRIMARY KEY,
        urn             TEXT NOT NULL UNIQUE,
        display_name    TEXT NOT NULL DEFAULT '',
        account_type    TEXT NOT NULL DEFAULT 'person'
                        CHECK(account_type IN ('person','organization')),
        client_id       TEXT NOT NULL DEFAULT '',
        client_secret   TEXT NOT NULL DEFAULT '',
        access_token    TEXT NOT NULL DEFAULT '',
        refresh_token   TEXT NOT NULL DEFAULT '',
        token_expires_at TEXT,
        role            TEXT NOT NULL DEFAULT 'founder'
                        CHECK(role IN ('brand','founder','community','other')),
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','disabled','suspended')),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS linkedin_posts (
        id              TEXT PRIMARY KEY,
        account_id      TEXT NOT NULL REFERENCES linkedin_accounts(id) ON DELETE CASCADE,
        text            TEXT NOT NULL DEFAULT '',
        kind            TEXT NOT NULL DEFAULT 'text'
                        CHECK(kind IN ('text','article','image')),
        article_url     TEXT NOT NULL DEFAULT '',
        article_title   TEXT NOT NULL DEFAULT '',
        article_desc    TEXT NOT NULL DEFAULT '',
        image_path      TEXT NOT NULL DEFAULT '',
        visibility      TEXT NOT NULL DEFAULT 'PUBLIC'
                        CHECK(visibility IN ('PUBLIC','CONNECTIONS','LOGGED_IN')),
        status          TEXT NOT NULL DEFAULT 'draft'
                        CHECK(status IN ('draft','scheduled','published','failed')),
        scheduled_for   TEXT,
        published_at    TEXT,
        post_urn        TEXT NOT NULL DEFAULT '',
        impressions     INTEGER NOT NULL DEFAULT 0,
        likes           INTEGER NOT NULL DEFAULT 0,
        comments_count  INTEGER NOT NULL DEFAULT 0,
        shares          INTEGER NOT NULL DEFAULT 0,
        error           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_linkedin_posts_account ON linkedin_posts(account_id);
      CREATE INDEX IF NOT EXISTS idx_linkedin_posts_status ON linkedin_posts(status);
      CREATE INDEX IF NOT EXISTS idx_linkedin_posts_scheduled ON linkedin_posts(scheduled_for);
    `,
  },
];
