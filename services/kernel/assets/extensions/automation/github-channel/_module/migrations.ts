import type { Migration } from "@kernl/extension-sdk";
import { forgeConnectionsMigrationSql } from "../../_lib/forge/index.js";

export const githubChannelMigrations: Migration[] = [
  {
    version: 1,
    sql: forgeConnectionsMigrationSql("github_connections", `
        app_id          TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        private_key_pem TEXT NOT NULL,`),
  },
  {
    // A personal access token instead of an App (a fine-grained token scoped to
    // one repo). '' = an App connection; the App columns stay '' for a token one.
    version: 2,
    sql: "ALTER TABLE github_connections ADD COLUMN token TEXT NOT NULL DEFAULT '';",
  },
];
