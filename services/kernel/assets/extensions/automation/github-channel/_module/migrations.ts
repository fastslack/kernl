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
];
