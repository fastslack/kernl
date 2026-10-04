import type { Migration } from "@kernl/extension-sdk";

/**
 * The HTML part of each Gmail message, sanitized, so the mail view can show
 * formatting and images instead of the plain-text fallback.
 *
 * Nullable on purpose (unlike the NOT NULL DEFAULT '' convention): NULL means
 * "never fetched" — every row synced before this column existed — and the
 * detail route fills it from the Gmail API on first open. '' means "fetched,
 * the message has no HTML part", so it is never fetched again.
 */
export const bodyHtmlMigrations: Migration[] = [
  {
    version: 1,
    sql: `ALTER TABLE google_emails ADD COLUMN body_html TEXT;`,
  },
];
