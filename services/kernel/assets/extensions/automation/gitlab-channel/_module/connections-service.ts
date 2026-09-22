import type { SqliteDb } from "@kernl/extension-sdk";
import { ForgeConnectionStore, type ForgeConnectionRow } from "../../_lib/forge/index.js";

export interface GitLabConnection extends ForgeConnectionRow {
  host: string;
  token: string;
}

export interface AddGitLabConnectionInput {
  name: string;
  token: string;
  host?: string;
}

export class GitLabConnectionsService extends ForgeConnectionStore<GitLabConnection> {
  constructor(db: SqliteDb, encryptionKey = "") {
    super(db, { table: "gitlab_connections", columns: ["host", "token"], secretColumns: ["token"], encryptionKey });
  }

  add(input: AddGitLabConnectionInput): GitLabConnection {
    if (!input.name?.trim()) throw new Error("name is required");
    if (!input.token?.trim()) throw new Error("token is required");
    return this.insert(input.name.trim(), {
      host: (input.host ?? "https://gitlab.com").replace(/\/+$/, ""),
      token: input.token.trim(),
    });
  }
}
