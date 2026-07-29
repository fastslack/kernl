import type { Migration } from "../../../../../src/core/db/migrations.js";

export const issuesMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS issue_tokens (
        provider    TEXT PRIMARY KEY CHECK(provider IN ('github','gitlab')),
        token       TEXT NOT NULL,
        base_url    TEXT NOT NULL DEFAULT '',
        username    TEXT NOT NULL DEFAULT '',
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issues (
        id              TEXT PRIMARY KEY,
        provider        TEXT NOT NULL CHECK(provider IN ('github','gitlab')),
        external_id     TEXT NOT NULL,
        external_number INTEGER NOT NULL,
        repo            TEXT NOT NULL,
        title           TEXT NOT NULL,
        body            TEXT NOT NULL DEFAULT '',
        state           TEXT NOT NULL DEFAULT 'open'
                        CHECK(state IN ('open','closed','merged')),
        author          TEXT NOT NULL DEFAULT '',
        assignees       TEXT NOT NULL DEFAULT '',
        milestone       TEXT NOT NULL DEFAULT '',
        is_pull_request INTEGER NOT NULL DEFAULT 0,
        url             TEXT NOT NULL DEFAULT '',
        time_estimate   INTEGER NOT NULL DEFAULT 0,
        time_spent      INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        closed_at       TEXT,
        synced_at       TEXT NOT NULL,
        raw_json        TEXT NOT NULL DEFAULT '',
        UNIQUE(provider, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo);
      CREATE INDEX IF NOT EXISTS idx_issues_state ON issues(state);
      CREATE INDEX IF NOT EXISTS idx_issues_provider ON issues(provider);

      CREATE TABLE IF NOT EXISTS issue_labels (
        issue_id  TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        label     TEXT NOT NULL,
        color     TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(issue_id, label)
      );

      CREATE TABLE IF NOT EXISTS issue_time_entries (
        id          TEXT PRIMARY KEY,
        issue_id    TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        duration    INTEGER NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        logged_at   TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issue_sync_meta (
        provider      TEXT NOT NULL,
        repo          TEXT NOT NULL,
        last_sync_at  TEXT NOT NULL,
        items_synced  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(provider, repo)
      );
    `,
  },
];
