import type { Migration } from "@kernl/extension-sdk";
import { forgeConnectionsMigrationSql } from "../../_lib/forge/index.js";

export const giteaChannelMigrations: Migration[] = [
  {
    version: 1,
    sql: forgeConnectionsMigrationSql("gitea_connections", `
        host            TEXT NOT NULL,
        token           TEXT NOT NULL,`),
  },
];
