import type { Migration } from "../../core/db/migrations.js";

export const officeInfraMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS office_environments (
        flow_id           TEXT PRIMARY KEY,
        image             TEXT NOT NULL DEFAULT 'oven/bun:1',
        container_name    TEXT NOT NULL DEFAULT '',
        workspace_subpath TEXT NOT NULL DEFAULT '',
        ports_json        TEXT NOT NULL DEFAULT '[]',
        env_json          TEXT NOT NULL DEFAULT '{}',
        network           TEXT NOT NULL DEFAULT 'kernl_default',
        run_command       TEXT NOT NULL DEFAULT '',
        desired_state     TEXT NOT NULL DEFAULT 'stopped',
        last_status       TEXT NOT NULL DEFAULT 'absent',
        last_status_at    TEXT NOT NULL DEFAULT '',
        last_error        TEXT NOT NULL DEFAULT '',
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
    `,
  },
];
