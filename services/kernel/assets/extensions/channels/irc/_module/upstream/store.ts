/**
 * UpstreamStore — SQLite access for the bouncer's outbound networks.
 *
 * Passwords live in the `secrets` JSON column. The field is named "password"
 * on purpose: core/secrets encrypts exactly that set of well-known field names,
 * so the encryption happens without this module knowing the cipher. Rows are
 * scoped by `account`, which is what keeps one user's networks out of another's.
 */
import type { SqliteDb } from "../../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../../src/core/helpers.js";
import { encryptSecrets, decryptSecrets } from "../../../../../../src/core/secrets.js";
import { log } from "../../../../../../src/core/logger.js";

export interface UpstreamRow {
  id: string;
  account: string;
  network: string;
  label: string;
  host: string;
  port: number;
  tls: number;
  nick: string;
  username: string;
  realname: string;
  sasl_account: string;
  secrets: string;
  enabled: number;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export interface UpstreamChannelRow {
  upstream_id: string;
  channel: string;
  key: string;
  joined_at: string;
}

export interface UpstreamInput {
  account: string;
  network: string;
  label?: string;
  host: string;
  port?: number;
  tls?: boolean;
  nick: string;
  username?: string;
  realname?: string;
  sasl_account?: string;
  password?: string;
  enabled?: boolean;
}

export class UpstreamStore {
  constructor(
    private db: SqliteDb,
    /** Kernel encryption key. Empty means plaintext, as elsewhere in the kernel. */
    private encryptionKey = "",
  ) {
    if (!encryptionKey) {
      log.warn("IRC upstream: no encryption key configured — network passwords are stored in plaintext");
    }
  }

  // ── Reads ───────────────────────────────────────────────────
  list(account?: string): UpstreamRow[] {
    const sql = account
      ? `SELECT * FROM irc_upstreams WHERE account = ? ORDER BY network`
      : `SELECT * FROM irc_upstreams ORDER BY account, network`;
    const stmt = this.db.prepare(sql);
    return (account ? stmt.all(account) : stmt.all()) as UpstreamRow[];
  }

  listEnabled(): UpstreamRow[] {
    return this.db
      .prepare(`SELECT * FROM irc_upstreams WHERE enabled = 1 ORDER BY account, network`)
      .all() as UpstreamRow[];
  }

  // bun:sqlite answers a miss with null; normalise so the declared type holds.
  get(id: string): UpstreamRow | undefined {
    return (this.db.prepare(`SELECT * FROM irc_upstreams WHERE id = ?`).get(id) as
      | UpstreamRow
      | null) ?? undefined;
  }

  find(account: string, network: string): UpstreamRow | undefined {
    return (this.db
      .prepare(`SELECT * FROM irc_upstreams WHERE account = ? AND network = ?`)
      .get(account, network) as UpstreamRow | null) ?? undefined;
  }

  /** The decrypted password for a row, or "" when none is stored. */
  password(row: UpstreamRow): string {
    if (!row.secrets) return "";
    try {
      const raw = JSON.parse(row.secrets) as Record<string, unknown>;
      const plain = this.encryptionKey ? decryptSecrets(raw, this.encryptionKey) : raw;
      return typeof plain.password === "string" ? plain.password : "";
    } catch (err) {
      log.warn(`IRC upstream: unreadable secrets for ${row.network}: ${String(err)}`);
      return "";
    }
  }

  /** True when a password is stored, without revealing it. */
  hasPassword(row: UpstreamRow): boolean {
    return this.password(row) !== "";
  }

  // ── Writes ──────────────────────────────────────────────────
  create(input: UpstreamInput): UpstreamRow {
    const now = isoNow();
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO irc_upstreams
           (id, account, network, label, host, port, tls, nick, username, realname,
            sasl_account, secrets, enabled, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
      )
      .run(
        id,
        input.account,
        input.network,
        input.label ?? "",
        input.host,
        input.port ?? 6697,
        input.tls === false ? 0 : 1,
        input.nick,
        input.username ?? "",
        input.realname ?? "",
        input.sasl_account ?? "",
        this.sealSecrets(input.password ?? ""),
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    return this.get(id)!;
  }

  /**
   * Partial update. An undefined password keeps whatever is stored; an empty
   * string clears it. That distinction is what lets the UI edit a network
   * without ever receiving the password it is not changing.
   */
  update(id: string, patch: Partial<UpstreamInput>): UpstreamRow | undefined {
    const row = this.get(id);
    if (!row) return undefined;
    const secrets = patch.password === undefined ? row.secrets : this.sealSecrets(patch.password);
    this.db
      .prepare(
        `UPDATE irc_upstreams SET
           label=?, host=?, port=?, tls=?, nick=?, username=?, realname=?,
           sasl_account=?, secrets=?, enabled=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        patch.label ?? row.label,
        patch.host ?? row.host,
        patch.port ?? row.port,
        patch.tls === undefined ? row.tls : patch.tls ? 1 : 0,
        patch.nick ?? row.nick,
        patch.username ?? row.username,
        patch.realname ?? row.realname,
        patch.sasl_account ?? row.sasl_account,
        secrets,
        patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
        isoNow(),
        id,
      );
    return this.get(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare(`UPDATE irc_upstreams SET enabled=?, updated_at=? WHERE id=?`)
      .run(enabled ? 1 : 0, isoNow(), id);
  }

  setError(id: string, message: string): void {
    this.db
      .prepare(`UPDATE irc_upstreams SET last_error=?, updated_at=? WHERE id=?`)
      .run(message.slice(0, 500), isoNow(), id);
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM irc_upstream_channels WHERE upstream_id = ?`).run(id);
    this.db.prepare(`DELETE FROM irc_upstreams WHERE id = ?`).run(id);
  }

  // ── Channels ────────────────────────────────────────────────
  channels(upstreamId: string): UpstreamChannelRow[] {
    return this.db
      .prepare(`SELECT * FROM irc_upstream_channels WHERE upstream_id = ? ORDER BY channel`)
      .all(upstreamId) as UpstreamChannelRow[];
  }

  addChannel(upstreamId: string, channel: string, key = ""): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO irc_upstream_channels (upstream_id, channel, key, joined_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(upstreamId, channel, key, isoNow());
  }

  removeChannel(upstreamId: string, channel: string): void {
    this.db
      .prepare(`DELETE FROM irc_upstream_channels WHERE upstream_id = ? AND channel = ?`)
      .run(upstreamId, channel);
  }

  // ── Internals ───────────────────────────────────────────────
  private sealSecrets(password: string): string {
    if (!password) return "";
    const data = { password };
    const sealed = this.encryptionKey ? encryptSecrets(data, this.encryptionKey) : data;
    return JSON.stringify(sealed);
  }
}
