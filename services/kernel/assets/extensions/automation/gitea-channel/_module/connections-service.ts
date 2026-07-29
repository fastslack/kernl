import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

export interface GiteaConnection {
  id: string;
  name: string;
  host: string;
  token: string;
  last_test_at: string | null;
  last_test_ok: number | null;
  last_test_error: string;
  created_at: string;
  updated_at: string;
}

export interface AddGiteaConnectionInput {
  name: string;
  host: string;
  token: string;
}

export class GiteaConnectionsService {
  constructor(private db: SqliteDb) {}

  add(input: AddGiteaConnectionInput): GiteaConnection {
    if (!input.name?.trim()) throw new Error("name is required");
    if (!input.host?.trim()) throw new Error("host is required (e.g. https://codeberg.org)");
    if (!input.token?.trim()) throw new Error("token is required");
    const id = newId();
    const now = isoNow();
    const host = input.host.trim().replace(/\/+$/, "");
    this.db
      .prepare(
        `INSERT INTO gitea_connections
           (id, name, host, token, last_test_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', ?, ?)`,
      )
      .run(id, input.name.trim(), host, input.token.trim(), now, now);
    return this.get(id)!;
  }

  get(id: string): GiteaConnection | null {
    const row = this.db
      .prepare(
        `SELECT id, name, host, token, last_test_at, last_test_ok, last_test_error,
                created_at, updated_at
           FROM gitea_connections
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(id) as GiteaConnection | undefined;
    return row ?? null;
  }

  getByName(name: string): GiteaConnection | null {
    const row = this.db
      .prepare(
        `SELECT id, name, host, token, last_test_at, last_test_ok, last_test_error,
                created_at, updated_at
           FROM gitea_connections
          WHERE name = ? AND deleted_at IS NULL`,
      )
      .get(name) as GiteaConnection | undefined;
    return row ?? null;
  }

  list(): GiteaConnection[] {
    return this.db
      .prepare(
        `SELECT id, name, host, token, last_test_at, last_test_ok, last_test_error,
                created_at, updated_at
           FROM gitea_connections
          WHERE deleted_at IS NULL
          ORDER BY name ASC`,
      )
      .all() as GiteaConnection[];
  }

  remove(id: string): boolean {
    const now = isoNow();
    const r = this.db
      .prepare(
        `UPDATE gitea_connections SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(now, now, id);
    return r.changes > 0;
  }

  recordTest(id: string, ok: boolean, error: string): void {
    const now = isoNow();
    this.db
      .prepare(
        `UPDATE gitea_connections
            SET last_test_at = ?, last_test_ok = ?, last_test_error = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(now, ok ? 1 : 0, error.slice(0, 1000), now, id);
  }
}
