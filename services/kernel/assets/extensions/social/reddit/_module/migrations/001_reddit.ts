import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const redditMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS reddit_accounts (
        id              TEXT PRIMARY KEY,
        username        TEXT NOT NULL UNIQUE,
        client_id       TEXT NOT NULL DEFAULT '',
        client_secret   TEXT NOT NULL DEFAULT '',
        password        TEXT NOT NULL DEFAULT '',
        user_agent      TEXT NOT NULL DEFAULT 'kernl/1.0',
        access_token    TEXT NOT NULL DEFAULT '',
        token_expires_at TEXT,
        role            TEXT NOT NULL DEFAULT 'founder'
                        CHECK(role IN ('brand','founder','community','other')),
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','disabled','locked','banned')),
        karma_comment   INTEGER NOT NULL DEFAULT 0,
        karma_post      INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reddit_posts (
        id              TEXT PRIMARY KEY,
        account_id      TEXT NOT NULL REFERENCES reddit_accounts(id) ON DELETE CASCADE,
        subreddit       TEXT NOT NULL,
        title           TEXT NOT NULL,
        body            TEXT NOT NULL DEFAULT '',
        url             TEXT NOT NULL DEFAULT '',
        kind            TEXT NOT NULL DEFAULT 'self'
                        CHECK(kind IN ('self','link','image')),
        status          TEXT NOT NULL DEFAULT 'draft'
                        CHECK(status IN ('draft','scheduled','published','failed','removed')),
        scheduled_for   TEXT,
        published_at    TEXT,
        reddit_id       TEXT NOT NULL DEFAULT '',
        permalink       TEXT NOT NULL DEFAULT '',
        upvotes         INTEGER NOT NULL DEFAULT 0,
        comments_count  INTEGER NOT NULL DEFAULT 0,
        error           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_reddit_posts_account ON reddit_posts(account_id);
      CREATE INDEX IF NOT EXISTS idx_reddit_posts_status ON reddit_posts(status);
      CREATE INDEX IF NOT EXISTS idx_reddit_posts_subreddit ON reddit_posts(subreddit);
      CREATE INDEX IF NOT EXISTS idx_reddit_posts_scheduled ON reddit_posts(scheduled_for);
    `,
  },
];
