import type { SqliteDb } from "@kernl/extension-sdk";
import { ForgeConnectionStore, type ForgeConnectionRow } from "../../_lib/forge/index.js";

export interface GitHubConnection extends ForgeConnectionRow {
  app_id: string;
  installation_id: string;
  private_key_pem: string;
}

export interface AddGitHubConnectionInput {
  name: string;
  app_id: string;
  installation_id: string;
  private_key_pem: string;
}

export class GitHubConnectionsService extends ForgeConnectionStore<GitHubConnection> {
  constructor(db: SqliteDb, encryptionKey = "") {
    super(db, {
      table: "github_connections",
      columns: ["app_id", "installation_id", "private_key_pem"],
      secretColumns: ["private_key_pem"],
      encryptionKey,
    });
  }

  add(input: AddGitHubConnectionInput): GitHubConnection {
    if (!input.name?.trim()) throw new Error("name is required");
    if (!input.app_id?.trim()) throw new Error("app_id is required");
    if (!input.installation_id?.trim()) throw new Error("installation_id is required");
    if (!input.private_key_pem?.includes("BEGIN")) {
      throw new Error("private_key_pem must be a PEM-encoded RSA key");
    }
    return this.insert(input.name.trim(), {
      app_id: input.app_id.trim(),
      installation_id: input.installation_id.trim(),
      private_key_pem: input.private_key_pem,
    });
  }
}
