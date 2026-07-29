import type { Migration } from "../../../../../src/core/db/migrations.js";

/**
 * Consolidated initial schema for the `comms` extension.
 *
 * Previously 5 versions (base communications, email accounts, campaigns,
 * analysis suggestions, email actions/labels) — merged into one.
 *
 * Note: the provider CHECK constraint widening to allow 'imap_smtp' is still
 * handled at runtime by ensureEmailAccountsSchema() in index.ts — it requires
 * PRAGMA foreign_keys = OFF around a table rebuild, which cannot run inside
 * the implicit transaction wrapping db.exec(). The helper is idempotent.
 *
 * Forward-only: add new changes as v2+, never edit this in place.
 */
export const commsMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- Unified communications log (email + social + IM).
      CREATE TABLE IF NOT EXISTS communications (
        id               TEXT PRIMARY KEY,
        account_id       TEXT REFERENCES email_accounts(id) ON DELETE SET NULL,
        channel          TEXT NOT NULL DEFAULT 'email'
                         CHECK(channel IN ('email','whatsapp','mattermost','x','instagram','linkedin')),
        direction        TEXT NOT NULL DEFAULT 'outbound'
                         CHECK(direction IN ('inbound','outbound')),
        status           TEXT NOT NULL DEFAULT 'draft'
                         CHECK(status IN ('draft','ready','sending','sent','failed','archived')),
        subject          TEXT NOT NULL DEFAULT '',
        body             TEXT NOT NULL DEFAULT '',
        body_html        TEXT NOT NULL DEFAULT '',
        contact_id       TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        task_id          TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        thread_id        TEXT NOT NULL DEFAULT '',
        in_reply_to      TEXT NOT NULL DEFAULT '',
        recipients_to    TEXT NOT NULL DEFAULT '',
        recipients_cc    TEXT NOT NULL DEFAULT '',
        recipients_bcc   TEXT NOT NULL DEFAULT '',
        gmail_message_id TEXT NOT NULL DEFAULT '',
        gmail_thread_id  TEXT NOT NULL DEFAULT '',
        scheduled_at     TEXT,
        sent_at          TEXT,
        error_message    TEXT NOT NULL DEFAULT '',
        metadata         TEXT NOT NULL DEFAULT '{}',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comms_channel ON communications(channel);
      CREATE INDEX IF NOT EXISTS idx_comms_status  ON communications(status);
      CREATE INDEX IF NOT EXISTS idx_comms_contact ON communications(contact_id);
      CREATE INDEX IF NOT EXISTS idx_comms_task    ON communications(task_id);
      CREATE INDEX IF NOT EXISTS idx_comms_thread  ON communications(thread_id);
      CREATE INDEX IF NOT EXISTS idx_comms_account ON communications(account_id);

      -- Attachments linked to a communication.
      CREATE TABLE IF NOT EXISTS comm_attachments (
        id            TEXT PRIMARY KEY,
        comm_id       TEXT NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
        filename      TEXT NOT NULL,
        original_path TEXT NOT NULL DEFAULT '',
        stored_path   TEXT NOT NULL DEFAULT '',
        mime_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comm_attachments_comm ON comm_attachments(comm_id);

      -- Email account registry (Gmail, Resend, IMAP/SMTP at runtime).
      CREATE TABLE IF NOT EXISTS email_accounts (
        id              TEXT PRIMARY KEY,
        label           TEXT NOT NULL,
        email           TEXT NOT NULL,
        type            TEXT NOT NULL DEFAULT 'personal'
                        CHECK(type IN ('personal','work','transactional','marketing')),
        provider        TEXT NOT NULL DEFAULT 'gmail'
                        CHECK(provider IN ('gmail','resend')),
        company         TEXT NOT NULL DEFAULT '',
        signature       TEXT NOT NULL DEFAULT '',
        provider_config TEXT NOT NULL DEFAULT '{}',
        is_default      INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_email_accounts_email ON email_accounts(email);

      -- Reusable email templates (parameterised by variables[]).
      CREATE TABLE IF NOT EXISTS email_templates (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        subject    TEXT NOT NULL DEFAULT '',
        body       TEXT NOT NULL DEFAULT '',
        body_html  TEXT NOT NULL DEFAULT '',
        category   TEXT NOT NULL DEFAULT 'general',
        variables  TEXT NOT NULL DEFAULT '[]',
        account_id TEXT REFERENCES email_accounts(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Batch email campaigns (drives many campaign_recipients rows).
      CREATE TABLE IF NOT EXISTS email_campaigns (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        template_id      TEXT REFERENCES email_templates(id) ON DELETE SET NULL,
        account_id       TEXT REFERENCES email_accounts(id) ON DELETE SET NULL,
        status           TEXT NOT NULL DEFAULT 'draft'
                         CHECK(status IN ('draft','sending','sent','paused','cancelled')),
        subject_override TEXT NOT NULL DEFAULT '',
        total_recipients INTEGER NOT NULL DEFAULT 0,
        sent_count       INTEGER NOT NULL DEFAULT 0,
        failed_count     INTEGER NOT NULL DEFAULT 0,
        scheduled_at     TEXT,
        started_at       TEXT,
        completed_at     TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_campaigns_status ON email_campaigns(status);

      -- Per-recipient campaign state and resulting comm link.
      CREATE TABLE IF NOT EXISTS campaign_recipients (
        id            TEXT PRIMARY KEY,
        campaign_id   TEXT NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
        contact_id    TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        email         TEXT NOT NULL,
        name          TEXT NOT NULL DEFAULT '',
        variables     TEXT NOT NULL DEFAULT '{}',
        status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','sent','failed','skipped')),
        comm_id       TEXT REFERENCES communications(id) ON DELETE SET NULL,
        sent_at       TEXT,
        error_message TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign ON campaign_recipients(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_campaign_recipients_status   ON campaign_recipients(campaign_id, status);

      -- LLM-derived suggestions parsed from email content (task/reminder/etc).
      CREATE TABLE IF NOT EXISTS email_analysis_suggestions (
        id          TEXT PRIMARY KEY,
        comm_id     TEXT NOT NULL REFERENCES communications(id) ON DELETE CASCADE,
        type        TEXT NOT NULL CHECK(type IN ('task','reminder','contact','shopping')),
        status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','approved','dismissed')),
        payload     TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL,
        reviewed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_eas_comm   ON email_analysis_suggestions(comm_id);
      CREATE INDEX IF NOT EXISTS idx_eas_status ON email_analysis_suggestions(status);

      -- User-driven email actions recorded per Gmail message id.
      CREATE TABLE IF NOT EXISTS email_actions (
        id          TEXT PRIMARY KEY,
        gmail_id    TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK(action_type IN (
          'note','label','follow_up','link_task','link_contact',
          'block_sender','snooze','important','archive','trash'
        )),
        value       TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_email_actions_gmail ON email_actions(gmail_id);
      CREATE INDEX IF NOT EXISTS idx_email_actions_type  ON email_actions(action_type);

      -- User-defined email labels (colored tags).
      CREATE TABLE IF NOT EXISTS email_labels (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        color      TEXT NOT NULL DEFAULT '#666',
        created_at TEXT NOT NULL
      );
    `,
  },
];
