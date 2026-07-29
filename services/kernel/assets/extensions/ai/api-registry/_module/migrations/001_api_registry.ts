import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const apiRegistryMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- API Categories (hierarchical)
      CREATE TABLE IF NOT EXISTS api_categories (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        icon        TEXT NOT NULL DEFAULT '',
        parent_id   TEXT REFERENCES api_categories(id) ON DELETE SET NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_api_categories_parent ON api_categories(parent_id);

      -- API Registry (main table)
      CREATE TABLE IF NOT EXISTS api_registry (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        slug                 TEXT NOT NULL UNIQUE,
        description          TEXT NOT NULL DEFAULT '',
        category_id          TEXT REFERENCES api_categories(id) ON DELETE SET NULL,
        base_url             TEXT NOT NULL,
        docs_url             TEXT NOT NULL DEFAULT '',
        
        -- Authentication
        auth_type            TEXT NOT NULL DEFAULT 'none'
                             CHECK(auth_type IN ('none','api_key','bearer','basic','oauth2','custom')),
        auth_location        TEXT NOT NULL DEFAULT 'header'
                             CHECK(auth_location IN ('header','query','body')),
        auth_key_name        TEXT NOT NULL DEFAULT '',
        api_key_encrypted    TEXT NOT NULL DEFAULT '',
        api_secret_encrypted TEXT NOT NULL DEFAULT '',
        
        -- Rate limiting
        rate_limit_requests  INTEGER,
        rate_limit_window_ms INTEGER,
        
        -- Capabilities (JSON array)
        capabilities         TEXT NOT NULL DEFAULT '[]',
        
        -- Status & flags
        status               TEXT NOT NULL DEFAULT 'active'
                             CHECK(status IN ('active','disabled','deprecated','error')),
        is_free              INTEGER NOT NULL DEFAULT 1,
        requires_signup      INTEGER NOT NULL DEFAULT 0,
        
        -- Health & usage tracking
        last_check_at        TEXT,
        last_check_ok        INTEGER,
        total_calls          INTEGER NOT NULL DEFAULT 0,
        total_errors         INTEGER NOT NULL DEFAULT 0,
        
        -- Discovery
        tags                 TEXT NOT NULL DEFAULT '',
        
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_api_registry_category ON api_registry(category_id);
      CREATE INDEX IF NOT EXISTS idx_api_registry_status ON api_registry(status);
      CREATE INDEX IF NOT EXISTS idx_api_registry_slug ON api_registry(slug);
      CREATE INDEX IF NOT EXISTS idx_api_registry_is_free ON api_registry(is_free);

      -- API Endpoints (documentation per endpoint)
      CREATE TABLE IF NOT EXISTS api_endpoints (
        id          TEXT PRIMARY KEY,
        api_id      TEXT NOT NULL REFERENCES api_registry(id) ON DELETE CASCADE,
        method      TEXT NOT NULL DEFAULT 'GET'
                    CHECK(method IN ('GET','POST','PUT','PATCH','DELETE')),
        path        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        parameters  TEXT NOT NULL DEFAULT '[]',
        response    TEXT NOT NULL DEFAULT '{}',
        rate_limit  TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_api_endpoints_api ON api_endpoints(api_id);
    `,
  },
];
