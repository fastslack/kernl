import type { Migration } from "../../core/db/migrations.js";

/**
 * Projects: a product or business (a SaaS, a shop, a service…) that offices work for.
 * The agents module only carries `project_id` columns (agents v51); every
 * project-owned table lives here.
 */
export const projectsMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id              TEXT PRIMARY KEY,
        slug            TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
        brief           TEXT NOT NULL DEFAULT '{}',
        connector_url   TEXT NOT NULL DEFAULT '',
        connector_token TEXT NOT NULL DEFAULT '',
        webhook_secret  TEXT NOT NULL DEFAULT '',
        last_pull_at    TEXT,
        last_webhook_at TEXT,
        connector_error TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_links (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK(kind IN ('repo','social_account','email_account','task_project','workspace')),
        ref_id     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, kind, ref_id)
      );
      CREATE TABLE IF NOT EXISTS office_projects (
        flow_id    TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        active     INTEGER NOT NULL DEFAULT 1,
        settings   TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (flow_id, project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_office_projects_project ON office_projects(project_id);
    `,
  },
  {
    // Drafts that leave Kernl only after a human approves them. 'sending' is
    // the claim a sender takes before calling the channel, so a double
    // approve or a tick racing an approve can never publish twice.
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS outbox_items (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        flow_id       TEXT NOT NULL DEFAULT '',
        agent_id      TEXT NOT NULL DEFAULT '',
        run_id        TEXT NOT NULL DEFAULT '',
        channel       TEXT NOT NULL,
        account_ref   TEXT NOT NULL,
        payload       TEXT NOT NULL DEFAULT '{}',
        scheduled_for TEXT,
        status        TEXT NOT NULL DEFAULT 'draft'
                      CHECK(status IN ('draft','approved','sending','sent','rejected','failed')),
        review_note   TEXT NOT NULL DEFAULT '',
        sent_ref      TEXT NOT NULL DEFAULT '',
        error         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        decided_at    TEXT,
        sent_at       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_status  ON outbox_items(status, scheduled_for);
      CREATE INDEX IF NOT EXISTS idx_outbox_project ON outbox_items(project_id, status);
    `,
  },
  {
    // The JSON schema an office (its extension's office.json) declares for
    // the settings it keeps per project — drives the settings editor.
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS office_project_schemas (
        flow_id TEXT PRIMARY KEY,
        schema  TEXT NOT NULL DEFAULT '{}'
      );
    `,
  },
  {
    // Project connector (contract v1): a local copy of what the project
    // reports, and the webhook event ids already processed (idempotency).
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS project_records (
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,
        external_id TEXT NOT NULL,
        data        TEXT NOT NULL DEFAULT '{}',
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (project_id, kind, external_id)
      );
      CREATE TABLE IF NOT EXISTS project_webhook_events (
        project_id  TEXT NOT NULL,
        event_id    TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (project_id, event_id)
      );
    `,
  },
  {
    // Pull cursor in the PROJECT's clock (snapshot generated_at minus an
    // overlap). last_pull_at stays Kernl's clock: due-check and the UI.
    version: 5,
    sql: `ALTER TABLE projects ADD COLUMN pull_since TEXT;`,
  },
  {
    // A shared office (Ventas, Marketing…) works for whichever project the
    // caller brings: serves_any lets a run for ANY active project through the
    // gate. Schedules still fan out only over office_projects — being callable
    // by a project is not the same as working for it on a cron.
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS office_scopes (
        flow_id    TEXT PRIMARY KEY,
        serves_any INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    // The project's own office. A shared office working for the project keeps
    // its documents in THIS office's home instead of its own, so each
    // project's files stay with the project ('' = not set).
    version: 7,
    sql: `ALTER TABLE projects ADD COLUMN home_flow_id TEXT NOT NULL DEFAULT '';`,
  },
];
