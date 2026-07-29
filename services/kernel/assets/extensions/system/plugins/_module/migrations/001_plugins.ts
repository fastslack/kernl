import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const pluginsMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- Plugin repositories (GitLab/GitHub sources)
      CREATE TABLE IF NOT EXISTS plugin_repos (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        url             TEXT NOT NULL UNIQUE,
        type            TEXT NOT NULL DEFAULT 'gitlab',
        token           TEXT NOT NULL DEFAULT '',
        last_synced_at  TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );

      -- Cached plugin registry (from syncing repos)
      CREATE TABLE IF NOT EXISTS plugin_registry (
        id              TEXT PRIMARY KEY,
        repo_id         TEXT NOT NULL REFERENCES plugin_repos(id) ON DELETE CASCADE,
        plugin_name     TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        author          TEXT NOT NULL DEFAULT '',
        version         TEXT NOT NULL DEFAULT '',
        clone_url       TEXT NOT NULL DEFAULT '',
        stars           INTEGER NOT NULL DEFAULT 0,
        updated_at      TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_registry_repo ON plugin_registry(repo_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_registry_name ON plugin_registry(repo_id, plugin_name);

      -- Installed plugins
      CREATE TABLE IF NOT EXISTS installed_plugins (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        version         TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        author          TEXT NOT NULL DEFAULT '',
        repo_id         TEXT NOT NULL DEFAULT '',
        clone_url       TEXT NOT NULL DEFAULT '',
        install_path    TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'active',
        manifest_json   TEXT NOT NULL DEFAULT '{}',
        installed_at    TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_installed_plugins_status ON installed_plugins(status);
    `,
  },
];
