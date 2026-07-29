import type { Migration } from "../../../core/db/migrations.js";

export const configMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- Runtime configuration store.
      -- Each row is one setting: an env-var name mapped to a human-readable
      -- label, value, type, and optional constraints.
      -- Settings written here are also synced to process.env + .env file
      -- so the live KernelConfig object stays consistent.
      CREATE TABLE IF NOT EXISTS app_settings (
        key           TEXT PRIMARY KEY,   -- env var name, e.g. ANTHROPIC_API_KEY
        value         TEXT NOT NULL DEFAULT '',
        type          TEXT NOT NULL DEFAULT 'string'
                      CHECK(type IN ('string','number','boolean','secret','json')),
        label         TEXT NOT NULL DEFAULT '',  -- human-readable label
        description   TEXT NOT NULL DEFAULT '',
        category      TEXT NOT NULL DEFAULT 'general'
                      CHECK(category IN (
                        'general','ai','chat','agents','notifications',
                        'integrations','life','security','advanced'
                      )),
        sensitive     INTEGER NOT NULL DEFAULT 0,   -- 1 = mask in read/list
        readonly      INTEGER NOT NULL DEFAULT 0,   -- 1 = cannot change via tools
        updated_at    TEXT NOT NULL,
        updated_by    TEXT NOT NULL DEFAULT 'system'  -- 'system'|'user'|'chat'
      );

      CREATE INDEX IF NOT EXISTS idx_app_settings_category ON app_settings(category);
    `,
  },
];
