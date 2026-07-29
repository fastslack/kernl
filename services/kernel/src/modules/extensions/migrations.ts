import type { Migration } from "../../core/db/migrations.js";

/**
 * Unified registry for everything installable.
 *
 * Replaces the three parallel systems:
 *   - marketplace_items  (catalog + state)
 *   - installed_plugins  (git-cloned backend plugins)
 *   - skills-config.json (filesystem-managed skills)
 *
 * On upgrade, Step 5's data migration copies rows from those sources into
 * this table. The legacy tables stay read-only for history.
 */
export const extensionsMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS installed_extensions (
        id                        TEXT PRIMARY KEY,
        slug                      TEXT NOT NULL,
        name                      TEXT NOT NULL,
        version                   TEXT NOT NULL,
        type                      TEXT NOT NULL
                                  CHECK(type IN (
                                    'module','skill','agent-bundle',
                                    'flow','theme','template','channel'
                                  )),
        status                    TEXT NOT NULL DEFAULT 'installed'
                                  CHECK(status IN ('installed','active','disabled','error')),
        manifest_json             TEXT NOT NULL,
        source_json               TEXT NOT NULL DEFAULT '{"type":"local","path":""}',
        install_path              TEXT NOT NULL DEFAULT '',
        granted_permissions_json  TEXT NOT NULL DEFAULT '[]',
        settings_json             TEXT NOT NULL DEFAULT '{}',
        error                     TEXT NOT NULL DEFAULT '',
        installed_at              TEXT NOT NULL,
        updated_at                TEXT NOT NULL,
        last_loaded_at            TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ix_ext_slug   ON installed_extensions(slug);
      CREATE INDEX IF NOT EXISTS ix_ext_status ON installed_extensions(status);
      CREATE INDEX IF NOT EXISTS ix_ext_type   ON installed_extensions(type);
    `,
  },
  {
    // v2 — relaxes the `type` CHECK to admit the new extension points
    // (sandbox-driver, llm-provider, email-provider, exchange-adapter, …).
    // The TS ExtensionType already includes them; the CHECK was duplicating
    // validation and blocked the built-in driver seeds with
    // "CHECK constraint failed: type IN (...)".
    // SQLite can't ALTER a CHECK — we recreate the table without the constraint
    // of type (validation stays in TS, where it belongs).
    version: 2,
    sql: `
      CREATE TABLE installed_extensions_new (
        id                        TEXT PRIMARY KEY,
        slug                      TEXT NOT NULL,
        name                      TEXT NOT NULL,
        version                   TEXT NOT NULL,
        type                      TEXT NOT NULL,
        status                    TEXT NOT NULL DEFAULT 'installed'
                                  CHECK(status IN ('installed','active','disabled','error')),
        manifest_json             TEXT NOT NULL,
        source_json               TEXT NOT NULL DEFAULT '{"type":"local","path":""}',
        install_path              TEXT NOT NULL DEFAULT '',
        granted_permissions_json  TEXT NOT NULL DEFAULT '[]',
        settings_json             TEXT NOT NULL DEFAULT '{}',
        error                     TEXT NOT NULL DEFAULT '',
        installed_at              TEXT NOT NULL,
        updated_at                TEXT NOT NULL,
        last_loaded_at            TEXT
      );
      INSERT INTO installed_extensions_new
        SELECT id, slug, name, version, type, status, manifest_json, source_json,
               install_path, granted_permissions_json, settings_json, error,
               installed_at, updated_at, last_loaded_at
        FROM installed_extensions;
      DROP TABLE installed_extensions;
      ALTER TABLE installed_extensions_new RENAME TO installed_extensions;
      CREATE UNIQUE INDEX IF NOT EXISTS ix_ext_slug   ON installed_extensions(slug);
      CREATE INDEX IF NOT EXISTS ix_ext_status ON installed_extensions(status);
      CREATE INDEX IF NOT EXISTS ix_ext_type   ON installed_extensions(type);
    `,
  },
  {
    // v3 — install receipts. Every install (bundled, local, file, url, git,
    // marketplace) gets a per-install receipt with:
    //   - install_id (uuid v4) — globally unique per install event
    //   - bundle_sha256        — content hash of the install_path tree
    //   - install_sha256       — sha256(install_id || bundle_sha256 || installed_at || identity_fp)
    //   - kernel_identity_fp   — Ed25519 attestation pubkey fingerprint
    //   - signature            — Ed25519 over install_sha256
    //   - source               — same shape as source_json
    //   - remote_watermark     — null OR { download_id, downloader_fp,
    //                                       source_fp, ts, signature }
    //
    // Stored as JSON blob; the column stays empty ('{}') for legacy rows that
    // pre-date the receipt feature.
    version: 3,
    sql: `
      ALTER TABLE installed_extensions
        ADD COLUMN install_receipt_json TEXT NOT NULL DEFAULT '{}';
    `,
  },
];
