import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const accountIdMigrations: Migration[] = [
  {
    version: 4,
    sql: `
      ALTER TABLE google_emails ADD COLUMN account_id TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_google_emails_account ON google_emails(account_id);
    `,
  },
];
