import type { Migration } from "../../../../../src/core/db/migrations.js";

export const twitterMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS twitter_accounts (
        id            TEXT PRIMARY KEY,
        handle        TEXT NOT NULL,
        display_name  TEXT NOT NULL DEFAULT '',
        api_key       TEXT NOT NULL DEFAULT '',
        api_secret    TEXT NOT NULL DEFAULT '',
        access_token  TEXT NOT NULL DEFAULT '',
        access_secret TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'active'
                      CHECK(status IN ('active','paused','suspended')),
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_twitter_accounts_handle ON twitter_accounts(handle);

      CREATE TABLE IF NOT EXISTS twitter_posts (
        id                  TEXT PRIMARY KEY,
        account_id          TEXT NOT NULL REFERENCES twitter_accounts(id) ON DELETE CASCADE,
        content             TEXT NOT NULL DEFAULT '',
        post_type           TEXT NOT NULL DEFAULT 'tweet'
                            CHECK(post_type IN ('tweet','reply','thread','quote')),
        status              TEXT NOT NULL DEFAULT 'draft'
                            CHECK(status IN ('draft','queued','approved','posted','failed')),
        scheduled_at        TEXT,
        posted_at           TEXT,
        x_post_id           TEXT NOT NULL DEFAULT '',
        reply_to_x_id       TEXT NOT NULL DEFAULT '',
        quote_x_id          TEXT NOT NULL DEFAULT '',
        metrics_impressions INTEGER NOT NULL DEFAULT 0,
        metrics_likes       INTEGER NOT NULL DEFAULT 0,
        metrics_retweets    INTEGER NOT NULL DEFAULT 0,
        metrics_replies     INTEGER NOT NULL DEFAULT 0,
        error_message       TEXT NOT NULL DEFAULT '',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_twitter_posts_account ON twitter_posts(account_id);
      CREATE INDEX IF NOT EXISTS idx_twitter_posts_status ON twitter_posts(status);
      CREATE INDEX IF NOT EXISTS idx_twitter_posts_scheduled ON twitter_posts(scheduled_at);

      CREATE TABLE IF NOT EXISTS twitter_mentions (
        id            TEXT PRIMARY KEY,
        account_id    TEXT NOT NULL REFERENCES twitter_accounts(id) ON DELETE CASCADE,
        x_post_id     TEXT NOT NULL DEFAULT '',
        author_handle TEXT NOT NULL DEFAULT '',
        author_name   TEXT NOT NULL DEFAULT '',
        content       TEXT NOT NULL DEFAULT '',
        replied       INTEGER NOT NULL DEFAULT 0,
        reply_post_id TEXT REFERENCES twitter_posts(id) ON DELETE SET NULL,
        detected_at   TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_twitter_mentions_account ON twitter_mentions(account_id);
      CREATE INDEX IF NOT EXISTS idx_twitter_mentions_replied ON twitter_mentions(replied);

      CREATE TABLE IF NOT EXISTS twitter_metrics_snapshots (
        id            TEXT PRIMARY KEY,
        account_id    TEXT NOT NULL REFERENCES twitter_accounts(id) ON DELETE CASCADE,
        followers     INTEGER NOT NULL DEFAULT 0,
        following     INTEGER NOT NULL DEFAULT 0,
        tweets_count  INTEGER NOT NULL DEFAULT 0,
        snapshot_date TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_twitter_metrics_account_date ON twitter_metrics_snapshots(account_id, snapshot_date);
    `,
  },
  {
    version: 2,
    sql: `
      -- Multi-driver support + cookie-based auth (xactions) for twitter_accounts.
      -- 'api'      = oficial X API via api_key/api_secret/access_token/access_secret
      -- 'xactions' = browser-driven via x_login(cookie); auth_cookie_ref points to a vault key.
      ALTER TABLE twitter_accounts ADD COLUMN driver TEXT NOT NULL DEFAULT 'api'
        CHECK(driver IN ('api','xactions'));
      ALTER TABLE twitter_accounts ADD COLUMN auth_cookie_ref TEXT NOT NULL DEFAULT '';
      ALTER TABLE twitter_accounts ADD COLUMN last_login_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE twitter_accounts ADD COLUMN voice_persona TEXT NOT NULL DEFAULT '';
      ALTER TABLE twitter_accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'brand'
        CHECK(role IN ('brand','founder','community','support','other'));
      ALTER TABLE twitter_accounts ADD COLUMN partner_account_id TEXT NOT NULL DEFAULT '';

      -- Campaign metadata for each post: which format/signal/phase it targets,
      -- and whether it came from a scripted anchor (1) or was free-generated (0).
      ALTER TABLE twitter_posts ADD COLUMN format TEXT NOT NULL DEFAULT '';
      ALTER TABLE twitter_posts ADD COLUMN signal_target TEXT NOT NULL DEFAULT '';
      ALTER TABLE twitter_posts ADD COLUMN phase TEXT NOT NULL DEFAULT '';
      ALTER TABLE twitter_posts ADD COLUMN campaign_anchor INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE twitter_posts ADD COLUMN audit_score INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE twitter_posts ADD COLUMN audit_notes TEXT NOT NULL DEFAULT '';
      ALTER TABLE twitter_posts ADD COLUMN parent_post_id TEXT REFERENCES twitter_posts(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_twitter_posts_phase ON twitter_posts(phase);
      CREATE INDEX IF NOT EXISTS idx_twitter_posts_anchor ON twitter_posts(campaign_anchor);

      -- Per-post rolling KPI snapshots: OON %, mute rate, engagement rate, etc.
      -- Used by Engagement Tracker for embedding-drift detection.
      CREATE TABLE IF NOT EXISTS twitter_post_analytics (
        id              TEXT PRIMARY KEY,
        post_id         TEXT NOT NULL REFERENCES twitter_posts(id) ON DELETE CASCADE,
        snapshot_at     TEXT NOT NULL,
        impressions     INTEGER NOT NULL DEFAULT 0,
        oon_impressions INTEGER NOT NULL DEFAULT 0,
        oon_pct         REAL NOT NULL DEFAULT 0,
        likes           INTEGER NOT NULL DEFAULT 0,
        retweets        INTEGER NOT NULL DEFAULT 0,
        replies         INTEGER NOT NULL DEFAULT 0,
        quotes          INTEGER NOT NULL DEFAULT 0,
        bookmarks       INTEGER NOT NULL DEFAULT 0,
        profile_clicks  INTEGER NOT NULL DEFAULT 0,
        mute_count      INTEGER NOT NULL DEFAULT 0,
        block_count     INTEGER NOT NULL DEFAULT 0,
        mute_rate       REAL NOT NULL DEFAULT 0,
        engagement_rate REAL NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_twitter_post_analytics_post ON twitter_post_analytics(post_id, snapshot_at);

      -- Account-wide rolling phase + crisis state. One row per account; phase changes
      -- when Engagement Tracker triggers crisis_recovery or campaign timeline advances.
      CREATE TABLE IF NOT EXISTS twitter_account_state (
        account_id           TEXT PRIMARY KEY REFERENCES twitter_accounts(id) ON DELETE CASCADE,
        phase                TEXT NOT NULL DEFAULT 'seeding'
                             CHECK(phase IN ('foundation','seeding','authority','launch','capitalize','sustain','crisis_recovery','idle')),
        phase_started_at     TEXT NOT NULL DEFAULT '',
        oon_pct_7d           REAL NOT NULL DEFAULT 0,
        mute_rate_7d         REAL NOT NULL DEFAULT 0,
        crisis_triggered_at  TEXT NOT NULL DEFAULT '',
        updated_at           TEXT NOT NULL
      );
    `,
  },
];
