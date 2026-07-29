import type { Migration } from "../../../../../src/core/db/migrations.js";

export const triageMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS triage_targets (
        id                  TEXT PRIMARY KEY,
        repo                TEXT NOT NULL UNIQUE,
        default_branch      TEXT NOT NULL DEFAULT 'main',
        enabled             INTEGER NOT NULL DEFAULT 1,
        github_app_id       TEXT NOT NULL DEFAULT '',
        github_app_key      TEXT NOT NULL DEFAULT '',
        last_sync_at        TEXT,
        last_sync_ok        INTEGER,
        last_error          TEXT NOT NULL DEFAULT '',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        deleted_at          TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_triage_targets_enabled ON triage_targets(enabled, deleted_at);

      CREATE TABLE IF NOT EXISTS triage_items (
        id                  TEXT PRIMARY KEY,
        target_id           TEXT NOT NULL REFERENCES triage_targets(id) ON DELETE CASCADE,
        number              INTEGER NOT NULL,
        kind                TEXT NOT NULL CHECK(kind IN ('issue','pull_request')),
        title               TEXT NOT NULL DEFAULT '',
        author              TEXT NOT NULL DEFAULT '',
        author_association  TEXT NOT NULL DEFAULT 'NONE',
        labels_json         TEXT NOT NULL DEFAULT '[]',
        state               TEXT NOT NULL DEFAULT 'open',
        item_created_at     TEXT NOT NULL,
        item_updated_at     TEXT NOT NULL,
        snapshot_hash       TEXT NOT NULL DEFAULT '',
        last_seen_at        TEXT NOT NULL,
        last_reviewed_at    TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        deleted_at          TEXT,
        UNIQUE(target_id, number)
      );

      CREATE INDEX IF NOT EXISTS idx_triage_items_target_state ON triage_items(target_id, state, deleted_at);
      CREATE INDEX IF NOT EXISTS idx_triage_items_due ON triage_items(last_reviewed_at, item_updated_at);
      CREATE INDEX IF NOT EXISTS idx_triage_items_kind ON triage_items(kind);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE triage_targets ADD COLUMN github_installation_id TEXT NOT NULL DEFAULT '';
      -- Note: superseded by v3 (provider-agnostic refactor). Columns are
      -- preserved here for migration ordering but will be dropped in v3.

      CREATE TABLE IF NOT EXISTS triage_reviews (
        id                       TEXT PRIMARY KEY,
        item_id                  TEXT NOT NULL REFERENCES triage_items(id) ON DELETE CASCADE,
        decision                 TEXT NOT NULL CHECK(decision IN ('close','keep_open')),
        close_reason             TEXT NOT NULL DEFAULT 'none',
        confidence               TEXT NOT NULL CHECK(confidence IN ('high','medium','low')),
        summary                  TEXT NOT NULL DEFAULT '',
        best_solution            TEXT NOT NULL DEFAULT '',
        evidence_json            TEXT NOT NULL DEFAULT '[]',
        risks_json               TEXT NOT NULL DEFAULT '[]',
        close_comment            TEXT NOT NULL DEFAULT '',
        fixed_release            TEXT NOT NULL DEFAULT '',
        fixed_sha                TEXT NOT NULL DEFAULT '',
        snapshot_hash_at_review  TEXT NOT NULL,
        policy_hash              TEXT NOT NULL,
        model                    TEXT NOT NULL DEFAULT '',
        reasoning_effort         TEXT NOT NULL DEFAULT '',
        status                   TEXT NOT NULL DEFAULT 'proposed'
                                 CHECK(status IN ('proposed','applied','skipped_changed','failed','superseded')),
        applied_at               TEXT,
        comment_id               TEXT NOT NULL DEFAULT '',
        comment_url              TEXT NOT NULL DEFAULT '',
        error                    TEXT NOT NULL DEFAULT '',
        reviewed_at              TEXT NOT NULL,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_triage_reviews_item ON triage_reviews(item_id);
      CREATE INDEX IF NOT EXISTS idx_triage_reviews_status ON triage_reviews(status, reviewed_at);
      CREATE INDEX IF NOT EXISTS idx_triage_reviews_policy ON triage_reviews(policy_hash);
    `,
  },
  {
    version: 3,
    sql: `
      -- Drop GitHub-specific credential columns and replace with a generic
      -- (provider, connection_config_json) pair so any repo host can plug in
      -- via a channel extension.
      CREATE TABLE triage_targets_new (
        id                    TEXT PRIMARY KEY,
        provider              TEXT NOT NULL DEFAULT 'github',
        repo                  TEXT NOT NULL,
        default_branch        TEXT NOT NULL DEFAULT 'main',
        enabled               INTEGER NOT NULL DEFAULT 1,
        connection_config_json TEXT NOT NULL DEFAULT '{}',
        last_sync_at          TEXT,
        last_sync_ok          INTEGER,
        last_error            TEXT NOT NULL DEFAULT '',
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        deleted_at            TEXT,
        UNIQUE(provider, repo)
      );

      INSERT INTO triage_targets_new
        (id, provider, repo, default_branch, enabled, connection_config_json,
         last_sync_at, last_sync_ok, last_error, created_at, updated_at, deleted_at)
      SELECT
        id,
        'github',
        repo,
        default_branch,
        enabled,
        json_object(
          'app_id', github_app_id,
          'private_key_pem', github_app_key,
          'installation_id', github_installation_id
        ),
        last_sync_at, last_sync_ok, last_error, created_at, updated_at, deleted_at
      FROM triage_targets;

      DROP TABLE triage_targets;
      ALTER TABLE triage_targets_new RENAME TO triage_targets;

      CREATE INDEX IF NOT EXISTS idx_triage_targets_enabled ON triage_targets(enabled, deleted_at);
      CREATE INDEX IF NOT EXISTS idx_triage_targets_provider ON triage_targets(provider);
    `,
  },
  {
    version: 4,
    sql: `
      -- Connections move OUT of triage_targets and INTO each channel extension
      -- (github_connections, gitlab_connections). Targets only reference the
      -- connection by id; the channel resolves it.
      CREATE TABLE triage_targets_new (
        id              TEXT PRIMARY KEY,
        provider        TEXT NOT NULL,
        connection_id   TEXT NOT NULL DEFAULT '',
        repo            TEXT NOT NULL,
        default_branch  TEXT NOT NULL DEFAULT 'main',
        enabled         INTEGER NOT NULL DEFAULT 1,
        last_sync_at    TEXT,
        last_sync_ok    INTEGER,
        last_error      TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        deleted_at      TEXT,
        UNIQUE(provider, repo)
      );

      INSERT INTO triage_targets_new
        (id, provider, connection_id, repo, default_branch, enabled,
         last_sync_at, last_sync_ok, last_error, created_at, updated_at, deleted_at)
      SELECT
        id, provider, '', repo, default_branch, enabled,
        last_sync_at, last_sync_ok, last_error, created_at, updated_at, deleted_at
      FROM triage_targets;

      DROP TABLE triage_targets;
      ALTER TABLE triage_targets_new RENAME TO triage_targets;

      CREATE INDEX IF NOT EXISTS idx_triage_targets_enabled ON triage_targets(enabled, deleted_at);
      CREATE INDEX IF NOT EXISTS idx_triage_targets_provider ON triage_targets(provider);
      CREATE INDEX IF NOT EXISTS idx_triage_targets_connection ON triage_targets(connection_id);
    `,
  },
];
