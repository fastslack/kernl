/**
 * Connection store shared by the forge channels (GitHub, GitLab, Gitea).
 *
 * Each one kept the same table shape (id, name, its own credential columns,
 * the last test result, soft delete) and the same five queries with its
 * table name swapped in. The credential columns were stored as plaintext;
 * here they are sealed at rest with the kernel's encryption key.
 */

import { type SqliteDb, newId, isoNow, decrypt, encryptIfNeeded, isEncrypted, log } from "@kernl/extension-sdk";

export interface ForgeConnectionRow {
  id: string;
  name: string;
  last_test_at: string | null;
  last_test_ok: number | null;
  last_test_error: string;
  created_at: string;
  updated_at: string;
  /**
   * Set when a stored credential is ciphertext the current key can't open
   * (KERNEL_ENCRYPTION_KEY rotated, lost or unset since it was sealed). The
   * credential column then reads as "" — never the ciphertext — and the
   * provider refuses to use the connection.
   */
  credentials_unreadable?: boolean;
}

/** The message a connection with unreadable credentials fails with. */
export function unreadableCredentialsMessage(label: string, name: string): string {
  return `${label} connection ${name}: stored credentials can't be decrypted with the current KERNEL_ENCRYPTION_KEY — re-add the connection`;
}

/**
 * Whether a stored value is a sealed credential rather than a plaintext one.
 * `isEncrypted()` alone only checks the decoded length, which a 40-char hex
 * token (Gitea) also passes; so also require strict base64 (what `encrypt()`
 * emits) and rule out pure hex. Plaintext forge credentials — `ghp_…`,
 * `glpat-…`, hex tokens, PEM keys — fail one of these.
 */
export function looksSealed(value: string): boolean {
  return (
    isEncrypted(value) &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value) &&
    !/^[0-9a-fA-F]+$/.test(value)
  );
}

export interface ForgeStoreSpec {
  table: string;
  /** Provider columns stored after `name`, in order. */
  columns: string[];
  /** Of those, the credentials: encrypted at rest, decrypted on read. */
  secretColumns: string[];
  /** The kernel's encryption key (`config.encryption.key`). Empty → stored as given. */
  encryptionKey: string;
}

/** The CREATE TABLE every forge channel ran, with its own columns in the middle. */
export function forgeConnectionsMigrationSql(table: string, columnsSql: string): string {
  return `
      CREATE TABLE IF NOT EXISTS ${table} (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
${columnsSql}
        last_test_at    TEXT,
        last_test_ok    INTEGER,
        last_test_error TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        deleted_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_${table}_active
        ON ${table}(deleted_at);
    `;
}

export class ForgeConnectionStore<C extends ForgeConnectionRow> {
  private readonly select: string;

  constructor(protected db: SqliteDb, private spec: ForgeStoreSpec) {
    this.select = `SELECT id, name, ${spec.columns.join(", ")}, last_test_at, last_test_ok,
                          last_test_error, created_at, updated_at
                     FROM ${spec.table}`;
    this.sealLegacyRows();
  }

  /** Insert a validated, normalized connection; returns it as read back. */
  protected insert(name: string, values: Record<string, string>): C {
    const id = newId();
    const now = isoNow();
    const cols = this.spec.columns;
    this.db
      .prepare(
        `INSERT INTO ${this.spec.table}
           (id, name, ${cols.join(", ")}, last_test_error, created_at, updated_at)
         VALUES (?, ?, ${cols.map(() => "?").join(", ")}, '', ?, ?)`,
      )
      .run(id, name, ...cols.map((c) => this.seal(c, values[c] ?? "")), now, now);
    return this.get(id)!;
  }

  get(id: string): C | null {
    return this.open(this.db.prepare(`${this.select} WHERE id = ? AND deleted_at IS NULL`).get(id));
  }

  getByName(name: string): C | null {
    return this.open(this.db.prepare(`${this.select} WHERE name = ? AND deleted_at IS NULL`).get(name));
  }

  list(): C[] {
    return (this.db.prepare(`${this.select} WHERE deleted_at IS NULL ORDER BY name ASC`).all() as unknown[])
      .map((row) => this.open(row)!);
  }

  remove(id: string): boolean {
    const now = isoNow();
    const r = this.db
      .prepare(`UPDATE ${this.spec.table} SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(now, now, id);
    return r.changes > 0;
  }

  recordTest(id: string, ok: boolean, error: string): void {
    const now = isoNow();
    this.db
      .prepare(
        `UPDATE ${this.spec.table}
            SET last_test_at = ?, last_test_ok = ?, last_test_error = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(now, ok ? 1 : 0, error.slice(0, 1000), now, id);
  }

  // ── Credentials at rest ──────────────────────────────────────

  private seal(column: string, value: string): string {
    if (!this.spec.encryptionKey || !this.spec.secretColumns.includes(column) || !value) return value;
    return encryptIfNeeded(value, this.spec.encryptionKey);
  }

  private open(row: unknown): C | null {
    if (!row) return null;
    const out = { ...(row as Record<string, unknown>) };
    for (const c of this.spec.secretColumns) {
      const v = out[c];
      if (typeof v !== "string" || !v) continue;
      if (this.spec.encryptionKey) {
        try {
          out[c] = decrypt(v, this.spec.encryptionKey);
          continue;
        } catch { /* not sealed with this key — see below */ }
      }
      // It does not open with the current key (or there is none). Ciphertext
      // here means the key changed or went missing since it was sealed: flag
      // the connection instead of handing the ciphertext to the forge as a
      // token. Anything else is a legacy plaintext value, used as stored
      // (with a key configured, startup has already sealed those).
      if (looksSealed(v)) {
        out[c] = "";
        out.credentials_unreadable = true;
      }
    }
    return out as unknown as C;
  }

  private opens(value: string): boolean {
    try { decrypt(value, this.spec.encryptionKey); return true; } catch { return false; }
  }

  /** Rows saved before credentials were sealed get sealed now, once. */
  private sealLegacyRows(): void {
    if (!this.spec.encryptionKey || this.spec.secretColumns.length === 0) return;
    const rows = this.db
      .prepare(`SELECT id, ${this.spec.secretColumns.join(", ")} FROM ${this.spec.table}`)
      .all() as Array<Record<string, string>>;
    let sealed = 0;
    for (const row of rows) {
      // Ciphertext sealed under another key is left alone: re-sealing it would
      // wrap it again and it would later "decrypt" to the old ciphertext.
      // open() reports it as unreadable instead.
      const next = this.spec.secretColumns.map((c) => {
        const v = row[c] ?? "";
        return looksSealed(v) && !this.opens(v) ? v : this.seal(c, v);
      });
      if (next.every((v, i) => v === row[this.spec.secretColumns[i]])) continue;
      this.db
        .prepare(`UPDATE ${this.spec.table} SET ${this.spec.secretColumns.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
        .run(...next, row.id);
      sealed++;
    }
    if (sealed > 0) log.info(`${this.spec.table}: encrypted the credentials of ${sealed} existing connection(s)`);
  }
}
