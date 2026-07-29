import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const emailTriageMigrations: Migration[] = [
  {
    version: 3,
    sql: `
      ALTER TABLE google_emails ADD COLUMN urgency TEXT NOT NULL DEFAULT ''
        CHECK(urgency IN ('', 'critical', 'high', 'normal', 'low'));
      ALTER TABLE google_emails ADD COLUMN attention_needed INTEGER NOT NULL DEFAULT -1;
      ALTER TABLE google_emails ADD COLUMN ai_summary TEXT NOT NULL DEFAULT '';
      ALTER TABLE google_emails ADD COLUMN draft_comm_id TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_google_emails_urgency ON google_emails(urgency);
      CREATE INDEX IF NOT EXISTS idx_google_emails_attention ON google_emails(attention_needed);
    `,
  },
];
