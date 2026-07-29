import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const youtubeMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS youtube_accounts (
        id              TEXT PRIMARY KEY,
        channel_id      TEXT NOT NULL UNIQUE,
        channel_title   TEXT NOT NULL DEFAULT '',
        client_id       TEXT NOT NULL DEFAULT '',
        client_secret   TEXT NOT NULL DEFAULT '',
        refresh_token   TEXT NOT NULL DEFAULT '',
        access_token    TEXT NOT NULL DEFAULT '',
        token_expires_at TEXT,
        role            TEXT NOT NULL DEFAULT 'brand'
                        CHECK(role IN ('brand','founder','community','other')),
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','disabled','suspended')),
        subscribers     INTEGER NOT NULL DEFAULT 0,
        total_views     INTEGER NOT NULL DEFAULT 0,
        total_videos    INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS youtube_videos (
        id              TEXT PRIMARY KEY,
        account_id      TEXT NOT NULL REFERENCES youtube_accounts(id) ON DELETE CASCADE,
        video_id        TEXT NOT NULL DEFAULT '',
        title           TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        tags            TEXT NOT NULL DEFAULT '',
        category_id     TEXT NOT NULL DEFAULT '22',
        privacy         TEXT NOT NULL DEFAULT 'private'
                        CHECK(privacy IN ('public','unlisted','private')),
        status          TEXT NOT NULL DEFAULT 'draft'
                        CHECK(status IN ('draft','uploading','uploaded','failed')),
        file_path       TEXT NOT NULL DEFAULT '',
        upload_url      TEXT NOT NULL DEFAULT '',
        views           INTEGER NOT NULL DEFAULT 0,
        likes           INTEGER NOT NULL DEFAULT 0,
        comments_count  INTEGER NOT NULL DEFAULT 0,
        published_at    TEXT,
        error           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_youtube_videos_account ON youtube_videos(account_id);
      CREATE INDEX IF NOT EXISTS idx_youtube_videos_status ON youtube_videos(status);
      CREATE INDEX IF NOT EXISTS idx_youtube_videos_video_id ON youtube_videos(video_id);
    `,
  },
];
