import type { SqliteDb } from "@kernl/extension-sdk";
import { ForgeConnectionStore, type ForgeConnectionRow } from "../../_lib/forge/index.js";

export interface GiteaConnection extends ForgeConnectionRow {
  host: string;
  token: string;
}

export interface AddGiteaConnectionInput {
  name: string;
  host: string;
  token: string;
}

export class GiteaConnectionsService extends ForgeConnectionStore<GiteaConnection> {
  constructor(db: SqliteDb, encryptionKey = "") {
    super(db, { table: "gitea_connections", columns: ["host", "token"], secretColumns: ["token"], encryptionKey });
  }

  add(input: AddGiteaConnectionInput): GiteaConnection {
    if (!input.name?.trim()) throw new Error("name is required");
    if (!input.host?.trim()) throw new Error("host is required (e.g. https://codeberg.org)");
    if (!input.token?.trim()) throw new Error("token is required");
    return this.insert(input.name.trim(), {
      host: input.host.trim().replace(/\/+$/, ""),
      token: input.token.trim(),
    });
  }
}
