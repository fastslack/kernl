import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const securityMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS security_scans (
        id                       TEXT PRIMARY KEY,
        kind                     TEXT NOT NULL,
        target_path              TEXT NOT NULL,
        started_at               TEXT NOT NULL,
        completed_at             TEXT,
        status                   TEXT NOT NULL DEFAULT 'running',
        files_scanned            INTEGER NOT NULL DEFAULT 0,
        finding_count_critical   INTEGER NOT NULL DEFAULT 0,
        finding_count_high       INTEGER NOT NULL DEFAULT 0,
        finding_count_medium     INTEGER NOT NULL DEFAULT 0,
        finding_count_low        INTEGER NOT NULL DEFAULT 0,
        error                    TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_scans_started ON security_scans(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scans_kind    ON security_scans(kind);

      CREATE TABLE IF NOT EXISTS security_findings (
        id            TEXT PRIMARY KEY,
        scan_id       TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        line          INTEGER NOT NULL DEFAULT 0,
        severity      TEXT NOT NULL,
        rule_id       TEXT NOT NULL,
        title         TEXT NOT NULL,
        evidence      TEXT NOT NULL DEFAULT '',
        resolved      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        FOREIGN KEY (scan_id) REFERENCES security_scans(id)
      );

      CREATE INDEX IF NOT EXISTS idx_findings_scan     ON security_findings(scan_id);
      CREATE INDEX IF NOT EXISTS idx_findings_severity ON security_findings(severity);
      CREATE INDEX IF NOT EXISTS idx_findings_resolved ON security_findings(resolved);
    `,
  },
];
