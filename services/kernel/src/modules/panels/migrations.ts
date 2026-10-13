// src/modules/panels/migrations.ts
import type { Migration } from "../../core/db/migrations.js";

export const panelsMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS office_panels (
        flow_id    TEXT PRIMARY KEY,
        spec_json  TEXT NOT NULL,
        root_dir   TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS panel_records (
        owner      TEXT NOT NULL,
        collection TEXT NOT NULL,
        key        TEXT NOT NULL,
        data       TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (owner, collection, key)
      );
      CREATE INDEX IF NOT EXISTS idx_panel_records_recent ON panel_records(owner, collection, updated_at);
      CREATE TABLE IF NOT EXISTS panel_audit (
        id     TEXT PRIMARY KEY,
        owner  TEXT NOT NULL,
        action TEXT NOT NULL,
        values_json TEXT NOT NULL DEFAULT '{}',
        ok     INTEGER NOT NULL DEFAULT 0,
        result TEXT NOT NULL DEFAULT '',
        actor  TEXT NOT NULL DEFAULT '',
        at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_panel_audit_owner ON panel_audit(owner, at);
    `,
  },
];
