/**
 * IrcStore — all SQLite access for the IRC extension. Powers registration,
 * the bouncer (persistent channels/memberships), CHATHISTORY scrollback,
 * CertFP, bans and E2E key distribution.
 */
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

export interface IrcAccountRow {
  id: string;
  account: string;
  nick: string;
  identity_id: string;
  is_agent: number;
  flags: string;
  created_at: string;
  updated_at: string;
}

export interface IrcChannelRow {
  name: string;
  topic: string;
  topic_by: string;
  topic_at: string;
  modes: string;
  e2e: number;
  is_office: number;
  office_flow: string;
  created_at: string;
}

export interface IrcMessageRow {
  id: string;
  msgid: string;
  target: string;
  sender: string;
  account: string;
  ts: string;
  kind: string;
  tags: string;
  payload: string;
  encrypted: number;
}

export class IrcStore {
  constructor(private db: SqliteDb) {}

  // ── Accounts ────────────────────────────────────────────────
  upsertAccount(opts: {
    account: string;
    nick?: string;
    identity_id?: string;
    is_agent?: boolean;
  }): IrcAccountRow {
    const existing = this.getAccount(opts.account);
    const now = isoNow();
    if (existing) {
      this.db
        .prepare(
          `UPDATE irc_accounts SET nick=?, identity_id=?, is_agent=?, updated_at=? WHERE account=?`,
        )
        .run(
          opts.nick ?? existing.nick,
          opts.identity_id ?? existing.identity_id,
          opts.is_agent === undefined ? existing.is_agent : opts.is_agent ? 1 : 0,
          now,
          opts.account,
        );
      return this.getAccount(opts.account)!;
    }
    this.db
      .prepare(
        `INSERT INTO irc_accounts (id, account, nick, identity_id, is_agent, flags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
      )
      .run(
        newId(),
        opts.account,
        opts.nick ?? "",
        opts.identity_id ?? "",
        opts.is_agent ? 1 : 0,
        now,
        now,
      );
    return this.getAccount(opts.account)!;
  }

  getAccount(account: string): IrcAccountRow | undefined {
    return this.db
      .prepare(`SELECT * FROM irc_accounts WHERE account = ?`)
      .get(account) as IrcAccountRow | undefined;
  }

  // ── CertFP ──────────────────────────────────────────────────
  addCert(fingerprint: string, account: string, label = ""): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO irc_certs (fingerprint, account, label, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(fingerprint.toLowerCase(), account, label, isoNow());
  }

  accountForCert(fingerprint: string): string | undefined {
    const row = this.db
      .prepare(`SELECT account FROM irc_certs WHERE fingerprint = ?`)
      .get(fingerprint.toLowerCase()) as { account: string } | undefined;
    return row?.account;
  }

  // ── Channels ────────────────────────────────────────────────
  upsertChannel(opts: {
    name: string;
    e2e?: boolean;
    is_office?: boolean;
    office_flow?: string;
  }): IrcChannelRow {
    const existing = this.getChannel(opts.name);
    if (existing) return existing;
    this.db
      .prepare(
        `INSERT INTO irc_channels (name, e2e, is_office, office_flow, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        opts.name,
        opts.e2e ? 1 : 0,
        opts.is_office ? 1 : 0,
        opts.office_flow ?? "",
        isoNow(),
      );
    return this.getChannel(opts.name)!;
  }

  getChannel(name: string): IrcChannelRow | undefined {
    return this.db
      .prepare(`SELECT * FROM irc_channels WHERE name = ?`)
      .get(name) as IrcChannelRow | undefined;
  }

  listChannels(): IrcChannelRow[] {
    return this.db
      .prepare(`SELECT * FROM irc_channels ORDER BY name`)
      .all() as IrcChannelRow[];
  }

  setTopic(name: string, topic: string, by: string): void {
    this.db
      .prepare(`UPDATE irc_channels SET topic=?, topic_by=?, topic_at=? WHERE name=?`)
      .run(topic, by, isoNow(), name);
  }

  // ── Memberships ─────────────────────────────────────────────
  addMembership(channel: string, account: string, prefix = ""): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO irc_memberships (channel, account, prefix, joined_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(channel, account, prefix, isoNow());
  }

  removeMembership(channel: string, account: string): void {
    this.db
      .prepare(`DELETE FROM irc_memberships WHERE channel=? AND account=?`)
      .run(channel, account);
  }

  membersOf(channel: string): { account: string; prefix: string }[] {
    return this.db
      .prepare(`SELECT account, prefix FROM irc_memberships WHERE channel=?`)
      .all(channel) as { account: string; prefix: string }[];
  }

  channelsFor(account: string): string[] {
    return (
      this.db
        .prepare(`SELECT channel FROM irc_memberships WHERE account=?`)
        .all(account) as { channel: string }[]
    ).map((r) => r.channel);
  }

  // ── Scrollback / CHATHISTORY ────────────────────────────────
  storeMessage(opts: {
    msgid: string;
    target: string;
    sender: string;
    account: string;
    kind?: string;
    tags?: string;
    payload: string;
    encrypted?: boolean;
    ts?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO irc_messages (id, msgid, target, sender, account, ts, kind, tags, payload, encrypted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        opts.msgid,
        opts.target,
        opts.sender,
        opts.account,
        opts.ts ?? isoNow(),
        opts.kind ?? "PRIVMSG",
        opts.tags ?? "",
        opts.payload,
        opts.encrypted ? 1 : 0,
      );
  }

  /** Latest `limit` messages for a target, oldest-first (CHATHISTORY LATEST). */
  history(target: string, limit: number, before?: string): IrcMessageRow[] {
    const rows = before
      ? (this.db
          .prepare(
            `SELECT * FROM irc_messages WHERE target=? AND deleted_at IS NULL AND ts < ?
             ORDER BY ts DESC LIMIT ?`,
          )
          .all(target, before, limit) as IrcMessageRow[])
      : (this.db
          .prepare(
            `SELECT * FROM irc_messages WHERE target=? AND deleted_at IS NULL
             ORDER BY ts DESC LIMIT ?`,
          )
          .all(target, limit) as IrcMessageRow[]);
    return rows.reverse();
  }

  purgeOld(days: number): number {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    const res = this.db
      .prepare(`DELETE FROM irc_messages WHERE ts < ?`)
      .run(cutoff);
    return Number(res.changes ?? 0);
  }

  // ── Bans ────────────────────────────────────────────────────
  addBan(channel: string, mask: string, setBy: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO irc_bans (channel, mask, set_by, set_at) VALUES (?, ?, ?, ?)`,
      )
      .run(channel, mask, setBy, isoNow());
  }

  bansOf(channel: string): string[] {
    return (
      this.db
        .prepare(`SELECT mask FROM irc_bans WHERE channel=?`)
        .all(channel) as { mask: string }[]
    ).map((r) => r.mask);
  }

  // ── E2E key distribution ────────────────────────────────────
  setPubkey(account: string, pubkey: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO irc_e2e_pubkeys (account, pubkey, created_at) VALUES (?, ?, ?)`,
      )
      .run(account, pubkey, isoNow());
  }

  getPubkey(account: string): string | undefined {
    const row = this.db
      .prepare(`SELECT pubkey FROM irc_e2e_pubkeys WHERE account=?`)
      .get(account) as { pubkey: string } | undefined;
    return row?.pubkey;
  }

  storeWrappedKey(opts: {
    channel: string;
    member_account: string;
    key_version: number;
    wrapped_key: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO irc_e2e_keys (channel, member_account, key_version, wrapped_key, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        opts.channel,
        opts.member_account,
        opts.key_version,
        opts.wrapped_key,
        isoNow(),
      );
  }

  latestKeyVersion(channel: string): number {
    const row = this.db
      .prepare(`SELECT MAX(key_version) AS v FROM irc_e2e_keys WHERE channel=?`)
      .get(channel) as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  wrappedKeyFor(channel: string, account: string): { key_version: number; wrapped_key: string } | undefined {
    return this.db
      .prepare(
        `SELECT key_version, wrapped_key FROM irc_e2e_keys
         WHERE channel=? AND member_account=? ORDER BY key_version DESC LIMIT 1`,
      )
      .get(channel, account) as { key_version: number; wrapped_key: string } | undefined;
  }
}
