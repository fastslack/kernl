import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const remindersMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS reminders (
        id                TEXT PRIMARY KEY,
        title             TEXT NOT NULL,
        body              TEXT NOT NULL DEFAULT '',
        trigger_at        TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'active'
                          CHECK(status IN ('active','snoozed','fired','dismissed')),
        repeat            TEXT NOT NULL DEFAULT 'none'
                          CHECK(repeat IN ('none','daily','weekly','monthly')),
        task_id           TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        snoozed_until     TEXT,
        last_fired_at     TEXT,
        notify_mattermost INTEGER NOT NULL DEFAULT 1,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_trigger ON reminders(trigger_at);
      CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
      CREATE INDEX IF NOT EXISTS idx_reminders_task ON reminders(task_id);
      CREATE INDEX IF NOT EXISTS idx_reminders_status_trigger ON reminders(status, trigger_at);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE reminders ADD COLUMN notify_telegram INTEGER NOT NULL DEFAULT 1;
    `,
  },
];
