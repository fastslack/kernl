import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * IRC server persistence. The kernel is always-on, so these tables also make
 * the server a bouncer: scrollback survives reconnects and powers CHATHISTORY.
 */
export const ircMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- Registered accounts (identity ↔ nick). An account is the SASL login.
      CREATE TABLE IF NOT EXISTS irc_accounts (
        id           TEXT PRIMARY KEY,
        account      TEXT NOT NULL UNIQUE,
        nick         TEXT NOT NULL DEFAULT '',
        identity_id  TEXT NOT NULL DEFAULT '',
        is_agent     INTEGER NOT NULL DEFAULT 0,
        flags        TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      -- CertFP: SHA-256 fingerprint of a client TLS cert → account (SASL EXTERNAL).
      CREATE TABLE IF NOT EXISTS irc_certs (
        fingerprint  TEXT PRIMARY KEY,
        account      TEXT NOT NULL,
        label        TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_irc_certs_account ON irc_certs(account);

      -- Channels. 'e2e' = 1 means the channel carries opt-in E2E ciphertext (+E).
      CREATE TABLE IF NOT EXISTS irc_channels (
        name         TEXT PRIMARY KEY,
        topic        TEXT NOT NULL DEFAULT '',
        topic_by     TEXT NOT NULL DEFAULT '',
        topic_at     TEXT NOT NULL DEFAULT '',
        modes        TEXT NOT NULL DEFAULT '',
        e2e          INTEGER NOT NULL DEFAULT 0,
        is_office    INTEGER NOT NULL DEFAULT 0,
        office_flow  TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL
      );

      -- Persistent memberships (bouncer: rejoin channels across reconnects).
      CREATE TABLE IF NOT EXISTS irc_memberships (
        channel      TEXT NOT NULL,
        account      TEXT NOT NULL,
        prefix       TEXT NOT NULL DEFAULT '',
        joined_at    TEXT NOT NULL,
        PRIMARY KEY (channel, account)
      );

      -- Scrollback / CHATHISTORY. For +E channels, payload is ciphertext and
      -- encrypted=1; the server stores and relays it without being able to read.
      CREATE TABLE IF NOT EXISTS irc_messages (
        id           TEXT PRIMARY KEY,
        msgid        TEXT NOT NULL,
        target       TEXT NOT NULL,
        sender       TEXT NOT NULL DEFAULT '',
        account      TEXT NOT NULL DEFAULT '',
        ts           TEXT NOT NULL,
        kind         TEXT NOT NULL DEFAULT 'PRIVMSG',
        tags         TEXT NOT NULL DEFAULT '',
        payload      TEXT NOT NULL DEFAULT '',
        encrypted    INTEGER NOT NULL DEFAULT 0,
        deleted_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_irc_messages_target_ts ON irc_messages(target, ts);
      CREATE INDEX IF NOT EXISTS idx_irc_messages_msgid ON irc_messages(msgid);

      -- Bans / K-lines per channel (mask = nick!user@host glob).
      CREATE TABLE IF NOT EXISTS irc_bans (
        channel      TEXT NOT NULL,
        mask         TEXT NOT NULL,
        set_by       TEXT NOT NULL DEFAULT '',
        set_at       TEXT NOT NULL,
        PRIMARY KEY (channel, mask)
      );

      -- E2E channel keys, wrapped per member with their X25519 public key.
      -- Bumped key_version on every membership change (post-compromise security).
      CREATE TABLE IF NOT EXISTS irc_e2e_keys (
        channel        TEXT NOT NULL,
        member_account TEXT NOT NULL,
        key_version    INTEGER NOT NULL DEFAULT 1,
        wrapped_key    TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        PRIMARY KEY (channel, member_account, key_version)
      );

      -- Per-account X25519 public keys for E2E key distribution.
      CREATE TABLE IF NOT EXISTS irc_e2e_pubkeys (
        account      TEXT PRIMARY KEY,
        pubkey       TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
    `,
  },
];
