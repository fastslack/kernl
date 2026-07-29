import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

export interface GitHubConnection {
  id: string;
  name: string;
  app_id: string;
  installation_id: string;
  private_key_pem: string;
  last_test_at: string | null;
  last_test_ok: number | null;
  last_test_error: string;
  created_at: string;
  updated_at: string;
}

export interface AddGitHubConnectionInput {
  name: string;
  app_id: string;
  installation_id: string;
  private_key_pem: string;
}

export class GitHubConnectionsService {
  constructor(private db: SqliteDb) {}

  add(input: AddGitHubConnectionInput): GitHubConnection {
    if (!input.name?.trim()) throw new Error("name is required");
    if (!input.app_id?.trim()) throw new Error("app_id is required");
    if (!input.installation_id?.trim()) throw new Error("installation_id is required");
    if (!input.private_key_pem?.includes("BEGIN")) {
      throw new Error("private_key_pem must be a PEM-encoded RSA key");
    }
    const id = newId();
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO github_connections
           (id, name, app_id, installation_id, private_key_pem,
            last_test_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        input.app_id.trim(),
        input.installation_id.trim(),
        input.private_key_pem,
        now,
        now,
      );
    return this.get(id)!;
  }

  get(id: string): GitHubConnection | null {
    const row = this.db
      .prepare(
        `SELECT id, name, app_id, installation_id, private_key_pem,
                last_test_at, last_test_ok, last_test_error, created_at, updated_at
           FROM github_connections
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(id) as GitHubConnection | undefined;
    return row ?? null;
  }

  getByName(name: string): GitHubConnection | null {
    const row = this.db
      .prepare(
        `SELECT id, name, app_id, installation_id, private_key_pem,
                last_test_at, last_test_ok, last_test_error, created_at, updated_at
           FROM github_connections
          WHERE name = ? AND deleted_at IS NULL`,
      )
      .get(name) as GitHubConnection | undefined;
    return row ?? null;
  }

  list(): GitHubConnection[] {
    return this.db
      .prepare(
        `SELECT id, name, app_id, installation_id, private_key_pem,
                last_test_at, last_test_ok, last_test_error, created_at, updated_at
           FROM github_connections
          WHERE deleted_at IS NULL
          ORDER BY name ASC`,
      )
      .all() as GitHubConnection[];
  }

  remove(id: string): boolean {
    const now = isoNow();
    const r = this.db
      .prepare(
        `UPDATE github_connections SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(now, now, id);
    return r.changes > 0;
  }

  recordTest(id: string, ok: boolean, error: string): void {
    const now = isoNow();
    this.db
      .prepare(
        `UPDATE github_connections
            SET last_test_at = ?, last_test_ok = ?, last_test_error = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(now, ok ? 1 : 0, error.slice(0, 1000), now, id);
  }
}
