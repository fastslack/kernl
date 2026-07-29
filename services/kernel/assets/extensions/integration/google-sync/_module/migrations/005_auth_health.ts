import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Token health columns. `needs_reauth_at` is set when a refresh fails with
 * invalid_grant (token revoked/expired) and cleared on a successful refresh or
 * re-auth — so the dashboard can distinguish "token present" from "token works".
 */
export const authHealthMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      ALTER TABLE google_tokens ADD COLUMN needs_reauth_at TEXT;
      ALTER TABLE google_tokens ADD COLUMN last_auth_error TEXT;
    `,
  },
];
