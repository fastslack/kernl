import type { Migration } from "@kernl/extension-sdk";

/**
 * The text of a Gmail message's PDF attachments (importers/gmail-attachments.ts), for the agenda extraction.
 * NULL = never looked (rows synced before this column, or with no attachments); '' = looked, nothing to read.
 */
export const attachmentsTextMigrations: Migration[] = [
  {
    version: 1,
    sql: `ALTER TABLE google_emails ADD COLUMN attachments_text TEXT;`,
  },
];
