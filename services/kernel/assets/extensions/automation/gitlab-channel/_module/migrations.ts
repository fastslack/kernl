import type { Migration } from "@kernl/extension-sdk";
import { forgeConnectionsMigrationSql } from "../../_lib/forge/index.js";

export const gitlabChannelMigrations: Migration[] = [
  {
    version: 1,
    sql: forgeConnectionsMigrationSql("gitlab_connections", `
        host            TEXT NOT NULL DEFAULT 'https://gitlab.com',
        token           TEXT NOT NULL,`),
  },
];
